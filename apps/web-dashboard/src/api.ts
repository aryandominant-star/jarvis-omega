import type { Device, Task, TaskEvent, UserSettings, Workflow } from "../../../packages/shared-types/src/index";

// Same origin when the dashboard is served by the Worker; VITE_API_URL when hosted elsewhere (e.g. InfinityFree).
const devHost = ["localhost", "127.0.0.1"].includes(location.hostname) && location.port !== "8787";
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || (devHost ? "http://localhost:8787" : location.origin);

const TOKEN_KEY = "jarvis.session";
let token: string | null = null;
try { token = localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);
export const hasToken = () => !!token;

export function setToken(t: string | null, remember = true) {
  token = t;
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (t) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
  } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the JARVIS control plane", "offline");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { setToken(null); onUnauthorized(); }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code);
  return data as T;
}

export interface Me { user: { id: string; username: string }; settings: UserSettings; automationPaused: boolean }
export interface TaskDetail { task: Task; children: Task[]; events: TaskEvent[] }
export interface AuditLog { id: number; ts: number; actor: string; action: string; detail: any; ip: string | null }

export const Api = {
  health: () => api<{ ok: boolean; registration: boolean; inviteRequired: boolean }>("/api/health"),
  login: (username: string, password: string) => api<{ token: string; user: Me["user"] }>("/api/auth/login", { body: { username, password } }),
  register: (username: string, password: string, inviteCode?: string) =>
    api<{ token: string; user: Me["user"] }>("/api/auth/register", { body: { username, password, inviteCode } }),
  me: () => api<Me>("/api/auth/me"),
  logout: () => api("/api/auth/logout", { method: "POST" }),
  logoutAll: () => api("/api/auth/logout-all", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) => api("/api/auth/change-password", { body: { currentPassword, newPassword } }),
  updateSettings: (s: Partial<UserSettings>) => api<{ settings: UserSettings }>("/api/settings", { method: "PATCH", body: s }),
  devices: () => api<{ devices: Device[] }>("/api/devices"),
  pairingCode: () => api<{ code: string; expiresAt: number }>("/api/devices/pairing-code", { method: "POST" }),
  updateDevice: (id: string, patch: any) => api<{ devices: Device[] }>(`/api/devices/${id}`, { method: "PATCH", body: patch }),
  revokeDevice: (id: string) => api(`/api/devices/${id}`, { method: "DELETE" }),
  tasks: (q = "") => api<{ tasks: Task[]; automationPaused: boolean }>(`/api/tasks${q}`),
  task: (id: string) => api<TaskDetail>(`/api/tasks/${id}`),
  createTask: (body: { prompt: string; deviceId?: string; source?: string; kind?: string; controlAction?: string; controlArgs?: any }) =>
    api<{ task: Task; routedTo: string[]; reason: string }>("/api/tasks", { body }),
  cancelTask: (id: string) => api(`/api/tasks/${id}/cancel`, { method: "POST" }),
  respond: (id: string, approved: boolean, text?: string) => api(`/api/tasks/${id}/respond`, { body: { approved, text } }),
  retry: (id: string) => api<{ task: Task }>(`/api/tasks/${id}/retry`, { method: "POST" }),
  emergencyStop: () => api("/api/emergency-stop", { method: "POST" }),
  resume: () => api("/api/resume-automation", { method: "POST" }),
  workflows: () => api<{ workflows: Workflow[] }>("/api/workflows"),
  createWorkflow: (w: Partial<Workflow>) => api("/api/workflows", { body: w }),
  updateWorkflow: (id: string, w: Partial<Workflow>) => api(`/api/workflows/${id}`, { method: "PATCH", body: w }),
  deleteWorkflow: (id: string) => api(`/api/workflows/${id}`, { method: "DELETE" }),
  runWorkflow: (id: string) => api(`/api/workflows/${id}/run`, { method: "POST" }),
  audit: () => api<{ logs: AuditLog[] }>("/api/audit?limit=200"),
};

/** Run a control action on a device and wait for its result (used by Memory and file search). */
export async function runControl(deviceId: string, controlAction: string, controlArgs: any = {}, timeoutMs = 30_000): Promise<any> {
  const { task } = await Api.createTask({ prompt: controlAction, deviceId, kind: "control", controlAction, controlArgs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const d = await Api.task(task.id);
    if (d.task.status === "COMPLETED") return d.task.result ? JSON.parse(d.task.result) : null;
    if (d.task.status === "FAILED" || d.task.status === "CANCELLED") throw new Error(d.task.error || "Device could not complete the request");
  }
  throw new Error("The device did not respond in time. Is it online?");
}
