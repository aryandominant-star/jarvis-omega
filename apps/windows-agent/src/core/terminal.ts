// Runs a single terminal command and returns combined output. Used by the dashboard terminal panel and the
// run_terminal tool. "scoped" runs from an approved directory; "full" allows any working directory.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { killTree } from "../../../../packages/windows-automation/src/index";
import type { EffectivePermissions } from "../../../../packages/permissions/src/index";
import { isPathAllowed } from "../../../../packages/permissions/src/index";

const IS_WIN = process.platform === "win32";

export interface TerminalResult { exitCode: number | null; output: string; cwd: string; timedOut: boolean }

export function runTerminal(command: string, perms: EffectivePermissions, opts: { cwd?: string } = {}): Promise<TerminalResult> {
  if (perms.terminal === "off") return Promise.reject(new Error("The terminal is disabled on this PC (enable it in policy.json: terminal = \"scoped\" or \"full\")."));
  let cwd = opts.cwd ? path.resolve(opts.cwd) : perms.workspaceDir;
  if (perms.terminal === "scoped") {
    if (!isPathAllowed(cwd, perms)) cwd = perms.workspaceDir; // scoped terminals start inside an approved folder
  }
  const cmd = String(command).slice(0, 8000);
  if (!cmd.trim()) return Promise.resolve({ exitCode: 0, output: "", cwd, timedOut: false });
  const shell = IS_WIN ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = IS_WIN ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(shell, args, { cwd, windowsHide: true, env: process.env, detached: !IS_WIN });
    } catch (e: any) { return reject(e); }
    let out = "";
    let timedOut = false;
    const cap = (d: Buffer) => { out = (out + d.toString()).slice(-60000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); }, Math.max(1, perms.terminalTimeoutSec) * 1000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: out || (timedOut ? "" : "(no output)"), cwd, timedOut });
    });
  });
}

export const homeDir = () => os.homedir();
