import { useState } from "react";
import { isTerminal } from "../../../../packages/shared-types/src/index";
import { Api } from "../api";
import { Layout } from "../components/Layout";
import { ago, Markdown, statusDot, usePoll } from "../components/ui";

function describe(ev: { type: string; data: any }): string {
  const d = ev.data ?? {};
  if (ev.type === "status") return `→ ${d.status}${d.routedTo ? ` on ${d.routedTo.join(", ")} (${d.reason})` : ""}`;
  if (ev.type === "tool") return [d.tool ?? d.kind, d.detail ?? d.command ?? d.query ?? "", d.status ? `[${d.status}]` : ""].join(" ").trim();
  if (ev.type === "message") return d.text ?? "";
  if (ev.type === "input_request") return `needs approval: ${d.action}`;
  if (ev.type === "input_response") return d.approved ? "approved by user" : "denied by user";
  return d.message ?? JSON.stringify(d);
}

export function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, reload } = usePoll(() => Api.task(id), 2000, [id]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await reload(); } finally { setBusy(false); } };
  const t = data?.task;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        {!t ? <div className="empty">Loading…</div> : (
          <>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className={`badge ${t.status}`}>{t.status.replace(/_/g, " ")}</span>
              <button className="btn ghost sm" onClick={onClose}>Close</button>
            </div>
            <h2 style={{ letterSpacing: "0.04em", fontWeight: 600 }}>{t.prompt}</h2>
            <div className="task-meta">
              <span>{t.kind === "group" ? "multi-device" : t.deviceName}</span><span>source: {t.source}</span>
              <span>created {ago(t.createdAt)}</span>{t.finishedAt && <span>finished {ago(t.finishedAt)}</span>}
            </div>

            {t.status === "WAITING_FOR_INPUT" && t.pendingInput && (
              <div className="approval">
                <div style={{ color: "var(--amber)", letterSpacing: "0.2em", fontSize: 12, fontWeight: 600 }}>
                  {t.pendingInput.kind === "question" ? "JARVIS HAS A QUESTION" : `APPROVAL REQUIRED · ${t.pendingInput.risk?.toUpperCase() ?? "HIGH"} RISK`}
                </div>
                <p style={{ margin: "8px 0 4px", fontSize: 16 }}>{t.pendingInput.action}</p>
                <p className="note">{t.pendingInput.details}</p>
                <input className="input" placeholder={t.pendingInput.kind === "question" ? "Your answer" : "Optional note to JARVIS"} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn" disabled={busy} onClick={() => act(() => Api.respond(t.id, true, note))}>{t.pendingInput.kind === "question" ? "Send answer" : "Approve"}</button>
                  <button className="btn danger" disabled={busy} onClick={() => act(() => Api.respond(t.id, false, note))}>Deny</button>
                </div>
              </div>
            )}

            <div className="row" style={{ margin: "14px 0" }}>
              {!isTerminal(t.status) && <button className="btn danger sm" disabled={busy} onClick={() => act(() => Api.cancelTask(t.id))}>Cancel task</button>}
              {isTerminal(t.status) && t.kind !== "group" && <button className="btn sm" disabled={busy} onClick={() => act(() => Api.retry(t.id))}>Retry safely</button>}
            </div>

            {data.children.length > 0 && (
              <div className="panel" style={{ marginBottom: 16 }}>
                <div className="panel-title">Per-device</div>
                {data.children.map((c) => (
                  <div key={c.id} className="task-row" style={{ cursor: "default" }}>
                    <span className={statusDot(c.status)} />
                    <div><div className="task-prompt">{c.deviceName}</div><div className="task-meta">{c.error ?? ""}</div></div>
                    <span className={`badge ${c.status}`}>{c.status.replace(/_/g, " ")}</span>
                  </div>
                ))}
              </div>
            )}
            {t.result && <div className="panel" style={{ marginBottom: 16 }}><div className="panel-title">Result</div><Markdown text={t.result} /></div>}
            {t.error && <div className="error-box">{t.error}</div>}
            <div className="panel">
              <div className="panel-title">Execution trace <span className="count">{data.events.length}</span></div>
              <div className="timeline">
                {data.events.map((e) => (
                  <div className="ev" key={e.id}>
                    <span>{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><span className="t">{e.type}</span><span>{describe(e)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

export function Tasks() {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const { data } = usePoll(() => Api.tasks(`?limit=100${filter ? `&status=${filter}` : ""}`), 3000, [filter]);
  return (
    <Layout title="Tasks" right={
      <select className="target-select" style={{ padding: 8 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="">All statuses</option>
        {["QUEUED", "PLANNING", "RUNNING", "WAITING_FOR_INPUT", "VALIDATING", "COMPLETED", "FAILED", "CANCELLED"].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    }>
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Status</th><th>Instruction</th><th>Device</th><th>Source</th><th>Created</th></tr></thead>
          <tbody>
            {(data?.tasks ?? []).map((t) => (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setOpen(t.id)}>
                <td><span className={`badge ${t.status}`}>{t.status.replace(/_/g, " ")}</span></td>
                <td>{t.prompt}</td>
                <td className="mono">{t.kind === "group" ? "multi-device" : t.deviceName}</td>
                <td className="mono">{t.source}</td>
                <td className="mono">{ago(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.tasks.length === 0 && <div className="empty">No tasks match.</div>}
      </div>
      {open && <TaskDrawer id={open} onClose={() => setOpen(null)} />}
    </Layout>
  );
}
