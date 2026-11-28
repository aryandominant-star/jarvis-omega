import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "../../../../packages/shared-types/src/index";
import { Api } from "../api";
import { useAuth } from "../auth";
import { Universe3D, type CoreState } from "../components/Universe3D";
import { ago, gb, Icon, statusDot, usePoll, Waveform } from "../components/ui";
import { TaskDrawer } from "./Tasks";
import { useVoice, voiceSupported } from "../voice";

const RAIL = [
  { to: "/devices", label: "Devices", icon: Icon.devices },
  { to: "/tasks", label: "Tasks", icon: Icon.tasks },
  { to: "/workflows", label: "Workflows", icon: Icon.flows },
  { to: "/memory", label: "Memory", icon: Icon.memory },
  { to: "/logs", label: "Security", icon: Icon.logs },
  { to: "/settings", label: "Settings", icon: Icon.settings },
];

export function Universe() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState("auto");
  const [flash, setFlash] = useState<{ text: string; bad?: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [serious, setSerious] = useState(false);
  const [arming, setArming] = useState(false);
  const voiceTasks = useRef(new Set<string>());
  const spokenFor = useRef(new Set<string>());
  const prevAutonomy = useRef(new Map<string, "routine" | "confirm-all" | "serious">());

  const devicesQ = usePoll(() => Api.devices(), 4000);
  const tasksQ = usePoll(() => Api.tasks("?limit=14"), 2500);
  const devices = devicesQ.data?.devices ?? [];
  const tasks = tasksQ.data?.tasks ?? [];
  const offline = !!(devicesQ.error && tasksQ.error);

  const send = async (text: string, source: "text" | "voice") => {
    if (!text.trim()) return;
    setSending(true); setFlash(null);
    try {
      const r = await Api.createTask({ prompt: text, deviceId: target, source });
      if (source === "voice") voiceTasks.current.add(r.task.id);
      setFlash({ text: `Dispatched to ${r.routedTo.join(", ")} — ${r.reason}.` });
      setPrompt(""); tasksQ.reload();
    } catch (e: any) {
      setFlash({ text: e.message, bad: true });
      if (source === "voice") voice.speak(e.message);
    } finally { setSending(false); }
  };
  const voice = useVoice({ onCommand: (t) => send(t, "voice"), voiceName: me?.settings.voiceName ?? null });

  useEffect(() => {
    for (const t of tasks) {
      if (!voiceTasks.current.has(t.id) || spokenFor.current.has(t.id)) continue;
      if (t.status === "COMPLETED" || t.status === "FAILED") {
        spokenFor.current.add(t.id);
        voice.speak((t.status === "COMPLETED" ? t.result ?? "Done." : `That didn't work. ${t.error ?? ""}`).split(/(?<=[.!?])\s/).slice(0, 2).join(" "));
      }
    }
  }, [tasks, voice]);

  const active = tasks.filter((t) => !["COMPLETED", "FAILED", "CANCELLED"].includes(t.status));
  const waiting = active.find((t) => t.status === "WAITING_FOR_INPUT");
  const online = devices.filter((d) => d.online).length;
  const sel = devices.find((d) => d.id === selected);

  const coreState: CoreState = useMemo(() => {
    if (offline) return "offline";
    if (voice.speaking) return "speaking";
    if (voice.listening) return "listening";
    if (active.some((t) => t.status === "RUNNING" || t.status === "VALIDATING")) return "executing";
    if (active.some((t) => t.status === "PLANNING" || t.status === "QUEUED")) return "thinking";
    if (waiting) return "error";
    return "idle";
  }, [offline, voice.speaking, voice.listening, active, waiting]);

  // Reflect serious mode from the fleet: if every paired device is already on full authority, show as armed.
  useEffect(() => {
    if (!devices.length) return;
    const allSerious = devices.every((d) => d.permissions?.autonomy === "serious");
    setSerious((s) => (s !== allSerious ? allSerious : s));
  }, [devices.map((d) => d.permissions?.autonomy).join(",")]);

  const toggleSerious = async () => {
    if (arming) return;
    if (!devices.length) { setFlash({ text: "Pair a computer first — there's nothing to command.", bad: true }); return; }
    if (serious) {
      setArming(true);
      try {
        for (const d of devices) {
          const back = prevAutonomy.current.get(d.id) ?? "routine";
          await Api.updateDevice(d.id, { permissions: { ...d.permissions, autonomy: back } });
        }
        setSerious(false); setFlash({ text: "Serious mode disengaged. Back to normal authority." });
        voice.speak("Serious mode disengaged. Standing down to normal authority.");
      } catch (e: any) { setFlash({ text: e.message, bad: true }); }
      finally { setArming(false); devicesQ.reload(); }
      return;
    }
    // Explain it once, the first time ever on this browser. After that, arming is a single click —
    // no declaration to accept every time.
    let acked = false;
    try { acked = localStorage.getItem("jarvis.seriousAck") === "1"; } catch { /* storage blocked */ }
    if (!acked) {
      const ok = confirm(
        "ARM SERIOUS MODE\n\n" +
        "Every paired computer will carry out your orders without stopping to ask — researching, browsing, opening apps, running tasks.\n\n" +
        "Still protected: truly irreversible actions (shutdown, disk wipe, payments, disabling security) always ask first, and Emergency Stop always works.\n\n" +
        "You won't be asked this again. Arm now?"
      );
      if (!ok) return;
      try { localStorage.setItem("jarvis.seriousAck", "1"); } catch { /* ignore */ }
    }
    setArming(true);
    try {
      for (const d of devices) {
        prevAutonomy.current.set(d.id, d.permissions?.autonomy ?? "routine");
        await Api.updateDevice(d.id, { permissions: { ...d.permissions, autonomy: "serious" } });
      }
      setSerious(true); setFlash({ text: "⚡ Serious mode engaged. I have the helm." });
      voice.speak("Serious mode engaged. I have the helm.");
    } catch (e: any) { setFlash({ text: e.message, bad: true }); }
    finally { setArming(false); devicesQ.reload(); }
  };

  const paused = me?.automationPaused;
  const reduced = !!me?.settings.reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const emergencyToggle = async () => {
    if (paused) await Api.resume();
    else if (confirm("Emergency stop: cancel every running task on every device and pause automation?")) await Api.emergencyStop();
    refresh();
  };

  return (
    <div className={`universe${serious ? " serious" : ""}`}>
      <div className="universe-canvas">
        <Universe3D state={coreState} level={voice.level} devices={devices} selected={selected} onSelect={(id) => setSelected(id || null)} reducedMotion={reduced} serious={serious} />
      </div>
      <div className="universe-vignette" />

      {/* top-left identity + state */}
      <div className="u-brand">
        <div className="brand-mark" />
        <div>
          <div className="brand-name">J.A.R.V.I.S.</div>
          <div className="brand-sub">OMEGA</div>
        </div>
        <div className={`u-core-state ${coreState}`}>
          <span className="hud-label">CORE</span>
          <b>{coreState.toUpperCase()}</b>
        </div>
      </div>

      {/* top-right status + emergency */}
      <div className="u-topright">
        <span className="status-pill"><span className={`dot ${online ? "on" : ""}`} />{online}/{devices.length} online</span>
        <span className="status-pill"><span className={`dot ${active.length ? "on pulse" : ""}`} />{active.length} active</span>
        <button className={`btn serious-toggle${serious ? " armed" : ""}`} onClick={toggleSerious} disabled={arming}
          title="Serious mode — full authority, no questions asked">
          {Icon.stop}{arming ? "…" : serious ? "SERIOUS — ARMED" : "Serious mode"}
        </button>
        <button className={paused ? "btn amber" : "btn danger"} onClick={emergencyToggle}>{Icon.stop}{paused ? "Resume" : "Emergency stop"}</button>
      </div>

      {serious && <div className="u-serious-banner"><span className="pip" />SERIOUS MODE — FULL AUTHORITY · orders execute without confirmation · irreversible actions still require a yes · Emergency Stop always works</div>}

      {/* floating function rail */}
      <nav className="u-rail">
        <button className="u-rail-btn active" title="Command center">{Icon.core}<span>Command</span></button>
        {RAIL.map((r) => <button key={r.to} className="u-rail-btn" onClick={() => nav(r.to)} title={r.label}>{r.icon}<span>{r.label}</span></button>)}
        <div className="u-rail-user">{me?.user.username}</div>
      </nav>

      {paused && <div className="u-banner"><span className="dot warn" /> Automation paused — devices will not start or continue any task.</div>}

      {/* selected device card or fleet summary */}
      <aside className="u-side">
        {sel ? (
          <div className="panel u-device">
            <div className="panel-title">{sel.name}<span className="right"><button className="btn ghost sm" onClick={() => setSelected(null)}>✕</button></span></div>
            <div className="sub" style={{ marginBottom: 10 }}>{sel.os || "Windows"} · agent {sel.agentVersion || "?"} · {sel.online ? "online" : `seen ${ago(sel.lastHeartbeat)}`}</div>
            {sel.metrics && <>
              <div className="kv"><span>CPU</span><div className={`meter ${sel.metrics.cpuPercent > 85 ? "hot" : ""}`}><i style={{ width: `${sel.metrics.cpuPercent}%` }} /></div><b>{sel.metrics.cpuPercent.toFixed(0)}%</b></div>
              <div className="kv"><span>MEM</span><div className="meter"><i style={{ width: `${(sel.metrics.memUsedBytes / sel.metrics.memTotalBytes) * 100}%` }} /></div><b>{gb(sel.metrics.memTotalBytes)}</b></div>
              {sel.metrics.disks.slice(0, 2).map((k) => <div className="kv" key={k.mount}><span>{k.mount}</span><div className={`meter ${k.usedBytes / k.totalBytes > 0.9 ? "hot" : ""}`}><i style={{ width: `${(k.usedBytes / k.totalBytes) * 100}%` }} /></div><b>{gb(k.totalBytes - k.usedBytes)}</b></div>)}
            </>}
            <div className="caps" style={{ marginTop: 10 }}>
              <span className={`cap ${sel.sessionActive ? "on" : ""}`}>{sel.sessionActive ? "unlocked" : "locked"}</span>
              <span className={`cap ${sel.capabilities?.codex === "ready" ? "on" : ""}`}>codex</span>
              <span className={`cap ${sel.capabilities?.browser ? "on" : ""}`}>browser</span>
              <span className={`cap ${sel.capabilities?.voice ? "on" : ""}`}>voice</span>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm" onClick={() => { setTarget(sel.id); document.getElementById("u-cmd")?.focus(); }}>Target this</button>
              <button className="btn ghost sm" onClick={() => nav("/devices")}>Manage</button>
            </div>
          </div>
        ) : (
          <div className="panel u-device">
            <div className="panel-title">Fleet <span className="right count">{online}/{devices.length}</span></div>
            {devices.length === 0 && <div className="empty" style={{ padding: 16 }}>No computers paired.<br /><button className="btn sm" style={{ marginTop: 10 }} onClick={() => nav("/devices")}>Pair a PC</button></div>}
            {devices.map((d) => (
              <div key={d.id} className="u-fleet-row" onClick={() => setSelected(d.id)}>
                <span className={`dot ${d.online ? (d.currentTasks ? "on pulse" : "on") : ""}`} />
                <span className="nm">{d.name}</span>
                <span className="mt">{d.online ? (d.currentTasks ? `${d.currentTasks} active` : `${d.metrics?.cpuPercent.toFixed(0) ?? 0}%`) : "offline"}</span>
              </div>
            ))}
          </div>
        )}
        <div className="panel u-ops">
          <div className="panel-title">Live operations <span className="right count">{tasks.length}</span></div>
          <div className="u-ops-list">
            {tasks.length === 0 && <div className="empty" style={{ padding: 12 }}>Idle. Give an order below.</div>}
            {tasks.slice(0, 7).map((t: Task) => (
              <div key={t.id} className="u-op" onClick={() => setOpenTask(t.id)}>
                <span className={statusDot(t.status)} />
                <span className="op-text">{t.prompt}</span>
                <span className={`badge ${t.status}`}>{t.status.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* command dock */}
      <div className="u-dock">
        {flash && <div className={`u-flash ${flash.bad ? "bad" : ""}`}>{flash.text}</div>}
        {waiting && <div className="u-flash amber" onClick={() => setOpenTask(waiting.id)} style={{ cursor: "pointer" }}>⚠ Approval needed: {waiting.pendingInput?.action} — tap to review</div>}
        {voice.listening && <div className="u-listening">◉ LISTENING {voice.interim && <span>“{voice.interim}”</span>}</div>}
        <form className="u-cmd" onSubmit={(e: FormEvent) => { e.preventDefault(); send(prompt, "text"); }}>
          <span className="prompt-glyph">›</span>
          <input id="u-cmd" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Jarvis, research the latest in AI and save a report to my documents…" />
          <select className="target-select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="auto">Auto-route</option>
            <option value="all">All online</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? "" : " (offline)"}</option>)}
          </select>
          <div className="u-voice">
            <Waveform analyser={voice.analyser} />
          </div>
          <button type="button" className={`btn icon mic ${voice.mode === "push" && voice.listening ? "live" : ""}`} disabled={!voiceSupported}
            onClick={() => (voice.mode !== "off" ? voice.stop() : voice.start("push"))} title="Push to talk">{Icon.mic}</button>
          <button type="button" className={`btn icon ${voice.mode === "wake" ? "mic live" : "ghost"}`} disabled={!voiceSupported}
            onClick={() => (voice.mode === "wake" ? voice.stop() : voice.start("wake"))} title="“Hey Jarvis” wake word">HEY</button>
          <button className="btn" disabled={sending || !prompt.trim() || paused}>{Icon.send}Execute</button>
        </form>
      </div>

      {openTask && <TaskDrawer id={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  );
}
