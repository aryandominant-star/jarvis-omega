import { DEFAULT_SETTINGS, PASSWORD_MIN, USERNAME_RE, type UserSettings } from "../../../packages/shared-types/src/index";
import {
  audit, b64url, clientIp, hashPassword, HttpError, now, PBKDF2_ITER, randomBytes, randomId, rateLimit,
  readJson, safeParse, sha256Hex, timingSafeEqual, type Env, b64decode,
} from "./lib";

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILED = 8;
const LOCK_MS = 15 * 60 * 1000;

// Iteration count for new/changed passwords. Stored per user, so it can be tuned to fit the Workers
// free-tier 10ms CPU budget without breaking existing accounts (login uses each row's stored count).
const iterFor = (env: Env) => {
  const n = Number(env.PBKDF2_ITER);
  return Number.isFinite(n) && n >= 10_000 && n <= 600_000 ? n : PBKDF2_ITER;
};
// Used when the username does not exist so the response time does not reveal it.
const DUMMY_SALT = new Uint8Array(16);

export interface AuthedUser {
  id: string;
  username: string;
  settings: UserSettings;
  automationPaused: boolean;
  sessionId: string;
}

function validatePassword(pw: unknown): string {
  if (typeof pw !== "string") throw new HttpError(400, "Password is required");
  if (pw.length < PASSWORD_MIN) throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters`);
  if (pw.length > 256) throw new HttpError(400, "Password is too long");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) throw new HttpError(400, "Use at least three of: lowercase, uppercase, numbers, symbols");
  return pw;
}

function normalizeUsername(u: unknown): string {
  if (typeof u !== "string") throw new HttpError(400, "Username is required");
  const name = u.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) throw new HttpError(400, "Username must be 3-32 characters: letters, numbers, dot, dash or underscore");
  return name;
}

async function createSession(env: Env, userId: string, req: Request) {
  const token = b64url(randomBytes(32));
  const id = await sha256Hex(token);
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?,?,?,?,?,?,?)")
    .bind(id, userId, t, t + SESSION_TTL_MS, t, (req.headers.get("user-agent") || "").slice(0, 200), clientIp(req))
    .run();
  return { token, expiresAt: t + SESSION_TTL_MS };
}

export async function register(req: Request, env: Env) {
  if ((env.ALLOW_REGISTRATION ?? "true") !== "true") throw new HttpError(403, "Registration is disabled on this server");
  const ip = clientIp(req);
  await rateLimit(env, `register:${ip}`, 10, 3600);
  const body = await readJson(req);
  if (env.REGISTRATION_INVITE_CODE && !timingSafeEqual(String(body.inviteCode ?? ""), env.REGISTRATION_INVITE_CODE)) {
    throw new HttpError(403, "A valid invite code is required to register");
  }
  const username = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  if (password.toLowerCase().includes(username)) throw new HttpError(400, "Password must not contain your username");

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
  if (exists) throw new HttpError(409, "That username is already taken", "username_taken");

  const salt = randomBytes(16);
  const iter = iterFor(env);
  const hash = await hashPassword(password, salt, iter);
  const id = randomId("u_");
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, password_salt, password_iter, created_at, settings) VALUES (?,?,?,?,?,?,?)"
  ).bind(id, username, hash, b64url(salt), iter, now(), JSON.stringify(DEFAULT_SETTINGS)).run();
  await audit(env, id, "user", "account.registered", { username }, ip);
  const session = await createSession(env, id, req);
  return { user: { id, username }, ...session };
}

export async function login(req: Request, env: Env) {
  const ip = clientIp(req);
  const body = await readJson(req);
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  await rateLimit(env, `login-ip:${ip}`, 20, 900);
  await rateLimit(env, `login-user:${username}`, 10, 900);

  const user = await env.DB.prepare(
    "SELECT id, username, password_hash, password_salt, password_iter, failed_logins, locked_until FROM users WHERE username = ?"
  ).bind(username).first<any>();

  if (!user) {
    await hashPassword(password || "x", DUMMY_SALT); // equalize timing
    throw new HttpError(401, "Incorrect username or password", "invalid_credentials");
  }
  if (user.locked_until > now()) {
    throw new HttpError(423, "Account temporarily locked after repeated failed sign-ins. Try again later.", "locked");
  }
  const hash = await hashPassword(password, b64decode(user.password_salt), user.password_iter);
  if (!timingSafeEqual(hash, user.password_hash)) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED ? now() + LOCK_MS : 0;
    await env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : failed, lock, user.id).run();
    await audit(env, user.id, "user", lock ? "auth.locked" : "auth.login_failed", { failed }, ip);
    throw new HttpError(401, "Incorrect username or password", "invalid_credentials");
  }
  await env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = 0, last_active_at = ? WHERE id = ?").bind(now(), user.id).run();
  await audit(env, user.id, "user", "auth.login", {}, ip);
  const session = await createSession(env, user.id, req);
  return { user: { id: user.id, username: user.username }, ...session };
}

/** Resolve the bearer token to a user, or throw 401. */
export async function requireUser(req: Request, env: Env): Promise<AuthedUser> {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(auth);
  if (!m) throw new HttpError(401, "Sign in required", "unauthenticated");
  const sid = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.id, u.username, u.settings, u.automation_paused
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(sid).first<any>();
  if (!row || row.expires_at < now()) {
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    throw new HttpError(401, "Session expired. Please sign in again.", "unauthenticated");
  }
  // Limit writes: refresh activity markers at most once a minute.
  if (now() - row.last_seen_at > 60_000) {
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now(), sid),
      env.DB.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").bind(now(), row.id),
    ]);
  }
  return {
    id: row.id,
    username: row.username,
    settings: { ...DEFAULT_SETTINGS, ...safeParse(row.settings, {}) },
    automationPaused: !!row.automation_paused,
    sessionId: sid,
  };
}

export async function logout(env: Env, user: AuthedUser, all: boolean, req: Request) {
  if (all) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
  else await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(user.sessionId).run();
  await audit(env, user.id, "user", all ? "auth.logout_all" : "auth.logout", {}, clientIp(req));
  return { ok: true };
}

export async function changePassword(req: Request, env: Env, user: AuthedUser) {
  const body = await readJson(req);
  await rateLimit(env, `pwchange:${user.id}`, 5, 900);
  const row = await env.DB.prepare("SELECT password_hash, password_salt, password_iter FROM users WHERE id = ?").bind(user.id).first<any>();
  const current = await hashPassword(String(body.currentPassword ?? ""), b64decode(row.password_salt), row.password_iter);
  if (!timingSafeEqual(current, row.password_hash)) throw new HttpError(401, "Current password is incorrect");
  const next = validatePassword(body.newPassword);
  if (next.toLowerCase().includes(user.username)) throw new HttpError(400, "Password must not contain your username");
  const salt = randomBytes(16);
  const iter = iterFor(env);
  const hash = await hashPassword(next, salt, iter);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ?").bind(hash, b64url(salt), iter, user.id),
    // Sign out every other session after a password change.
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, user.sessionId),
  ]);
  await audit(env, user.id, "user", "auth.password_changed", {}, clientIp(req));
  return { ok: true };
}

export async function updateSettings(req: Request, env: Env, user: AuthedUser) {
  const body = await readJson<Partial<UserSettings>>(req);
  const next: UserSettings = {
    ...user.settings,
    ...(body.defaultDeviceId !== undefined ? { defaultDeviceId: body.defaultDeviceId } : {}),
    ...(body.voiceName !== undefined ? { voiceName: body.voiceName } : {}),
    ...(body.reducedMotion !== undefined ? { reducedMotion: !!body.reducedMotion } : {}),
    notifications: { ...user.settings.notifications, ...(body.notifications ?? {}) },
  };
  if (next.defaultDeviceId) {
    const ok = await env.DB.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked = 0").bind(next.defaultDeviceId, user.id).first();
    if (!ok) throw new HttpError(400, "Unknown device");
  }
  await env.DB.prepare("UPDATE users SET settings = ? WHERE id = ?").bind(JSON.stringify(next), user.id).run();
  return { settings: next };
}
