// Shared contracts between the cloud control plane, the web dashboard and the Windows agent.
// Keep this file free of runtime dependencies so every app can import it directly.

export const TASK_STATUSES = [
  "QUEUED",
  "PLANNING",
  "RUNNING",
  "WAITING_FOR_INPUT",
  "VALIDATING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
export const isTerminal = (s: string) => (TERMINAL_STATUSES as readonly string[]).includes(s);

/** Allowed state-machine transitions. The server rejects anything else. */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["PLANNING", "RUNNING", "FAILED", "CANCELLED"],
  PLANNING: ["RUNNING", "WAITING_FOR_INPUT", "VALIDATING", "COMPLETED", "FAILED", "CANCELLED"],
  RUNNING: ["RUNNING", "WAITING_FOR_INPUT", "VALIDATING", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_FOR_INPUT: ["RUNNING", "VALIDATING", "COMPLETED", "FAILED", "CANCELLED"],
  VALIDATING: ["RUNNING", "COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export type TaskKind = "agent" | "control" | "group";
export type TaskSource = "text" | "voice" | "workflow" | "agent-voice" | "retry";

export type ControlAction =
  | "memory.list"
  | "memory.add"
  | "memory.delete"
  | "apps.list"
  | "apps.refresh"
  | "files.search"
  | "files.list"
  | "files.index"       // walk approved roots into a tree + learn a summary of what's on the machine
  | "files.read"
  | "files.delete"
  | "files.fetch"       // stage a file's bytes back to the dashboard (download)
  | "files.put"         // write bytes pushed from the dashboard (upload)
  | "message.show"      // pop a message on the PC's screen
  | "terminal.exec"     // run one command, return output
  | "power.shutdown"
  | "power.restart"
  | "power.sleep"
  | "power.lock"
  | "power.cancel"      // cancel a pending shutdown/restart within its grace window
  | "screen.capture"    // single screenshot (with on-screen indicator)
  | "system.info";

export type PowerAction = "shutdown" | "restart" | "sleep" | "lock";

export interface Task {
  id: string;
  deviceId: string | null;
  deviceName?: string | null;
  parentId: string | null;
  kind: TaskKind;
  source: TaskSource;
  prompt: string;
  controlAction?: ControlAction | null;
  controlArgs?: Record<string, unknown> | null;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  pendingInput: PendingInput | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  workflowId: string | null;
  retryOf: string | null;
  threadId: string | null;
}

export interface PendingInput {
  kind: "confirmation" | "question";
  action: string;
  details: string;
  risk?: "low" | "medium" | "high";
  requestedAt: number;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: number;
  type: "status" | "log" | "tool" | "message" | "error" | "result" | "input_request" | "input_response";
  data: Record<string, unknown>;
}

export interface DeviceMetrics {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  disks: { mount: string; usedBytes: number; totalBytes: number }[];
  uptimeSec: number;
  onBattery: boolean | null;
}

export interface DeviceCapabilities {
  browser: boolean;
  codex: "ready" | "not_logged_in" | "missing" | "unknown";
  voice: boolean;
  desktop: boolean; // interactive desktop available (unlocked session)
  vault: boolean;
  rea: boolean;
  power: boolean;
  terminal: "off" | "scoped" | "full";
  screen: boolean;
  messenger: boolean;
  provider: "codex" | "claude";
}

export interface PermissionProfile {
  autonomy: "routine" | "confirm-all" | "serious";
  workspaceDir: string;
  approvedDirs: string[];
  allowedApps: string[]; // ["*"] = any discovered app
  browserDomains: string[]; // [] = any domain
  allowedCommands: string[]; // names that must exist in the device's local policy
  allowNetworkInSandbox: boolean;
  voice: boolean;
  rea: boolean;
  power: boolean;       // allow shutdown/restart/sleep/lock
  terminal: "off" | "scoped" | "full"; // scoped = commands run inside approved dirs; full = unrestricted shell
  screen: boolean;      // allow screen capture / view
  messenger: boolean;   // allow showing messages on the PC
}

export const DEFAULT_PERMISSIONS: PermissionProfile = {
  autonomy: "routine",
  workspaceDir: "",
  approvedDirs: [],
  allowedApps: ["*"],
  browserDomains: [],
  allowedCommands: [],
  allowNetworkInSandbox: false,
  voice: true,
  rea: false,
  power: true,
  terminal: "scoped",
  screen: true,
  messenger: true,
};

export interface Device {
  id: string;
  name: string;
  os: string;
  agentVersion: string;
  online: boolean;
  lastHeartbeat: number | null;
  metrics: DeviceMetrics | null;
  capabilities: DeviceCapabilities | null;
  sessionActive: boolean;
  permissions: PermissionProfile;
  localCeiling: Partial<PermissionProfile> | null;
  createdAt: number;
  currentTasks: number;
}

export interface NotificationPrefs {
  startup: boolean;
  taskCompletion: boolean;
  errors: boolean;
  security: boolean;
  quietHours: { enabled: boolean; start: string; end: string }; // "22:00" - "07:00" local time
}

export interface UserSettings {
  defaultDeviceId: string | null;
  notifications: NotificationPrefs;
  voiceName: string | null;
  reducedMotion: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultDeviceId: null,
  notifications: {
    startup: true,
    taskCompletion: true,
    errors: true,
    security: true,
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  },
  voiceName: null,
  reducedMotion: false,
};

export interface Workflow {
  id: string;
  name: string;
  schedule: string; // 5-field cron
  timezone: string;
  deviceId: string | null; // null = default device
  prompt: string;
  enabled: boolean;
  lastRunAt: number | null;
  createdAt: number;
}

/** Sent by the agent on every sync (long poll). */
export interface AgentSyncRequest {
  agentVersion: string;
  metrics?: DeviceMetrics;
  capabilities?: DeviceCapabilities;
  sessionActive?: boolean;
  activeTaskIds: string[];
  wait?: boolean;
}

export interface DispatchedTask {
  id: string;
  kind: TaskKind;
  source: TaskSource;
  prompt: string;
  controlAction: ControlAction | null;
  controlArgs: Record<string, unknown> | null;
  retryOf: string | null;
  threadId: string | null; // thread to resume (retry/continue)
}

export interface AgentSyncResponse {
  paused: boolean;
  revoked: boolean;
  permissions: PermissionProfile;
  notifications: NotificationPrefs;
  tasks: DispatchedTask[];
  cancelTaskIds: string[];
  inputResponses: { taskId: string; approved: boolean; text: string | null }[];
  serverTime: number;
  update: { version: string; url: string; sha256: string } | null;
}

export interface AgentTaskUpdate {
  status?: TaskStatus;
  events?: { type: TaskEvent["type"]; data: Record<string, unknown> }[];
  result?: string;
  error?: string;
  threadId?: string;
  pendingInput?: Omit<PendingInput, "requestedAt"> | null;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PASSWORD_MIN = 10;
