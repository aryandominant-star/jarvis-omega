import fs from "node:fs";
import os from "node:os";
import { defaultPolicy, type LocalPolicy } from "../../../../packages/permissions/src/index";
import { protectSecret, unprotectSecret } from "../../../../packages/credential-vault/src/index";
import { paths, readJsonFile, writeFileAtomic } from "./paths";

export interface AgentConfig {
  apiUrl: string | null;       // control plane, e.g. https://jarvis-omega-control.<sub>.workers.dev
  dashboardUrl: string | null; // where the tray's "Open JARVIS" goes (usually same as apiUrl)
  deviceId: string | null;
  deviceName: string;
}

export interface AgentState {
  crashes: number[];          // timestamps of recent crashes (crash-loop guard)
  lastStartupToastKey: string | null;
  notifiedUpdate: string | null;
}

export function loadConfig(): AgentConfig {
  return { apiUrl: null, dashboardUrl: null, deviceId: null, deviceName: os.hostname().toUpperCase(), ...readJsonFile<Partial<AgentConfig>>(paths.config, {}) };
}
export function saveConfig(c: AgentConfig) {
  writeFileAtomic(paths.config, JSON.stringify(c, null, 2));
}

export function loadPolicy(): LocalPolicy {
  const def = defaultPolicy(os.homedir());
  const p = readJsonFile<Partial<LocalPolicy>>(paths.policy, {});
  return { ...def, ...p, rea: { ...def.rea, ...(p.rea ?? {}) } };
}
export function savePolicy(p: LocalPolicy) {
  writeFileAtomic(paths.policy, JSON.stringify(p, null, 2));
}

export function loadState(): AgentState {
  return { crashes: [], lastStartupToastKey: null, notifiedUpdate: null, ...readJsonFile<Partial<AgentState>>(paths.state, {}) };
}
export function saveState(s: AgentState) {
  writeFileAtomic(paths.state, JSON.stringify(s));
}

export async function saveDeviceSecret(secret: string) {
  writeFileAtomic(paths.secret, await protectSecret(secret));
}
export async function loadDeviceSecret(): Promise<string | null> {
  if (!fs.existsSync(paths.secret)) return null;
  try { return await unprotectSecret(fs.readFileSync(paths.secret, "utf8")); } catch { return null; }
}
export function clearDeviceSecret() {
  fs.rmSync(paths.secret, { force: true });
}
