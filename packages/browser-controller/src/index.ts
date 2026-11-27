// Manages JARVIS's own Chrome/Edge instance (dedicated profile, so logins persist between tasks)
// and exposes its local CDP endpoint to Playwright MCP. Credential filling happens here, outside the model.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Vault } from "../../credential-vault/src/index";

const IS_WIN = process.platform === "win32";

export function findBrowser(kind: "chrome" | "msedge"): string | null {
  if (process.env.JARVIS_BROWSER_EXE) return process.env.JARVIS_BROWSER_EXE;
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const candidates = IS_WIN
    ? kind === "chrome"
      ? [path.join(pf, "Google\\Chrome\\Application\\chrome.exe"), path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"), path.join(local, "Google\\Chrome\\Application\\chrome.exe")]
      : [path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe")]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function probe(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${endpoint}/json/version`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => (req.destroy(), resolve(false)));
  });
}

export class BrowserManager {
  private proc: ChildProcess | null = null;
  private endpoint: string | null = null;
  private headless = false;

  constructor(private profileDir: string, private preferred: () => "chrome" | "msedge", private log: (m: string) => void) {}

  available(): boolean {
    if (process.env.JARVIS_DISABLE_BROWSER === "1") return false;
    return !!(findBrowser(this.preferred()) ?? findBrowser(this.preferred() === "chrome" ? "msedge" : "chrome"));
  }

  /** Start (or reuse) the JARVIS browser and return its CDP endpoint. */
  async ensure(opts: { headless: boolean }): Promise<string> {
    if (this.endpoint && (await probe(this.endpoint))) {
      if (this.headless === opts.headless || !this.proc) return this.endpoint;
      // Desktop state changed (e.g. locked -> unlocked); restart in the right mode.
      this.stop();
    }
    const exe = findBrowser(this.preferred()) ?? findBrowser(this.preferred() === "chrome" ? "msedge" : "chrome");
    if (!exe) throw new Error("Neither Google Chrome nor Microsoft Edge was found on this computer");
    const portFile = path.join(this.profileDir, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(opts.headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    this.log(`Launching browser ${path.basename(exe)} (headless=${opts.headless})`);
    this.proc = spawn(exe, args, { stdio: "ignore", windowsHide: opts.headless, detached: false });
    this.proc.on("exit", () => {
      this.proc = null;
      this.endpoint = null;
    });
    this.headless = opts.headless;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (!fs.existsSync(portFile)) continue;
      const port = parseInt(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0], 10);
      if (!port) continue;
      const ep = `http://127.0.0.1:${port}`;
      if (await probe(ep)) {
        this.endpoint = ep;
        return ep;
      }
    }
    this.stop();
    throw new Error("The browser did not start in time");
  }

  stop() {
    if (this.proc?.pid) {
      try {
        if (IS_WIN) spawn("taskkill.exe", ["/PID", String(this.proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else this.proc.kill();
      } catch { /* already gone */ }
    }
    this.proc = null;
    this.endpoint = null;
  }

  currentEndpoint() {
    return this.endpoint;
  }

  /**
   * Fill the login form on the open page for `domain` with the stored credential. The password is typed
   * directly into the page over CDP and is never returned to the caller. Does not submit the form.
   */
  async fillLogin(domain: string, vault: Vault, username?: string): Promise<{ filled: string[]; page: string }> {
    if (!this.endpoint) throw new Error("The JARVIS browser is not running. Open the login page first.");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require("playwright-core");
    const browser = await chromium.connectOverCDP(this.endpoint, { timeout: 10_000 });
    try {
      const pages = browser.contexts().flatMap((c: any) => c.pages());
      const target = [...pages].reverse().find((p: any) => {
        try {
          const u = new URL(p.url());
          return (u.hostname === domain || u.hostname.endsWith("." + domain)) && (u.protocol === "https:" || u.hostname === "localhost");
        } catch { return false; }
      });
      if (!target) throw new Error(`No open HTTPS page on ${domain}. Navigate to its login page first.`);
      const host = new URL(target.url()).hostname;
      const cred = await vault.forHost(host, username);
      if (!cred) throw new Error(`No saved credential for ${host}. Add one in the JARVIS credential vault (tray menu).`);
      const filled: string[] = [];
      const userField = target.locator(
        'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="user" i], input[id*="email" i]'
      ).filter({ visible: true }).first();
      if (await userField.count()) {
        const current = await userField.inputValue().catch(() => "");
        if (!current) { await userField.fill(cred.username); filled.push("username"); }
      }
      const pw = target.locator('input[type="password"]').filter({ visible: true }).first();
      if (await pw.count()) { await pw.fill(cred.password); filled.push("password"); }
      if (!filled.length) throw new Error("Could not find a visible username or password field on the page");
      return { filled, page: `${host}${new URL(target.url()).pathname}` };
    } finally {
      await browser.close().catch(() => undefined); // disconnects; JARVIS's browser keeps running
    }
  }

  /** Render HTML to PDF with the browser's print engine (headless one-shot, separate from the session). */
  async htmlToPdf(htmlFile: string, pdfFile: string): Promise<void> {
    const exe = findBrowser("msedge") ?? findBrowser("chrome");
    if (!exe) throw new Error("PDF export needs Microsoft Edge or Google Chrome");
    const tmpProfile = fs.mkdtempSync(path.join(path.dirname(pdfFile), ".pdfprofile-"));
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(exe, [
          "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${tmpProfile}`,
          "--no-pdf-header-footer", `--print-to-pdf=${pdfFile}`, "file:///" + htmlFile.replace(/\\/g, "/"),
        ], { windowsHide: true, stdio: "ignore" });
        const t = setTimeout(() => (p.kill(), reject(new Error("PDF export timed out"))), 60_000);
        p.on("exit", () => (clearTimeout(t), resolve()));
        p.on("error", (e) => (clearTimeout(t), reject(e)));
      });
    } finally {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
    }
    if (!fs.existsSync(pdfFile)) throw new Error("PDF export failed");
  }
}
