// Claude as an alternative reasoning engine, via the Anthropic Messages API with tool use. It runs in-process
// in the agent and calls the same jarvis tools (power, terminal, files, browser-less actions) through a callback.
// The API key is read from the local credential vault or ANTHROPIC_API_KEY; it never goes to the control plane.

export interface ClaudeTool { name: string; description: string; input_schema: unknown }

export interface ClaudeRunOptions {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  history: any[];                 // prior messages for thread continuation
  tools: ClaudeTool[];
  runTool: (name: string, args: any) => Promise<string>;
  onEvent: (ev: { type: string; [k: string]: any }) => void;
  isCancelled: () => boolean;
  maxTurns?: number;
}

export interface ClaudeResult { finalMessage: string | null; failed: string | null; history: any[] }

const ENDPOINT = "https://api.anthropic.com/v1/messages";

export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeResult> {
  const messages: any[] = [...o.history, { role: "user", content: o.prompt }];
  let finalMessage: string | null = null;
  const maxTurns = o.maxTurns ?? 40;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (o.isCancelled()) return { finalMessage, failed: "cancelled", history: messages };
    let data: any;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: o.model, max_tokens: 4096, system: o.system, tools: o.tools, messages }),
      });
      data = await res.json();
      if (!res.ok) return { finalMessage, failed: `Anthropic API ${res.status}: ${data?.error?.message ?? ""}`, history: messages };
    } catch (e: any) {
      return { finalMessage, failed: `Could not reach the Anthropic API: ${e.message}`, history: messages };
    }

    messages.push({ role: "assistant", content: data.content });
    const toolUses = (data.content ?? []).filter((b: any) => b.type === "tool_use");
    for (const b of data.content ?? []) {
      if (b.type === "text" && b.text?.trim()) { finalMessage = b.text; o.onEvent({ type: "message", text: b.text }); }
    }
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { finalMessage, failed: null, history: messages };
    }

    const results: any[] = [];
    for (const tu of toolUses) {
      if (o.isCancelled()) return { finalMessage, failed: "cancelled", history: messages };
      o.onEvent({ type: "tool", tool: `jarvis.${tu.name}`, status: "in_progress", detail: summarize(tu.input) });
      let text: string; let isError = false;
      try { text = await o.runTool(tu.name, tu.input ?? {}); }
      catch (e: any) { text = `Error: ${e.message}`; isError = true; }
      o.onEvent({ type: "tool", tool: `jarvis.${tu.name}`, status: isError ? "failed" : "completed" });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: text.slice(0, 20000), is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  return { finalMessage, failed: finalMessage ? null : "Reached the maximum number of steps", history: messages };
}

function summarize(input: any): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  return String(o.command ?? o.action ?? o.path ?? o.query ?? o.name ?? o.title ?? o.domain ?? "").slice(0, 160);
}
