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

const MAX_TRANSFER = 180 * 1024; // keep a single control-task result within D1 / request limits

/** Read a file's raw bytes as base64 for download. Caps at MAX_TRANSFER. */
export function readFileBase64(file: string): { name: string; size: number; base64: string; truncated: boolean } {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error("Not a file");
  if (st.size > MAX_TRANSFER) throw new Error(`File is ${(st.size / 1024).toFixed(0)} KB; downloads are limited to ${MAX_TRANSFER / 1024} KB in this version`);
  const buf = fs.readFileSync(file);
  return { name: path.basename(file), size: st.size, base64: buf.toString("base64"), truncated: false };
}

/** Write base64 bytes pushed from the dashboard into an approved directory. */
export function writeFileBase64(dir: string, name: string, base64: string): { path: string; size: number } {
  const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "upload.bin";
  const buf = Buffer.from(base64, "base64");
  if (buf.length > MAX_TRANSFER) throw new Error(`Uploads are limited to ${MAX_TRANSFER / 1024} KB in this version`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safe);
  fs.writeFileSync(dest, buf);
  return { path: dest, size: buf.length };
}

/** Delete a file or (recursively) a directory. Returns how many entries were removed. */
export function deletePath(target: string): { removed: number; isDir: boolean } {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    let count = 0;
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else count++; } };
    try { walk(target); } catch { /* best-effort count */ }
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: count, isDir: true };
  }
  fs.rmSync(target, { force: true });
  return { removed: 1, isDir: false };
}

/** Count files under a path without deleting — used to decide if a delete needs confirmation. */
export function countEntries(target: string): number {
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return 1;
    let count = 0;
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else count++; if (count > 9999) return; } };
    walk(target);
    return count;
  } catch { return 0; }
}

// ---------------- directory index (for the dashboard tree + agent "learning") ----------------
export interface IndexNode { name: string; type: "dir" | "file"; size?: number; path: string; children?: IndexNode[]; truncated?: boolean }
export interface FileIndex {
  roots: IndexNode[];
  fileCount: number;
  dirCount: number;
  bytes: number;
  byExt: { ext: string; count: number }[];
  summary: string;
  truncated: boolean;
  scannedAt: number;
}

/**
 * Walk the approved roots into a bounded directory tree. Used to populate the dashboard file browser
 * on connect and to give the AI a compact, learnable picture of what lives on the machine.
 */
export function buildFileIndex(roots: string[], opts: { maxEntries?: number; maxDepth?: number } = {}): FileIndex {
  const maxEntries = opts.maxEntries ?? 2000; // keeps the JSON result well within request/D1 limits
  const maxDepth = opts.maxDepth ?? 4;
  let fileCount = 0, dirCount = 0, bytes = 0, visited = 0;
  let truncated = false;
  const byExt = new Map<string, number>();

  const walk = (dir: string, depth: number): IndexNode[] => {
    if (depth > maxDepth || visited >= maxEntries) { truncated = truncated || visited >= maxEntries; return []; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: IndexNode[] = [];
    // Directories first, then files — both alphabetical, so the tree reads naturally.
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (visited >= maxEntries) { truncated = true; break; }
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name.toLowerCase()) || e.name.startsWith(".")) continue;
        visited++; dirCount++;
        out.push({ name: e.name, type: "dir", path: full, children: walk(full, depth + 1) });
      } else {
        visited++; fileCount++;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* vanished */ }
        bytes += size;
        const ext = (path.extname(e.name).toLowerCase() || "(none)").replace(/^\./, "");
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        out.push({ name: e.name, type: "file", path: full, size });
      }
    }
    return out;
  };

  const rootNodes: IndexNode[] = [];
  for (const r of [...new Set(roots)]) {
    if (!fs.existsSync(r)) continue;
    rootNodes.push({ name: r, type: "dir", path: r, children: walk(r, 1) });
  }
  const topExt = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ext, count]) => ({ ext, count }));

  const topExtStr = topExt.slice(0, 6).map((e) => `${e.ext} (${e.count})`).join(", ");
  const rootList = rootNodes.map((r) => r.name).join("; ");
  const summary =
    `Workspace scan: ${fileCount} files and ${dirCount} folders (${(bytes / 1024 / 1024).toFixed(1)} MB) under ${rootList || "no approved folders"}. ` +
    (topExtStr ? `Most common file types: ${topExtStr}.` : "No files found.") +
    (truncated ? " (Index truncated at the scan limit.)" : "");

  return { roots: rootNodes, fileCount, dirCount, bytes, byExt: topExt, summary, truncated, scannedAt: Date.now() };
}
