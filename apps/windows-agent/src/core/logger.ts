import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths";

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 5;
const secrets = new Set<string>();

/** Register a value that must never appear in logs or anything sent to the cloud. */
export function registerSecret(value: string | null | undefined) {
  if (value && value.length >= 4) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  // Common credential shapes
  out = out.replace(/(password|passwd|secret|token|api[_-]?key)(["'\s:=]+)([^\s"',;]{4,})/gi, "$1$2[REDACTED]");
  return out;
}

function rotate(file: string) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
    if (fs.existsSync(`${file}.${KEEP + 1}`)) fs.unlinkSync(`${file}.${KEEP + 1}`);
  } catch {
    /* never let logging crash the agent */
  }
}

export function createLogger(name: string) {
  const file = path.join(paths.logs, `${name}.log`);
  let writes = 0;
  const write = (level: string, msg: string, extra?: unknown) => {
    const line = redact(
      `${new Date().toISOString()} [${level}] ${msg}${extra !== undefined ? " " + (extra instanceof Error ? extra.stack : JSON.stringify(extra)) : ""}`
    );
    if (++writes % 200 === 0) rotate(file);
    try {
      fs.appendFileSync(file, line + "\n");
    } catch {
      /* ignore */
    }
    if (process.env.JARVIS_DEBUG) process.stderr.write(line + "\n");
  };
  rotate(file);
  return {
    info: (m: string, e?: unknown) => write("INFO", m, e),
    warn: (m: string, e?: unknown) => write("WARN", m, e),
    error: (m: string, e?: unknown) => write("ERROR", m, e),
    debug: (m: string, e?: unknown) => process.env.JARVIS_DEBUG && write("DEBUG", m, e),
  };
}
export type Logger = ReturnType<typeof createLogger>;
