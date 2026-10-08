import type { Env } from "./types";
import { sendSmtpMail } from "./smtp";

const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 5;
const RATE_WINDOW_MINUTES = 10;
const MAX_CODES_PER_EMAIL = 3;
const MAX_CODES_PER_IP = 10;

export type SessionUser = {
  id: number;
  email: string;
  className: string | null;
};

function normalizeEmail(username: string, domain: string): string | null {
  const value = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) return null;
  return value + "@" + domain.toLowerCase();
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomToken(bytes = 32): string {
  return [...randomBytes(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const bytes = randomBytes(4);
  const value = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return value.toString().padStart(CODE_LENGTH, "0");
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function sessionCookie(token: string, maxAge: number): string {
  return "__Host-session=" + encodeURIComponent(token) + "; Max-Age=" + maxAge + "; Path=/; Secure; HttpOnly; SameSite=Lax";
}

function nowPlusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function nowPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function parseIservEmail(username: string, env: Env): string | null {
  const domain = env.ISERV_DOMAIN.toLowerCase().replace(/^@/, "");
  return normalizeEmail(username, domain);
}

export async function requestLoginCode(
  request: Request,
  env: Env,
  username: string,
): Promise<{ email: string; codeId: number }> {
  const email = parseIservEmail(username, env);
  if (!email) throw new Error("Ungültiger IServ-Benutzername.");

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const windowStart = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();

  const emailCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM login_codes WHERE email = ? AND created_at >= ?",
  ).bind(email, windowStart).first<{ count: number }>();

  const ipCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM login_codes WHERE request_ip = ? AND created_at >= ?",
  ).bind(ip, windowStart).first<{ count: number }>();

  if (Number(emailCount?.count ?? 0) >= MAX_CODES_PER_EMAIL) {
    throw new Error("Zu viele Codes angefordert. Bitte versuche es später erneut.");
  }
  if (Number(ipCount?.count ?? 0) >= MAX_CODES_PER_IP) {
    throw new Error("Zu viele Anfragen. Bitte versuche es später erneut.");
  }

  await env.DB.prepare(
    "DELETE FROM login_codes WHERE expires_at < ? OR used = 1",
  ).bind(new Date().toISOString()).run();

  const code = randomCode();
  const codeHash = await sha256(code);
  const createdAt = new Date().toISOString();
  const expiresAt = nowPlusMinutes(CODE_MINUTES);

  const inserted = await env.DB.prepare(
    "INSERT INTO login_codes (email, code_hash, expires_at, created_at, request_ip, attempts, used) VALUES (?, ?, ?, ?, ?, 0, 0) RETURNING id",
  ).bind(email, codeHash, expiresAt, createdAt, ip).first<{ id: number }>();

  if (!inserted?.id) throw new Error("Login-Code konnte nicht erstellt werden.");

  try {
    await sendSmtpMail(env, {
      to: email,
      from: env.EMAIL_FROM,
      subject: "Dein Vertretungsplan – Anmeldecode",
      text: [
        "Hallo,",
        "",
        "dein Anmeldecode für den Vertretungsplan lautet:",
        "",
        code,
        "",
        "Der Code ist " + CODE_MINUTES + " Minuten gültig und kann nur einmal verwendet werden.",
        "",
        "Wenn du diese Anmeldung nicht angefordert hast, kannst du diese E-Mail ignorieren.",
      ].join("\n"),
      html: "<p>Hallo,</p><p>dein Anmeldecode für den Vertretungsplan lautet:</p><p style=\"font-size:28px;font-weight:700;letter-spacing:6px\">" + code + "</p><p>Der Code ist " + CODE_MINUTES + " Minuten gültig und kann nur einmal verwendet werden.</p><p>Wenn du diese Anmeldung nicht angefordert hast, kannst du diese E-Mail ignorieren.</p>",
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM login_codes WHERE id = ?").bind(inserted.id).run();
    console.error("Failed to send login code:", error);
    throw new Error("Die E-Mail konnte nicht gesendet werden.");
  }

  return { email, codeId: Number(inserted.id) };
}

export async function verifyLoginCode(
  env: Env,
  email: string,
  code: string,
): Promise<{ sessionToken: string; user: SessionUser }> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalizedEmail) || !/^\d{6}$/.test(code)) {
    throw new Error("Ungültiger Code.");
  }

  const row = await env.DB.prepare(
    "SELECT id, email, code_hash, expires_at, attempts, used FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(normalizedEmail).first<{
    id: number;
    email: string;
    code_hash: string;
    expires_at: string;
    attempts: number;
    used: number;
  }>();

  if (!row || row.used || new Date(row.expires_at).getTime() <= Date.now() || Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    throw new Error("Ungültiger oder abgelaufener Code.");
  }

  const suppliedHash = await sha256(code);
  if (suppliedHash !== row.code_hash) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    throw new Error("Ungültiger oder abgelaufener Code.");
  }

  await env.DB.prepare("UPDATE login_codes SET used = 1 WHERE id = ?").bind(row.id).run();

  const existing = await env.DB.prepare(
    "SELECT id, email, class_name AS className FROM users WHERE email = ? LIMIT 1",
  ).bind(normalizedEmail).first<SessionUser>();

  let user: SessionUser;
  if (existing) {
    user = { id: Number(existing.id), email: existing.email, className: existing.className ?? null };
  } else {
    const inserted = await env.DB.prepare(
      "INSERT INTO users (email, class_name, created_at, updated_at) VALUES (?, NULL, ?, ?) RETURNING id",
    ).bind(normalizedEmail, new Date().toISOString(), new Date().toISOString()).first<{ id: number }>();
    if (!inserted?.id) throw new Error("Benutzer konnte nicht angelegt werden.");
    user = { id: Number(inserted.id), email: normalizedEmail, className: null };
  }

  const sessionToken = randomToken();
  const sessionHash = await sha256(sessionToken);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(sessionHash, user.id, nowPlusDays(SESSION_DAYS), new Date().toISOString()).run();

  return { sessionToken, user };
}

export async function getSession(request: Request, env: Env): Promise<{ token: string; user: SessionUser } | null> {
  const token = cookieValue(request, "__Host-session");
  if (!token) return null;

  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT s.user_id, s.expires_at, u.email, u.class_name AS className FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? LIMIT 1",
  ).bind(tokenHash).first<{
    user_id: number;
    expires_at: string;
    email: string;
    className: string | null;
  }>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  return {
    token,
    user: {
      id: Number(row.user_id),
      email: row.email,
      className: row.className ?? null,
    },
  };
}

export function setSessionCookie(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
  return new Response(response.body, { status: response.status, headers });
}

export function clearSessionCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", sessionCookie("", 0));
  return new Response(response.body, { status: response.status, headers });
}

export async function destroySession(request: Request, env: Env): Promise<void> {
  const token = cookieValue(request, "__Host-session");
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export async function updateClass(env: Env, userId: number, className: string): Promise<void> {
  if (!/^(?:5|6|7|8|9|10)-[GORH]\d+$/.test(className)) {
    throw new Error("Ungültige Klasse.");
  }
  await env.DB.prepare(
    "UPDATE users SET class_name = ?, updated_at = ? WHERE id = ?",
  ).bind(className, new Date().toISOString(), userId).run();
}
