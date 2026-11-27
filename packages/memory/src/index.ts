// Local long-term memory and task checkpoints in SQLite (node:sqlite, no native modules).
import { DatabaseSync } from "node:sqlite";

export const MEMORY_CATEGORIES = [
  "preference", "context", "project", "task", "device", "website", "application", "document", "workflow", "research",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryItem { id: number; category: string; content: string; createdAt: number; updatedAt: number }
export interface LocalTaskRecord {
  id: string; prompt: string; source: string; state: string; threadId: string | null;
  summary: string | null; sideEffects: number; startedAt: number; finishedAt: number | null;
}

const SECRETISH = /(password|passwd|pwd|passcode|otp|2fa code|secret|api[_ -]?key|token)\s*[:=]/i;

export class Memory {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_mem_cat ON memories(category);
      CREATE TABLE IF NOT EXISTS local_tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, source TEXT, state TEXT NOT NULL, thread_id TEXT,
        summary TEXT, side_effects INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS apps (name TEXT NOT NULL, app_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  // ----- memories -----
  add(category: string, content: string): MemoryItem {
    const cat = (MEMORY_CATEGORIES as readonly string[]).includes(category) ? category : "context";
    const text = content.trim().slice(0, 4000);
    if (!text) throw new Error("Memory content is empty");
    if (SECRETISH.test(text)) throw new Error("Refusing to store something that looks like a password or secret in memory. Use the credential vault.");
    const t = Date.now();
    const r = this.db.prepare("INSERT INTO memories (category, content, created_at, updated_at) VALUES (?,?,?,?)").run(cat, text, t, t);
    return { id: Number(r.lastInsertRowid), category: cat, content: text, createdAt: t, updatedAt: t };
  }
  update(id: number, content: string) {
    if (SECRETISH.test(content)) throw new Error("Refusing to store secrets in memory");
    this.db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(content.slice(0, 4000), Date.now(), id);
  }
  delete(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
  }
  list(category?: string, limit = 200): MemoryItem[] {
    const rows = category
      ? this.db.prepare("SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?").all(category, limit)
      : this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map(toItem);
  }
  search(query: string, limit = 10): MemoryItem[] {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).slice(0, 8);
    if (!words.length) return this.list(undefined, limit);
    const all = this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT 2000").all().map(toItem);
    return all
      .map((m) => ({ m, score: words.filter((w) => m.content.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
      .slice(0, limit)
      .map((x) => x.m);
  }
  exportAll() {
    return { memories: this.list(undefined, 100000), tasks: this.recentTasks(1000) };
  }

  // ----- task checkpoints -----
  taskStart(id: string, prompt: string, source: string) {
    this.db.prepare("INSERT OR IGNORE INTO local_tasks (id, prompt, source, state, started_at) VALUES (?,?,?,?,?)").run(id, prompt, source, "running", Date.now());
  }
  getTask(id: string): LocalTaskRecord | null {
    const r = this.db.prepare("SELECT * FROM local_tasks WHERE id = ?").get(id) as any;
    return r ? toTask(r) : null;
  }
  taskCheckpoint(id: string, patch: { threadId?: string; sideEffects?: boolean }) {
    if (patch.threadId) this.db.prepare("UPDATE local_tasks SET thread_id = ? WHERE id = ?").run(patch.threadId, id);
    if (patch.sideEffects) this.db.prepare("UPDATE local_tasks SET side_effects = 1 WHERE id = ?").run(id);
  }
  taskFinish(id: string, state: "completed" | "failed" | "cancelled" | "interrupted", summary: string | null) {
    this.db.prepare("UPDATE local_tasks SET state = ?, summary = ?, finished_at = ? WHERE id = ?").run(state, summary?.slice(0, 2000) ?? null, Date.now(), id);
  }
  /** Tasks that were running when the agent stopped unexpectedly. */
  interruptedTasks(): LocalTaskRecord[] {
    return this.db.prepare("SELECT * FROM local_tasks WHERE state = 'running'").all().map(toTask);
  }
  recentTasks(limit = 5): LocalTaskRecord[] {
    return this.db.prepare("SELECT * FROM local_tasks WHERE state != 'running' ORDER BY started_at DESC LIMIT ?").all(limit).map(toTask);
  }
  lastThreadId(): string | null {
    const r = this.db.prepare("SELECT thread_id FROM local_tasks WHERE thread_id IS NOT NULL ORDER BY started_at DESC LIMIT 1").get() as any;
    return r?.thread_id ?? null;
  }

  // ----- application catalog -----
  replaceApps(apps: { name: string; appId: string }[]) {
    const t = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM apps");
      const ins = this.db.prepare("INSERT OR REPLACE INTO apps (name, app_id, updated_at) VALUES (?,?,?)");
      for (const a of apps) ins.run(a.name, a.appId, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  apps(): { name: string; appId: string }[] {
    return this.db.prepare("SELECT name, app_id FROM apps ORDER BY name").all().map((r: any) => ({ name: r.name, appId: r.app_id }));
  }
  findApp(query: string): { name: string; appId: string } | null {
    const q = query.toLowerCase().trim();
    const all = this.apps();
    return all.find((a) => a.name.toLowerCase() === q)
      ?? all.find((a) => a.name.toLowerCase().startsWith(q))
      ?? all.find((a) => a.name.toLowerCase().includes(q))
      ?? null;
  }

  // ----- kv -----
  get(key: string): string | null {
    return ((this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any)?.value as string) ?? null;
  }
  set(key: string, value: string) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  close() {
    this.db.close();
  }
}

const toItem = (r: any): MemoryItem => ({ id: r.id, category: r.category, content: r.content, createdAt: r.created_at, updatedAt: r.updated_at });
const toTask = (r: any): LocalTaskRecord => ({
  id: r.id, prompt: r.prompt, source: r.source, state: r.state, threadId: r.thread_id, summary: r.summary,
  sideEffects: r.side_effects, startedAt: r.started_at, finishedAt: r.finished_at,
});
