// File tools restricted to approved directories. Nothing is indexed or uploaded outside them.
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", "$recycle.bin", "system volume information", "appdata", ".cache"]);

export interface FileHit { path: string; size: number; modified: number }

/** Find files whose name contains the query (case-insensitive, `*` wildcard supported) inside approved roots. */
export function searchFiles(query: string, roots: string[], opts: { limit?: number; maxVisited?: number } = {}): { hits: FileHit[]; truncated: boolean } {
  const limit = opts.limit ?? 50;
  const maxVisited = opts.maxVisited ?? 60_000;
  const q = query.toLowerCase().trim();
  if (!q) return { hits: [], truncated: false };
  const re = q.includes("*") ? new RegExp("^" + q.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i") : null;
  const hits: FileHit[] = [];
  let visited = 0;
  const stack = [...new Set(roots)].filter((r) => fs.existsSync(r));
  while (stack.length && hits.length < limit && visited < maxVisited) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      if (e.isSymbolicLink()) continue; // never follow links out of approved roots
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name.toLowerCase()) && !e.name.startsWith(".")) stack.push(full);
        continue;
      }
      const name = e.name.toLowerCase();
      if (re ? re.test(name) : name.includes(q)) {
        try {
          const st = fs.statSync(full);
          hits.push({ path: full, size: st.size, modified: st.mtimeMs });
        } catch { /* vanished */ }
        if (hits.length >= limit) break;
      }
    }
  }
  return { hits, truncated: hits.length >= limit || visited >= maxVisited };
}

export function readTextFile(file: string, maxBytes = 200_000): { text: string; truncated: boolean } {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error("Not a file");
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    if (buf.includes(0)) throw new Error("This looks like a binary file; open it with the right application instead");
    return { text: buf.toString("utf8"), truncated: st.size > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

export function listDir(dir: string, limit = 300) {
  return fs.readdirSync(dir, { withFileTypes: true }).slice(0, limit).map((e) => ({
    name: e.name, type: e.isDirectory() ? "dir" : "file",
  }));
}
