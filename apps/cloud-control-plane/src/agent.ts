import {
  DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, TASK_TRANSITIONS, isTerminal,
  type AgentSyncRequest, type AgentSyncResponse, type AgentTaskUpdate, type DispatchedTask, type TaskStatus,
} from "../../../packages/shared-types/src/index";
import {
  audit, b64url, clientIp, decryptSecret, encryptSecret, hmacHex, HttpError, now, randomBytes, randomId,
  rateLimit, safeParse, semverGt, sha256Hex, timingSafeEqual, truncate, type Env,
} from "./lib";
import { addEvent, createTask, refreshGroup, sanitizePermissions } from "./store";

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const REDISPATCH_MS = 120_000;
const LOST_TASK_MS = 180_000;

export interface AuthedDevice {
  id: string;
  userId: string;
  name: string;
  row: any;
}

// ---------------- pairing ----------------
export async function createPairingCode(env: Env, userId: string, ip: string) {
  await rateLimit(env, `paircode:${userId}`, 10, 3600);
  // 8 chars from an unambiguous alphabet, shown as XXXX-XXXX
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expiresAt = now() + 10 * 60 * 1000;
  await env.DB.prepare("INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .bind(await sha256Hex(raw), userId, now(), expiresAt).run();
  await audit(env, userId, "user", "device.pairing_code_created", {}, ip);
  return { code, expiresAt };
}

export async function pairDevice(req: Request, env: Env) {
  const ip = clientIp(req);
  await rateLimit(env, `pair:${ip}`, 10, 3600);
  const body = await req.json<any>().catch(() => ({}));
  const raw = String(body.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = String(body.name ?? "").trim().replace(/[^\w .-]/g, "").slice(0, 40);
  if (raw.length !== 8 || !name) throw new HttpError(400, "Pairing code and device name are required");
  const hash = await sha256Hex(raw);
  // Atomically consume the code.
  const code = await env.DB.prepare(
    "UPDATE pairing_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ? RETURNING user_id"
  ).bind(hash, now()).first<{ user_id: string }>();
  if (!code) throw new HttpError(403, "Pairing code is invalid, expired or already used");

  const secret = b64url(randomBytes(32));
  const id = randomId("d_");
  const ceiling = body.localCeiling && typeof body.localCeiling === "object" ? body.localCeiling : null;
  const permissions = sanitizePermissions(ceiling ?? {}, { ...DEFAULT_PERMISSIONS });
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, os, agent_version, secret_enc, permissions, local_ceiling, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, code.user_id, name, String(body.os ?? "").slice(0, 100), String(body.agentVersion ?? "").slice(0, 20),
    await encryptSecret(env, secret), JSON.stringify(permissions), ceiling ? truncate(ceiling, 20000) : null, now()).run();
  await audit(env, code.user_id, `device:${id}`, "device.paired", { name, os: body.os }, ip);
  return { deviceId: id, deviceSecret: secret, deviceName: name };
}

// ---------------- request signing ----------------
// signature = HMAC_SHA256(secret, METHOD \n PATH \n TIMESTAMP \n SHA256(body))
export async function requireDevice(req: Request, env: Env, body: string, channel: "sync" | "req"): Promise<AuthedDevice> {
  const id = req.headers.get("x-jarvis-device") || "";
  const ts = Number(req.headers.get("x-jarvis-timestamp") || 0);
  const sig = req.headers.get("x-jarvis-signature") || "";
  if (!id || !ts || !/^[0-9a-f]{64}$/.test(sig)) throw new HttpError(401, "Missing device signature", "unauthenticated");
  if (Math.abs(now() - ts) > CLOCK_SKEW_MS) throw new HttpError(401, "Clock skew too large; check the device's time", "clock_skew");
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<any>();
  if (!row) throw new HttpError(401, "Unknown device", "unauthenticated");
  if (row.revoked) throw new HttpError(403, "This device has been revoked", "revoked");
  const url = new URL(req.url);
  const base = `${req.method}\n${url.pathname}${url.search}\n${ts}\n${await sha256Hex(body)}`;
  const expected = await hmacHex(await decryptSecret(env, row.secret_enc), base);
  if (!timingSafeEqual(expected, sig)) throw new HttpError(401, "Bad device signature", "unauthenticated");
  // Replay protection: timestamps must strictly increase per channel. Single atomic write.
  const col = channel === "sync" ? "last_sync_ts" : "last_req_ts";
  const res = await env.DB.prepare(`UPDATE devices SET ${col} = ? WHERE id = ? AND ${col} < ?`).bind(ts, id, ts).run();
  if (!res.meta.changes) throw new HttpError(401, "Replayed or out-of-order request rejected", "replay");
  return { id, userId: row.user_id, name: row.name, row };
}

// ---------------- sync (heartbeat + long-poll dispatch) ----------------
async function collect(env: Env, dev: AuthedDevice, active: string[]) {
  const t = now();
  const { results: queued } = await env.DB.prepare(
    `SELECT * FROM tasks WHERE device_id = ? AND status = 'QUEUED' AND cancel_requested = 0
     AND (dispatched_at IS NULL OR dispatched_at < ?) ORDER BY created_at LIMIT 5`
  ).bind(dev.id, t - REDISPATCH_MS).all<any>();
  const fresh = queued.filter((q) => !active.includes(q.id));
  const { results: cancels } = await env.DB.prepare(
    `SELECT id FROM tasks WHERE device_id = ? AND cancel_requested = 1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`
  ).bind(dev.id).all<any>();
  const { results: inputs } = await env.DB.prepare(
    `SELECT id, input_response FROM tasks WHERE device_id = ? AND status = 'WAITING_FOR_INPUT' AND input_response IS NOT NULL AND input_delivered = 0`
  ).bind(dev.id).all<any>();
  return { fresh, cancels, inputs };
}

export async function sync(req: Request, env: Env, ctx: ExecutionContext): Promise<AgentSyncResponse> {
  const bodyText = await req.text();
  const dev = await requireDevice(req, env, bodyText, "sync");
  const body = safeParse<AgentSyncRequest>(bodyText, { agentVersion: "", activeTaskIds: [] });
  const active = Array.isArray(body.activeTaskIds) ? body.activeTaskIds.filter((x) => typeof x === "string").slice(0, 50) : [];
  const t = now();

  await env.DB.prepare(
    `UPDATE devices SET last_heartbeat = ?, agent_version = ?, metrics = COALESCE(?, metrics), capabilities = COALESCE(?, capabilities),
     session_active = ? WHERE id = ?`
  ).bind(t, String(body.agentVersion ?? "").slice(0, 20), body.metrics ? truncate(body.metrics, 4000) : null,
    body.capabilities ? truncate(body.capabilities, 2000) : null, body.sessionActive ? 1 : 0, dev.id).run();

  // Backstop for tasks the agent no longer knows about (e.g. hard power loss before it could report).
  const { results: lost } = await env.DB.prepare(
    `SELECT id, parent_id FROM tasks WHERE device_id = ? AND status IN ('PLANNING','RUNNING','VALIDATING') AND updated_at < ?`
  ).bind(dev.id, t - LOST_TASK_MS).all<any>();
  for (const l of lost.filter((l) => !active.includes(l.id))) {
    await env.DB.prepare(`UPDATE tasks SET status = 'FAILED', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .bind("The agent stopped reporting this task (restart or crash). It was not re-run automatically; use Retry to resume safely.", t, t, l.id).run();
    await addEvent(env, l.id, "status", { status: "FAILED", reason: "lost" });
    if (l.parent_id) await refreshGroup(env, l.parent_id);
  }

  const user = await env.DB.prepare("SELECT automation_paused, settings FROM users WHERE id = ?").bind(dev.userId).first<any>();
  let { fresh, cancels, inputs } = await collect(env, dev, active);

  // Long poll: hold the request until there is work or the window elapses.
  const maxWait = Math.min(Number(env.LONG_POLL_MS ?? 20000), 25000);
  if (body.wait && !user.automation_paused && !fresh.length && !cancels.length && !inputs.length) {
    const deadline = t + maxWait;
    while (now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const probe = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM tasks WHERE device_id = ?1 AND ((status = 'QUEUED' AND dispatched_at IS NULL AND cancel_requested = 0)
              OR (cancel_requested = 1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED'))
              OR (status = 'WAITING_FOR_INPUT' AND input_response IS NOT NULL AND input_delivered = 0))) AS n,
           (SELECT automation_paused FROM users WHERE id = ?2) AS paused`
      ).bind(dev.id, dev.userId).first<any>();
      if (probe.n > 0 || probe.paused) {
        user.automation_paused = probe.paused;
        ({ fresh, cancels, inputs } = await collect(env, dev, active));
        break;
      }
    }
  }

  const paused = !!user.automation_paused;
  const tasks: DispatchedTask[] = paused ? [] : fresh.map((r) => ({
    id: r.id, kind: r.kind, source: r.source, prompt: r.prompt, controlAction: r.control_action,
    controlArgs: safeParse(r.control_args, null), retryOf: r.retry_of, threadId: r.thread_id,
  }));
  const stmts: D1PreparedStatement[] = [];
  for (const task of tasks) stmts.push(env.DB.prepare("UPDATE tasks SET dispatched_at = ? WHERE id = ?").bind(now(), task.id));
  for (const i of inputs) stmts.push(env.DB.prepare("UPDATE tasks SET input_delivered = 1 WHERE id = ?").bind(i.id));
  if (stmts.length) await env.DB.batch(stmts);

  const settings = { ...DEFAULT_SETTINGS, ...safeParse(user.settings, {}) };
  const update = env.LATEST_AGENT_VERSION && env.LATEST_AGENT_URL && env.LATEST_AGENT_SHA256 && semverGt(env.LATEST_AGENT_VERSION, body.agentVersion || "0.0.0")
    ? { version: env.LATEST_AGENT_VERSION, url: env.LATEST_AGENT_URL, sha256: env.LATEST_AGENT_SHA256 }
    : null;

  return {
    paused,
    revoked: false,
    permissions: { ...DEFAULT_PERMISSIONS, ...safeParse(dev.row.permissions, {}) },
    notifications: settings.notifications,
    tasks,
    cancelTaskIds: paused ? [...new Set([...cancels.map((c) => c.id), ...active])] : cancels.map((c) => c.id),
    inputResponses: inputs.map((i) => {
      const r = safeParse<any>(i.input_response, {});
      return { taskId: i.id, approved: !!r.approved, text: r.text ?? null };
    }),
    serverTime: now(),
    update,
  };
}

// ---------------- task updates from the agent ----------------
export async function taskUpdate(req: Request, env: Env, taskId: string) {
  const bodyText = await req.text();
  if (bodyText.length > 256 * 1024) throw new HttpError(413, "Update too large");
  const dev = await requireDevice(req, env, bodyText, "req");
  const body = safeParse<AgentTaskUpdate>(bodyText, {});
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND device_id = ?").bind(taskId, dev.id).first<any>();
  if (!task) throw new HttpError(404, "Task not found for this device");
  const t = now();

  for (const ev of (body.events ?? []).slice(0, 50)) {
    if (typeof ev?.type === "string") await addEvent(env, taskId, ev.type, ev.data ?? {});
  }
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [t];

  if (body.status && body.status !== task.status) {
    if (isTerminal(task.status)) return { ok: true, ignored: "task already finished" };
    const allowed = TASK_TRANSITIONS[task.status as TaskStatus] ?? [];
    if (!allowed.includes(body.status)) throw new HttpError(409, `Illegal transition ${task.status} -> ${body.status}`);
    sets.push("status = ?");
    vals.push(body.status);
    if (!task.started_at && body.status !== "QUEUED") { sets.push("started_at = ?"); vals.push(t); }
    if (isTerminal(body.status)) { sets.push("finished_at = ?"); vals.push(t); }
    if (body.status !== "WAITING_FOR_INPUT" && task.status === "WAITING_FOR_INPUT") {
      sets.push("pending_input = NULL", "input_response = NULL", "input_delivered = 0");
    }
    await addEvent(env, taskId, "status", { status: body.status });
  }
  if (body.pendingInput !== undefined) {
    sets.push("pending_input = ?", "input_response = NULL", "input_delivered = 0");
    vals.push(body.pendingInput ? JSON.stringify({ ...body.pendingInput, requestedAt: t }) : null);
    if (body.pendingInput) await addEvent(env, taskId, "input_request", body.pendingInput as any);
  }
  if (typeof body.result === "string") { sets.push("result = ?"); vals.push(body.result.slice(0, 60000)); }
  if (typeof body.error === "string") { sets.push("error = ?"); vals.push(body.error.slice(0, 4000)); }
  if (typeof body.threadId === "string") { sets.push("thread_id = ?"); vals.push(body.threadId.slice(0, 100)); }

  vals.push(taskId);
  await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  if (task.parent_id && body.status && isTerminal(body.status)) await refreshGroup(env, task.parent_id);
  return { ok: true };
}

/** A command heard by the device's local voice assistant. Routed like a dashboard command. */
export async function agentCommand(req: Request, env: Env) {
  const bodyText = await req.text();
  const dev = await requireDevice(req, env, bodyText, "req");
  await rateLimit(env, `agentcmd:${dev.id}`, 60, 3600);
  const body = safeParse<any>(bodyText, {});
  const text = String(body.text ?? "").trim();
  if (!text) throw new HttpError(400, "Empty command");
  const user = await env.DB.prepare("SELECT settings, automation_paused FROM users WHERE id = ?").bind(dev.userId).first<any>();
  if (user.automation_paused) throw new HttpError(423, "Automation is paused");
  const settings = { ...DEFAULT_SETTINGS, ...safeParse(user.settings, {}) };
  return createTask(env, {
    userId: dev.userId, prompt: text, target: "auto", source: "agent-voice",
    originDeviceId: dev.id, defaultDeviceId: settings.defaultDeviceId, ip: clientIp(req),
  });
}

export async function unpairSelf(req: Request, env: Env) {
  const bodyText = await req.text();
  const dev = await requireDevice(req, env, bodyText, "req");
  await env.DB.prepare("UPDATE devices SET revoked = 1 WHERE id = ?").bind(dev.id).run();
  await audit(env, dev.userId, `device:${dev.id}`, "device.disconnected_locally", { name: dev.name }, clientIp(req));
  return { ok: true };
}
