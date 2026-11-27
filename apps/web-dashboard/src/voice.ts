import { useCallback, useEffect, useRef, useState } from "react";

// Browser voice: Web Speech API for recognition + speechSynthesis for a British English voice.
// Note: in Chrome, recognition audio is processed by the browser vendor's service. For fully local
// recognition use the Windows agent's offline voice engine ("Hey Jarvis" on the PC itself).

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const voiceSupported = !!SR;

export function pickVoice(preferred: string | null): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return (
    voices.find((v) => v.name === preferred) ??
    voices.find((v) => v.lang === "en-GB" && /male|daniel|george|arthur|ryan/i.test(v.name)) ??
    voices.find((v) => v.lang === "en-GB") ??
    voices.find((v) => v.lang.startsWith("en")) ??
    null
  );
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
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice(opts.voiceName);
    if (v) u.voice = v;
    u.lang = v?.lang ?? "en-GB";
    u.rate = 1.0;
    u.pitch = 0.92;
    u.onstart = () => setSpeaking(true);
    u.onend = u.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [muted, opts.voiceName]);

  useEffect(() => () => stop(), [stop]);

  return { mode, listening, speaking, interim, analyser, level, start, stop, speak, muted, setMuted };
}
