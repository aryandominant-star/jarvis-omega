// Windows notification-area icon + menu (systray2). Hosted inside the per-user agent process.
import fs from "node:fs";
import path from "node:path";

export type TrayStatus = "connected" | "disconnected" | "attention" | "busy";
export type TrayAction =
  | "open" | "voice" | "devices" | "tasks" | "pause" | "resume" | "startup" | "vault" | "codex"
  | "pair" | "disconnect" | "logs" | "update" | "exit";

interface Item { key: TrayAction | "sep" | "status"; title: string; tooltip?: string; checked?: boolean; enabled?: boolean; hidden?: boolean }

export class Tray {
  private tray: any = null;
  private items: Item[] = [];
  private status: TrayStatus = "disconnected";
  private icons: Record<TrayStatus, string> = { connected: "", disconnected: "", attention: "", busy: "" };

  constructor(private assetsDir: string, private onAction: (a: TrayAction) => void, private log: (m: string) => void) {}

  static supported() { return process.platform === "win32" || process.env.JARVIS_TRAY === "1"; }

  async start() {
    if (!Tray.supported()) return;
    for (const s of Object.keys(this.icons) as TrayStatus[]) {
      const f = path.join(this.assetsDir, `tray-${s}.${process.platform === "win32" ? "ico" : "png"}`);
      this.icons[s] = fs.existsSync(f) ? fs.readFileSync(f).toString("base64") : "";
    }
    this.items = [
      { key: "status", title: "J.A.R.V.I.S. — starting…", enabled: false },
      { key: "sep", title: "<SEPARATOR>" },
      { key: "open", title: "Open JARVIS" },
      { key: "voice", title: "Voice Assistant", checked: false },
      { key: "devices", title: "Connected Devices" },
      { key: "tasks", title: "Current Tasks" },
      { key: "sep", title: "<SEPARATOR>" },
      { key: "pause", title: "Pause Automation" },
      { key: "resume", title: "Resume Automation", enabled: false },
      { key: "startup", title: "Start with Windows", checked: true },
      { key: "vault", title: "Credential Vault…" },
      { key: "codex", title: "Connect Codex (ChatGPT sign-in)…" },
      { key: "pair", title: "Pair this PC…", hidden: true },
      { key: "update", title: "Install update…", hidden: true },
      { key: "logs", title: "Open Logs Folder" },
      { key: "sep", title: "<SEPARATOR>" },
      { key: "disconnect", title: "Disconnect This Device…" },
      { key: "exit", title: "Exit JARVIS" },
    ];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SysTray = require("systray2").default ?? require("systray2");
    this.tray = new SysTray({
      menu: {
        icon: this.icons.disconnected, isTemplateIcon: false, title: "", tooltip: "J.A.R.V.I.S.",
        items: this.items.map((i) => ({ title: i.title, tooltip: i.tooltip ?? "", checked: !!i.checked, enabled: i.enabled !== false, hidden: !!i.hidden })),
      },
      debug: false,
      copyDir: true, // copies the helper exe to a writable folder; required when installed
    });
    this.tray.onClick((action: any) => {
      const item = this.items[action.seq_id];
      if (item && item.key !== "sep" && item.key !== "status") this.onAction(item.key);
    });
    this.tray.onError?.((e: any) => this.log(`tray error: ${e?.message ?? e}`));
    await this.tray.ready().catch((e: any) => this.log(`tray failed: ${e?.message ?? e}`));
  }

  private update(key: Item["key"], patch: Partial<Item>) {
    const idx = this.items.findIndex((i) => i.key === key);
    if (idx < 0) return;
    Object.assign(this.items[idx], patch);
    const i = this.items[idx];
    this.tray?.sendAction({ type: "update-item", seq_id: idx,
      item: { title: i.title, tooltip: i.tooltip ?? "", checked: !!i.checked, enabled: i.enabled !== false, hidden: !!i.hidden } });
  }

  setStatus(status: TrayStatus, text: string) {
    this.update("status", { title: text });
    if (status === this.status || !this.tray) { this.status = status; return; }
    this.status = status;
    this.tray.sendAction({ type: "update-menu", menu: {
      icon: this.icons[status], isTemplateIcon: false, title: "", tooltip: `J.A.R.V.I.S. — ${text}`,
      items: this.items.map((i) => ({ title: i.title, tooltip: i.tooltip ?? "", checked: !!i.checked, enabled: i.enabled !== false, hidden: !!i.hidden })),
    } });
  }
  setPaused(p: boolean) { this.update("pause", { enabled: !p }); this.update("resume", { enabled: p }); }
  setVoice(on: boolean) { this.update("voice", { checked: on }); }
  setStartup(on: boolean) { this.update("startup", { checked: on }); }
  setPaired(p: boolean) { this.update("pair", { hidden: p }); this.update("disconnect", { hidden: !p }); }
  setUpdate(version: string | null) { this.update("update", { hidden: !version, title: version ? `Install update ${version}…` : "Install update…" }); }
  stop() { try { this.tray?.kill(false); } catch { /* ignore */ } }
}
