import { DEFAULT_PERMISSIONS, isTerminal } from "../../../packages/shared-types/src/index";
import { agentCommand, createPairingCode, pairDevice, sync, taskUpdate, unpairSelf } from "./agent";
import { changePassword, login, logout, register, requireUser, updateSettings, type AuthedUser } from "./auth";
import { cronMatches, isValidTimeZone, parseCron, zonedParts } from "./cron";
import { audit, clientIp, HttpError, json, now, randomId, readJson, safeParse, type Env } from "./lib";
import { addEvent, cancelTask, createTask, listDevices, refreshGroup, rowToTask, sanitizePermissions } from "./store";
import { ASSETS } from "./static";

const decodeB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Serve the embedded dashboard SPA for any non-API GET. Hash routing means unknown paths get index.html. */
const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>J.A.R.V.I.S. OMEGA — Control Plane</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 600px at 50% 40%,#0a1626,#03060d);color:#dcf6ff;font-family:Segoe UI,system-ui,sans-serif}.b{text-align:center;padding:40px}.c{width:70px;height:70px;border:3px solid #00e5ff;border-radius:50%;margin:0 auto 24px;box-shadow:0 0 30px #00e5ff8c,inset 0 0 20px #00e5ff66;position:relative}.c::after{content:"";position:absolute;inset:20px;border-radius:50%;background:#00e5ff;box-shadow:0 0 18px #00e5ff}h1{letter-spacing:.34em;font-weight:700;margin:0 0 6px}p{color:#7d98aa}code{color:#7df3ff;background:#0a1626;padding:2px 7px;border-radius:5px;font-size:13px}</style></head><body><div class="b"><div class="c"></div><h1>J.A.R.V.I.S. OMEGA</h1><p>Control plane online · <code>/api/health</code></p><p style="font-size:13px">Open the dashboard app to sign in.</p></div></body></html>`;

/** Dashboard hosted elsewhere (e.g. GitHub Pages): proxy it so it is served from this Worker's origin. */
async function proxyDashboard(origin: string, pathname: string, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const target = origin.replace(/\/$/, "") + (pathname === "/" ? "/index.html" : pathname);
  const key = new Request(target);
  const hit = await cache.match(key);
  if (hit) return hit;
  let res = await fetch(target, { cf: { cacheTtl: 300 } } as RequestInit);
  if (res.status === 404 && !/\.[a-z0-9]+$/i.test(pathname)) res = await fetch(origin.replace(/\/$/, "") + "/index.html");
  const isIndex = !/\/assets\//.test(pathname);
  // Raw file hosts send text/plain; derive the real type from the extension.
  const ext = (/\.([a-z0-9]+)$/i.exec(res.url || target)?.[1] ?? "html").toLowerCase();
  const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp", ico: "image/x-icon", json: "application/json", woff2: "font/woff2" };
  const out = new Response(res.body, { status: res.status, headers: {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  } });
  if (res.ok && !isIndex) ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

function serveStatic(pathname: string): Response {
  if (!ASSETS["/index.html"]) {
    // API-only deployment (dashboard hosted separately): show a status landing page.
    return new Response(LANDING, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  const key = pathname === "/" ? "/index.html" : pathname;
  const asset = ASSETS[key] ?? ASSETS["/index.html"];
  const isIndex = asset === ASSETS["/index.html"];
  return new Response(decodeB64(asset.b64), {
    status: 200,
    headers: {
      "content-type": asset.ct,
      // Hashed asset filenames are immutable; index.html must always revalidate.
      "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

const CONTROL_ACTIONS = new Set(["memory.list", "memory.add", "memory.delete", "apps.list", "apps.refresh", "files.search", "system.info"]);

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // "*" reflects any origin. Safe here because auth uses Authorization: Bearer tokens, never cookies,
  // so cross-site requests cannot ride a user's ambient credentials.
  const ok = origin && (allowed.includes("*") || allowed.includes(origin));
  if (!origin || !ok) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "strict-transport-security": "max-age=31536000",
};

type Handler = (req: Request, env: Env, ctx: ExecutionContext, params: Record<string, string>) => Promise<unknown>;
type UserHandler = (req: Request, env: Env, user: AuthedUser, params: Record<string, string>, ctx: ExecutionContext) => Promise<unknown>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, keys, handler });
}
const authed = (h: UserHandler): Handler => async (req, env, ctx, params) => h(req, env, await requireUser(req, env), params, ctx);

// ---------- public ----------
route("GET", "/api/health", async (_r, env) => ({
  ok: true, time: now(), registration: (env.ALLOW_REGISTRATION ?? "true") === "true", inviteRequired: !!env.REGISTRATION_INVITE_CODE,
}));
route("POST", "/api/auth/register", async (req, env) => register(req, env));
route("POST", "/api/auth/login", async (req, env) => login(req, env));

// ---------- account ----------
route("GET", "/api/auth/me", authed(async (_r, _e, u) => ({ user: { id: u.id, username: u.username }, settings: u.settings, automationPaused: u.automationPaused })));
route("POST", "/api/auth/logout", authed(async (req, env, u) => logout(env, u, false, req)));
route("POST", "/api/auth/logout-all", authed(async (req, env, u) => logout(env, u, true, req)));
route("POST", "/api/auth/change-password", authed(async (req, env, u) => changePassword(req, env, u)));
route("PATCH", "/api/settings", authed(async (req, env, u) => updateSettings(req, env, u)));

// ---------- devices ----------
route("GET", "/api/devices", authed(async (_r, env, u) => ({ devices: await listDevices(env, u.id) })));
route("POST", "/api/devices/pairing-code", authed(async (req, env, u) => createPairingCode(env, u.id, clientIp(req))));
route("PATCH", "/api/devices/:id", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked = 0").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Device not found");
  const body = await readJson(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof body.name === "string" && body.name.trim()) {
    sets.push("name = ?");
    vals.push(body.name.trim().replace(/[^\w .-]/g, "").slice(0, 40));
  }
  if (body.permissions && typeof body.permissions === "object") {
    const next = sanitizePermissions(body.permissions, { ...DEFAULT_PERMISSIONS, ...safeParse(row.permissions, {}) });
    sets.push("permissions = ?");
    vals.push(JSON.stringify(next));
    await audit(env, u.id, "user", "device.permissions_changed", { device: row.name, permissions: next }, clientIp(req));
  }
  if (sets.length) await env.DB.prepare(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, p.id).run();
  return { devices: await listDevices(env, u.id) };
}));
route("DELETE", "/api/devices/:id", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT name FROM devices WHERE id = ? AND user_id = ? AND revoked = 0").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Device not found");
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET revoked = 1 WHERE id = ?").bind(p.id),
    env.DB.prepare(`UPDATE tasks SET status = 'CANCELLED', error = 'Device revoked', finished_at = ?, updated_at = ? WHERE device_id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`).bind(t, t, p.id),
  ]);
  await audit(env, u.id, "user", "device.revoked", { name: row.name }, clientIp(req));
  return { ok: true };
}));

// ---------- tasks ----------
route("GET", "/api/tasks", authed(async (req, env, u) => {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const status = url.searchParams.get("status");
  const active = url.searchParams.get("active") === "1";
  let sql = "SELECT t.*, d.name AS device_name FROM tasks t LEFT JOIN devices d ON d.id = t.device_id WHERE t.user_id = ? AND t.parent_id IS NULL";
  const vals: unknown[] = [u.id];
  if (status) { sql += " AND t.status = ?"; vals.push(status); }
  if (active) sql += " AND t.status NOT IN ('COMPLETED','FAILED','CANCELLED')";
  sql += " ORDER BY t.created_at DESC LIMIT ?";
  vals.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...vals).all<any>();
  return { tasks: results.map(rowToTask), automationPaused: u.automationPaused };
}));
route("POST", "/api/tasks", authed(async (req, env, u) => {
  const body = await readJson(req);
  const prompt = String(body.prompt ?? "").trim();
  const kind = body.kind === "control" ? "control" : "agent";
  if (kind === "control" && !CONTROL_ACTIONS.has(body.controlAction)) throw new HttpError(400, "Unknown control action");
  if (!prompt && kind === "agent") throw new HttpError(400, "Tell JARVIS what to do");
  if (u.automationPaused && kind === "agent") throw new HttpError(423, "Automation is paused. Resume it first.");
  try {
    return await createTask(env, {
      userId: u.id, prompt: prompt || String(body.controlAction), target: body.deviceId ?? "auto",
      source: body.source === "voice" ? "voice" : "text", kind, controlAction: kind === "control" ? body.controlAction : null,
      controlArgs: kind === "control" ? body.controlArgs ?? {} : null, defaultDeviceId: u.settings.defaultDeviceId, ip: clientIp(req),
    });
  } catch (e: any) {
    if (e.status) throw new HttpError(e.status, e.message);
    throw e;
  }
}));
route("GET", "/api/tasks/:id", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT t.*, d.name AS device_name FROM tasks t LEFT JOIN devices d ON d.id = t.device_id WHERE t.id = ? AND t.user_id = ?").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Task not found");
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  const { results: events } = await env.DB.prepare("SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 500").bind(p.id, after).all<any>();
  const { results: children } = await env.DB.prepare("SELECT t.*, d.name AS device_name FROM tasks t LEFT JOIN devices d ON d.id = t.device_id WHERE t.parent_id = ? ORDER BY t.created_at").bind(p.id).all<any>();
  return {
    task: rowToTask(row),
    children: children.map(rowToTask),
    events: events.map((e) => ({ id: e.id, taskId: e.task_id, ts: e.ts, type: e.type, data: safeParse(e.data, {}) })),
  };
}));
route("POST", "/api/tasks/:id/cancel", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND user_id = ?").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Task not found");
  if (isTerminal(row.status)) return { ok: true, alreadyFinished: true };
  await cancelTask(env, u.id, p.id);
  await audit(env, u.id, "user", "task.cancel_requested", { id: p.id }, clientIp(req));
  return { ok: true };
}));
route("POST", "/api/tasks/:id/respond", authed(async (req, env, u, p) => {
  const body = await readJson(req);
  const row = await env.DB.prepare("SELECT status, pending_input FROM tasks WHERE id = ? AND user_id = ?").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Task not found");
  if (row.status !== "WAITING_FOR_INPUT") throw new HttpError(409, "This task is not waiting for input");
  const response = { approved: !!body.approved, text: typeof body.text === "string" ? body.text.slice(0, 4000) : null };
  await env.DB.prepare("UPDATE tasks SET input_response = ?, input_delivered = 0, updated_at = ? WHERE id = ?").bind(JSON.stringify(response), now(), p.id).run();
  await addEvent(env, p.id, "input_response", response);
  await audit(env, u.id, "user", response.approved ? "task.action_approved" : "task.action_denied",
    { id: p.id, action: safeParse<any>(row.pending_input, {}).action }, clientIp(req));
  return { ok: true };
}));
route("POST", "/api/tasks/:id/retry", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Task not found");
  if (!isTerminal(row.status)) throw new HttpError(409, "Task is still running");
  if (row.kind === "group") throw new HttpError(400, "Retry individual device tasks instead");
  return createTask(env, {
    userId: u.id, prompt: row.prompt, target: row.device_id, source: "retry", kind: row.kind,
    controlAction: row.control_action, controlArgs: safeParse(row.control_args, null),
    retryOf: row.id, threadId: row.thread_id, defaultDeviceId: u.settings.defaultDeviceId, ip: clientIp(req),
  });
}));

// ---------- emergency stop ----------
route("POST", "/api/emergency-stop", authed(async (req, env, u) => {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET automation_paused = 1 WHERE id = ?").bind(u.id),
    env.DB.prepare(`UPDATE tasks SET status = 'CANCELLED', error = 'Emergency stop', finished_at = ?, updated_at = ? WHERE user_id = ? AND status = 'QUEUED'`).bind(t, t, u.id),
    env.DB.prepare(`UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE user_id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`).bind(t, u.id),
  ]);
  const { results: groups } = await env.DB.prepare("SELECT id FROM tasks WHERE user_id = ? AND kind = 'group' AND status NOT IN ('COMPLETED','FAILED','CANCELLED')").bind(u.id).all<any>();
  for (const g of groups) await refreshGroup(env, g.id);
  await audit(env, u.id, "user", "automation.emergency_stop", {}, clientIp(req));
  return { ok: true, automationPaused: true };
}));
route("POST", "/api/resume-automation", authed(async (req, env, u) => {
  await env.DB.prepare("UPDATE users SET automation_paused = 0 WHERE id = ?").bind(u.id).run();
  await audit(env, u.id, "user", "automation.resumed", {}, clientIp(req));
  return { ok: true, automationPaused: false };
}));

// ---------- workflows ----------
function validateWorkflow(body: any) {
  const name = String(body.name ?? "").trim().slice(0, 80);
  const prompt = String(body.prompt ?? "").trim().slice(0, 4000);
  const schedule = String(body.schedule ?? "").trim();
  const timezone = String(body.timezone ?? "UTC");
  if (!name || !prompt) throw new HttpError(400, "Name and instructions are required");
  try { parseCron(schedule); } catch (e: any) { throw new HttpError(400, `Schedule: ${e.message}`); }
  if (!isValidTimeZone(timezone)) throw new HttpError(400, "Unknown time zone");
  return { name, prompt, schedule, timezone };
}
const rowToWorkflow = (r: any) => ({
  id: r.id, name: r.name, schedule: r.schedule, timezone: r.timezone, deviceId: r.device_id, prompt: r.prompt,
  enabled: !!r.enabled, lastRunAt: r.last_run_at, createdAt: r.created_at,
});
route("GET", "/api/workflows", authed(async (_r, env, u) => {
  const { results } = await env.DB.prepare("SELECT * FROM workflows WHERE user_id = ? ORDER BY created_at").bind(u.id).all<any>();
  return { workflows: results.map(rowToWorkflow) };
}));
route("POST", "/api/workflows", authed(async (req, env, u) => {
  const body = await readJson(req);
  const w = validateWorkflow(body);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM workflows WHERE user_id = ?").bind(u.id).first<any>();
  if (count.n >= 50) throw new HttpError(400, "Workflow limit reached (50)");
  const id = randomId("w_");
  await env.DB.prepare("INSERT INTO workflows (id, user_id, name, schedule, timezone, device_id, prompt, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, u.id, w.name, w.schedule, w.timezone, body.deviceId || null, w.prompt, body.enabled === false ? 0 : 1, now()).run();
  await audit(env, u.id, "user", "workflow.created", { name: w.name, schedule: w.schedule }, clientIp(req));
  return { id };
}));
route("PATCH", "/api/workflows/:id", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT * FROM workflows WHERE id = ? AND user_id = ?").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Workflow not found");
  const body = await readJson(req);
  const merged = { ...rowToWorkflow(row), ...body };
  const w = validateWorkflow(merged);
  await env.DB.prepare("UPDATE workflows SET name=?, schedule=?, timezone=?, device_id=?, prompt=?, enabled=? WHERE id = ?")
    .bind(w.name, w.schedule, w.timezone, merged.deviceId || null, w.prompt, merged.enabled ? 1 : 0, p.id).run();
  await audit(env, u.id, "user", "workflow.updated", { name: w.name, enabled: !!merged.enabled }, clientIp(req));
  return { ok: true };
}));
route("DELETE", "/api/workflows/:id", authed(async (req, env, u, p) => {
  await env.DB.prepare("DELETE FROM workflows WHERE id = ? AND user_id = ?").bind(p.id, u.id).run();
  await audit(env, u.id, "user", "workflow.deleted", { id: p.id }, clientIp(req));
  return { ok: true };
}));
route("POST", "/api/workflows/:id/run", authed(async (req, env, u, p) => {
  const row = await env.DB.prepare("SELECT * FROM workflows WHERE id = ? AND user_id = ?").bind(p.id, u.id).first<any>();
  if (!row) throw new HttpError(404, "Workflow not found");
  try {
    return await createTask(env, { userId: u.id, prompt: row.prompt, target: row.device_id ?? "auto", source: "workflow", workflowId: row.id, defaultDeviceId: u.settings.defaultDeviceId, ip: clientIp(req) });
  } catch (e: any) {
    if (e.status) throw new HttpError(e.status, e.message);
    throw e;
  }
}));

// ---------- audit ----------
route("GET", "/api/audit", authed(async (req, env, u) => {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 100), 500);
  const { results } = await env.DB.prepare("SELECT id, ts, actor, action, detail, ip FROM audit_logs WHERE user_id = ? ORDER BY ts DESC LIMIT ?").bind(u.id, limit).all<any>();
  return { logs: results.map((r) => ({ ...r, detail: safeParse(r.detail, r.detail) })) };
}));

// ---------- agent (HMAC-signed) ----------
route("POST", "/api/agent/pair", async (req, env) => pairDevice(req, env));
route("POST", "/api/agent/sync", async (req, env, ctx) => sync(req, env, ctx));
route("POST", "/api/agent/tasks/:id/update", async (req, env, _c, p) => taskUpdate(req, env, p.id));
route("POST", "/api/agent/command", async (req, env) => {
  try { return await agentCommand(req, env); } catch (e: any) {
    if (e.status && !(e instanceof HttpError)) throw new HttpError(e.status, e.message);
    throw e;
  }
});
route("POST", "/api/agent/unpair", async (req, env) => unpairSelf(req, env));

// ---------- scheduler ----------
async function runScheduler(env: Env, at: Date) {
  const minuteKey = Math.floor(at.getTime() / 60000);
  const { results } = await env.DB.prepare(
    "SELECT w.*, u.settings, u.automation_paused FROM workflows w JOIN users u ON u.id = w.user_id WHERE w.enabled = 1"
  ).all<any>();
  for (const w of results) {
    try {
      if (w.automation_paused) continue;
      if (!cronMatches(parseCron(w.schedule), at, w.timezone)) continue;
      // Claim this minute atomically so overlapping cron invocations cannot double-run a workflow.
      const claim = await env.DB.prepare("UPDATE workflows SET last_run_key = ?, last_run_at = ? WHERE id = ? AND (last_run_key IS NULL OR last_run_key != ?)")
        .bind(String(minuteKey), at.getTime(), w.id, String(minuteKey)).run();
      if (!claim.meta.changes) continue;
      const settings = safeParse<any>(w.settings, {});
      await createTask(env, { userId: w.user_id, prompt: w.prompt, target: w.device_id ?? "auto", source: "workflow", workflowId: w.id, defaultDeviceId: settings.defaultDeviceId ?? null });
    } catch (e: any) {
      await audit(env, w.user_id, "system", "workflow.failed_to_start", { name: w.name, error: e.message });
    }
  }
  const t = at.getTime();
  // Workflow tasks wait at most 2h for an offline device; other queued tasks 24h.
  await env.DB.prepare(`UPDATE tasks SET status = 'FAILED', error = 'Target device stayed offline', finished_at = ?1, updated_at = ?1
    WHERE status = 'QUEUED' AND ((source = 'workflow' AND created_at < ?2) OR created_at < ?3)`).bind(t, t - 2 * 3600e3, t - 24 * 3600e3).run();
  if (zonedParts(at, "UTC").minute === 7) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").bind(t - 3600e3),
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(t - 24 * 3600e3),
      env.DB.prepare("DELETE FROM audit_logs WHERE ts < ?").bind(t - 90 * 24 * 3600e3),
      env.DB.prepare("DELETE FROM task_events WHERE ts < ?").bind(t - 30 * 24 * 3600e3),
    ]);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const data = await r.handler(req, env, ctx, params);
        return json(data, 200, { ...SECURITY_HEADERS, ...cors });
      } catch (e: any) {
        if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status, { ...SECURITY_HEADERS, ...cors });
        console.error("Unhandled", e?.stack || e);
        return json({ error: "Internal error", code: "internal" }, 500, { ...SECURITY_HEADERS, ...cors });
      }
    }
    // Non-API routes: serve the embedded dashboard (GET/HEAD only).
    if (!url.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) {
      if (!ASSETS["/index.html"] && env.DASHBOARD_ORIGIN) {
        try { return await proxyDashboard(env.DASHBOARD_ORIGIN, url.pathname, ctx); } catch { /* fall back to landing */ }
      }
      return serveStatic(url.pathname);
    }
    return json({ error: "Not found", code: "not_found" }, 404, { ...SECURITY_HEADERS, ...cors });
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduler(env, new Date(event.scheduledTime)));
  },
};

