import { useEffect, useState } from "react";
import type { Device, PermissionProfile } from "../../../../packages/shared-types/src/index";
import { Api, runControl } from "../api";
import { useAuth } from "../auth";
import { Layout } from "../components/Layout";
import { ago, gb, usePoll } from "../components/ui";

const lines = (a: string[]) => a.join("\n");
const parse = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const fmtSize = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

interface IndexNode { name: string; type: "dir" | "file"; path: string; size?: number; children?: IndexNode[]; truncated?: boolean }
interface FileIndex { roots: IndexNode[]; fileCount: number; dirCount: number; bytes: number; byExt: { ext: string; count: number }[]; summary: string; truncated: boolean; scannedAt: number }

function TreeNode({ node, depth, onDownload, onDelete }: { node: IndexNode; depth: number; onDownload: (p: string) => void; onDelete: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: 10 + depth * 14 };
  if (node.type === "file") {
    return (
      <div className="tree-row file" style={pad}>
        <span className="tree-label"><span className="tree-ico">📄</span>{node.name}</span>
        <span className="tree-actions">
          <span className="tree-size">{fmtSize(node.size)}</span>
          <button className="btn ghost xs" onClick={() => onDownload(node.path)}>download</button>
          <button className="btn danger xs" onClick={() => onDelete(node.path)}>delete</button>
        </span>
      </div>
    );
  }
  const kids = node.children ?? [];
  return (
    <div>
      <div className="tree-row dir" style={pad} onClick={() => setOpen((o) => !o)}>
        <span className="tree-label"><span className="tree-ico">{open ? "📂" : "📁"}</span>{depth === 0 ? node.path : node.name}</span>
        <span className="tree-count">{kids.length ? `${kids.length}` : node.truncated ? "…" : "empty"}</span>
      </div>
      {open && kids.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} onDownload={onDownload} onDelete={onDelete} />)}
    </div>
  );
}

function DeviceControl({ device }: { device: Device }) {
  const online = device.online;
  const caps = device.capabilities;
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string>("");
  const [cmd, setCmd] = useState("");
  const [cwd, setCwd] = useState("");
  const [msg, setMsg] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [index, setIndex] = useState<FileIndex | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);

  const call = async (action: string, args: any = {}) => {
    setBusy(true);
    try { return await runControl(device.id, action, args, 150_000); }
    catch (e: any) { setOut((o) => `${o}\n! ${e.message}`.trim()); throw e; }
    finally { setBusy(false); }
  };

  // On connect, fetch the file tree and let the AI learn what's on the machine — automatically.
  const scan = async () => {
    setScanning(true); setScanErr(null);
    try { setIndex(await runControl(device.id, "files.index", {}, 150_000)); }
    catch (e: any) { setScanErr(e.message); }
    finally { setScanning(false); }
  };
  useEffect(() => { if (online) scan(); /* eslint-disable-next-line */ }, [device.id, online]);

  const runCmd = async () => {
    if (!cmd.trim()) return;
    setOut((o) => `${o}\n$ ${cmd}`.trim());
    try { const r = await call("terminal.exec", { command: cmd, cwd: cwd || undefined }); setOut((o) => `${o}\n${r.output}\n[exit ${r.exitCode}]`.trim()); if (r.cwd) setCwd(r.cwd); setCmd(""); } catch { /* shown */ }
  };
  const power = async (action: string) => {
    const label = { shutdown: "shut down", restart: "restart", sleep: "sleep", lock: "lock" }[action] ?? action;
    if ((action === "shutdown" || action === "restart") && !confirm(`${label} ${device.name}? Unsaved work there could be lost (60-second cancel window).`)) return;
    try { const r = await call(`power.${action}`, {}); setOut((o) => `${o}\n⏻ ${r.message ?? label}`.trim()); } catch { /* shown */ }
  };
  const download = async (p: string) => {
    try {
      const r = await call("files.fetch", { path: p });
      const a = document.createElement("a");
      a.href = `data:application/octet-stream;base64,${r.base64}`;
      a.download = r.name; a.click();
    } catch { /* shown */ }
  };
  const del = async (p: string) => {
    if (!confirm(`Delete ${p} on ${device.name}? This cannot be undone.`)) return;
    try { const r = await call("files.delete", { path: p, confirmed: true }); setOut((o) => `${o}\n🗑 ${r.message ?? "deleted"}`.trim()); scan(); } catch { /* shown */ }
  };
  const viewScreen = async () => { try { const r = await call("screen.capture", {}); setShot(`data:image/png;base64,${r.base64}`); } catch { /* shown */ } };
  const sendMsg = async () => { if (!msg.trim()) return; try { await call("message.show", { title: "JARVIS", body: msg }); setOut((o) => `${o}\n✉ delivered to ${device.name}'s screen`.trim()); setMsg(""); } catch { /* shown */ } };

  if (!online) return <p className="note" style={{ marginTop: 12 }}>This device is offline. Controls are available when it reconnects.</p>;
  const term = caps?.terminal ?? "scoped";
  return (
    <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <label>Power {caps && !caps.power && <span className="note">(disabled on this PC)</span>}</label>
        <div className="row">
          {(["shutdown", "restart", "sleep", "lock"] as const).map((p) => (
            <button key={p} className={`btn sm ${p === "shutdown" ? "danger" : p === "restart" ? "amber" : "ghost"}`} disabled={busy || !!(caps && !caps.power)} onClick={() => power(p)}>{p}</button>
          ))}
          <button className="btn ghost sm" disabled={busy} onClick={() => power("cancel" as any)}>cancel shutdown</button>
        </div>
      </div>

      <div>
        <label>Message the screen {caps && !caps.messenger && <span className="note">(disabled on this PC)</span>}</label>
        <div className="row">
          <input className="input" style={{ flex: 1 }} placeholder="Type a message to pop up on that PC" value={msg} disabled={busy || !!(caps && !caps.messenger)} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMsg()} />
          <button className="btn sm" disabled={busy || !!(caps && !caps.messenger)} onClick={sendMsg}>Send</button>
        </div>
      </div>

      <div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label style={{ margin: 0 }}>Files on this computer</label>
          <span className="row">
            <button className="btn ghost sm" disabled={scanning} onClick={scan}>{scanning ? "Scanning…" : "Rescan & learn"}</button>
            <button className="btn ghost sm" disabled={busy || !!(caps && !caps.screen)} onClick={viewScreen}>View screen</button>
          </span>
        </div>
        {scanErr && <p className="note" style={{ color: "var(--danger)" }}>{scanErr}</p>}
        {index && (
          <>
            <div className="learned">
              <span className="learned-pip" /> {index.summary}
            </div>
            <div className="file-tree">
              {index.roots.length === 0 && <div className="note" style={{ padding: 10 }}>No approved folders to browse. Add one under Permissions.</div>}
              {index.roots.map((r) => <TreeNode key={r.path} node={r} depth={0} onDownload={download} onDelete={del} />)}
            </div>
          </>
        )}
        {!index && !scanErr && <div className="note" style={{ padding: 10 }}>Fetching the file directory…</div>}
        {shot && <img src={shot} alt="screen" style={{ marginTop: 10, maxWidth: "100%", borderRadius: 8, border: "1px solid var(--line)" }} />}
      </div>

      <div>
        <label>Terminal {term === "off" ? <span className="note">(disabled on this PC)</span> : <span className="note">({term})</span>}</label>
        {out && <pre className="md" style={{ maxHeight: 220, overflow: "auto", fontSize: 12, background: "rgba(0,0,0,.35)", padding: 10, borderRadius: 8, whiteSpace: "pre-wrap" }}>{out}</pre>}
        <div className="row">
          <input className="input" style={{ flex: 1, fontFamily: "monospace" }} placeholder={term === "off" ? "terminal disabled in this PC's policy" : "command, e.g. git status"} value={cmd}
            disabled={busy || term === "off"} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runCmd()} />
          <button className="btn sm" disabled={busy || term === "off"} onClick={runCmd}>Run</button>
        </div>
        {cwd && <div className="note" style={{ fontFamily: "monospace", fontSize: 11 }}>cwd: {cwd}</div>}
      </div>
    </div>
  );
}

function PermissionsEditor({ device, onSaved }: { device: Device; onSaved: () => void }) {
  const [p, setP] = useState<PermissionProfile>(device.permissions);
  const [dirs, setDirs] = useState(lines(p.approvedDirs));
  const [apps, setApps] = useState(lines(p.allowedApps));
  const [domains, setDomains] = useState(lines(p.browserDomains));
  const [cmds, setCmds] = useState(lines(p.allowedCommands));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      await Api.updateDevice(device.id, { permissions: { ...p, approvedDirs: parse(dirs), allowedApps: parse(apps), browserDomains: parse(domains), allowedCommands: parse(cmds) } });
      setMsg("Saved. The device applies it on its next sync (capped by its local policy).");
      onSaved();
    } catch (e: any) { setMsg(e.message); } finally { setSaving(false); }
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div className="field"><label>Autonomy</label>
        <select className="input" value={p.autonomy} onChange={(e) => setP({ ...p, autonomy: e.target.value as any })}>
          <option value="routine">Routine — act on low-risk steps, confirm high-risk actions</option>
          <option value="confirm-all">Confirm everything that changes something</option>
          <option value="serious">Serious — full authority, only truly irreversible actions are held</option>
        </select>
      </div>
      <div className="field"><label>Default workspace</label><input className="input" value={p.workspaceDir} onChange={(e) => setP({ ...p, workspaceDir: e.target.value })} placeholder="(device default)" /></div>
      <div className="field"><label>Approved directories (one per line; empty = device policy)</label><textarea className="input" value={dirs} onChange={(e) => setDirs(e.target.value)} /></div>
      <div className="field"><label>Allowed applications (* = any)</label><textarea className="input" value={apps} onChange={(e) => setApps(e.target.value)} /></div>
      <div className="field"><label>Browser domains (empty = any)</label><textarea className="input" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="github.com" /></div>
      <div className="field"><label>Allowed command names (defined in the device's local policy)</label><textarea className="input" value={cmds} onChange={(e) => setCmds(e.target.value)} placeholder="build-tests" /></div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="check"><input type="checkbox" checked={p.allowNetworkInSandbox} onChange={(e) => setP({ ...p, allowNetworkInSandbox: e.target.checked })} /> Network inside the code sandbox</label>
        <label className="check"><input type="checkbox" checked={p.voice} onChange={(e) => setP({ ...p, voice: e.target.checked })} /> Local voice</label>
        <label className="check"><input type="checkbox" checked={p.rea} onChange={(e) => setP({ ...p, rea: e.target.checked })} /> REA integration</label>
        <label className="check"><input type="checkbox" checked={p.power} onChange={(e) => setP({ ...p, power: e.target.checked })} /> Power control</label>
        <label className="check"><input type="checkbox" checked={p.screen} onChange={(e) => setP({ ...p, screen: e.target.checked })} /> Screen view</label>
        <label className="check"><input type="checkbox" checked={p.messenger} onChange={(e) => setP({ ...p, messenger: e.target.checked })} /> Messenger</label>
      </div>
      <div className="field"><label>Terminal</label>
        <select className="input" value={p.terminal} onChange={(e) => setP({ ...p, terminal: e.target.value as any })}>
          <option value="off">Off</option>
          <option value="scoped">Scoped — runs inside approved folders</option>
          <option value="full">Full — unrestricted shell (only if the PC's local policy allows it)</option>
        </select>
      </div>
      <button className="btn" onClick={save} disabled={saving}>Save permissions</button>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}

export function Devices() {
  const { me, refresh } = useAuth();
  const { data, reload } = usePoll(() => Api.devices(), 5000);
  const [code, setCode] = useState<{ code: string; expiresAt: number; reusable?: boolean } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [controlling, setControlling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const newCode = async () => { setErr(null); try { setCode(await Api.pairingCode()); } catch (e: any) { setErr(e.message); } };
  const newEnroll = async () => { setErr(null); try { setCode(await Api.enrollmentCode(30)); } catch (e: any) { setErr(e.message); } };
  const revoke = async (d: Device) => {
    if (!confirm(`Revoke ${d.name}? It will be disconnected immediately and must be paired again.`)) return;
    await Api.revokeDevice(d.id); reload();
  };
  const rename = async (d: Device) => {
    const name = prompt("New device name", d.name);
    if (name) { await Api.updateDevice(d.id, { name }); reload(); }
  };
  const makeDefault = async (d: Device) => { await Api.updateSettings({ defaultDeviceId: d.id }); refresh(); };

  return (
    <Layout title="Connected Devices">
      <div className="panel">
        <div className="panel-title">Pair a new computer</div>
        <div className="row" style={{ gap: 24, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <p className="note">Install <b>JARVIS-Setup.exe</b> on the PC. At the <i>Device pairing</i> step, enter a code below. One-time codes expire after 10 minutes; enrollment codes are reusable for 30 days and are what you bake into a pre-configured installer.</p>
            <div className="row">
              <button className="btn" onClick={newCode}>One-time pairing code</button>
              <button className="btn ghost" onClick={newEnroll}>Create enrollment code</button>
            </div>
            {err && <div className="error-box" style={{ marginTop: 12 }}>{err}</div>}
          </div>
          {code && (
            <div style={{ textAlign: "center" }}>
              <div className="code-big">{code.code}</div>
              <div className="task-meta" style={{ justifyContent: "center" }}>
                {code.reusable ? "reusable · " : ""}expires {new Date(code.expiresAt).toLocaleString()}
              </div>
              {code.reusable && <div className="note" style={{ maxWidth: 260, margin: "6px auto 0" }}>Bake this into the installer build (<code>PAIR_CODE</code> repo variable) for download-and-run setup.</div>}
            </div>
          )}
        </div>
      </div>

      <div className="cards">
        {(data?.devices ?? []).map((d) => {
          const caps = d.capabilities;
          const isDefault = me?.settings.defaultDeviceId === d.id;
          return (
            <div key={d.id} className="panel device-card">
              <div className="head">
                <span className={`dot ${d.online ? "on" : ""}`} />
                <div style={{ flex: 1 }}>
                  <div className="name">{d.name}{isDefault && <span className="badge" style={{ marginLeft: 8 }}>DEFAULT</span>}</div>
                  <div className="sub">{d.os || "Windows"} · agent {d.agentVersion || "?"} · {d.online ? "online" : `seen ${ago(d.lastHeartbeat)}`}</div>
                </div>
              </div>
              {d.metrics && (
                <>
                  <div className="kv"><span>CPU</span><div className="meter"><i style={{ width: `${d.metrics.cpuPercent}%` }} /></div><b>{d.metrics.cpuPercent.toFixed(0)}%</b></div>
                  <div className="kv"><span>MEMORY</span><div className="meter"><i style={{ width: `${(d.metrics.memUsedBytes / d.metrics.memTotalBytes) * 100}%` }} /></div><b>{gb(d.metrics.memTotalBytes)}</b></div>
                  {d.metrics.disks.slice(0, 3).map((k) => (
                    <div className="kv" key={k.mount}><span>DISK {k.mount}</span><div className={`meter ${k.usedBytes / k.totalBytes > 0.9 ? "hot" : ""}`}><i style={{ width: `${(k.usedBytes / k.totalBytes) * 100}%` }} /></div><b>{gb(k.totalBytes - k.usedBytes)}</b></div>
                  ))}
                </>
              )}
              <div className="caps">
                <span className={`cap ${d.sessionActive ? "on" : ""}`}>{d.sessionActive ? "desktop unlocked" : "desktop locked"}</span>
                <span className={`cap ${caps?.codex === "ready" ? "on" : ""}`}>codex {caps?.codex ?? "unknown"}</span>
                <span className={`cap ${caps?.browser ? "on" : ""}`}>browser</span>
                <span className={`cap ${caps?.voice ? "on" : ""}`}>voice</span>
                <span className={`cap ${caps?.vault ? "on" : ""}`}>vault</span>
                <span className={`cap ${caps?.rea ? "on" : ""}`}>rea</span>
                <span className="cap">{d.permissions.autonomy}</span>
                <span className="cap">{d.currentTasks} active</span>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => setControlling(controlling === d.id ? null : d.id)}>{controlling === d.id ? "Close" : "Control"}</button>
                <button className="btn sm" onClick={() => setEditing(editing === d.id ? null : d.id)}>Permissions</button>
                <button className="btn ghost sm" onClick={() => rename(d)}>Rename</button>
                {!isDefault && <button className="btn ghost sm" onClick={() => makeDefault(d)}>Make default</button>}
                <button className="btn danger sm" onClick={() => revoke(d)}>Revoke</button>
              </div>
              {controlling === d.id && <DeviceControl device={d} />}
              {editing === d.id && <PermissionsEditor device={d} onSaved={reload} />}
            </div>
          );
        })}
      </div>
      {data && data.devices.length === 0 && <div className="panel empty">No computers are paired with this account yet.</div>}
    </Layout>
  );
}
