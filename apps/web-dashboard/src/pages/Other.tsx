import { useEffect, useState, type FormEvent } from "react";
import type { Workflow } from "../../../../packages/shared-types/src/index";
import { Api, runControl } from "../api";
import { useAuth } from "../auth";
import { Layout } from "../components/Layout";
import { ago, usePoll } from "../components/ui";
import { ensureVoices, listVoices, pickVoice } from "../voice";

// ---------------- Workflows ----------------
const PRESETS = [
  { label: "Every morning 8:00", cron: "0 8 * * *" },
  { label: "Weekdays 9:30", cron: "30 9 * * 1-5" },
  { label: "Every Sunday 18:00", cron: "0 18 * * 0" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
];

export function Workflows() {
  const { data, reload } = usePoll(() => Api.workflows(), 10000);
  const devices = usePoll(() => Api.devices(), 15000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [form, setForm] = useState({ name: "", prompt: "", schedule: "0 8 * * *", deviceId: "" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await Api.createWorkflow({ ...form, deviceId: form.deviceId || null, timezone: tz }); setForm({ ...form, name: "", prompt: "" }); reload(); }
    catch (e: any) { setErr(e.message); }
  };
  const toggle = async (w: Workflow) => { await Api.updateWorkflow(w.id, { enabled: !w.enabled }); reload(); };
  return (
    <Layout title="Scheduled Workflows">
      <div className="grid-2">
        <div className="panel">
          <div className="panel-title">Workflows <span className="count">{data?.workflows.length ?? 0}</span></div>
          {(data?.workflows ?? []).map((w) => (
            <div className="task-row" key={w.id} style={{ cursor: "default" }}>
              <span className={`dot ${w.enabled ? "on" : ""}`} />
              <div>
                <div className="task-prompt">{w.name}</div>
                <div className="task-meta"><span>{w.schedule}</span><span>{w.timezone}</span><span>last run {ago(w.lastRunAt)}</span></div>
                <div className="note" style={{ marginTop: 4 }}>{w.prompt}</div>
              </div>
              <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <button className="btn sm" onClick={() => Api.runWorkflow(w.id).then(reload)}>Run now</button>
                <button className="btn ghost sm" onClick={() => toggle(w)}>{w.enabled ? "Disable" : "Enable"}</button>
                <button className="btn danger sm" onClick={() => confirm(`Delete "${w.name}"?`) && Api.deleteWorkflow(w.id).then(reload)}>Delete</button>
              </div>
            </div>
          ))}
          {data?.workflows.length === 0 && <div className="empty">No workflows yet.</div>}
        </div>
        <form className="panel" onSubmit={submit}>
          <div className="panel-title">New workflow</div>
          {err && <div className="error-box">{err}</div>}
          <div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Morning project check" required /></div>
          <div className="field"><label>Instructions</label><textarea className="input" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Check my project dashboard and summarise anything that changed overnight." required /></div>
          <div className="field"><label>Schedule (cron, {tz})</label>
            <input className="input" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} />
            <div className="row">{PRESETS.map((p) => <button type="button" key={p.cron} className="btn ghost sm" onClick={() => setForm({ ...form, schedule: p.cron })}>{p.label}</button>)}</div>
          </div>
          <div className="field"><label>Device</label>
            <select className="input" value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
              <option value="">Default / auto-route</option>
              {(devices.data?.devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button className="btn">Create workflow</button>
          <p className="note">Workflows run from the cloud scheduler, so they fire even if this browser is closed. If the device is offline the run waits up to 2 hours, then is marked failed.</p>
        </form>
      </div>
    </Layout>
  );
}

// ---------------- Memory ----------------
export function Memory() {
  const devices = usePoll(() => Api.devices(), 15000);
  const [deviceId, setDeviceId] = useState("");
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState({ category: "preference", content: "" });
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<any | null>(null);
  const list = devices.data?.devices ?? [];
  useEffect(() => { if (!deviceId && list.length) setDeviceId(list.find((d) => d.online)?.id ?? list[0].id); }, [list, deviceId]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const load = () => run(async () => setItems(await runControl(deviceId, "memory.list")));
  const add = (e: FormEvent) => { e.preventDefault(); run(async () => { await runControl(deviceId, "memory.add", newItem); setNewItem({ ...newItem, content: "" }); setItems(await runControl(deviceId, "memory.list")); }); };
  const del = (id: number) => run(async () => { await runControl(deviceId, "memory.delete", { id }); setItems(await runControl(deviceId, "memory.list")); });
  const search = (e: FormEvent) => { e.preventDefault(); run(async () => setFiles(await runControl(deviceId, "files.search", { query }))); };

  return (
    <Layout title="Memory & Files" right={
      <select className="target-select" style={{ padding: 8 }} value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setItems(null); }}>
        {list.map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? "" : " (offline)"}</option>)}
      </select>
    }>
      <p className="note" style={{ margin: 0 }}>Memory is stored locally on each computer in SQLite and is read on demand. Passwords are never stored in memory.</p>
      {err && <div className="error-box">{err}</div>}
      <div className="grid-2">
        <div className="panel">
          <div className="panel-title">Long-term memory <span className="right"><button className="btn sm" onClick={load} disabled={busy || !deviceId}>{items ? "Refresh" : "Load from device"}</button></span></div>
          {items?.map((m) => (
            <div className="task-row" key={m.id} style={{ cursor: "default" }}>
              <span className="dot on" />
              <div><div className="task-prompt">{m.content}</div><div className="task-meta"><span>{m.category}</span><span>{ago(m.updatedAt)}</span></div></div>
              <button className="btn ghost sm" onClick={() => del(m.id)} disabled={busy}>Forget</button>
            </div>
          ))}
          {items?.length === 0 && <div className="empty">Nothing remembered yet.</div>}
          <form onSubmit={add} className="row" style={{ marginTop: 14 }}>
            <select className="target-select" style={{ padding: 10 }} value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}>
              {["preference", "project", "context", "website", "application", "document", "workflow", "research"].map((c) => <option key={c}>{c}</option>)}
            </select>
            <input className="input" style={{ flex: 1 }} placeholder="I prefer reports as PDF" value={newItem.content} onChange={(e) => setNewItem({ ...newItem, content: e.target.value })} />
            <button className="btn" disabled={busy || !newItem.content}>Remember</button>
          </form>
        </div>
        <div className="panel">
          <div className="panel-title">Find files (approved folders only)</div>
          <form onSubmit={search} className="row">
            <input className="input" style={{ flex: 1 }} placeholder="project-report.pdf or *.docx" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn" disabled={busy || !query}>Search</button>
          </form>
          <div style={{ marginTop: 12 }}>
            {files?.hits?.map((h: any) => <div key={h.path} className="task-meta" style={{ padding: "6px 0", color: "var(--text)" }}>{h.path} <span style={{ color: "var(--muted)" }}>· {(h.size / 1024).toFixed(0)} KB</span></div>)}
            {files && files.hits?.length === 0 && <div className="empty">No matching files.</div>}
          </div>
        </div>
      </div>
    </Layout>
  );
}

// ---------------- Security log ----------------
export function Logs() {
  const { data } = usePoll(() => Api.audit(), 10000);
  return (
    <Layout title="Security Log">
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>
            {(data?.logs ?? []).map((l) => (
              <tr key={l.id}>
                <td className="mono">{new Date(l.ts).toLocaleString()}</td>
                <td className="mono">{l.actor}</td>
                <td>{l.action}</td>
                <td className="mono" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis" }}>{typeof l.detail === "string" ? l.detail : JSON.stringify(l.detail)}</td>
                <td className="mono">{l.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

// ---------------- Settings ----------------
export function Settings() {
  const { me, setMe, signOut } = useAuth();
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setVoices(listVoices()); // best (natural/neural) first
    ensureVoices().then(load); window.speechSynthesis?.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", load);
  }, []);
  const NATURAL = /natural|neural|online|google|siri|premium|enhanced|wavenet/i;
  if (!me) return null;
  const s = me.settings;
  const save = async (patch: any) => { const r = await Api.updateSettings(patch); setMe({ ...me, settings: r.settings }); };
  const n = s.notifications;
  const change = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    try { await Api.changePassword(cur, next); setCur(""); setNext(""); setMsg("Password changed. Other sessions were signed out."); }
    catch (e: any) { setMsg(e.message); }
  };
  return (
    <Layout title="Settings">
      <div className="grid-3">
        <div className="panel">
          <div className="panel-title">Account</div>
          <p className="note">Signed in as <b style={{ color: "var(--text)" }}>{me.user.username}</b></p>
          <form onSubmit={change}>
            <div className="field"><label>Current password</label><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
            <div className="field"><label>New password</label><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} /></div>
            <button className="btn">Change password</button>
          </form>
          {msg && <p className="note">{msg}</p>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => signOut(false)}>Sign out</button>
            <button className="btn danger" onClick={() => confirm("Sign out of every browser?") && signOut(true)}>Sign out everywhere</button>
          </div>
        </div>
        <div className="panel">
          <div className="panel-title">Windows notifications</div>
          <p className="note">Applied by every paired PC on its next sync.</p>
          {([["startup", "Startup notification (“JARVIS is online”)"], ["taskCompletion", "Task completed"], ["errors", "Important errors"], ["security", "Security events & approvals"]] as const).map(([k, label]) => (
            <label className="check" key={k} style={{ margin: "10px 0" }}><input type="checkbox" checked={n[k]} onChange={(e) => save({ notifications: { ...n, [k]: e.target.checked } })} />{label}</label>
          ))}
          <label className="check" style={{ margin: "14px 0 8px" }}><input type="checkbox" checked={n.quietHours.enabled} onChange={(e) => save({ notifications: { ...n, quietHours: { ...n.quietHours, enabled: e.target.checked } } })} />Quiet hours</label>
          <div className="row">
            <input className="input" type="time" style={{ width: 130 }} value={n.quietHours.start} onChange={(e) => save({ notifications: { ...n, quietHours: { ...n.quietHours, start: e.target.value } } })} />
            <span className="note">to</span>
            <input className="input" type="time" style={{ width: 130 }} value={n.quietHours.end} onChange={(e) => save({ notifications: { ...n, quietHours: { ...n.quietHours, end: e.target.value } } })} />
          </div>
          <p className="note">Windows Focus Assist / Do Not Disturb and full-screen apps are always respected.</p>
        </div>
        <div className="panel">
          <div className="panel-title">Voice & display</div>
          <div className="field"><label>Browser voice</label>
            <select className="input" value={s.voiceName ?? ""} onChange={(e) => save({ voiceName: e.target.value || null })}>
              <option value="">Automatic (best available)</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{NATURAL.test(v.name) ? "★ " : ""}{v.name} — {v.lang}</option>)}
            </select>
            <p className="note" style={{ marginTop: 6 }}>★ marks natural / neural voices (best quality). If the list is short, install more in your OS voice settings — e.g. Microsoft “Online (Natural)” or a Google voice in Chrome.</p>
          </div>
          <button className="btn ghost sm" onClick={() => {
            const u = new SpeechSynthesisUtterance("All systems online. Standing by for your orders.");
            const v = pickVoice(s.voiceName); if (v) { u.voice = v; u.lang = v.lang; }
            const nat = v ? NATURAL.test(v.name) : false;
            u.rate = nat ? 1.0 : 0.96; u.pitch = nat ? 1.0 : 0.9;
            window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
          }}>Test voice</button>
          <label className="check" style={{ marginTop: 18 }}><input type="checkbox" checked={s.reducedMotion} onChange={(e) => save({ reducedMotion: e.target.checked })} />Reduce motion</label>
        </div>
      </div>
    </Layout>
  );
}
