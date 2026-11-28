import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SETTINGS, type AgentSyncResponse, type AgentTaskUpdate, type DeviceCapabilities, type DispatchedTask, type NotificationPrefs, type PermissionProfile, type TaskEvent, type TaskStatus,
} from "../../../packages/shared-types/src/index";
import { buildTaskPrompt, codexLogin, codexLoginStatus, PERSONA, resolveCodexBinary, runCodex, writeCodexConfig, type McpDef } from "../../../packages/agent-brain/src/index";
import { BrowserManager } from "../../../packages/browser-controller/src/index";
import { Vault } from "../../../packages/credential-vault/src/index";
import { CloudClient, CloudError } from "../../../packages/device-manager/src/index";
import { countEntries, deletePath, listDir, readFileBase64, readTextFile, searchFiles, writeFileBase64 } from "../../../packages/file-manager/src/index";
import { Memory } from "../../../packages/memory/src/index";
import { effectivePermissions, isAppAllowed, isPathAllowed, type EffectivePermissions, type LocalPolicy } from "../../../packages/permissions/src/index";
import { REA_INSTRUCTIONS, reaMcpServer } from "../../../packages/rea-integration/src/index";
import { backoff, inQuietHours, LocalMonitors } from "../../../packages/task-scheduler/src/index";
import { spokenSummary, VoiceEngine } from "../../../packages/voice-engine/src/index";
import { exportReport } from "../../../packages/web-research/src/index";
import {
  batteryStatus, cancelPower, captureScreen, collectMetrics, discoverApps, focusWindow, isWorkstationLocked, killTree,
  launchApp, listWindows, logonKey, powerAction, screenIndicator, setStartupEnabled, showMessage, startupStatus, toast, userNotificationState,
} from "../../../packages/windows-automation/src/index";
import { runTerminal } from "./core/terminal";
import { runClaude } from "../../../packages/agent-brain/src/claude";
import { TOOLS as CLAUDE_TOOLS } from "./mcp-server";

const safeParseJson = (s: string | null): any[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
import { Tray, type TrayAction } from "../../windows-tray/src/tray";
import { clearDeviceSecret, loadConfig, loadDeviceSecret, loadPolicy, loadState, saveConfig, saveState, type AgentConfig } from "./core/config";
import { ensureIpcToken, startIpcServer } from "./core/ipc";
import { createLogger, redact, registerSecret } from "./core/logger";
import { AGENT_VERSION, IS_WIN, paths } from "./core/paths";
import { startLocalUi } from "./localui";

const log = createLogger("agent");

interface Running {
  task: DispatchedTask;
  pid?: number;
  cancelled: boolean;
  status: TaskStatus;
  waiting: ((r: { approved: boolean; text: string | null }) => void) | null;
  events: { type: TaskEvent["type"]; data: Record<string, unknown> }[];
  sideEffects: boolean;
}

export class Agent {
  cfg: AgentConfig = loadConfig();
  policy: LocalPolicy = loadPolicy();
  cloudPerms: PermissionProfile | null = null;
  perms!: EffectivePermissions;
  prefs: NotificationPrefs = DEFAULT_SETTINGS.notifications;
  client: CloudClient | null = null;
  memory = new Memory(paths.memoryDb);
  vault = new Vault(paths.vault, registerSecret);
  browser = new BrowserManager(paths.browserProfile, () => this.policy.browser, (m) => log.info(m));
  voice: VoiceEngine;
  tray: Tray;
  monitors = new LocalMonitors({ diskFreePercent: 10, cooldownMs: 6 * 3600e3 });
  running = new Map<string, Running>();
  paused = false;
  connected = false;
  locked = false;
  battery: { onBattery: boolean; percent: number | null } | null = null;
  codex: DeviceCapabilities["codex"] = "unknown";
  codexBin: string | null;
  update: AgentSyncResponse["update"] = null;
  localUiUrl: string | null = null;
  private stopping = false;
  private startupToastShown = false;

  constructor(private opts: { safeMode: boolean; freshStart: boolean }) {
    this.perms = effectivePermissions(null, this.policy);
    this.codexBin = resolveCodexBinary([path.resolve(paths.appDir), path.resolve(paths.appDir, ".."), process.cwd()]);
    this.voice = new VoiceEngine(path.join(paths.appDir, "voice.ps1"), (m) => log.warn(m));
    this.tray = new Tray(path.join(paths.appDir, "assets"), (a) => this.onTray(a).catch((e) => log.error("tray action", e)), (m) => log.warn(m));
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    log.info(`JARVIS agent ${AGENT_VERSION} starting (safeMode=${this.opts.safeMode}, pid=${process.pid})`);
    os.setPriority?.(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    const token = ensureIpcToken();
    await startIpcServer(token, (m, p) => this.onIpc(m, p));
    this.localUiUrl = await startLocalUi(this).catch((e) => { log.error("local UI failed", e); return null; });
    await this.tray.start().catch((e) => log.error("tray failed", e));
    this.tray.setPaired(!!this.cfg.deviceId);
    this.tray.setStartup((await startupStatus()) === "enabled");
    this.applyPermissions();
    this.recoverInterruptedTasks();
    this.refreshLocalState().catch(() => undefined);
    setInterval(() => this.refreshLocalState().catch(() => undefined), 30_000).unref();
    setInterval(() => this.refreshCodexStatus().catch(() => undefined), 5 * 60_000).unref();
    await this.refreshCodexStatus().catch(() => undefined); // so the first heartbeat reports real Codex status
    this.refreshApps().catch((e) => log.warn("app discovery failed", e));
    if (this.policy.voice) this.startVoice();
    // Startup notification: once per Windows sign-in, after initialization (or after 60s if offline).
    setTimeout(() => this.startupToast(false), 60_000).unref();
    this.syncLoop().catch((e) => log.error("sync loop crashed", e));
  }

  async shutdown(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    log.info("Shutting down");
    for (const r of this.running.values()) { r.cancelled = true; if (r.pid) killTree(r.pid); }
    this.voice.stop();
    this.tray.stop();
    this.memory.close();
    setTimeout(() => process.exit(code), 500);
  }

  private recoverInterruptedTasks() {
    // Never repeat work automatically after a crash/restart: report it and let the user Retry (which resumes the thread).
    const interrupted = this.memory.interruptedTasks();
    for (const t of interrupted) {
      this.memory.taskFinish(t.id, "interrupted", null);
      this.pendingReports.push({ id: t.id, update: {
        status: "FAILED",
        error: t.sideEffects
          ? "JARVIS restarted while this task was running. Some steps had already run, so it was NOT repeated automatically. Review the trace, then use Retry to resume safely."
          : "JARVIS restarted before this task made any changes. Use Retry to run it again.",
      } });
    }
    if (interrupted.length) log.warn(`Recovered ${interrupted.length} interrupted task(s)`);
  }
  private pendingReports: { id: string; update: AgentTaskUpdate }[] = [];

  // ------------------------------------------------------------------ cloud sync
  private async ensureClient(): Promise<CloudClient | null> {
    if (this.client) return this.client;
    if (!this.cfg.apiUrl || !this.cfg.deviceId) return null;
    const secret = await loadDeviceSecret();
    if (!secret) return null;
    registerSecret(secret);
    this.client = new CloudClient(this.cfg.apiUrl, this.cfg.deviceId, secret);
    return this.client;
  }

  private async syncLoop() {
    let failures = 0;
    let lastTick = Date.now();
    while (!this.stopping) {
      // Detect sleep/hibernate: a large wall-clock jump means we just resumed.
      if (Date.now() - lastTick > 90_000) { log.info("Resume from sleep detected; reconnecting"); failures = 0; this.refreshLocalState().catch(() => undefined); }
      lastTick = Date.now();
      const client = await this.ensureClient();
      if (!client) {
        this.setTray();
        await sleep(5000);
        this.cfg = loadConfig();
        continue;
      }
      try {
        while (this.pendingReports.length) {
          const r = this.pendingReports[0];
          await client.updateTask(r.id, r.update).catch((e) => { if (!(e instanceof CloudError) || e.status === 0) throw e; });
          this.pendingReports.shift();
        }
        const res = await client.syncOnce({
          agentVersion: AGENT_VERSION,
          metrics: collectMetrics(this.battery?.onBattery ?? null),
          capabilities: this.capabilities(),
          sessionActive: !this.locked,
          activeTaskIds: [...this.running.keys()],
          wait: this.running.size === 0,
        });
        lastTick = Date.now();
        failures = 0;
        if (!this.connected) log.info("Connected to control plane");
        this.connected = true;
        await this.handleSync(res);
        this.startupToast(true);
      } catch (e: any) {
        this.connected = false;
        if (e instanceof CloudError && (e.code === "revoked" || (e.status === 401 && e.code === "unauthenticated" && /Unknown device/.test(e.message)))) {
          log.warn("This device was revoked or removed from the account");
          await this.forgetPairing("This PC was disconnected from your JARVIS account.");
          continue;
        }
        failures++;
        const wait = backoff(failures, 2000, this.battery?.onBattery ? 10 * 60_000 : 5 * 60_000);
        if (failures === 1 || failures % 10 === 0) log.warn(`Sync failed (${failures}): ${e.message}; retrying in ${Math.round(wait / 1000)}s`);
        this.setTray();
        await sleep(wait);
      }
    }
  }

  private async handleSync(res: AgentSyncResponse) {
    this.prefs = res.notifications;
    if (JSON.stringify(res.permissions) !== JSON.stringify(this.cloudPerms)) {
      this.cloudPerms = res.permissions;
      this.applyPermissions();
    }
    if (res.paused !== this.paused) {
      this.paused = res.paused;
      this.tray.setPaused(this.paused);
      if (this.paused) this.notify("security", "Automation paused", "Emergency stop received. All JARVIS tasks were stopped.");
    }
    for (const id of res.cancelTaskIds) this.cancel(id, this.paused ? "Emergency stop" : "Cancelled by user");
    for (const r of res.inputResponses) {
      const run = this.running.get(r.taskId);
      if (run?.waiting) { const w = run.waiting; run.waiting = null; w({ approved: r.approved, text: r.text }); }
    }
    for (const t of res.tasks) this.accept(t);
    if (res.update && this.update?.version !== res.update.version) {
      this.update = res.update;
      this.tray.setUpdate(res.update.version);
      const st = loadState();
      if (st.notifiedUpdate !== res.update.version) { st.notifiedUpdate = res.update.version; saveState(st); this.notify("errors", "Update available", `JARVIS ${res.update.version} is ready to install from the tray menu.`); }
    }
    this.setTray();
  }

  private capabilities(): DeviceCapabilities {
    return {
      browser: this.browser.available(),
      codex: this.codex,
      voice: this.voice.running(),
      desktop: !this.locked,
      vault: Vault.available(),
      rea: this.perms.rea,
      power: this.perms.power,
      terminal: this.perms.terminal,
      screen: this.perms.screen,
      messenger: this.perms.messenger,
      provider: this.perms.provider,
    };
  }

  private setTray() {
    const busy = [...this.running.values()].some((r) => r.status !== "WAITING_FOR_INPUT");
    const waiting = [...this.running.values()].some((r) => r.status === "WAITING_FOR_INPUT");
    if (!this.cfg.deviceId) return this.tray.setStatus("attention", "Not paired — choose “Pair this PC…”");
    if (this.opts.safeMode) return this.tray.setStatus("attention", "Safe mode after repeated errors");
    if (!this.connected) return this.tray.setStatus("disconnected", "Offline — reconnecting");
    if (waiting) return this.tray.setStatus("attention", "Waiting for your approval");
    if (this.codex !== "ready") return this.tray.setStatus("attention", "Connect Codex to run tasks");
    if (busy) return this.tray.setStatus("busy", `Running ${this.running.size} task(s)`);
    this.tray.setStatus("connected", this.paused ? "Online · automation paused" : "Online · all systems operational");
  }

  private async startupToast(initialized: boolean) {
    if (this.startupToastShown || !this.opts.freshStart) return;
    if (!initialized && this.connected) return;
    this.startupToastShown = true;
    const key = await logonKey();
    const st = loadState();
    if (st.lastStartupToastKey === key) return; // never repeat within the same sign-in
    st.lastStartupToastKey = key;
    saveState(st);
    if (!this.prefs.startup) return;
    const hour = new Date().getHours();
    const msg = !this.cfg.deviceId ? "Installed but not paired yet. Open the tray menu to pair this PC."
      : !this.connected ? "Running locally. The cloud connection will resume automatically."
      : hour < 11 && hour >= 5 ? "Good morning. JARVIS is ready." : "JARVIS is online. All systems operational.";
    this.notify("startup", "J.A.R.V.I.S.", msg);
  }

  /** Native toast, respecting user prefs, quiet hours and Windows full-screen / Focus Assist state. */
  async notify(kind: keyof Pick<NotificationPrefs, "startup" | "taskCompletion" | "errors" | "security">, title: string, message: string) {
    if (!this.prefs[kind]) return;
    if (inQuietHours(this.prefs.quietHours) && kind !== "security") return;
    for (let i = 0; i < 20; i++) {
      const state = await userNotificationState();
      if (state === 5 || state === 1) break;
      if (i === 19) return; // user stayed busy/full-screen for 10 minutes; skip quietly
      await sleep(30_000);
    }
    toast({ title, message: redact(message).slice(0, 240), appId: "Jarvis.Omega", iconPath: path.join(paths.appDir, "assets", "jarvis.png") }, (m) => log.info(m)).catch((e) => log.warn("toast failed", e));
  }

  // ------------------------------------------------------------------ permissions & codex config
  applyPermissions() {
    this.policy = loadPolicy();
    this.perms = effectivePermissions(this.cloudPerms, this.policy);
    for (const d of this.perms.approvedDirs) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* may be a removable drive */ } }
    const self = process.execPath;
    const mcp: Record<string, McpDef> = {
      jarvis: { command: self, args: [path.join(paths.appDir, "agent.cjs"), "mcp"], env: { JARVIS_DATA_DIR: process.env.JARVIS_DATA_DIR ?? "" }, toolTimeoutSec: 1800 },
    };
    const pwCli = findPlaywrightMcp();
    if (pwCli) mcp.playwright = { command: self, args: [pwCli], toolTimeoutSec: 600 };
    const rea = reaMcpServer(this.policy, this.perms.rea);
    if (rea) mcp.rea = rea;
    writeCodexConfig(paths.codexHome, { perms: this.perms, sandbox: this.policy.codexSandbox, model: this.policy.codexModel, mcp });
    log.info(`Permissions applied: autonomy=${this.perms.autonomy}, dirs=${this.perms.approvedDirs.length}, domains=${this.perms.browserDomains.length || "any"}`);
  }

  async refreshCodexStatus() {
    this.codexBin = this.codexBin ?? resolveCodexBinary([path.resolve(paths.appDir), process.cwd()]);
    this.codex = await codexLoginStatus(this.codexBin, paths.codexHome);
    this.setTray();
  }

  private async refreshLocalState() {
    this.locked = await isWorkstationLocked();
    this.battery = await batteryStatus();
    const m = collectMetrics(this.battery?.onBattery ?? null);
    for (const a of this.monitors.check(m)) this.notify("errors", a.title, a.message);
  }

  private async refreshApps() {
    const apps = await discoverApps();
    if (apps.length) this.memory.replaceApps(apps);
    log.info(`Application catalog: ${apps.length} apps`);
  }

  // ------------------------------------------------------------------ task engine
  private accept(task: DispatchedTask) {
    if (this.running.has(task.id)) return;
    const prior = this.memory.getTask(task.id);
    if (prior) {
      // Already seen (e.g. a re-dispatch after we restarted): never run twice.
      this.report(task.id, { status: "FAILED", error: "This task was already started on this PC; it was not run a second time." });
      return;
    }
    if (this.opts.safeMode) { this.report(task.id, { status: "FAILED", error: "JARVIS on this PC is in safe mode after repeated errors. Restart it from the tray menu." }); return; }
    if (this.running.size >= Math.max(1, this.policy.maxConcurrentTasks)) {
      // Leave it queued on the server; it will be re-dispatched shortly.
      return;
    }
    const run: Running = { task, cancelled: false, status: "QUEUED", waiting: null, events: [], sideEffects: false };
    this.running.set(task.id, run);
    this.memory.taskStart(task.id, task.prompt, task.source);
    this.setTray();
    (task.kind === "control" ? this.runControl(run) : this.runAgentTask(run))
      .catch((e) => { log.error(`task ${task.id} crashed`, e); return this.finish(run, "FAILED", null, e.message); });
  }

  private async report(id: string, update: AgentTaskUpdate) {
    try {
      const c = await this.ensureClient();
      if (!c) throw new Error("not connected");
      if (update.result) update.result = redact(update.result);
      if (update.error) update.error = redact(update.error);
      if (update.events) update.events = update.events.map((e) => ({ type: e.type, data: JSON.parse(redact(JSON.stringify(e.data))) }));
      await c.updateTask(id, update);
    } catch (e: any) {
      if (update.status) this.pendingReports.push({ id, update }); // deliver final states once we reconnect
      log.warn(`report ${id} failed: ${e.message}`);
    }
  }

  private setStatus(run: Running, status: TaskStatus, extra: AgentTaskUpdate = {}) {
    if (run.status === status && !Object.keys(extra).length) return;
    run.status = status;
    this.report(run.task.id, { status, ...extra });
    this.setTray();
  }

  private flushEvents(run: Running) {
    if (!run.events.length) return;
    const events = run.events.splice(0, 50);
    this.report(run.task.id, { events });
  }

  private async finish(run: Running, status: "COMPLETED" | "FAILED" | "CANCELLED", result: string | null, error: string | null) {
    this.flushEvents(run);
    this.running.delete(run.task.id);
    this.memory.taskFinish(run.task.id, status === "COMPLETED" ? "completed" : status === "CANCELLED" ? "cancelled" : "failed", result ?? error);
    await this.report(run.task.id, { status, ...(result ? { result } : {}), ...(error ? { error } : {}) });
    this.setTray();
    if (run.task.kind === "control") return;
    if (status === "COMPLETED") this.notify("taskCompletion", "Task complete", spokenSummary(result ?? "Done."));
    if (status === "FAILED") this.notify("errors", "Task failed", error ?? "Unknown error");
    if (run.task.source === "agent-voice" && this.voice.running()) {
      this.voice.say(status === "COMPLETED" ? spokenSummary(result ?? "Done.") : `I'm afraid that didn't work. ${spokenSummary(error ?? "")}`);
    }
  }

  cancel(id: string, reason: string) {
    const run = this.running.get(id);
    if (!run) { this.report(id, { status: "CANCELLED", error: reason }); return; }
    run.cancelled = true;
    if (run.pid) killTree(run.pid);
    if (run.waiting) { const w = run.waiting; run.waiting = null; w({ approved: false, text: reason }); }
    log.info(`Cancelled ${id}: ${reason}`);
  }

  private async runControl(run: Running) {
    const a = run.task.controlArgs ?? {};
    const act = run.task.controlAction;
    this.setStatus(run, "RUNNING");
    let out: unknown;
    if (act === "memory.list") out = this.memory.list(typeof a.category === "string" ? a.category : undefined);
    else if (act === "memory.add") out = this.memory.add(String(a.category ?? "context"), String(a.content ?? ""));
    else if (act === "memory.delete") out = { deleted: this.memory.delete(Number(a.id)) };
    else if (act === "apps.list") out = this.memory.apps();
    else if (act === "apps.refresh") { await this.refreshApps(); out = { count: this.memory.apps().length }; }
    else if (act === "files.search") out = searchFiles(String(a.query ?? ""), this.perms.approvedDirs);
    else if (act === "files.list") out = this.controlListDir(String(a.path ?? this.perms.workspaceDir));
    else if (act === "files.read") out = this.controlRead(String(a.path ?? ""));
    else if (act === "files.fetch") out = this.controlFetch(String(a.path ?? ""));
    else if (act === "files.put") out = this.controlPut(String(a.dir ?? this.perms.workspaceDir), String(a.name ?? "upload.bin"), String(a.base64 ?? ""));
    else if (act === "files.delete") out = await this.controlDelete(String(a.path ?? ""), a.confirmed === true);
    else if (act === "message.show") out = await this.controlMessage(String(a.title ?? "JARVIS"), String(a.body ?? ""));
    else if (act === "terminal.exec") out = await this.controlTerminal(String(a.command ?? ""), a.cwd ? String(a.cwd) : undefined);
    else if (act === "screen.capture") out = await this.controlScreen();
    else if (act?.startsWith("power.")) out = await this.controlPower(act);
    else if (act === "system.info") out = { ...collectMetrics(this.battery?.onBattery ?? null), battery: this.battery, locked: this.locked, codex: this.codex, provider: this.perms.provider };
    else throw new Error(`Unknown control action ${act}`);
    await this.finish(run, "COMPLETED", JSON.stringify(out), null);
  }

  // ---- control-action implementations (dashboard-initiated; the click is the human's authorisation) ----
  private controlListDir(p: string) {
    const dir = path.resolve(p);
    if (!isPathAllowed(dir, this.perms)) throw new Error("That folder is outside the approved directories");
    return { path: dir, entries: listDir(dir) };
  }
  private controlRead(p: string) {
    const f = path.resolve(p);
    if (!isPathAllowed(f, this.perms)) throw new Error("That file is outside the approved directories");
    return { path: f, ...readTextFile(f) };
  }
  private controlFetch(p: string) {
    const f = path.resolve(p);
    if (!isPathAllowed(f, this.perms)) throw new Error("That file is outside the approved directories");
    return readFileBase64(f);
  }
  private controlPut(dir: string, name: string, base64: string) {
    const d = path.resolve(dir);
    if (!isPathAllowed(d, this.perms)) throw new Error("That folder is outside the approved directories");
    const r = writeFileBase64(d, name, base64);
    return { ...r, message: `Uploaded ${name} (${Math.round(r.size / 1024)} KB) to ${d}` };
  }
  private async controlDelete(p: string, confirmed: boolean) {
    const f = path.resolve(p);
    if (!isPathAllowed(f, this.perms)) throw new Error("That path is outside the approved directories");
    const n = countEntries(f);
    // Deleting a lot is irreversible — require an explicit confirmed flag (the dashboard asks first).
    if (n > 20 && !confirmed) {
      return { needsConfirm: true, count: n, path: f, message: `This would delete ${n} files. Confirm to proceed.` };
    }
    return { ...deletePath(f), message: `Deleted ${f}` };
  }
  private async controlMessage(title: string, body: string) {
    if (!this.perms.messenger) throw new Error("Messenger is disabled on this PC");
    if (this.locked) throw new Error("The screen is locked; the message will not be visible");
    await showMessage(title.slice(0, 80), body.slice(0, 1000));
    return { shown: true };
  }
  private async controlTerminal(command: string, cwd?: string) {
    if (this.perms.terminal === "off") throw new Error("The terminal is disabled on this PC");
    const r = await runTerminal(command, this.perms, { cwd });
    return r;
  }
  private async controlScreen() {
    if (!this.perms.screen) throw new Error("Screen view is disabled on this PC");
    if (this.locked) throw new Error("The screen is locked");
    await screenIndicator();
    const base64 = await captureScreen();
    return { base64, mime: "image/png", capturedAt: Date.now() };
  }
  private async controlPower(act: string) {
    if (!this.perms.power) throw new Error("Power control is disabled on this PC");
    if (act === "power.cancel") return { cancelled: await cancelPower() };
    const action = act.slice("power.".length) as "shutdown" | "restart" | "sleep" | "lock";
    if (action === "shutdown" || action === "restart") {
      await powerAction(action, 60);
      this.notify("security", action === "restart" ? "Restarting" : "Shutting down",
        `This PC will ${action} in 60 seconds. Run "shutdown /a" or use the dashboard to cancel.`);
      return { action, graceSec: 60, message: `${action} scheduled in 60s (cancellable).` };
    }
    await powerAction(action, 0);
    return { action, message: `${action} now.` };
  }

  private async runAgentTask(run: Running) {
    if (this.perms.provider === "claude") return this.runClaudeTask(run);
    const t = run.task;
    if (!this.codexBin || this.codex === "missing") return this.finish(run, "FAILED", null, "Codex is not installed on this PC. Reinstall JARVIS.");
    if (this.codex !== "ready") {
      await this.refreshCodexStatus();
      if ((this.codex as string) !== "ready") return this.finish(run, "FAILED", null, "Codex is not signed in on this PC. Choose “Connect Codex (ChatGPT sign-in)” in the JARVIS tray menu.");
    }
    this.setStatus(run, "PLANNING");
    this.locked = await isWorkstationLocked();
    const overrides: string[] = [`mcp_servers.jarvis.env.JARVIS_TASK_ID=${JSON.stringify(t.id)}`];
    const pwCli = findPlaywrightMcp();
    if (pwCli && this.browser.available()) {
      try {
        const ep = await this.browser.ensure({ headless: this.locked });
        const args = [pwCli, "--cdp-endpoint", ep, "--output-dir", path.join(this.perms.workspaceDir, ".browser-output")];
        if (this.perms.browserDomains.length) args.push("--allowed-origins", this.perms.browserDomains.flatMap((d) => [`https://${d}`, `https://*.${d}`]).join(";"));
        overrides.push(`mcp_servers.playwright.args=[${args.map((x) => JSON.stringify(x)).join(", ")}]`);
      } catch (e: any) {
        run.events.push({ type: "log", data: { message: `Browser unavailable: ${e.message}` } });
      }
    }
    const recent = this.memory.recentTasks(5).map((r) => ({ prompt: r.prompt, summary: r.summary, state: r.state, finishedAt: r.finishedAt }));
    const memories = [...this.memory.list("preference", 15), ...this.memory.search(t.prompt, 8)]
      .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i).map((m) => ({ category: m.category, content: m.content }));
    let resume = t.threadId ?? null;
    let prompt = t.prompt;
    if (!resume && /\b(continue|resume|pick up)\b.*\b(previous|last|my)\b.*\btask\b/i.test(t.prompt)) resume = this.memory.lastThreadId();
    if (t.source === "retry" && resume) prompt = `This is a retry of a task that stopped before finishing. FIRST check what was already done (files, pages, messages) and do NOT repeat any completed step, especially anything irreversible. Then finish the task:\n${t.prompt}`;
    const fullPrompt = buildTaskPrompt(prompt, {
      deviceName: this.cfg.deviceName, otherDevices: [], perms: this.perms, memories, recent, desktopAvailable: !this.locked,
      source: t.source, reaInstructions: this.perms.rea ? REA_INSTRUCTIONS : undefined,
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      const flush = setInterval(() => this.flushEvents(run), 1500);
      const handle = runCodex({
        bin: this.codexBin!, codexHome: paths.codexHome, prompt: fullPrompt, cwd: this.perms.workspaceDir,
        addDirs: this.perms.approvedDirs, sandbox: this.policy.codexSandbox, resumeThreadId: resume, overrides,
        env: { JARVIS_DATA_DIR: process.env.JARVIS_DATA_DIR ?? "" },
        onEvent: (ev) => this.onCodexEvent(run, ev),
        onStderr: (l) => log.debug(`codex: ${l}`),
      });
      run.pid = handle.pid;
      if (handle.pid) { try { os.setPriority(handle.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ } }
      const timeout = setTimeout(() => { run.cancelled = true; (run as any).timedOut = true; if (run.pid) killTree(run.pid); }, this.policy.taskTimeoutMin * 60_000);
      const r = await handle.done;
      clearTimeout(timeout);
      clearInterval(flush);
      run.pid = undefined;
      if (r.threadId) { this.memory.taskCheckpoint(t.id, { threadId: r.threadId }); resume = r.threadId; }
      if (run.cancelled) {
        return (run as any).timedOut
          ? this.finish(run, "FAILED", null, `Timed out after ${this.policy.taskTimeoutMin} minutes.`)
          : this.finish(run, "CANCELLED", null, "Cancelled");
      }
      if (!r.failed && r.code === 0 && r.finalMessage) {
        this.setStatus(run, "VALIDATING");
        return this.finish(run, "COMPLETED", r.finalMessage, null);
      }
      const err = r.failed ?? (r.code !== 0 ? `Codex exited with code ${r.code}` : "Codex finished without a result");
      // Retry once, and only if nothing has been changed yet (no tool calls ran) — never repeat side effects.
      if (attempt === 1 && !run.sideEffects && /network|timeout|timed out|stream|ECONN|429|503|overloaded/i.test(err)) {
        run.events.push({ type: "log", data: { message: `Transient error (${err}); retrying once.` } });
        await sleep(5000);
        continue;
      }
      return this.finish(run, "FAILED", null, /login|auth|401|unauthori/i.test(err) ? `Codex sign-in problem: ${err}. Use “Connect Codex” in the tray.` : err);
    }
  }

  /** Alternative brain: Claude via the Anthropic API, using the jarvis tools (no browser automation in this version). */
  private async runClaudeTask(run: Running) {
    const t = run.task;
    const apiKey = process.env.ANTHROPIC_API_KEY || (await this.vault.forHost("anthropic.com").then((c) => c?.password).catch(() => null));
    if (!apiKey) return this.finish(run, "FAILED", null, "No Anthropic API key. Add one in the JARVIS credential vault (domain anthropic.com, any username) or set ANTHROPIC_API_KEY, or switch this PC's provider back to Codex.");
    this.setStatus(run, "PLANNING");
    this.locked = await isWorkstationLocked();
    const recent = this.memory.recentTasks(5).map((r) => ({ prompt: r.prompt, summary: r.summary, state: r.state, finishedAt: r.finishedAt }));
    const memories = [...this.memory.list("preference", 15), ...this.memory.search(t.prompt, 8)]
      .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i).map((m) => ({ category: m.category, content: m.content }));
    const fullPrompt = buildTaskPrompt(t.prompt, {
      deviceName: this.cfg.deviceName, otherDevices: [], perms: this.perms, memories, recent, desktopAvailable: !this.locked, source: t.source,
    });
    const tools = CLAUDE_TOOLS.map((x) => ({ name: x.name, description: x.description, input_schema: x.inputSchema }));
    const history = t.threadId ? safeParseJson(this.memory.get(`claude_thread:${t.threadId}`)) : [];
    const threadId = t.threadId ?? `cl_${Date.now().toString(36)}`;
    this.report(run.task.id, { threadId });
    this.setStatus(run, "RUNNING");
    const r = await runClaude({
      apiKey, model: this.policy.anthropicModel || "claude-opus-4-8", system: PERSONA, prompt: fullPrompt, history: history ?? [], tools,
      runTool: (name, args) => this.runTool(run.task.id, name, args).then((v) => typeof v === "string" ? v : JSON.stringify(v)),
      onEvent: (ev) => { const { type, ...data } = ev; run.events.push({ type: type as any, data }); this.flushEvents(run); },
      isCancelled: () => run.cancelled,
    });
    this.memory.set(`claude_thread:${threadId}`, JSON.stringify(r.history.slice(-40)));
    if (run.cancelled) return this.finish(run, "CANCELLED", null, "Cancelled");
    if (r.failed) return this.finish(run, "FAILED", null, r.failed);
    this.setStatus(run, "VALIDATING");
    return this.finish(run, "COMPLETED", r.finalMessage ?? "Done.", null);
  }

  private onCodexEvent(run: Running, ev: any) {
    if (ev.type === "thread.started" && ev.thread_id) {
      this.report(run.task.id, { threadId: ev.thread_id });
      return;
    }
    const item = ev.item;
    if (!item) {
      if (ev.type === "turn.failed" || ev.type === "error") run.events.push({ type: "error", data: { message: ev.error?.message ?? ev.message } });
      return;
    }
    const done = ev.type === "item.completed";
    switch (item.type) {
      case "agent_message":
        if (done) run.events.push({ type: "message", data: { text: String(item.text ?? "").slice(0, 2000) } });
        break;
      case "command_execution":
        run.sideEffects = true; this.memory.taskCheckpoint(run.task.id, { sideEffects: true });
        if (run.status === "PLANNING") this.setStatus(run, "RUNNING");
        if (done) run.events.push({ type: "tool", data: { tool: "shell", detail: String(item.command ?? "").slice(0, 300), status: item.status, exit: item.exit_code } });
        break;
      case "mcp_tool_call":
        if (!/^(memory_search|vault_list|list_apps|list_windows|search_files|read_file|system_info|browser_snapshot|browser_take_screenshot)$/.test(item.tool ?? "")) {
          run.sideEffects = true; this.memory.taskCheckpoint(run.task.id, { sideEffects: true });
        }
        if (run.status === "PLANNING") this.setStatus(run, "RUNNING");
        if (done) run.events.push({ type: "tool", data: { tool: `${item.server}.${item.tool}`, status: item.status, detail: summarizeArgs(item.arguments) } });
        break;
      case "file_change":
        run.sideEffects = true; this.memory.taskCheckpoint(run.task.id, { sideEffects: true });
        if (done) run.events.push({ type: "tool", data: { tool: "file_change", detail: (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join(", ").slice(0, 400) } });
        break;
      case "web_search":
        if (run.status === "PLANNING") this.setStatus(run, "RUNNING");
        if (done) run.events.push({ type: "tool", data: { tool: "web_search", detail: item.query } });
        break;
      case "todo_list":
        run.events.push({ type: "log", data: { message: "Plan: " + (item.items ?? []).map((x: any) => `${x.completed ? "✓" : "•"} ${x.text}`).join("  ") } });
        break;
      case "error":
        run.events.push({ type: "error", data: { message: item.message } });
        break;
    }
  }

  // ------------------------------------------------------------------ tools (called by the jarvis MCP server via IPC)
  private async onIpc(method: string, params: any): Promise<unknown> {
    if (method === "ping") return "pong";
    if (method === "status") return {
      version: AGENT_VERSION, paired: !!this.cfg.deviceId, device: this.cfg.deviceName, connected: this.connected, paused: this.paused,
      codex: this.codex, running: [...this.running.values()].map((r) => ({ id: r.task.id, status: r.status })), safeMode: this.opts.safeMode,
    };
    if (method === "reload") { this.cfg = loadConfig(); this.client = null; this.applyPermissions(); this.tray.setPaired(!!this.cfg.deviceId); return "ok"; }
    if (method === "quit") { setTimeout(() => this.shutdown(0), 50); return "bye"; }
    if (method === "tool") return this.runTool(String(params.taskId ?? ""), String(params.name ?? ""), params.args ?? {});
    throw new Error(`Unknown method ${method}`);
  }

  private async runTool(taskId: string, name: string, a: any): Promise<unknown> {
    const run = this.running.get(taskId);
    if (!run) throw new Error("This tool call does not belong to an active JARVIS task");
    if (this.paused || run.cancelled) throw new Error("Automation is paused or the task was cancelled. Stop now.");
    const needConfirm = async (action: string, details: string) => {
      if (this.perms.autonomy !== "confirm-all") return;
      const r = await this.askUser(run, { kind: "confirmation", action, details, risk: "medium" });
      if (!r.approved) throw new Error(`User denied: ${action}`);
    };
    switch (name) {
      case "request_confirmation": {
        const r = await this.askUser(run, { kind: "confirmation", action: String(a.action), details: String(a.details ?? ""), risk: a.risk ?? "high" });
        return r.approved ? `APPROVED${r.text ? ` — note from user: ${r.text}` : ""}` : `DENIED${r.text ? ` — ${r.text}` : ""}. Do not perform this action.`;
      }
      case "ask_user": {
        const r = await this.askUser(run, { kind: "question", action: String(a.question), details: String(a.context ?? "") });
        return r.approved || r.text ? `User answered: ${r.text ?? "(no text)"}` : "The user did not answer.";
      }
      case "vault_list": return (await this.vault.list()).map((c) => `${c.domain} (${c.username})`).join("\n") || "No saved credentials.";
      case "vault_fill_login": {
        if (!Vault.available()) throw new Error("Credential vault is unavailable on this PC");
        const domain = String(a.domain).toLowerCase();
        if (this.perms.browserDomains.length && !this.perms.browserDomains.some((d) => domain === d || domain.endsWith("." + d))) throw new Error(`${domain} is not an allowed browser domain`);
        const r = await this.browser.fillLogin(domain, this.vault, a.username);
        run.sideEffects = true;
        return `Filled ${r.filled.join(" and ")} on ${r.page}. Now click the sign-in / continue button.`;
      }
      case "list_apps": {
        const q = String(a.query ?? "").toLowerCase();
        const apps = this.memory.apps().filter((x) => !q || x.name.toLowerCase().includes(q)).filter((x) => isAppAllowed(x.name, this.perms));
        return apps.slice(0, 80).map((x) => x.name).join("\n") || "No matching applications.";
      }
      case "launch_app": {
        if (this.locked) throw new Error("The desktop is locked; desktop applications cannot be opened right now.");
        const app = this.memory.findApp(String(a.name));
        if (!app) throw new Error(`No installed application matches "${a.name}"`);
        if (!isAppAllowed(app.name, this.perms)) throw new Error(`${app.name} is not in this PC's allowed applications`);
        await needConfirm(`Open ${app.name}`, "Launch an application");
        await launchApp(app.appId);
        run.sideEffects = true;
        return `Opened ${app.name}.`;
      }
      case "list_windows": return JSON.stringify(await listWindows());
      case "focus_window": if (this.locked) throw new Error("Desktop is locked"); return (await focusWindow(Number(a.pid))) ? "Focused." : "Could not focus that window.";
      case "search_files": {
        const r = searchFiles(String(a.query), this.perms.approvedDirs);
        return r.hits.length ? r.hits.map((h) => `${h.path}  (${Math.round(h.size / 1024)} KB, modified ${new Date(h.modified).toLocaleString()})`).join("\n") + (r.truncated ? "\n(more results not shown)" : "") : "No matching files in the approved directories.";
      }
      case "read_file": {
        const p = path.resolve(String(a.path));
        if (!isPathAllowed(p, this.perms)) throw new Error("That file is outside the approved directories");
        const r = readTextFile(p);
        return r.text + (r.truncated ? "\n…(truncated)" : "");
      }
      case "export_report": {
        const dir = a.directory ? path.resolve(String(a.directory)) : path.join(this.perms.workspaceDir, "Reports");
        if (!isPathAllowed(dir, this.perms)) throw new Error("That directory is not approved");
        const r = await exportReport({ title: String(a.title), markdown: String(a.markdown), format: a.format, dir, fileName: a.fileName, htmlToPdf: (h, p) => this.browser.htmlToPdf(h, p) });
        run.sideEffects = true;
        return `Saved and verified: ${r.path} (${Math.round(r.bytes / 1024)} KB)`;
      }
      case "run_command": {
        if (a.name === "?") return this.perms.commands.map((c) => c.name).join(", ") || "No commands are allowlisted on this PC.";
        const cmd = this.perms.commands.find((c) => c.name === a.name);
        if (!cmd) throw new Error(`"${a.name}" is not an allowlisted command on this PC`);
        await needConfirm(`Run ${cmd.name}`, `${cmd.command} ${(cmd.args ?? []).join(" ")}`);
        run.sideEffects = true;
        return await runAllowlisted(cmd, run);
      }
      case "run_terminal": {
        if (this.perms.terminal === "off") throw new Error("The terminal is disabled on this PC (local policy).");
        const r = await runTerminal(String(a.command ?? ""), this.perms, { cwd: a.cwd ? String(a.cwd) : undefined });
        run.sideEffects = true;
        return `[exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}] (cwd ${r.cwd})\n${r.output}`;
      }
      case "send_message": {
        if (!this.perms.messenger) throw new Error("Messenger is disabled on this PC");
        if (this.locked) return "The screen is locked; the message was not shown.";
        await showMessage(String(a.title ?? "JARVIS").slice(0, 80), String(a.body ?? "").slice(0, 1000));
        return "Message shown on the screen.";
      }
      case "power_control": {
        if (!this.perms.power) throw new Error("Power control is disabled on this PC");
        const action = String(a.action ?? "");
        if (!["shutdown", "restart", "sleep", "lock", "cancel"].includes(action)) throw new Error("action must be shutdown, restart, sleep, lock or cancel");
        if (action === "cancel") return (await cancelPower()) ? "Pending shutdown cancelled." : "Nothing to cancel.";
        if (action === "shutdown" || action === "restart") {
          const r = await this.askUser(run, { kind: "confirmation", action: `${action} ${this.cfg.deviceName}`, details: "Unsaved work on that PC could be lost. There is a 60-second cancel window.", risk: "high" });
          if (!r.approved) return "DENIED. Power action not performed.";
          await powerAction(action as any, 60);
          run.sideEffects = true;
          return `${action} scheduled in 60 seconds (cancellable with power_control cancel or shutdown /a).`;
        }
        await powerAction(action as any, 0);
        return `${action} done.`;
      }
      case "screen_capture": {
        if (!this.perms.screen) throw new Error("Screen view is disabled on this PC");
        if (this.locked) throw new Error("The screen is locked");
        await screenIndicator();
        const base64 = await captureScreen();
        const dir = path.join(this.perms.workspaceDir, ".screens");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `shot-${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(base64, "base64"));
        run.sideEffects = true;
        return `Screenshot saved to ${file} (${Math.round(base64.length * 0.75 / 1024)} KB). Read or analyse it from there.`;
      }
      case "delete_path": {
        const p = path.resolve(String(a.path ?? ""));
        if (!isPathAllowed(p, this.perms)) throw new Error("That path is outside the approved directories");
        const n = countEntries(p);
        if (n > 20) {
          const r = await this.askUser(run, { kind: "confirmation", action: `Delete ${n} files under ${p}`, details: "This cannot be undone.", risk: "high" });
          if (!r.approved) return "DENIED. Nothing deleted.";
        }
        const d = deletePath(p);
        run.sideEffects = true;
        return `Deleted ${p} (${d.removed} file${d.removed === 1 ? "" : "s"}).`;
      }
      case "memory_search": return this.memory.search(String(a.query), 10).map((m) => `[${m.category}] ${m.content}`).join("\n") || "Nothing relevant in memory.";
      case "memory_save": { const m = this.memory.add(String(a.category), String(a.content)); return `Remembered (#${m.id}).`; }
      case "system_info": return JSON.stringify({ ...collectMetrics(this.battery?.onBattery ?? null), battery: this.battery, locked: this.locked, device: this.cfg.deviceName });
    }
    throw new Error(`Unknown tool ${name}`);
  }

  /** In SERIOUS mode JARVIS stops asking and just executes — except a small floor of actions that are
   *  irreversible or leave the machine, which always keep one checkpoint. Everything is still logged and
   *  the emergency stop always works. */
  private static SERIOUS_FLOOR = /\b(shut ?down|restart|reboot|format|wipe|erase the disk|pay |payment|purchase|buy |wire|transfer (money|funds)|send money|uninstall windows|factory reset|delete \d{3,}|bitlocker|disable (firewall|defender|antivirus))\b/i;

  private askUser(run: Running, p: { kind: "confirmation" | "question"; action: string; details: string; risk?: "low" | "medium" | "high" }) {
    if (this.perms.autonomy === "serious" && p.kind === "confirmation" && !Agent.SERIOUS_FLOOR.test(p.action)) {
      run.events.push({ type: "log", data: { message: `⚡ SERIOUS MODE — proceeding without asking: ${p.action}` } });
      return Promise.resolve({ approved: true, text: "auto-approved (serious mode)" });
    }
    return new Promise<{ approved: boolean; text: string | null }>((resolve) => {
      const prev = run.status;
      run.waiting = (r) => { clearTimeout(t); this.setStatus(run, prev === "WAITING_FOR_INPUT" ? "RUNNING" : prev); resolve(r); };
      const t = setTimeout(() => { if (run.waiting) { const w = run.waiting; run.waiting = null; w({ approved: false, text: "No answer within 15 minutes" }); } }, 15 * 60_000);
      this.flushEvents(run);
      this.setStatus(run, "WAITING_FOR_INPUT", { pendingInput: { kind: p.kind, action: p.action, details: p.details, risk: p.risk } });
      this.notify("security", p.kind === "question" ? "JARVIS has a question" : "Approval needed", p.action);
      if (run.task.source === "agent-voice" && this.voice.running()) this.voice.say(`I need your approval to ${p.action}. Please check the dashboard.`);
    });
  }

  // ------------------------------------------------------------------ pairing / tray
  async forgetPairing(message: string) {
    clearDeviceSecret();
    this.client = null;
    this.cfg = { ...this.cfg, deviceId: null };
    saveConfig(this.cfg);
    this.connected = false;
    this.tray.setPaired(false);
    this.setTray();
    this.notify("security", "Device disconnected", message);
  }

  startVoice() {
    if (!VoiceEngine.supported()) return;
    if (!this.voice.listenerCount("event")) {
      this.voice.on("event", async (ev) => {
        if (ev.type === "ready") log.info(`Voice ready (${ev.recognizer}, ${ev.voice})`);
        if (ev.type === "error") log.warn(`voice: ${ev.message}`);
        if (ev.type === "command" && ev.text?.trim()) {
          if (ev.confidence < 0.35) return this.voice.say("Sorry, I didn't catch that.");
          const c = await this.ensureClient();
          if (!c || !this.connected) return this.voice.say("I can't reach the control plane at the moment.");
          try {
            const r = await c.command(ev.text);
            this.voice.say(r.routedTo.length > 1 ? `On it, across ${r.routedTo.length} computers.` : r.routedTo[0] === this.cfg.deviceName ? "On it." : `Sending that to ${r.routedTo[0]}.`);
          } catch (e: any) { this.voice.say(e.message); }
        }
      });
    }
    try { this.voice.start(); this.tray.setVoice(true); } catch (e: any) { log.warn(`voice unavailable: ${e.message}`); }
  }

  private async onTray(a: TrayAction) {
    const dash = this.cfg.dashboardUrl ?? this.cfg.apiUrl;
    switch (a) {
      case "open": if (dash) openUrl(dash); break;
      case "devices": if (dash) openUrl(dash + "/#/devices"); break;
      case "tasks": if (dash) openUrl(dash + "/#/tasks"); break;
      case "voice": if (this.voice.running()) { this.voice.stop(); this.tray.setVoice(false); } else this.startVoice(); break;
      case "pause":
        this.paused = true; this.tray.setPaused(true);
        for (const id of [...this.running.keys()]) this.cancel(id, "Paused locally from the tray");
        this.setTray(); break;
      case "resume": this.paused = false; this.tray.setPaused(false); this.setTray(); break;
      case "startup": {
        const on = (await startupStatus()) !== "enabled";
        await setStartupEnabled(on).catch((e) => log.warn("startup toggle failed", e));
        this.tray.setStartup((await startupStatus()) === "enabled"); break;
      }
      case "vault": if (this.localUiUrl) openUrl(this.localUiUrl + "#vault"); break;
      case "pair": if (this.localUiUrl) openUrl(this.localUiUrl + "#pair"); break;
      case "codex":
        if (!this.codexBin) { this.notify("errors", "Codex missing", "Reinstall JARVIS to restore Codex."); break; }
        codexLogin(this.codexBin, paths.codexHome).then(() => this.refreshCodexStatus()).catch((e) => log.warn("codex login failed", e));
        break;
      case "logs": openUrl(paths.logs); break;
      case "update": if (this.update) installUpdate(this.update, (m) => this.notify("errors", "Update", m)); break;
      case "disconnect":
        try { await (await this.ensureClient())?.unpair(); } catch (e) { log.warn("unpair call failed", e); }
        await this.forgetPairing("This PC is no longer connected to your JARVIS account. Pair it again from the tray menu.");
        break;
      case "exit": await this.shutdown(0); break;
    }
  }
}

// ------------------------------------------------------------------ helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  const pick = o.url ?? o.domain ?? o.name ?? o.query ?? o.title ?? o.element ?? o.path ?? o.action ?? "";
  return String(pick).slice(0, 200);
}

function findPlaywrightMcp(): string | null {
  const roots = [paths.appDir, path.resolve(paths.appDir, ".."), process.cwd()];
  for (const r of roots) {
    const p = path.join(r, "node_modules", "@playwright", "mcp", "cli.js");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function openUrl(url: string) {
  if (IS_WIN) spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}

function runAllowlisted(cmd: LocalPolicy["commands"][number], run: Running): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd.command, cmd.args ?? [], { cwd: cmd.cwd, windowsHide: true, shell: false });
    run.pid = p.pid;
    let out = "";
    const cap = (d: Buffer) => { out = (out + d.toString()).slice(-20000); };
    p.stdout.on("data", cap); p.stderr.on("data", cap);
    const t = setTimeout(() => { if (p.pid) killTree(p.pid); }, (cmd.timeoutSec ?? 900) * 1000);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); run.pid = undefined; resolve(`Exit code ${code}\n${out.slice(-8000)}`); });
  });
}

/** Download the installer, verify its SHA-256 against the control plane's value, then run it. */
async function installUpdate(u: NonNullable<AgentSyncResponse["update"]>, say: (m: string) => void) {
  try {
    const res = await fetch(u.url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = (await import("node:crypto")).createHash("sha256").update(buf).digest("hex");
    if (hash.toLowerCase() !== u.sha256.toLowerCase()) throw new Error("checksum mismatch — update rejected");
    const file = path.join(os.tmpdir(), `JARVIS-Setup-${u.version}.exe`);
    fs.writeFileSync(file, buf);
    spawn(file, ["/SILENT", "/NORESTART"], { detached: true, stdio: "ignore" }).unref();
  } catch (e: any) {
    say(`Update failed: ${e.message}`);
  }
}

export { PERSONA };
