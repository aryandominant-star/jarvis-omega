// Authenticated local IPC over a per-user named pipe (Windows) / unix socket (dev).
// Used by the jarvis-tools MCP process (spawned by Codex) and by CLI commands (status/stop).
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { ipcPipePath, paths, writeFileAtomic } from "./paths";

export type IpcHandler = (method: string, params: any) => Promise<unknown>;

export function ensureIpcToken(): string {
  if (fs.existsSync(paths.ipcToken)) return fs.readFileSync(paths.ipcToken, "utf8").trim();
  const t = crypto.randomBytes(24).toString("hex");
  writeFileAtomic(paths.ipcToken, t);
  return t;
}

export function startIpcServer(token: string, handler: IpcHandler): Promise<net.Server> {
  const pipe = ipcPipePath();
  if (process.platform !== "win32") fs.rmSync(pipe, { force: true });
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) return sock.destroy();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const ok = typeof msg.token === "string" && msg.token.length === token.length &&
          crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(token));
        if (!ok) { sock.write(JSON.stringify({ id: msg.id, error: "unauthorized" }) + "\n"); continue; }
        try {
          const result = await handler(msg.method, msg.params ?? {});
          if (!sock.destroyed) sock.write(JSON.stringify({ id: msg.id, result }) + "\n");
        } catch (e: any) {
          if (!sock.destroyed) sock.write(JSON.stringify({ id: msg.id, error: e?.message ?? String(e) }) + "\n");
        }
      }
    });
    sock.on("error", () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, () => {
      if (process.platform !== "win32") fs.chmodSync(pipe, 0o600);
      resolve(server);
    });
  });
}

export function ipcCall<T = any>(method: string, params: unknown = {}, timeoutMs = 20 * 60_000): Promise<T> {
  const token = fs.existsSync(paths.ipcToken) ? fs.readFileSync(paths.ipcToken, "utf8").trim() : "";
  return new Promise((resolve, reject) => {
    const sock = net.connect(ipcPipePath());
    const id = crypto.randomBytes(6).toString("hex");
    let buf = "";
    const t = setTimeout(() => { sock.destroy(); reject(new Error("JARVIS agent did not respond")); }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, token, method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(t);
      sock.end();
      const msg = JSON.parse(buf.slice(0, i));
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
    });
    sock.on("error", (e) => { clearTimeout(t); reject(new Error(`JARVIS agent is not running (${e.message})`)); });
  });
}
