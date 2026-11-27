// Optional REA adapter. REA runs as an MCP server that the user installs and points JARVIS at in the
// device's local policy (policy.json -> rea). It complements Playwright + Windows automation; it never replaces them.
// It is enabled only when BOTH the local policy and the cloud permission profile allow it.
import type { LocalPolicy } from "../../permissions/src/index";

export interface McpServerEntry { command?: string; args?: string[]; url?: string; env?: Record<string, string> }

export function reaMcpServer(policy: LocalPolicy, cloudAllows: boolean): McpServerEntry | null {
  if (!cloudAllows || !policy.rea?.enabled) return null;
  if (policy.rea.url) return { url: policy.rea.url };
  if (policy.rea.command) return { command: policy.rea.command, args: policy.rea.args ?? [] };
  return null;
}

export const REA_INSTRUCTIONS =
  "An REA MCP server is connected (tools prefixed with the server name 'rea'). Use it only for observing or analysing " +
  "applications and software the user owns or is authorised to analyse, as a complement to the browser and Windows tools.";
