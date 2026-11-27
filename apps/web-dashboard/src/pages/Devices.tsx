import { useState } from "react";
import type { Device, PermissionProfile } from "../../../../packages/shared-types/src/index";
import { Api } from "../api";
import { useAuth } from "../auth";
import { Layout } from "../components/Layout";
import { ago, gb, usePoll } from "../components/ui";

const lines = (a: string[]) => a.join("\n");
const parse = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

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
      </div>
      <button className="btn" onClick={save} disabled={saving}>Save permissions</button>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}

export function Devices() {
  const { me, refresh } = useAuth();
  const { data, reload } = usePoll(() => Api.devices(), 5000);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const newCode = async () => { setErr(null); try { setCode(await Api.pairingCode()); } catch (e: any) { setErr(e.message); } };
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
            <p className="note">Install <b>JARVIS-Setup.exe</b> on the PC. At the <i>Device pairing</i> step, enter this one-time code. Codes expire after 10 minutes and work once.</p>
            <button className="btn" onClick={newCode}>Generate pairing code</button>
            {err && <div className="error-box" style={{ marginTop: 12 }}>{err}</div>}
          </div>
          {code && (
            <div style={{ textAlign: "center" }}>
              <div className="code-big">{code.code}</div>
              <div className="task-meta" style={{ justifyContent: "center" }}>expires {new Date(code.expiresAt).toLocaleTimeString()}</div>
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
                <button className="btn sm" onClick={() => setEditing(editing === d.id ? null : d.id)}>Permissions</button>
                <button className="btn ghost sm" onClick={() => rename(d)}>Rename</button>
                {!isDefault && <button className="btn ghost sm" onClick={() => makeDefault(d)}>Make default</button>}
                <button className="btn danger sm" onClick={() => revoke(d)}>Revoke</button>
              </div>
              {editing === d.id && <PermissionsEditor device={d} onSaved={reload} />}
            </div>
          );
        })}
      </div>
      {data && data.devices.length === 0 && <div className="panel empty">No computers are paired with this account yet.</div>}
    </Layout>
  );
}
