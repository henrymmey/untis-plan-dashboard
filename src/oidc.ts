import type { Env } from "./types";
import { createSessionForEmail } from "./auth";

const OIDC_STATE_MINUTES = 10;
const SPECIAL_USERNAMES = new Set(["henry.meyer", "lennard.mathis.meyer"]);

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomToken(bytes = 32): string {
  return [...randomBytes(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(await sha256Bytes(verifier));
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isMeyerAuthUser(email: string, env: Env): boolean {
  const domain = env.ISERV_DOMAIN.toLowerCase().replace(/^@/, "");
  return email.toLowerCase() === "henry.meyer@" + domain || email.toLowerCase() === "lennard.mathis.meyer@" + domain;
}

async function discovery(env: Env): Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string }> {
  const issuer = normalizeIssuer(env.OIDC_ISSUER);
  const response = await fetch(issuer + "/.well-known/openid-configuration");
  if (!response.ok) throw new Error("MeyerAuth ist derzeit nicht erreichbar.");
  const data = await response.json() as { authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string };
  if (!data.authorization_endpoint || !data.token_endpoint) throw new Error("MeyerAuth ist nicht korrekt konfiguriert.");
  return data as { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string };
}

export async function startOidcLogin(env: Env, email: string): Promise<string> {
  if (!isMeyerAuthUser(email, env)) throw new Error("MeyerAuth ist für dieses Konto nicht verfügbar.");
  const meta = await discovery(env);
  const state = randomToken(32);
  const verifier = base64Url(randomBytes(48));
  const challenge = await pkceChallenge(verifier);
  const now = new Date();
  await env.DB.prepare(
    "DELETE FROM oidc_states WHERE expires_at < ?",
  ).bind(now.toISOString()).run();
  await env.DB.prepare(
    "INSERT INTO oidc_states (state, email, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(state, email.toLowerCase(), verifier, new Date(now.getTime() + OIDC_STATE_MINUTES * 60_000).toISOString(), now.toISOString()).run();

  const params = new URLSearchParams({
    client_id: env.OIDC_CLIENT_ID,
    redirect_uri: env.OIDC_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return meta.authorization_endpoint + "?" + params.toString();
}

export async function finishOidcLogin(env: Env, requestUrl: string): Promise<{ sessionToken: string; user: Awaited<ReturnType<typeof createSessionForEmail>>["user"] }> {
  const url = new URL(requestUrl);
  const error = url.searchParams.get("error");
  if (error) throw new Error("MeyerAuth-Anmeldung wurde abgebrochen.");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) throw new Error("Ungültige MeyerAuth-Antwort.");

  const row = await env.DB.prepare(
    "SELECT email, code_verifier, expires_at FROM oidc_states WHERE state = ? LIMIT 1",
  ).bind(state).first<{ email: string; code_verifier: string; expires_at: string }>();
  await env.DB.prepare("DELETE FROM oidc_states WHERE state = ?").bind(state).run();
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) throw new Error("MeyerAuth-Anmeldung ist abgelaufen.");

  const meta = await discovery(env);
  const tokenResponse = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
      redirect_uri: env.OIDC_REDIRECT_URI,
      code_verifier: row.code_verifier,
    }),
  });
  if (!tokenResponse.ok) throw new Error("MeyerAuth konnte den Login-Code nicht bestätigen.");
  const tokens = await tokenResponse.json() as { access_token?: string; token_type?: string };
  if (!tokens.access_token) throw new Error("MeyerAuth hat kein Zugriffstoken geliefert.");

  let email: string | undefined;
  if (meta.userinfo_endpoint) {
    const userinfoResponse = await fetch(meta.userinfo_endpoint, {
      headers: { Authorization: "Bearer " + tokens.access_token },
    });
    if (userinfoResponse.ok) {
      const userinfo = await userinfoResponse.json() as { email?: string; email_verified?: boolean };
      if (userinfo.email_verified === false) throw new Error("Die MeyerAuth-E-Mail ist nicht verifiziert.");
      email = userinfo.email?.trim().toLowerCase();
    }
  }

  if (!email) throw new Error("MeyerAuth hat keine E-Mail-Adresse zurückgegeben.");
  if (email !== row.email) throw new Error("Die MeyerAuth-E-Mail stimmt nicht mit deinem IServ-Konto überein.");
  if (!isMeyerAuthUser(email, env)) throw new Error("Dieses Konto ist für MeyerAuth nicht freigeschaltet.");

  return createSessionForEmail(env, email);
}
