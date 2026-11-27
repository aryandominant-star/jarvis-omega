// Integration tests against a running control plane (`npm run dev:cloud`).
// Usage: node tests/integration/run.mjs [--api http://localhost:8787] [--keep-alive]
// --keep-alive leaves three simulated PCs connected (useful for dashboard demos).
import crypto from "node:crypto";
import assert from "node:assert/strict";

const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "http://localhost:8787";
const KEEP = process.argv.includes("--keep-alive");
let passed = 0;
const step = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; throw e; }
};

async function http(method, path, { body, token, headers = {}, raw } = {}) {
  const res = await fetch(API + path, {
    method, body: raw ?? (body ? JSON.stringify(body) : undefined),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

class SimAgent {
  constructor(name, deviceId, secret) { Object.assign(this, { name, deviceId, secret, last: 0, lastReq: 0 }); }
  sign(method, path, text, ts) {
    const h = crypto.createHash("sha256").update(text).digest("hex");
    return crypto.createHmac("sha256", this.secret).update(`${method}\n${path}\n${ts}\n${h}`).digest("hex");
  }
  async call(path, body, channel = "req", tsOverride, sigOverride) {
    const text = JSON.stringify(body ?? {});
    const key = channel === "sync" ? "last" : "lastReq";
    const ts = tsOverride ?? (this[key] = Math.max(Date.now(), this[key] + 1));
    return http("POST", path, { raw: text, headers: {
      "x-jarvis-device": this.deviceId, "x-jarvis-timestamp": String(ts), "x-jarvis-signature": sigOverride ?? this.sign("POST", path, text, ts),
    } });
  }
  metrics(cpu, memFrac, diskFrac) {
    const tot = 32e9, disk = 1e12;
    return { cpuPercent: cpu, memTotalBytes: tot, memUsedBytes: tot * memFrac, disks: [{ mount: "C:\\", totalBytes: disk, usedBytes: disk * diskFrac }], uptimeSec: 3600 * 7, onBattery: false };
  }
  sync(extra = {}) {
    return this.call("/api/agent/sync", { agentVersion: "1.0.0", activeTaskIds: [], sessionActive: true,
      capabilities: { browser: true, codex: "ready", voice: true, desktop: true, vault: true, rea: false }, ...extra }, "sync");
  }
  update(taskId, upd) { return this.call(`/api/agent/tasks/${taskId}/update`, upd); }
}

console.log(`J.A.R.V.I.S. control-plane integration tests → ${API}`);
const user = `pilot${Date.now().toString(36)}`;
const pw = "Omega-Prime-2026!";
let token;
const agents = {};

await step("health endpoint is public", async () => {
  const r = await http("GET", "/api/health");
  assert.equal(r.status, 200); assert.equal(r.data.ok, true);
});
await step("protected endpoints reject anonymous requests", async () => {
  for (const p of ["/api/devices", "/api/tasks", "/api/auth/me", "/api/audit", "/api/workflows"]) {
    assert.equal((await http("GET", p)).status, 401, p);
  }
  assert.equal((await http("GET", "/api/devices", { token: "x".repeat(43) })).status, 401);
});
await step("registration enforces username and password rules", async () => {
  assert.equal((await http("POST", "/api/auth/register", { body: { username: "a", password: pw } })).status, 400);
  assert.equal((await http("POST", "/api/auth/register", { body: { username: user, password: "short" } })).status, 400);
  assert.equal((await http("POST", "/api/auth/register", { body: { username: user, password: "alllowercaseletters" } })).status, 400);
});
await step("user can register with username + password and gets a session", async () => {
  const r = await http("POST", "/api/auth/register", { body: { username: user, password: pw } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.token);
  token = r.data.token;
  const me = await http("GET", "/api/auth/me", { token });
  assert.equal(me.data.user.username, user);
});
await step("duplicate usernames are rejected (case-insensitive)", async () => {
  assert.equal((await http("POST", "/api/auth/register", { body: { username: user.toUpperCase(), password: pw } })).status, 409);
  assert.equal((await http("POST", "/api/auth/register", { body: { username: user, password: pw } })).status, 409);
});
await step("wrong password fails, correct password signs in", async () => {
  assert.equal((await http("POST", "/api/auth/login", { body: { username: user, password: "Wrong-Password-1" } })).status, 401);
  assert.equal((await http("POST", "/api/auth/login", { body: { username: "nobody-here", password: pw } })).status, 401);
  const r = await http("POST", "/api/auth/login", { body: { username: user, password: pw } });
  assert.equal(r.status, 200); token = r.data.token;
});
await step("a second account cannot see the first account's data", async () => {
  const other = await http("POST", "/api/auth/register", { body: { username: user + "b", password: pw } });
  const d = await http("GET", "/api/devices", { token: other.data.token });
  assert.equal(d.data.devices.length, 0);
});

for (const [name, os] of [["MAIN-PC", "Windows 11 Pro 24H2"], ["HOME-LAPTOP", "Windows 11 Home 24H2"], ["WORKSTATION", "Windows 11 Pro for Workstations"]]) {
  await step(`pair ${name} with a one-time code`, async () => {
    const c = await http("POST", "/api/devices/pairing-code", { token });
    assert.match(c.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const p = await http("POST", "/api/agent/pair", { body: { code: c.data.code, name, os, agentVersion: "1.0.0" } });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    agents[name] = new SimAgent(name, p.data.deviceId, p.data.deviceSecret);
    const again = await http("POST", "/api/agent/pair", { body: { code: c.data.code, name: "EVIL", os } });
    assert.equal(again.status, 403, "pairing code must be single-use");
  });
}
const A = agents["MAIN-PC"], L = agents["HOME-LAPTOP"], W = agents["WORKSTATION"];

await step("signed heartbeat brings devices online with metrics", async () => {
  assert.equal((await A.sync({ metrics: A.metrics(23, 0.48, 0.61) })).status, 200);
  assert.equal((await L.sync({ metrics: L.metrics(9, 0.37, 0.42) })).status, 200);
  assert.equal((await W.sync({ metrics: W.metrics(67, 0.71, 0.93) })).status, 200);
  const d = await http("GET", "/api/devices", { token });
  assert.equal(d.data.devices.filter((x) => x.online).length, 3);
});
await step("bad signatures, replays and stale timestamps are rejected", async () => {
  const ts = A.last; // accepted by the server in the previous step
  assert.equal((await A.call("/api/agent/sync", { activeTaskIds: [] }, "sync", undefined, "0".repeat(64))).status, 401);
  assert.equal((await A.call("/api/agent/sync", { activeTaskIds: [] }, "sync", ts)).status, 401, "replay");
  assert.equal((await A.call("/api/agent/sync", { activeTaskIds: [] }, "sync", Date.now() - 10 * 60e3)).status, 401, "skew");
});
await step("natural-language routing picks the right computer", async () => {
  const r = await http("POST", "/api/tasks", { token, body: { prompt: "Open Chrome on my laptop" } });
  assert.deepEqual(r.data.routedTo, ["HOME-LAPTOP"]);
  const r2 = await http("POST", "/api/tasks", { token, body: { prompt: "Run the build tests on my workstation" } });
  assert.deepEqual(r2.data.routedTo, ["WORKSTATION"]);
});
await step("'all connected computers' fans out into a group task", async () => {
  const r = await http("POST", "/api/tasks", { token, body: { prompt: "Check disk space on all connected computers" } });
  assert.equal(r.data.routedTo.length, 3); assert.equal(r.data.task.kind, "group");
});

let laptopTask;
await step("agent receives tasks and walks the state machine", async () => {
  const s = await L.sync({ wait: false });
  const t = s.data.tasks.find((x) => x.prompt.includes("Chrome"));
  assert.ok(t, "laptop got its task");
  laptopTask = t.id;
  assert.equal((await L.update(t.id, { status: "PLANNING", threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53" })).status, 200);
  assert.equal((await L.update(t.id, { status: "RUNNING", events: [{ type: "tool", data: { tool: "jarvis.launch_app", detail: "Google Chrome", status: "completed" } }] })).status, 200);
  assert.equal((await L.update(t.id, { status: "QUEUED" })).status, 409, "illegal transition rejected");
  assert.equal((await L.update(t.id, { status: "VALIDATING" })).status, 200);
  assert.equal((await L.update(t.id, { status: "COMPLETED", result: "Chrome is open on HOME-LAPTOP." })).status, 200);
  const d = await http("GET", `/api/tasks/${t.id}`, { token });
  assert.equal(d.data.task.status, "COMPLETED"); assert.ok(d.data.events.length >= 4);
});
await step("a device cannot update another device's task", async () => {
  assert.equal((await A.update(laptopTask, { status: "FAILED" })).status, 404);
});
await step("high-risk action waits for the user's approval", async () => {
  const r = await http("POST", "/api/tasks", { token, body: { prompt: "Renew my domain on the registrar", deviceId: A.deviceId } });
  const s = await A.sync({ wait: false });
  const t = s.data.tasks.find((x) => x.id === r.data.task.id);
  await A.update(t.id, { status: "RUNNING" });
  await A.update(t.id, { status: "WAITING_FOR_INPUT", pendingInput: { kind: "confirmation", action: "Pay $18.99 to renew example.dev", details: "Card ending 4242 on the registrar checkout page", risk: "high" } });
  const resp = await http("POST", `/api/tasks/${t.id}/respond`, { token, body: { approved: false, text: "not now" } });
  assert.equal(resp.status, 200);
  const s2 = await A.sync({ wait: false, activeTaskIds: [t.id] });
  assert.deepEqual(s2.data.inputResponses.map((x) => [x.taskId, x.approved]), [[t.id, false]]);
  await A.update(t.id, { status: "CANCELLED", error: "User declined the payment" });
});
await step("cancel reaches the device; emergency stop pauses everything", async () => {
  const r = await http("POST", "/api/tasks", { token, body: { prompt: "Index my project folder", deviceId: W.deviceId } });
  const s = await W.sync({ wait: false });
  const id = s.data.tasks.find((x) => x.id === r.data.task.id).id;
  await W.update(id, { status: "RUNNING" });
  await http("POST", `/api/tasks/${id}/cancel`, { token });
  const s2 = await W.sync({ wait: false, activeTaskIds: [id] });
  assert.ok(s2.data.cancelTaskIds.includes(id));
  await W.update(id, { status: "CANCELLED" });
  await http("POST", "/api/emergency-stop", { token });
  assert.equal((await http("POST", "/api/tasks", { token, body: { prompt: "anything" } })).status, 423);
  assert.equal((await W.sync({ wait: false })).data.paused, true);
  await http("POST", "/api/resume-automation", { token });
});
await step("long-poll returns early when work arrives", async () => {
  const t0 = Date.now();
  const pending = A.sync({ wait: true });
  await new Promise((r) => setTimeout(r, 2500));
  await http("POST", "/api/tasks", { token, body: { prompt: "Tell me which of my computers are online", deviceId: A.deviceId } });
  const s = await pending;
  assert.ok(s.data.tasks.length >= 1, "task delivered via long poll");
  assert.ok(Date.now() - t0 < 15000, "returned before the 20s window");
  for (const t of s.data.tasks) { await A.update(t.id, { status: "RUNNING" }); await A.update(t.id, { status: "COMPLETED", result: "MAIN-PC, HOME-LAPTOP and WORKSTATION are online." }); }
});
await step("workflows validate cron + timezone", async () => {
  assert.equal((await http("POST", "/api/workflows", { token, body: { name: "x", prompt: "y", schedule: "61 * * * *" } })).status, 400);
  assert.equal((await http("POST", "/api/workflows", { token, body: { name: "x", prompt: "y", schedule: "0 8 * * *", timezone: "Mars/Olympus" } })).status, 400);
  const ok = await http("POST", "/api/workflows", { token, body: { name: "Morning project check", prompt: "Check my project dashboard and summarise overnight changes.", schedule: "0 8 * * 1-5", timezone: "Asia/Kolkata" } });
  assert.equal(ok.status, 200);
  await http("POST", "/api/workflows", { token, body: { name: "Low disk watch", prompt: "Notify me if any computer has less than 10% free disk.", schedule: "0 * * * *", timezone: "Asia/Kolkata" } });
});
await step("revoked devices are locked out immediately", async () => {
  const c = await http("POST", "/api/devices/pairing-code", { token });
  const p = await http("POST", "/api/agent/pair", { body: { code: c.data.code, name: "OLD-TABLET", os: "Windows 10" } });
  const tmp = new SimAgent("OLD-TABLET", p.data.deviceId, p.data.deviceSecret);
  assert.equal((await tmp.sync()).status, 200);
  assert.equal((await http("DELETE", `/api/devices/${tmp.deviceId}`, { token })).status, 200);
  const r = await tmp.sync();
  assert.equal(r.status, 403); assert.equal(r.data.code, "revoked");
});
await step("audit log records security events", async () => {
  const a = await http("GET", "/api/audit", { token });
  const actions = new Set(a.data.logs.map((l) => l.action));
  for (const x of ["account.registered", "auth.login", "auth.login_failed", "device.paired", "device.revoked", "automation.emergency_stop", "task.action_denied"]) assert.ok(actions.has(x), x);
});

console.log(`\n${passed} checks passed.`);

if (KEEP) {
  // Demo state: some live work in progress so the dashboard shows real data.
  await http("PATCH", "/api/settings", { token, body: { defaultDeviceId: A.deviceId } });
  const research = await http("POST", "/api/tasks", { token, body: { prompt: "Research the newest developments in artificial intelligence, prepare a cited report and save it to my Documents", deviceId: A.deviceId } });
  const grp = (await http("GET", "/api/tasks?limit=50", { token })).data.tasks.find((t) => t.kind === "group");
  const sA = await A.sync({ wait: false });
  for (const t of sA.data.tasks) {
    await A.update(t.id, { status: "PLANNING" });
    if (t.id === research.data.task.id) {
      await A.update(t.id, { status: "RUNNING", events: [
        { type: "tool", data: { tool: "web_search", detail: "latest AI research announcements November 2026" } },
        { type: "tool", data: { tool: "playwright.browser_navigate", detail: "arxiv.org/list/cs.AI/recent" } },
      ] });
    } else {
      await A.update(t.id, { status: "RUNNING" });
      await A.update(t.id, { status: "COMPLETED", result: "C:\\ has 390 GB free (39%)." });
    }
  }
  for (const ag of [L, W]) {
    const s = await ag.sync({ wait: false });
    for (const t of s.data.tasks) {
      await ag.update(t.id, { status: "RUNNING" });
      await ag.update(t.id, { status: "COMPLETED", result: ag === W ? "C:\\ has only 70 GB free (7%) — below your 10% threshold." : "C:\\ has 580 GB free (58%)." });
    }
  }
  const pay = await http("POST", "/api/tasks", { token, body: { prompt: "Open my GitHub account and check the latest issues on jarvis-omega", deviceId: W.deviceId } });
  const sW = await W.sync({ wait: false });
  for (const t of sW.data.tasks) {
    await W.update(t.id, { status: "RUNNING", events: [{ type: "tool", data: { tool: "jarvis.vault_fill_login", detail: "github.com", status: "completed" } }] });
    await W.update(t.id, { status: "WAITING_FOR_INPUT", pendingInput: { kind: "confirmation", action: "Close 3 duplicate issues on jarvis-omega", details: "#41, #44 and #47 duplicate #39. Closing changes the public repository.", risk: "medium" } });
  }
  console.log(`\nDemo account: ${user} / ${pw}`);
  console.log(`DEMO_TOKEN=${token}`);
  const cpu = { A: 23, L: 9, W: 67 };
  const busy = new Set([research.data.task.id, pay.data.task.id]);
  setInterval(async () => {
    for (const [k, ag] of Object.entries({ A, L, W })) {
      cpu[k] = Math.max(3, Math.min(97, cpu[k] + (Math.random() - 0.5) * 12));
      await ag.sync({ wait: false, activeTaskIds: [...busy], metrics: ag.metrics(cpu[k], k === "W" ? 0.71 : k === "A" ? 0.52 : 0.37, k === "W" ? 0.93 : k === "A" ? 0.61 : 0.42) }).catch(() => {});
    }
  }, 4000);
  // Keep in-progress tasks fresh so the server's lost-task backstop doesn't fail them.
  setInterval(() => A.update(research.data.task.id, { events: [{ type: "log", data: { message: "reading sources…" } }] }).catch(() => {}), 60000);
  void grp;
}
