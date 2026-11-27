import { useEffect, useRef, useState } from "react";
import type { Device, TaskStatus } from "../../../../packages/shared-types/src/index";

const P = (d: string) => <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />;
export const Icon = {
  core: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="3.2" fill="currentColor" /></svg>,
  devices: <svg viewBox="0 0 24 24">{P("M3 5h13v9H3zM7 18h5M9.5 14v4M18 8h3v11h-3z")}</svg>,
  tasks: <svg viewBox="0 0 24 24">{P("M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2")}</svg>,
  flows: <svg viewBox="0 0 24 24">{P("M12 3v4M12 17v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M3 12h4M17 12h4M12 8a4 4 0 100 8 4 4 0 000-8z")}</svg>,
  memory: <svg viewBox="0 0 24 24">{P("M6 4h12v16H6zM9 8h6M9 12h6M9 16h4")}</svg>,
  logs: <svg viewBox="0 0 24 24">{P("M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z M9 12l2 2 4-4")}</svg>,
  settings: <svg viewBox="0 0 24 24">{P("M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-1-3-2 .3-1.2-1.2L17 5l-3-1-1 2h-2L10 4 7 5l.2 2.1L6 8.3 4 8 3 11l2 1v0l-2 1 1 3 2-.3 1.2 1.2L7 19l3 1 1-2h2l1 2 3-1-.2-2.1 1.2-1.2 2 .3 1-3z")}</svg>,
  mic: <svg viewBox="0 0 24 24">{P("M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3")}</svg>,
  send: <svg viewBox="0 0 24 24">{P("M4 12l16-8-6 16-2-7z")}</svg>,
  stop: <svg viewBox="0 0 24 24">{P("M7 7h10v10H7z")}</svg>,
};

export function statusDot(s: TaskStatus | string) {
  if (s === "COMPLETED") return "dot ok";
  if (s === "FAILED") return "dot bad";
  if (s === "WAITING_FOR_INPUT") return "dot warn pulse";
  if (s === "CANCELLED") return "dot";
  return "dot on pulse";
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export const gb = (b: number) => `${(b / 1e9).toFixed(b > 1e11 ? 0 : 1)} GB`;

/** Poll an async loader while the tab is visible. */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    let timer: number;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try { const d = await loadRef.current(); if (alive) { setData(d); setError(null); } }
        catch (e: any) { if (alive) setError(e.message); }
      }
      if (alive) timer = window.setTimeout(tick, ms);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload: async () => setData(await loadRef.current()) };
}

/** Escape-first Markdown renderer for task results (no raw HTML from the agent ever reaches the DOM). */
export function Markdown({ text }: { text: string }) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const html: string[] = [];
  let inList = false, inCode = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) { if (inList) { html.push("</ul>"); inList = false; } html.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { html.push(esc(line)); continue; }
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(line);
    if (li) { if (!inList) { html.push("<ul>"); inList = true; } html.push(`<li>${inline(li[1])}</li>`); continue; }
    if (inList) { html.push("</ul>"); inList = false; }
    if (h) html.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (inList) html.push("</ul>");
  if (inCode) html.push("</code></pre>");
  return <div className="md" dangerouslySetInnerHTML={{ __html: html.join("") }} />;
}

/** Network map of enrolled devices around the core. Lines light up for online devices, animate when busy. */
export function DeviceMap({ devices }: { devices: Device[] }) {
  const w = 520, h = 220, cx = w / 2, cy = h / 2;
  const n = Math.max(devices.length, 1);
  return (
    <svg className="devmap" viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <radialGradient id="cg"><stop offset="0%" stopColor="#00e5ff" stopOpacity="0.9" /><stop offset="100%" stopColor="#00e5ff" stopOpacity="0" /></radialGradient>
      </defs>
      {devices.map((d, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * 190, y = cy + Math.sin(a) * 78;
        const color = d.online ? "#00e5ff" : "#35506a";
        return (
          <g key={d.id}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke={color} strokeOpacity={d.online ? 0.6 : 0.3} strokeWidth="1.2"
              strokeDasharray={d.currentTasks ? "6 6" : undefined}>
              {d.currentTasks ? <animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.8s" repeatCount="indefinite" /> : null}
            </line>
            <circle cx={x} cy={y} r="7" fill="#04060b" stroke={color} strokeWidth="2" />
            {d.online && <circle cx={x} cy={y} r="3" fill={color} />}
            <text x={x} y={y + (y > cy ? 24 : -14)} textAnchor="middle" fill={d.online ? "#dcf6ff" : "#4a6172"} fontSize="11" fontFamily="monospace" letterSpacing="1.5">{d.name}</text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r="30" fill="url(#cg)" />
      <circle cx={cx} cy={cy} r="11" fill="#00e5ff" />
      <circle cx={cx} cy={cy} r="20" fill="none" stroke="#00e5ff" strokeOpacity="0.6" />
      {devices.length === 0 && <text x={cx} y={cy + 52} textAnchor="middle" fill="#4a6172" fontSize="12" fontFamily="monospace">No devices paired yet</text>}
    </svg>
  );
}

/** Live microphone waveform (real analyser data, flat when the mic is off). */
export function Waveform({ analyser }: { analyser: AnalyserNode | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const buf = new Uint8Array(analyser?.fftSize ?? 256);
    const draw = () => {
      c.width = c.clientWidth * devicePixelRatio;
      c.height = c.clientHeight * devicePixelRatio;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.strokeStyle = analyser ? "#00e5ff" : "#35506a";
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.shadowColor = "#00e5ff";
      ctx.shadowBlur = analyser ? 12 : 0;
      ctx.beginPath();
      if (analyser) analyser.getByteTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = analyser ? (buf[i] - 128) / 128 : 0;
        const x = (i / (buf.length - 1)) * c.width;
        const y = c.height / 2 + v * c.height * 0.45;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);
  return <canvas ref={ref} className="waveform" />;
}
