// End-to-end: real agent bundle (dist/app/agent.cjs) + real control plane + fake Codex.
// Prereqs: `npm run dev:cloud` running and `npm run build:agent`.  Usage: node tests/e2e/agent-e2e.mjs [--api URL]
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "http://localhost:8787";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-e2e-"));
const fakeCodex = path.join(root, "tests/e2e/fake-codex.mjs");
fs.chmodSync(fakeCodex, 0o755);
const env = { ...process.env, JARVIS_DATA_DIR: dataDir, JARVIS_DEV: "1", JARVIS_DISABLE_BROWSER: "1", JARVIS_CODEX_BIN: fakeCodex, JARVIS_APP_DIR: path.join(root, "dist/app") };
const agentJs = path.join(root, "dist/app/agent.cjs");
const cli = (...a) => execFileSync(process.execPath, [agentJs, ...a], { env, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token, passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); cleanup(); process.exit(1); } };
const api = async (method, p, body) => {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const waitTask = async (id, pred, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const d = await api("GET", `/api/tasks/${id}`); if (pred(d.data.task)) return d.data; await sleep(500); }
  const d = await api("GET", `/api/tasks/${id}`);
  throw new Error(`timeout; task is ${d.data.task.status} ${d.data.task.error ?? ""}`);
};
let sup;
const startAgent = () => { sup = spawn(process.execPath, [agentJs, "--background"], { env, stdio: "ignore", detached: true }); };
const cleanup = () => { try { process.kill(-sup.pid, "SIGKILL"); } catch {} try { execFileSync("pkill", ["-f", `JARVIS_DATA_DIR=${dataDir}`]); } catch {} };
const workerPid = () => {
  const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes(agentJs) && l.includes("--worker"));
  return line ? Number(line.trim().split(/\s+/)[0]) : null;
};

console.log(`Agent end-to-end → ${API}  (data: ${dataDir})`);
const user = `e2e${Date.now().toString(36)}`;
token = (await api("POST", "/api/auth/register", { username: user, password: "Omega-Prime-2026!" })).data.token;

await step("CLI init + pair with a one-time code", async () => {
  cli("init", "--workspace", path.join(dataDir, "workspace"), "--browser", "chrome", "--voice", "false");
  const code = (await api("POST", "/api/devices/pairing-code")).data.code;
  assert.match(cli("pair", "--url", API, "--code", code, "--name", "E2E-PC"), /Paired as E2E-PC/);
  assert.ok(fs.existsSync(path.join(dataDir, "device.secret")));
  assert.ok(!fs.readFileSync(path.join(dataDir, "config.json"), "utf8").includes("secret"), "secret not stored in config");
});
await step("supervisor starts, agent connects and reports metrics", async () => {
  startAgent();
  const end = Date.now() + 20000;
  let d;
  while (Date.now() < end) { d = (await api("GET", "/api/devices")).data.devices[0]; if (d?.online && d.capabilities) break; await sleep(500); }
  assert.ok(d.online, "device online"); assert.equal(d.capabilities.codex, "ready"); assert.ok(d.metrics.memTotalBytes > 0);
});
await step("single-instance: a second launch exits immediately", async () => {
  const p = spawn(process.execPath, [agentJs, "--background"], { env, stdio: "ignore" });
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 0);
});
await step("agent task: Codex uses jarvis tools via MCP → IPC; report saved and verified", async () => {
  const t = (await api("POST", "/api/tasks", { prompt: "Research AI and save a report" })).data.task;
  const d = await waitTask(t.id, (x) => ["COMPLETED", "FAILED"].includes(x.status));
  assert.equal(d.task.status, "COMPLETED", d.task.error);
  assert.match(d.task.result, /Saved and verified: .*AI developments\.md/);
  assert.match(d.task.result, /Tools available: 20/);
  assert.ok(fs.existsSync(path.join(dataDir, "workspace", "Reports", "AI developments.md")));
  assert.ok(d.task.threadId, "thread id recorded for safe retry/resume");
  const evs = (await api("GET", `/api/tasks/${t.id}`)).data.events.map((e) => e.data.tool).filter(Boolean);
  assert.ok(evs.includes("jarvis.export_report"), "tool trace reported");
});
await step("memory is local and readable from the dashboard via control task", async () => {
  const t = (await api("POST", "/api/tasks", { prompt: "memory.list", kind: "control", controlAction: "memory.list" })).data.task;
  const d = await waitTask(t.id, (x) => x.status === "COMPLETED");
  assert.match(d.task.result, /Markdown in the workspace/);
});
await step("high-risk action waits for approval; approve resumes the task", async () => {
  const t = (await api("POST", "/api/tasks", { prompt: "Renew my domain (needs confirm)" })).data.task;
  const w = await waitTask(t.id, (x) => x.status === "WAITING_FOR_INPUT");
  assert.match(w.task.pendingInput.action, /Pay \$18\.99/);
  await api("POST", `/api/tasks/${t.id}/respond`, { approved: true, text: "ok" });
  const d = await waitTask(t.id, (x) => x.status === "COMPLETED");
  assert.match(d.task.result, /approved by you/);
});
await step("denial is respected", async () => {
  const t = (await api("POST", "/api/tasks", { prompt: "Renew again (needs confirm)" })).data.task;
  await waitTask(t.id, (x) => x.status === "WAITING_FOR_INPUT");
  await api("POST", `/api/tasks/${t.id}/respond`, { approved: false, text: "no" });
  const d = await waitTask(t.id, (x) => x.status === "COMPLETED");
  assert.match(d.task.result, /Stopped: DENIED/);
});
await step("cancel kills the running Codex process", async () => {
  const t = (await api("POST", "/api/tasks", { prompt: "sleep forever" })).data.task;
  await waitTask(t.id, (x) => x.status === "RUNNING");
  await api("POST", `/api/tasks/${t.id}/cancel`);
  const d = await waitTask(t.id, (x) => x.status === "CANCELLED");
  assert.equal(d.task.status, "CANCELLED");
});
await step("crash mid-task: supervisor restarts the agent; task is NOT re-run, reported as interrupted", async () => {
  const t = (await api("POST", "/api/tasks", { prompt: "sleep forever (crash test)" })).data.task;
  await waitTask(t.id, (x) => x.status === "RUNNING");
  const pid = workerPid(); assert.ok(pid, "worker pid");
  process.kill(pid, "SIGKILL");
  const d = await waitTask(t.id, (x) => x.status === "FAILED", 40000);
  assert.match(d.task.error, /NOT repeated automatically|not run a second time|restarted/);
  const dev = (await api("GET", "/api/devices")).data.devices[0];
  assert.ok(dev.online, "agent came back online");
});
await step("emergency stop pauses the agent", async () => {
  await api("POST", "/api/emergency-stop");
  await sleep(3000);
  const st = JSON.parse(cli("status"));
  assert.equal(st.paused, true);
  await api("POST", "/api/resume-automation");
});
await step("revoking the device makes the agent forget its pairing", async () => {
  const dev = (await api("GET", "/api/devices")).data.devices[0];
  await api("DELETE", `/api/devices/${dev.id}`);
  const end = Date.now() + 30000;
  while (Date.now() < end && fs.existsSync(path.join(dataDir, "device.secret"))) await sleep(500);
  assert.ok(!fs.existsSync(path.join(dataDir, "device.secret")), "secret wiped");
  assert.equal(JSON.parse(cli("status")).paired, false);
});
await step("stop command shuts the agent down cleanly", async () => {
  cli("stop");
  await sleep(1500);
  assert.equal(workerPid(), null);
});
cleanup();
console.log(`\n${passed} agent checks passed.`);
