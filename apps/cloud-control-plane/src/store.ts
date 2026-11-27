import {
  DEFAULT_PERMISSIONS, isTerminal, type Device, type PermissionProfile, type Task, type TaskStatus,
} from "../../../packages/shared-types/src/index";
import { audit, now, randomId, safeParse, truncate, type Env } from "./lib";
import { resolveDevices } from "./routing";

export const ONLINE_WINDOW_MS = 75_000;

export function rowToDevice(r: any, currentTasks = 0): Device {
  return {
    id: r.id,
    name: r.name,
    os: r.os,
    agentVersion: r.agent_version,
    online: !!r.last_heartbeat && now() - r.last_heartbeat < ONLINE_WINDOW_MS,
    lastHeartbeat: r.last_heartbeat ?? null,
    metrics: safeParse(r.metrics, null),
    capabilities: safeParse(r.capabilities, null),
    sessionActive: !!r.session_active,
    permissions: { ...DEFAULT_PERMISSIONS, ...safeParse(r.permissions, {}) },
    localCeiling: safeParse(r.local_ceiling, null),
    createdAt: r.created_at,
    currentTasks,
  };
}

export function rowToTask(r: any): Task {
  return {
    id: r.id,
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    parentId: r.parent_id,
    kind: r.kind,
    source: r.source,
    prompt: r.prompt,
    controlAction: r.control_action,
    controlArgs: safeParse(r.control_args, null),
    status: r.status,
    result: r.result,
    error: r.error,
    pendingInput: safeParse(r.pending_input, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    workflowId: r.workflow_id,
    retryOf: r.retry_of,
    threadId: r.thread_id,
  };
}

export async function listDevices(env: Env, userId: string): Promise<Device[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM tasks t WHERE t.device_id = d.id AND t.status IN ('QUEUED','PLANNING','RUNNING','WAITING_FOR_INPUT','VALIDATING')) AS active
     FROM devices d WHERE d.user_id = ? AND d.revoked = 0 ORDER BY d.created_at`
  ).bind(userId).all<any>();
  return results.map((r) => rowToDevice(r, r.active));
}

export async function addEvent(env: Env, taskId: string, type: string, data: Record<string, unknown>) {
  await env.DB.prepare("INSERT INTO task_events (task_id, ts, type, data) VALUES (?,?,?,?)")
    .bind(taskId, now(), type, truncate(data, 8000))
    .run();
}

export interface CreateTaskInput {
  userId: string;
  prompt: string;
  target: string | "auto" | "all" | null;
  source: Task["source"];
  kind?: "agent" | "control";
  controlAction?: string | null;
  controlArgs?: unknown;
  workflowId?: string | null;
  retryOf?: string | null;
  threadId?: string | null;
  originDeviceId?: string | null;
  defaultDeviceId: string | null;
  ip?: string;
}

/** Creates a task (or a group of per-device subtasks) and returns the top-level task. */
export async function createTask(env: Env, input: CreateTaskInput): Promise<{ task: Task; routedTo: string[]; reason: string }> {
  const devices = await listDevices(env, input.userId);
  let deviceIds: string[];
  let reason: string;
  if (input.target && input.target !== "auto" && input.target !== "all") {
    if (!devices.some((d) => d.id === input.target)) throw Object.assign(new Error("Unknown device"), { status: 400 });
    deviceIds = [input.target];
    reason = "selected device";
  } else if (input.target === "all") {
    deviceIds = devices.filter((d) => d.online).map((d) => d.id);
    reason = "all online devices";
  } else {
    ({ deviceIds, reason } = resolveDevices(input.prompt, devices, {
      defaultDeviceId: input.defaultDeviceId,
      originDeviceId: input.originDeviceId,
    }));
  }
  if (deviceIds.length === 0) {
    throw Object.assign(new Error(devices.length ? "None of your devices are online right now." : "No devices are enrolled yet. Pair a computer first."), { status: 409 });
  }

  const t = now();
  const kind = input.kind ?? "agent";
  const base = {
    prompt: input.prompt.slice(0, 8000),
    source: input.source,
    control_action: input.controlAction ?? null,
    control_args: input.controlArgs ? JSON.stringify(input.controlArgs) : null,
    workflow_id: input.workflowId ?? null,
    retry_of: input.retryOf ?? null,
    thread_id: input.threadId ?? null,
  };
  const insert = (id: string, deviceId: string | null, parentId: string | null, k: string, status: TaskStatus) =>
    env.DB.prepare(
      `INSERT INTO tasks (id, user_id, device_id, parent_id, kind, source, prompt, control_action, control_args, status, created_at, updated_at, workflow_id, retry_of, thread_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, input.userId, deviceId, parentId, k, base.source, base.prompt, base.control_action, base.control_args, status, t, t, base.workflow_id, base.retry_of, base.thread_id);

  let topId: string;
  const stmts: D1PreparedStatement[] = [];
  if (deviceIds.length === 1) {
    topId = randomId("t_");
    stmts.push(insert(topId, deviceIds[0], null, kind, "QUEUED"));
  } else {
    topId = randomId("g_");
    stmts.push(insert(topId, null, null, "group", "RUNNING"));
    for (const d of deviceIds) stmts.push(insert(randomId("t_"), d, topId, kind, "QUEUED"));
  }
  await env.DB.batch(stmts);
  const names = deviceIds.map((id) => devices.find((d) => d.id === id)?.name ?? id);
  await addEvent(env, topId, "status", { status: deviceIds.length === 1 ? "QUEUED" : "RUNNING", routedTo: names, reason });
  const offline = deviceIds.filter((id) => !devices.find((d) => d.id === id)?.online);
  if (offline.length) await addEvent(env, topId, "log", { message: "Target device is offline; the task will run when it reconnects." });
  await audit(env, input.userId, input.originDeviceId ? `device:${input.originDeviceId}` : "user", "task.created",
    { id: topId, source: input.source, devices: names, prompt: truncate(input.prompt, 200) }, input.ip);
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(topId).first<any>();
  return { task: rowToTask(row), routedTo: names, reason };
}

/** Recompute a group task's status once its subtasks finish. */
export async function refreshGroup(env: Env, parentId: string) {
  const { results } = await env.DB.prepare(
    "SELECT t.status, t.result, t.error, d.name AS device_name FROM tasks t LEFT JOIN devices d ON d.id = t.device_id WHERE t.parent_id = ?"
  ).bind(parentId).all<any>();
  if (!results.length || !results.every((r) => isTerminal(r.status))) return;
  const allOk = results.every((r) => r.status === "COMPLETED");
  const allCancelled = results.every((r) => r.status === "CANCELLED");
  const status: TaskStatus = allOk ? "COMPLETED" : allCancelled ? "CANCELLED" : "FAILED";
  const summary = results
    .map((r) => `### ${r.device_name ?? "Device"} — ${r.status}\n${r.result ?? r.error ?? ""}`)
    .join("\n\n");
  await env.DB.prepare("UPDATE tasks SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')")
    .bind(status, summary.slice(0, 60000), now(), now(), parentId).run();
}

/** Request cancellation. Tasks that never reached an agent are cancelled immediately. */
export async function cancelTask(env: Env, userId: string, taskId: string) {
  const ids = [taskId];
  const { results: children } = await env.DB.prepare("SELECT id FROM tasks WHERE parent_id = ? AND user_id = ?").bind(taskId, userId).all<any>();
  ids.push(...children.map((c) => c.id));
  for (const id of ids) {
    await env.DB.prepare(
      `UPDATE tasks SET status = 'CANCELLED', finished_at = ?1, updated_at = ?1, error = 'Cancelled before it started'
       WHERE id = ?2 AND user_id = ?3 AND status = 'QUEUED' AND dispatched_at IS NULL`
    ).bind(now(), id, userId).run();
    await env.DB.prepare(
      `UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ? AND user_id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`
    ).bind(now(), id, userId).run();
  }
  const parent = await env.DB.prepare("SELECT parent_id FROM tasks WHERE id = ?").bind(taskId).first<any>();
  if (children.length) await refreshGroup(env, taskId);
  else if (parent?.parent_id) await refreshGroup(env, parent.parent_id);
}

export function sanitizePermissions(input: any, current: PermissionProfile): PermissionProfile {
  const strList = (v: unknown, max = 50) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length < 500).slice(0, max) : undefined;
  const p = { ...current };
  if (input.autonomy === "routine" || input.autonomy === "confirm-all") p.autonomy = input.autonomy;
  if (typeof input.workspaceDir === "string") p.workspaceDir = input.workspaceDir.slice(0, 500);
  p.approvedDirs = strList(input.approvedDirs) ?? p.approvedDirs;
  p.allowedApps = strList(input.allowedApps, 200) ?? p.allowedApps;
  p.browserDomains = strList(input.browserDomains, 200)?.map((d) => d.toLowerCase().trim()) ?? p.browserDomains;
  p.allowedCommands = strList(input.allowedCommands) ?? p.allowedCommands;
  if (typeof input.allowNetworkInSandbox === "boolean") p.allowNetworkInSandbox = input.allowNetworkInSandbox;
  if (typeof input.voice === "boolean") p.voice = input.voice;
  if (typeof input.rea === "boolean") p.rea = input.rea;
  if (typeof input.power === "boolean") p.power = input.power;
  if (input.terminal === "off" || input.terminal === "scoped" || input.terminal === "full") p.terminal = input.terminal;
  if (typeof input.screen === "boolean") p.screen = input.screen;
  if (typeof input.messenger === "boolean") p.messenger = input.messenger;
  return p;
}
