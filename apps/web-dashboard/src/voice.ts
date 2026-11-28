import { useCallback, useEffect, useRef, useState } from "react";

// Browser voice: Web Speech API for recognition + speechSynthesis for a British English voice.
// Note: in Chrome, recognition audio is processed by the browser vendor's service. For fully local
// recognition use the Windows agent's offline voice engine ("Hey Jarvis" on the PC itself).

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const voiceSupported = !!SR;

// High-quality neural/cloud voices ship under these names; the flat robotic ones are the old
// local "Desktop"/eSpeak engines. We score every installed voice so JARVIS always grabs the best
// one available, preferring a natural British voice but taking a natural US voice over a robotic UK one.
const GREAT = /natural|neural|online|google|siri|premium|enhanced|wavenet|journey|aria|jenny|guy|ryan|libby|sonia|thomas|serena/i;
const BAD = /david|zira|mark|hazel|susan|desktop|espeak|festival|pico|compact|eloquence|robo/i;
const BRITISH_MALE = /ryan|george|arthur|thomas|daniel|oliver|uk english male/i;

function scoreVoice(v: SpeechSynthesisVoice): number {
  const n = v.name;
  let s = 0;
  if (GREAT.test(n)) s += 100;
  if (BAD.test(n)) s -= 120;
  if (v.lang === "en-GB") s += 25;
  else if (v.lang.startsWith("en")) s += 12;
  else s -= 60;
  if (BRITISH_MALE.test(n)) s += 18; // the JARVIS timbre
  if (!v.localService) s += 8; // cloud/neural voices are usually non-local and sound best
  return s;
}

export function pickVoice(preferred: string | null): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (!voices.length) return null;
  if (preferred) { const exact = voices.find((v) => v.name === preferred); if (exact) return exact; }
  return voices.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

/** getVoices() is empty until the engine loads them; resolve once they're ready (or after a timeout). */
let voicesReady: Promise<void> | null = null;
export function ensureVoices(): Promise<void> {
  if (!window.speechSynthesis) return Promise.resolve();
  if (window.speechSynthesis.getVoices().length) return Promise.resolve();
  if (!voicesReady) {
    voicesReady = new Promise<void>((resolve) => {
      const done = () => resolve();
      window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
      // Safari/Firefox sometimes never fire the event — poll briefly as a fallback.
      let tries = 0;
      const iv = setInterval(() => {
        if (window.speechSynthesis.getVoices().length || ++tries > 20) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }
  return voicesReady;
}

/** Every usable English voice, best first — for a voice picker in Settings. */
export function listVoices(): SpeechSynthesisVoice[] {
  return (window.speechSynthesis?.getVoices() ?? [])
    .filter((v) => v.lang.startsWith("en"))
    .sort((a, b) => scoreVoice(b) - scoreVoice(a));
}

export function useVoice(opts: { onCommand: (text: string) => void; voiceName: string | null }) {
  const [mode, setMode] = useState<"off" | "push" | "wake">("off");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [muted, setMuted] = useState(false);
  const level = useRef(0);
  const rec = useRef<any>(null);
  const stream = useRef<MediaStream | null>(null);
  const onCommand = useRef(opts.onCommand);
  onCommand.current = opts.onCommand;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const stopMic = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setAnalyser(null);
    level.current = 0;
  }, []);

  const startMic = useCallback(async () => {
    if (stream.current) return;
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    stream.current = s;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(s);
    const a = ctx.createAnalyser();
    a.fftSize = 512;
    src.connect(a);
    setAnalyser(a);
    const buf = new Uint8Array(a.fftSize);
    const loop = () => {
      if (!stream.current) return;
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      level.current = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      requestAnimationFrame(loop);
    };
    loop();
  }, []);

  const stop = useCallback(() => {
    setMode("off");
    try { rec.current?.abort(); } catch { /* ignore */ }
    rec.current = null;
    setListening(false);
    setInterim("");
    stopMic();
  }, [stopMic]);

  const start = useCallback(async (m: "push" | "wake") => {
    if (!SR) throw new Error("Speech recognition is not supported in this browser. Try Chrome or Edge.");
    window.speechSynthesis?.cancel(); // audio interruption: talking over JARVIS stops it
    await startMic();
    const r = new SR();
    r.lang = "en-GB";
    r.interimResults = true;
    r.continuous = m === "wake";
    r.onresult = (e: any) => {
      let finalText = "", interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interimText += t;
      }
      setInterim(interimText);
      if (!finalText) return;
      const text = finalText.trim();
      if (m === "push") { onCommand.current(text); return; }
      const wake = /^(?:hey|ok|okay)?\s*jarvis[,.!\s]*(.*)$/i.exec(text);
      if (/^(jarvis\s+)?(stop|stop talking|be quiet)$/i.test(text)) { window.speechSynthesis?.cancel(); return; }
      if (wake && wake[1].trim().length > 2) onCommand.current(wake[1].trim());
    };
    r.onstart = () => setListening(true);
    r.onend = () => {
      setListening(false);
      setInterim("");
      if (modeRef.current === "wake" && rec.current === r) { try { r.start(); } catch { /* restarting */ } }
      else if (modeRef.current === "push") { setMode("off"); stopMic(); }
    };
    r.onerror = (e: any) => { if (e.error === "not-allowed") stop(); };
    rec.current = r;
    setMode(m);
    r.start();
  }, [startMic, stop, stopMic]);

  const speak = useCallback((text: string) => {
    if (muted || !window.speechSynthesis) return;
    const clean = text.replace(/[`*_#>]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!clean) return;
    // Wait for the engine's voice list before choosing, or the first line gets the robotic default.
    ensureVoices().then(() => {
      const u = new SpeechSynthesisUtterance(clean);
      const v = pickVoice(opts.voiceName);
      if (v) u.voice = v;
      u.lang = v?.lang ?? "en-GB";
      // Natural voices sound best near their native cadence; a touch slower + slightly low for gravitas.
      const natural = v ? GREAT.test(v.name) : false;
      u.rate = natural ? 1.0 : 0.96;
      u.pitch = natural ? 1.0 : 0.9;
      u.onstart = () => setSpeaking(true);
      u.onend = u.onerror = () => setSpeaking(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  }, [muted, opts.voiceName]);

  useEffect(() => () => stop(), [stop]);

  return { mode, listening, speaking, interim, analyser, level, start, stop, speak, muted, setMuted };
}
