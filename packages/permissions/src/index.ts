// Permission model. The device's LOCAL policy (written at install, editable only on that PC) is the ceiling.
// The cloud profile can narrow it but never widen it, so a compromised account or server cannot grant
// itself new directories, apps, domains or commands on this machine.
import path from "node:path";
import { DEFAULT_PERMISSIONS, type PermissionProfile } from "../../shared-types/src/index";

export interface LocalCommand { name: string; command: string; args?: string[]; cwd?: string; timeoutSec?: number }

export interface LocalPolicy {
  workspaceDir: string;
  approvedDirs: string[];
  allowedApps: string[]; // ["*"] = any discovered app
  browserDomains: string[]; // [] = any
  commands: LocalCommand[];
  allowNetworkInSandbox: boolean;
  forceConfirmAll: boolean;
  browser: "chrome" | "msedge";
  voice: boolean;
  maxConcurrentTasks: number;
  taskTimeoutMin: number;
  codexSandbox: "workspace-write" | "read-only";
  codexModel?: string;
  rea: { enabled: boolean; command?: string; args?: string[]; url?: string };
}

export function defaultPolicy(home: string): LocalPolicy {
  const docs = path.join(home, "Documents", "JARVIS");
  return {
    workspaceDir: docs,
    approvedDirs: [docs],
    allowedApps: ["*"],
    browserDomains: [],
    commands: [],
    allowNetworkInSandbox: false,
    forceConfirmAll: false,
    browser: "chrome",
    voice: false,
    maxConcurrentTasks: 1,
    taskTimeoutMin: 45,
    codexSandbox: "workspace-write",
    rea: { enabled: false },
  };
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface EffectivePermissions {
  autonomy: "routine" | "confirm-all";
  workspaceDir: string;
  approvedDirs: string[];
  allowedApps: string[];
  browserDomains: string[];
  commands: LocalCommand[];
  allowNetworkInSandbox: boolean;
  voice: boolean;
  rea: boolean;
}

/** Intersect the cloud profile with the local ceiling. */
export function effectivePermissions(cloud: Partial<PermissionProfile> | null, local: LocalPolicy): EffectivePermissions {
  const c = { ...DEFAULT_PERMISSIONS, ...(cloud ?? {}) };
  const ceilingDirs = [local.workspaceDir, ...local.approvedDirs];
  const dirs = c.approvedDirs.length
    ? c.approvedDirs.filter((d) => ceilingDirs.some((cd) => isInside(d, cd)))
    : ceilingDirs;
  const workspace = c.workspaceDir && ceilingDirs.some((cd) => isInside(c.workspaceDir, cd)) ? c.workspaceDir : local.workspaceDir;

  const localAnyApp = local.allowedApps.includes("*");
  const cloudAnyApp = c.allowedApps.includes("*");
  const apps = localAnyApp
    ? c.allowedApps
    : cloudAnyApp
      ? local.allowedApps
      : c.allowedApps.filter((a) => local.allowedApps.some((l) => l.toLowerCase() === a.toLowerCase()));

  let domains: string[];
  if (!local.browserDomains.length) domains = c.browserDomains;
  else if (!c.browserDomains.length) domains = local.browserDomains;
  else domains = c.browserDomains.filter((d) => local.browserDomains.some((l) => domainMatches(d, l)));

  const commands = local.commands.filter((cmd) => c.allowedCommands.includes(cmd.name));

  return {
    autonomy: local.forceConfirmAll ? "confirm-all" : c.autonomy,
    workspaceDir: workspace,
    approvedDirs: [...new Set([workspace, ...dirs])],
    allowedApps: apps,
    browserDomains: domains,
    commands,
    allowNetworkInSandbox: local.allowNetworkInSandbox && c.allowNetworkInSandbox,
    voice: local.voice && c.voice,
    rea: local.rea.enabled && c.rea,
  };
}

/** "github.com" allows github.com and *.github.com. */
export function domainMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/^\*\./, "");
  const r = rule.toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return h === r || h.endsWith("." + r);
}

export function isPathAllowed(p: string, perms: EffectivePermissions): boolean {
  return perms.approvedDirs.some((d) => isInside(p, d));
}

export function isAppAllowed(name: string, perms: EffectivePermissions): boolean {
  if (perms.allowedApps.includes("*")) return true;
  return perms.allowedApps.some((a) => a.toLowerCase() === name.toLowerCase());
}

export function isDomainAllowed(host: string, perms: EffectivePermissions): boolean {
  if (!perms.browserDomains.length) return true;
  return perms.browserDomains.some((r) => domainMatches(host, r));
}

/** Actions that always need a human "yes", regardless of autonomy. */
export const HIGH_RISK_ACTIONS = [
  "sending money or making a payment",
  "making a purchase or subscription",
  "exporting or revealing credentials",
  "deleting more than a handful of files or any data you cannot restore",
  "sending sensitive files outside the approved workspaces",
  "sending an email, message or post on the user's behalf",
  "installing software or privileged services",
  "changing account security settings or access permissions",
];
