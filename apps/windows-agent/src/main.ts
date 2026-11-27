// J.A.R.V.I.S. OMEGA Windows agent — entry point.
//   agent.cjs --background      supervisor (started hidden by Task Scheduler at sign-in)
//   agent.cjs --worker [...]    the agent itself (forked by the supervisor)
//   agent.cjs mcp               jarvis-tools MCP server (spawned by Codex)
//   agent.cjs pair --url U --code C [--name N]
//   agent.cjs init --workspace DIR [--browser chrome|msedge] [--voice true|false] [--url U]
//   agent.cjs startup register|enable|disable|status|remove
//   agent.cjs codex-login | status | stop | check-url --url U
import { fork } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { codexLogin, resolveCodexBinary } from "../../../packages/agent-brain/src/index";
import { pair } from "../../../packages/device-manager/src/index";
import { registerStartup, setStartupEnabled, startupStatus, unregisterStartup } from "../../../packages/windows-automation/src/index";
import { loadConfig, loadPolicy, loadState, saveConfig, saveDeviceSecret, savePolicy, saveState } from "./core/config";
import { ipcCall } from "./core/ipc";
import { createLogger } from "./core/logger";
import { AGENT_VERSION, dataDir, IS_WIN, paths } from "./core/paths";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const cmd = argv.find((a) => !a.startsWith("--")) ?? (argv.includes("--worker") ? "worker" : argv.includes("--background") ? "background" : "help");

async function supervisor() {
  const log = createLogger("supervisor");
  // Single instance: hold an exclusive per-user pipe for our lifetime.
  const user = (os.userInfo().username || "user").replace(/[^\w.-]/g, "_");
  const lockPath = IS_WIN ? `\\\\.\\pipe\\jarvis-omega-lock-${user}` : path.join(dataDir(), "supervisor.lock.sock");
  if (!IS_WIN) {
    // stale unix socket from a crashed run?
    const alive = await new Promise<boolean>((r) => { const s = net.connect(lockPath); s.on("connect", () => (s.end(), r(true))); s.on("error", () => r(false)); });
    if (alive) { log.info("Another instance is running; exiting"); process.exit(0); }
    fs.rmSync(lockPath, { force: true });
  }
  const lock = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => {
    lock.once("error", () => { log.info("Another instance is running; exiting"); process.exit(0); });
    lock.listen(lockPath, () => resolve());
  });

  let first = true;
  let child: ReturnType<typeof fork> | null = null;
  const start = () => {
    const st = loadState();
    const cutoff = Date.now() - 10 * 60_000;
    st.crashes = st.crashes.filter((t) => t > cutoff);
    saveState(st);
    const safe = st.crashes.length >= 4;
    if (st.crashes.length >= 6) { log.error("Too many crashes; supervisor stopping (no restart loop)"); process.exit(1); }
    const args = ["--worker", ...(first ? ["--fresh-start"] : []), ...(safe ? ["--safe-mode"] : [])];
    first = false;
    log.info(`Starting worker ${args.join(" ")}`);
    child = fork(process.argv[1], args, { execArgv: ["--max-old-space-size=384", "--disable-warning=ExperimentalWarning"], stdio: "ignore", windowsHide: true });
    child.on("exit", (code, signal) => {
      child = null;
      if (code === 0) { log.info("Worker exited normally; supervisor exiting"); process.exit(0); }
      const s2 = loadState();
      s2.crashes.push(Date.now());
      saveState(s2);
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(s2.crashes.length, 5));
      log.warn(`Worker exited (code=${code}, signal=${signal}); restarting in ${delay / 1000}s`);
      setTimeout(start, delay);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { child?.kill(); process.exit(0); });
  start();
}

async function worker() {
  const log = createLogger("agent");
  process.on("uncaughtException", (e) => { log.error("uncaughtException", e); process.exit(70); });
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
  const { Agent } = await import("./agent");
  const agent = new Agent({ safeMode: argv.includes("--safe-mode"), freshStart: argv.includes("--fresh-start") });
  await agent.start();
  // A clean, long-running worker resets the crash counter.
  setTimeout(() => { const st = loadState(); st.crashes = []; saveState(st); }, 15 * 60_000).unref();
}

function out(msg: unknown) {
  process.stdout.write((typeof msg === "string" ? msg : JSON.stringify(msg, null, 2)) + "\n");
}

async function main() {
  switch (cmd) {
    case "background": return supervisor();
    case "worker": return worker();
    case "mcp": { const { runMcpServer } = await import("./mcp-server"); return runMcpServer(); }
    case "pair": {
      const url = (flag("url") ?? loadConfig().apiUrl ?? "").replace(/\/$/, "");
      const code = flag("code");
      if (!url || !code) throw new Error("Usage: pair --url https://… --code ABCD-EFGH [--name NAME]");
      const name = flag("name") ?? os.hostname().toUpperCase();
      const r = await pair(url, code, name, `${os.type()} ${os.release()}`, AGENT_VERSION, loadPolicy());
      await saveDeviceSecret(r.deviceSecret);
      saveConfig({ ...loadConfig(), apiUrl: url, dashboardUrl: url, deviceId: r.deviceId, deviceName: r.deviceName });
      await ipcCall("reload", {}, 3000).catch(() => undefined);
      return out(`Paired as ${r.deviceName}`);
    }
    case "init": {
      const p = loadPolicy();
      const ws = flag("workspace");
      if (ws) { p.workspaceDir = path.resolve(ws); if (!p.approvedDirs.includes(p.workspaceDir)) p.approvedDirs = [p.workspaceDir, ...p.approvedDirs.filter((d) => d !== p.workspaceDir)]; }
      const b = flag("browser"); if (b === "chrome" || b === "msedge") p.browser = b;
      const v = flag("voice"); if (v) p.voice = v === "true";
      savePolicy(p);
      fs.mkdirSync(p.workspaceDir, { recursive: true });
      const url = flag("url"); if (url) saveConfig({ ...loadConfig(), apiUrl: url.replace(/\/$/, ""), dashboardUrl: url.replace(/\/$/, "") });
      return out(`Policy written to ${paths.policy}`);
    }
    case "check-url": {
      const url = (flag("url") ?? "").replace(/\/$/, "");
      const r = await fetch(url + "/api/health", { signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json();
      if (!j.ok) throw new Error("Not a JARVIS control plane");
      return out("ok");
    }
    case "startup": {
      const sub = argv[1];
      const launcher = path.join(path.dirname(process.execPath), "jarvisw.exe");
      const exe = fs.existsSync(launcher) ? launcher : process.execPath;
      if (sub === "register") { await registerStartup(exe, `"${path.join(paths.appDir, "agent.cjs")}" --background`); return out("registered"); }
      if (sub === "enable" || sub === "disable") { await setStartupEnabled(sub === "enable"); return out(sub + "d"); }
      if (sub === "remove") { await unregisterStartup(); return out("removed"); }
      return out(await startupStatus());
    }
    case "codex-login": {
      const bin = resolveCodexBinary([paths.appDir, path.resolve(paths.appDir, ".."), process.cwd()]);
      if (!bin) throw new Error("Codex binary not found");
      const code = await codexLogin(bin, paths.codexHome, argv.includes("--device-auth"));
      return out(code === 0 ? "Codex connected" : `codex login exited with ${code}`);
    }
    case "status": return out(await ipcCall("status", {}, 5000));
    case "stop": { await ipcCall("quit", {}, 5000).catch(() => undefined); return out("stopped"); }
    case "version": return out(AGENT_VERSION);
    default:
      return out("J.A.R.V.I.S. agent. Commands: --background | pair | init | startup | codex-login | status | stop | check-url | mcp | version");
  }
}

main().catch((e) => {
  createLogger("cli").error(`command ${cmd} failed`, e);
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
