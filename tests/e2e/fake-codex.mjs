#!/usr/bin/env node
// Stand-in for the Codex CLI used by the agent end-to-end test. It speaks the same `codex exec --json` JSONL
// protocol and drives the real "jarvis" MCP server from CODEX_HOME/config.toml, exercising MCP → IPC → agent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] !== "exec") { console.error("fake codex: unsupported"); process.exit(2); }

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const overrides = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "-c" ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
const prompt = fs.readFileSync(0, "utf8");
const request = prompt.split("User request:").pop().trim();
const toml = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
const sect = toml.split("[mcp_servers.jarvis]")[1] ?? "";
const command = JSON.parse(/command = (".*")/.exec(sect)[1]);
const mcpArgs = JSON.parse(/args = (\[.*\])/.exec(sect)[1]);
const taskId = JSON.parse(overrides["mcp_servers.jarvis.env.JARVIS_TASK_ID"]);

const mcp = spawn(command, mcpArgs, { env: { ...process.env, JARVIS_TASK_ID: taskId }, stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: mcp.stdout });
const pending = new Map();
rl.on("line", (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
let nextId = 1;
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, a) => {
  emit({ type: "item.started", item: { id: `i${nextId}`, type: "mcp_tool_call", server: "jarvis", tool: name, arguments: a, status: "in_progress" } });
  const r = await rpc("tools/call", { name, arguments: a });
  const text = r.result?.content?.[0]?.text ?? r.error?.message;
  emit({ type: "item.completed", item: { id: `i${nextId}`, type: "mcp_tool_call", server: "jarvis", tool: name, arguments: a, status: r.result?.isError ? "failed" : "completed" } });
  return text;
};

emit({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0") });
emit({ type: "turn.started" });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "0" } });
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
let final;
if (/sleep forever/i.test(request)) {
  await call("system_info", {});
  await new Promise(() => {}); // until killed (cancel / crash tests)
} else if (/confirm/i.test(request)) {
  const answer = await call("request_confirmation", { action: "Pay $18.99 to renew example.dev", details: "Registrar checkout", risk: "high" });
  final = answer.startsWith("APPROVED") ? "Payment approved by you and completed." : `Stopped: ${answer}`;
} else {
  await call("memory_save", { category: "preference", content: "Reports should be saved as Markdown in the workspace." });
  const saved = await call("export_report", { title: "AI developments", markdown: "## Summary\n- Point one ([source](https://example.com))", format: "md" });
  const remembered = await call("memory_search", { query: "reports markdown" });
  final = `Report done. ${saved}. Tools available: ${tools.length}. Memory: ${remembered.split("\n")[0]}`;
}
emit({ type: "item.completed", item: { id: "final", type: "agent_message", text: final } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
mcp.kill();
process.exit(0);
