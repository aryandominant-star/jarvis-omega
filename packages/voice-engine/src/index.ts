// Local, offline voice: "Hey Jarvis" wake phrase + dictation via Windows System.Speech, and British English TTS.
// Never speaks at startup; only answers commands it heard (or when explicitly asked to speak).
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import readline from "node:readline";

export type VoiceEvent =
  | { type: "ready"; recognizer: string; voice: string; engine?: string }
  | { type: "wake" } | { type: "timeout" } | { type: "stop" } | { type: "speaking" } | { type: "spoken" }
  | { type: "command"; text: string; confidence: number }
  | { type: "level"; value: number }
  | { type: "error"; message: string };

export class VoiceEngine extends EventEmitter {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private wanted = false;

  constructor(private scriptPath: string, private log: (m: string) => void, private voiceName?: string) {
    super();
  }

  /** Choose a preferred TTS voice by (partial) name; applied on the next (re)start. */
  setVoice(name: string | null) {
    this.voiceName = name || undefined;
  }

  static supported() {
    return process.platform === "win32";
  }

  start() {
    if (!VoiceEngine.supported()) throw new Error("Local voice requires Windows speech components");
    if (!fs.existsSync(this.scriptPath)) throw new Error(`Voice script missing: ${this.scriptPath}`);
    this.wanted = true;
    if (this.proc) return;
    const psArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", this.scriptPath];
    if (this.voiceName) psArgs.push(this.voiceName);
    this.proc = spawn("powershell.exe", psArgs, {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      try {
        const ev = JSON.parse(line) as VoiceEvent;
        if (ev.type === "ready") this.restarts = 0;
        this.emit("event", ev);
      } catch { /* ignore non-JSON output */ }
    });
    this.proc.stderr!.on("data", (d) => this.log(`voice stderr: ${String(d).trim().slice(0, 300)}`));
    this.proc.on("exit", (code) => {
      this.proc = null;
      this.emit("event", { type: "error", message: `voice engine exited (${code})` } as VoiceEvent);
      // Bounded restarts only — never an infinite loop.
      if (this.wanted && code !== 2 && this.restarts < 3) {
        this.restarts++;
        setTimeout(() => this.wanted && this.start(), 5000 * this.restarts);
      }
    });
  }

  stop() {
    this.wanted = false;
    if (this.proc) {
      this.send({ quit: true });
      setTimeout(() => this.proc?.kill(), 1500);
    }
  }

  running() {
    return !!this.proc;
  }

  say(text: string) {
    const clean = text.replace(/[`*_#>|]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
    if (clean) this.send({ say: clean.slice(0, 600) });
  }

  interrupt() {
    this.send({ stop: true });
  }

  mute(m: boolean) {
    this.send({ mute: m });
  }

  private send(obj: unknown) {
    this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
  }
}

/** First one or two sentences — what JARVIS says out loud after a voice command. */
export function spokenSummary(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/^#+\s.*$/gm, "").replace(/\n+/g, " ").trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  return sentences.slice(0, 2).join(" ").trim().slice(0, 400);
}
