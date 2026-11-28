// Cloud assistant — a dashboard-native AI that runs in the control plane itself, so you can talk to
// JARVIS straight from the web dashboard even when no Windows device is online. It answers directly and
// can dispatch work to your paired PCs (which still need to be online to actually carry it out).
//
// The API key is the user's own (Anthropic or OpenAI), stored encrypted with MASTER_KEY. It is never
// shown back to the browser and never leaves the control plane except in calls to that provider.
import { audit, decryptSecret, encryptSecret, HttpError, now, truncate, type Env } from "./lib";
import { createTask, listDevices } from "./store";

export type AssistantProvider = "anthropic" | "openai";
const DEFAULT_MODEL: Record<AssistantProvider, string> = { anthropic: "claude-opus-4-8", openai: "gpt-4o" };
const HISTORY_LIMIT = 24;

interface AssistantRow { provider: string; model: string | null; api_key_enc: string | null }

export async function getAssistantConfig(env: Env, userId: string) {
  const row = await env.DB.prepare("SELECT provider, model, api_key_enc FROM assistant_config WHERE user_id = ?").bind(userId).first<AssistantRow>();
  const provider = (row?.provider as AssistantProvider) ?? "anthropic";
  return { configured: !!row?.api_key_enc, provider, model: row?.model || DEFAULT_MODEL[provider] };
}

export async function setAssistantConfig(env: Env, userId: string, body: any, ip: string) {
  const provider: AssistantProvider = body.provider === "openai" ? "openai" : "anthropic";
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 80) : DEFAULT_MODEL[provider];
  const existing = await env.DB.prepare("SELECT api_key_enc FROM assistant_config WHERE user_id = ?").bind(userId).first<AssistantRow>();
  let keyEnc = existing?.api_key_enc ?? null;
  const rawKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (rawKey) {
    if (rawKey.length < 20 || rawKey.length > 400) throw new HttpError(400, "That doesn't look like a valid API key.");
    keyEnc = await encryptSecret(env, rawKey);
  }
  await env.DB.prepare(
    `INSERT INTO assistant_config (user_id, provider, model, api_key_enc, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       api_key_enc = COALESCE(excluded.api_key_enc, assistant_config.api_key_enc), updated_at = excluded.updated_at`
  ).bind(userId, provider, model, keyEnc, now()).run();
  await audit(env, userId, "user", "assistant.configured", { provider, model, keyChanged: !!rawKey }, ip);
  return { configured: !!keyEnc, provider, model };
}

export async function clearAssistantKey(env: Env, userId: string) {
  await env.DB.prepare("UPDATE assistant_config SET api_key_enc = NULL, updated_at = ? WHERE user_id = ?").bind(now(), userId).run();
  return { configured: false };
}

export async function getAssistantHistory(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT role, content, actions, ts FROM assistant_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(userId, 60).all<any>();
  return results.reverse().map((r) => ({ role: r.role, content: r.content, actions: r.actions ? JSON.parse(r.actions) : [], ts: r.ts }));
}

export async function clearAssistantHistory(env: Env, userId: string) {
  await env.DB.prepare("DELETE FROM assistant_messages WHERE user_id = ?").bind(userId).run();
  return { ok: true };
}

// ---------------- tools the assistant can call ----------------
const TOOLS = [
  {
    name: "list_devices",
    description: "List the user's paired computers with their online status, OS and autonomy level.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_on_device",
    description:
      "Dispatch an instruction to one of the user's computers to carry out (research, browse, open apps, work with files, run tasks). " +
      "The computer must be online to execute; if it is offline the task is queued and runs when it next connects. " +
      "Use this when the user asks JARVIS to actually DO something on a machine, not for questions you can answer yourself.",
    schema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device name, or 'auto' to let routing pick, or 'all' for every online computer. Defaults to auto." },
        instruction: { type: "string", description: "The full task for the computer to perform." },
      },
      required: ["instruction"],
      additionalProperties: false,
    },
  },
];

async function execTool(env: Env, user: { id: string; settings: any; automationPaused: boolean }, name: string, input: any, ip: string, actions: any[]): Promise<string> {
  if (name === "list_devices") {
    const ds = await listDevices(env, user.id);
    return JSON.stringify(ds.map((d) => ({ name: d.name, online: d.online, os: d.os, autonomy: d.permissions.autonomy, currentTasks: d.currentTasks })));
  }
  if (name === "run_on_device") {
    const instruction = String(input?.instruction ?? "").trim();
    if (!instruction) return "Error: an instruction is required.";
    if (user.automationPaused) return "Automation is paused for this account. Ask the user to resume it (Emergency stop → Resume) before dispatching work.";
    const devices = await listDevices(env, user.id);
    if (!devices.length) return "No computers are paired with this account yet, so there's nothing to run this on.";
    let target: string = "auto";
    const dev = String(input?.device ?? "").trim();
    if (dev && dev.toLowerCase() !== "auto") {
      if (dev.toLowerCase() === "all") target = "all";
      else {
        const m = devices.find((d) => d.name.toLowerCase() === dev.toLowerCase());
        if (!m) return `No device named "${dev}". Available: ${devices.map((d) => d.name).join(", ")}.`;
        target = m.id;
      }
    }
    try {
      const r = await createTask(env, { userId: user.id, prompt: instruction, target, source: "text", kind: "agent", defaultDeviceId: user.settings?.defaultDeviceId ?? null, ip });
      actions.push({ taskId: r.task.id, routedTo: r.routedTo, reason: r.reason, instruction: instruction.slice(0, 200) });
      return JSON.stringify({ dispatched: true, taskId: r.task.id, routedTo: r.routedTo, reason: r.reason });
    } catch (e: any) {
      return `Could not dispatch: ${e.message}`;
    }
  }
  return `Unknown tool ${name}`;
}

function systemPrompt(deviceSummary: string): string {
  return (
    "You are J.A.R.V.I.S., a calm, precise, confident assistant with a subtle dry wit, speaking to your operator " +
    "directly inside their web command center. You run in the cloud, so you can always talk, think, research from your " +
    "own knowledge, draft, plan and advise — even with no computer online.\n\n" +
    "To actually operate a machine (open apps, drive a browser, work with files, run commands), use the run_on_device " +
    "tool; that work happens on a paired Windows PC and needs it online (otherwise the task queues). Use list_devices to " +
    "see what's available. Don't claim to have done something on a machine unless you dispatched it with a tool.\n\n" +
    "Be concise and useful. No filler, no flattery. If a request is ambiguous, ask one sharp question.\n\n" +
    "Current time: " + new Date().toString() + "\n" +
    "Paired computers:\n" + deviceSummary
  );
}

// ---------------- provider calls ----------------
async function callAnthropic(apiKey: string, model: string, system: string, convo: any[], runTool: (n: string, i: any) => Promise<string>): Promise<string> {
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const messages = convo.map((m) => ({ role: m.role, content: m.content }));
  let finalText = "";
  for (let turn = 0; turn < 6; turn++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 2048, system, tools, messages }),
      });
    } catch (e: any) { throw new HttpError(502, `Could not reach the Anthropic API: ${e.message}`); }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Anthropic API ${res.status}: ${data?.error?.message ?? "request failed"}`);
    messages.push({ role: "assistant", content: data.content });
    for (const b of data.content ?? []) if (b.type === "text" && b.text) finalText = b.text;
    const toolUses = (data.content ?? []).filter((b: any) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || !toolUses.length) return finalText;
    const results = [];
    for (const tu of toolUses) {
      const out = await runTool(tu.name, tu.input ?? {});
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.slice(0, 8000) });
    }
    messages.push({ role: "user", content: results });
  }
  return finalText || "I wasn't able to complete that in a reasonable number of steps.";
}

async function callOpenAI(apiKey: string, model: string, system: string, convo: any[], runTool: (n: string, i: any) => Promise<string>): Promise<string> {
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const messages: any[] = [{ role: "system", content: system }, ...convo.map((m) => ({ role: m.role, content: m.content }))];
  for (let turn = 0; turn < 6; turn++) {
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 2048, messages, tools, tool_choice: "auto" }),
      });
    } catch (e: any) { throw new HttpError(502, `Could not reach the OpenAI API: ${e.message}`); }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `OpenAI API ${res.status}: ${data?.error?.message ?? "request failed"}`);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new HttpError(502, "OpenAI returned no message.");
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) return msg.content ?? "";
    for (const c of calls) {
      let args: any = {};
      try { args = JSON.parse(c.function?.arguments ?? "{}"); } catch { /* bad json from model */ }
      const out = await runTool(c.function?.name, args);
      messages.push({ role: "tool", tool_call_id: c.id, content: out.slice(0, 8000) });
    }
  }
  return "I wasn't able to complete that in a reasonable number of steps.";
}

export async function assistantChat(env: Env, user: { id: string; settings: any; automationPaused: boolean }, message: string, ip: string) {
  const text = String(message ?? "").trim();
  if (!text) throw new HttpError(400, "Say something to JARVIS.");
  if (text.length > 8000) throw new HttpError(400, "That message is too long.");
  const cfg = await env.DB.prepare("SELECT provider, model, api_key_enc FROM assistant_config WHERE user_id = ?").bind(user.id).first<AssistantRow>();
  if (!cfg?.api_key_enc) throw new HttpError(400, "Add an API key under the Assistant settings to chat with JARVIS in the cloud.");
  const provider = (cfg.provider as AssistantProvider) ?? "anthropic";
  const model = cfg.model || DEFAULT_MODEL[provider];
  const apiKey = await decryptSecret(env, cfg.api_key_enc);

  // Context: the user's devices.
  const devices = await listDevices(env, user.id);
  const deviceSummary = devices.length
    ? devices.map((d) => `- ${d.name} (${d.os || "Windows"}): ${d.online ? "ONLINE" : "offline"}, autonomy ${d.permissions.autonomy}`).join("\n")
    : "- (none paired yet)";

  // Recent history for continuity.
  const { results: hist } = await env.DB.prepare(
    "SELECT role, content FROM assistant_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(user.id, HISTORY_LIMIT).all<any>();
  const convo = hist.reverse().map((r: any) => ({ role: r.role, content: r.content }));
  convo.push({ role: "user", content: text });

  const actions: any[] = [];
  const runTool = (n: string, i: any) => execTool(env, user, n, i, ip, actions);
  const system = systemPrompt(deviceSummary);

  const reply = provider === "openai"
    ? await callOpenAI(apiKey, model, system, convo, runTool)
    : await callAnthropic(apiKey, model, system, convo, runTool);
  const replyText = (reply || "").trim() || "(no reply)";

  const ts = now();
  await env.DB.prepare("INSERT INTO assistant_messages (user_id, role, content, ts) VALUES (?,?,?,?)").bind(user.id, "user", text, ts).run();
  await env.DB.prepare("INSERT INTO assistant_messages (user_id, role, content, actions, ts) VALUES (?,?,?,?,?)")
    .bind(user.id, "assistant", truncate(replyText, 16000), actions.length ? JSON.stringify(actions) : null, ts + 1).run();

  return { reply: replyText, actions };
}
