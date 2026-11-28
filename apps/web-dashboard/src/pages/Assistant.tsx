import { useEffect, useRef, useState } from "react";
import { Api, type AssistantMessage, type AssistantState } from "../api";
import { Layout } from "../components/Layout";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", placeholder: "sk-ant-…", defaultModel: "claude-opus-4-8", help: "console.anthropic.com → API keys" },
  { id: "openai", label: "OpenAI (GPT)", placeholder: "sk-…", defaultModel: "gpt-4o", help: "platform.openai.com → API keys" },
];

function Setup({ state, onSaved }: { state: AssistantState; onSaved: (s: Partial<AssistantState>) => void }) {
  const [provider, setProvider] = useState(state.provider || "anthropic");
  const [model, setModel] = useState(state.model || "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const prov = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await Api.assistantConfig({ provider, model: model.trim() || prov.defaultModel, apiKey: apiKey.trim() || undefined });
      onSaved({ configured: r.configured, provider: r.provider, model: r.model });
      setApiKey(""); setMsg("Saved.");
    } catch (e: any) { setMsg(e.message); } finally { setSaving(false); }
  };
  const removeKey = async () => {
    if (!confirm("Remove the stored API key? Cloud chat will stop working until you add one again.")) return;
    try { await Api.assistantClearKey(); onSaved({ configured: false }); } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div className="panel">
      <div className="panel-title">Connect an AI <span className="right note" style={{ marginLeft: "auto" }}>{state.configured ? "key stored ✓" : "no key yet"}</span></div>
      <p className="note" style={{ marginTop: -4 }}>
        This talks to the AI <b>directly in the dashboard</b> — it works even when no computer is online. Paste your own
        API key (stored encrypted, never shown to the AI and never sent to your PCs). Costs are billed by your provider.
      </p>
      <div className="row" style={{ alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
        <div className="field" style={{ marginBottom: 0, minWidth: 190 }}>
          <label>Provider</label>
          <select className="input" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(""); }}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0, minWidth: 190 }}>
          <label>Model</label>
          <input className="input" value={model} placeholder={prov.defaultModel} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240 }}>
          <label>API key {state.configured && <span className="note">(leave blank to keep current)</span>}</label>
          <input className="input" type="password" value={apiKey} placeholder={state.configured ? "•••••••• stored" : prov.placeholder} onChange={(e) => setApiKey(e.target.value)} />
        </div>
        <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        {state.configured && <button className="btn ghost" onClick={removeKey}>Remove key</button>}
      </div>
      <div className="note" style={{ marginTop: 8 }}>Get a key: {prov.help}</div>
      {msg && <p className="note" style={{ color: msg === "Saved." ? "var(--green)" : "var(--danger)" }}>{msg}</p>}
    </div>
  );
}

function Bubble({ m }: { m: AssistantMessage }) {
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-who">{m.role === "user" ? "You" : "JARVIS"}</div>
      <div className="chat-body">{m.content}</div>
      {m.actions?.length > 0 && (
        <div className="chat-actions">
          {m.actions.map((a) => (
            <a key={a.taskId} className="chip" href="#/tasks" title={a.instruction}>↗ dispatched to {a.routedTo.join(", ") || a.reason}</a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Assistant() {
  const [state, setState] = useState<AssistantState | null>(null);
  const [msgs, setMsgs] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { Api.assistant().then((s) => { setState(s); setMsgs(s.history); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setErr(null);
    setMsgs((m) => [...m, { role: "user", content: text, actions: [], ts: Date.now() }]);
    setInput(""); setBusy(true);
    try {
      const r = await Api.assistantChat(text);
      setMsgs((m) => [...m, { role: "assistant", content: r.reply, actions: r.actions, ts: Date.now() }]);
    } catch (e: any) {
      setErr(e.message);
      setMsgs((m) => [...m, { role: "assistant", content: `⚠ ${e.message}`, actions: [], ts: Date.now() }]);
    } finally { setBusy(false); }
  };
  const clearChat = async () => {
    if (!confirm("Clear this conversation?")) return;
    try { await Api.assistantClearHistory(); setMsgs([]); } catch (e: any) { setErr(e.message); }
  };

  const right = <span className="status-pill">{state?.configured ? `${state.provider} · ${state.model}` : "not connected"}</span>;

  return (
    <Layout title="JARVIS Assistant" right={right}>
      {state && <Setup state={state} onSaved={(s) => setState((p) => (p ? { ...p, ...s } : p))} />}

      <div className="panel chat-panel">
        <div className="panel-title">
          Conversation
          <span className="right" style={{ marginLeft: "auto" }}>
            {msgs.length > 0 && <button className="btn ghost sm" onClick={clearChat}>Clear</button>}
          </span>
        </div>
        <div className="chat-scroll" ref={scroller}>
          {msgs.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-mark" />
              <p>I'm online and ready. Ask me anything, have me plan or draft something, or tell me to run a task on one of your computers.</p>
              <div className="chat-suggest">
                {["Summarise what my devices can do", "Draft a plan to organise my Documents folder", "On my main PC, check for updates and report back"].map((s) => (
                  <button key={s} className="btn ghost sm" disabled={!state?.configured || busy} onClick={() => setInput(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => <Bubble key={i} m={m} />)}
          {busy && <div className="chat-msg assistant"><div className="chat-who">JARVIS</div><div className="chat-body thinking">thinking<span>.</span><span>.</span><span>.</span></div></div>}
        </div>
        {err && <div className="error-box" style={{ margin: "0 0 10px" }}>{err}</div>}
        <div className="command-input" style={{ marginTop: 4 }}>
          <span className="prompt-glyph">›</span>
          <input
            placeholder={state?.configured ? "Message JARVIS…" : "Add an API key above to start chatting"}
            value={input} disabled={!state?.configured || busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="btn" onClick={send} disabled={!state?.configured || busy || !input.trim()}>Send</button>
        </div>
      </div>
    </Layout>
  );
}
