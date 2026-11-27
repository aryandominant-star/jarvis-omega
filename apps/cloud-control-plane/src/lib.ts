export interface Env {
  DB: D1Database;
  MASTER_KEY: string; // base64, 32 bytes. `wrangler secret put MASTER_KEY`
  ALLOWED_ORIGINS?: string; // comma separated dashboard origins
  ALLOW_REGISTRATION?: string; // "true" (default) | "false"
  REGISTRATION_INVITE_CODE?: string; // optional: required to register when set
  LATEST_AGENT_VERSION?: string;
  LATEST_AGENT_URL?: string;
  LATEST_AGENT_SHA256?: string;
  LONG_POLL_MS?: string;
  DASHBOARD_ORIGIN?: string; // e.g. https://<user>.github.io/jarvis-omega — proxied at this Worker's origin
  PBKDF2_ITER?: string; // password hashing iterations; tune to fit the free-tier CPU budget
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export const now = () => Date.now();

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function readJson<T = any>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

// ---------- encoding helpers ----------
export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "===".slice((norm.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
export const randomId = (prefix = "") => prefix + b64url(randomBytes(16));

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", buf));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- password hashing (PBKDF2-SHA256; 100k is the Workers maximum) ----------
export const PBKDF2_ITER = 100_000;
export async function hashPassword(password: string, salt: Uint8Array, iterations = PBKDF2_ITER): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return b64url(bits);
}

// ---------- device secret encryption at rest ----------
async function masterKey(env: Env): Promise<CryptoKey> {
  if (!env.MASTER_KEY) throw new HttpError(500, "Server misconfigured: MASTER_KEY missing");
  const raw = b64decode(env.MASTER_KEY);
  if (raw.length !== 32) throw new HttpError(500, "Server misconfigured: MASTER_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await masterKey(env), new TextEncoder().encode(plaintext));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function decryptSecret(env: Env, blob: string): Promise<string> {
  const [iv, ct] = blob.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, await masterKey(env), b64decode(ct));
  return new TextDecoder().decode(pt);
}
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// ---------- rate limiting (fixed window, stored in D1) ----------
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<void> {
  const t = now();
  const cutoff = t - windowSec * 1000;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     RETURNING count, window_start`
  )
    .bind(key, t, cutoff)
    .first<{ count: number; window_start: number }>();
  if (row && row.count > limit) {
    const retry = Math.ceil((row.window_start + windowSec * 1000 - t) / 1000);
    throw new HttpError(429, `Too many attempts. Try again in ${Math.max(retry, 1)}s.`, "rate_limited");
  }
}

// ---------- audit ----------
export async function audit(env: Env, userId: string | null, actor: string, action: string, detail: unknown, ip?: string) {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail ?? {});
  await env.DB.prepare("INSERT INTO audit_logs (user_id, ts, actor, action, detail, ip) VALUES (?,?,?,?,?,?)")
    .bind(userId, now(), actor, action, d.slice(0, 2000), ip ?? null)
    .run();
}

export function truncate(s: unknown, n: number): string {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
}

export function semverGt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
