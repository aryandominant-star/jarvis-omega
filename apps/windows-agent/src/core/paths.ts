import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_VERSION = "1.1.0";
export const IS_WIN = process.platform === "win32";

/** Per-user data directory: %APPDATA%\JARVIS (Windows) or ~/.jarvis-omega (dev on other OSes). */
export function dataDir(): string {
  const override = process.env.JARVIS_DATA_DIR;
  const dir = override
    ? override
    : IS_WIN
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "JARVIS")
      : path.join(os.homedir(), ".jarvis-omega");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  get config() { return path.join(dataDir(), "config.json"); },
  get policy() { return path.join(dataDir(), "policy.json"); },
  get state() { return path.join(dataDir(), "state.json"); },
  get secret() { return path.join(dataDir(), "device.secret"); },
  get vault() { return path.join(dataDir(), "vault.bin"); },
  get memoryDb() { return path.join(dataDir(), "memory.db"); },
  get ipcToken() { return path.join(dataDir(), "ipc.token"); },
  get logs() { const d = path.join(dataDir(), "logs"); fs.mkdirSync(d, { recursive: true }); return d; },
  get codexHome() { const d = path.join(dataDir(), "codex"); fs.mkdirSync(d, { recursive: true }); return d; },
  get browserProfile() { const d = path.join(dataDir(), "browser-profile"); fs.mkdirSync(d, { recursive: true }); return d; },
  /** Directory of the bundled app (dist/ when built, install dir\app when installed). */
  get appDir() { return process.env.JARVIS_APP_DIR || path.dirname(process.argv[1] || __filename); },
};

export function ipcPipePath(): string {
  const user = (os.userInfo().username || "user").replace(/[^\w.-]/g, "_");
  if (IS_WIN) return `\\\\.\\pipe\\jarvis-omega-${user}`;
  return path.join(dataDir(), `jarvis-${user}.sock`);
}

/** Write a file atomically (write temp + rename) so a crash never leaves half-written state. */
export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
