// Credential vault encrypted with Windows DPAPI (CurrentUser scope). Secrets are decrypted only on demand,
// kept in memory for a short time, never logged and never handed to the AI model.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

export interface Credential { domain: string; username: string; password: string; note?: string; updatedAt: number }
export interface CredentialSummary { domain: string; username: string; updatedAt: number }

const IS_WIN = process.platform === "win32";
const ENTROPY = "JARVIS-OMEGA-VAULT-v1";
const AUTO_LOCK_MS = 120_000;

function psWithStdin(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`$ErrorActionPreference='Stop';${script}`, "utf16le").toString("base64");
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(0, 300) || `exit ${code}`))));
    p.stdin.end(input);
  });
}

async function dpapi(op: "Protect" | "Unprotect", b64: string): Promise<string> {
  const script =
    `Add-Type -AssemblyName System.Security;` +
    `$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
    `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');` +
    `$o=[Security.Cryptography.ProtectedData]::${op}($in,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Console]::Out.Write([Convert]::ToBase64String($o))`;
  return psWithStdin(script, b64);
}

/** Non-Windows development fallback: AES-256-GCM with a local key file. Never used on Windows. */
function devKey(file: string): Buffer {
  const kf = file + ".devkey";
  if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(kf);
}

export class Vault {
  private cache: Credential[] | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  constructor(private file: string, private onSecret?: (s: string) => void) {}

  static available(): boolean {
    return IS_WIN || process.env.JARVIS_DEV === "1";
  }

  private async load(): Promise<Credential[]> {
    if (this.cache) return this.touch(this.cache);
    if (!fs.existsSync(this.file)) return this.touch([]);
    const blob = fs.readFileSync(this.file);
    let json: string;
    if (IS_WIN) {
      json = Buffer.from(await dpapi("Unprotect", blob.toString("utf8")), "base64").toString("utf8");
    } else if (process.env.JARVIS_DEV === "1") {
      const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
      const d = crypto.createDecipheriv("aes-256-gcm", devKey(this.file), iv);
      d.setAuthTag(tag);
      json = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    } else {
      throw new Error("Credential vault requires Windows DPAPI");
    }
    const creds = JSON.parse(json) as Credential[];
    creds.forEach((c) => this.onSecret?.(c.password));
    return this.touch(creds);
  }

  private touch(c: Credential[]) {
    this.cache = c;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), AUTO_LOCK_MS);
    this.lockTimer.unref?.();
    return c;
  }

  lock() {
    this.cache = null;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
  }

  private async save(creds: Credential[]) {
    const json = JSON.stringify(creds);
    let out: Buffer;
    if (IS_WIN) {
      out = Buffer.from(await dpapi("Protect", Buffer.from(json, "utf8").toString("base64")), "utf8");
    } else if (process.env.JARVIS_DEV === "1") {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", devKey(this.file), iv);
      const ct = Buffer.concat([c.update(json, "utf8"), c.final()]);
      out = Buffer.concat([iv, c.getAuthTag(), ct]);
    } else throw new Error("Credential vault requires Windows DPAPI");
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.touch(creds);
  }

  async list(): Promise<CredentialSummary[]> {
    return (await this.load()).map(({ domain, username, updatedAt }) => ({ domain, username, updatedAt }));
  }

  async upsert(domain: string, username: string, password: string, note?: string) {
    const d = normalizeDomain(domain);
    if (!d || !username || !password) throw new Error("Domain, username and password are required");
    const creds = (await this.load()).filter((c) => !(c.domain === d && c.username === username));
    creds.push({ domain: d, username, password, note, updatedAt: Date.now() });
    this.onSecret?.(password);
    await this.save(creds);
  }

  async remove(domain: string, username?: string): Promise<number> {
    const d = normalizeDomain(domain);
    const creds = await this.load();
    const keep = creds.filter((c) => !(c.domain === d && (!username || c.username === username)));
    await this.save(keep);
    return creds.length - keep.length;
  }

  /** Returns the credential for an exact host match (or parent domain). Internal use only. */
  async forHost(host: string, username?: string): Promise<Credential | null> {
    const h = host.toLowerCase();
    const creds = await this.load();
    return creds.find((c) => (h === c.domain || h.endsWith("." + c.domain)) && (!username || c.username === username)) ?? null;
  }
}

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
}

/** Encrypt a short secret (e.g. the device key) for the current Windows user. */
export async function protectSecret(plain: string): Promise<string> {
  if (IS_WIN) return dpapi("Protect", Buffer.from(plain, "utf8").toString("base64"));
  if (process.env.JARVIS_DEV === "1") return "dev:" + Buffer.from(plain, "utf8").toString("base64");
  throw new Error("Secret storage requires Windows DPAPI");
}
export async function unprotectSecret(blob: string): Promise<string> {
  if (blob.startsWith("dev:")) return Buffer.from(blob.slice(4), "base64").toString("utf8");
  return Buffer.from(await dpapi("Unprotect", blob.trim()), "base64").toString("utf8");
}
