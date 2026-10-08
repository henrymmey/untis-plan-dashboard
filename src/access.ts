import type { Env } from "./types";

export type AccessConfig = {
  everyone: boolean;
  allowedUsers: string[];
};

const ADMIN_USERNAME = "henry.meyer";

function normalizeUsername(value: string): string | null {
  const username = value.trim().toLowerCase().replace(/^@+/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) return null;
  return username;
}

function usernameFromEmail(email: string): string {
  return email.trim().toLowerCase().split("@", 1)[0];
}

export function isAdminUser(email: string, env: Env): boolean {
  return usernameFromEmail(email) === ADMIN_USERNAME;
}

export async function getAccessConfig(env: Env): Promise<AccessConfig> {
  try {
    const rows = await env.DB.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('access_everyone', 'allowed_users')",
    ).all<{ key: string; value: string }>();

    const values = new Map(rows.results.map((row) => [row.key, row.value]));
    let allowedUsers: string[] = [];

    try {
      const parsed = JSON.parse(values.get("allowed_users") ?? "[]");
      if (Array.isArray(parsed)) {
        allowedUsers = parsed
          .map((value) => normalizeUsername(String(value)))
          .filter((value): value is string => Boolean(value));
      }
    } catch {
      allowedUsers = [];
    }

    return {
      everyone: values.get("access_everyone") !== "0",
      allowedUsers: [...new Set(allowedUsers)],
    };
  } catch {
    // If the settings table is not available yet, preserve the current open behaviour.
    return { everyone: true, allowedUsers: [] };
  }
}

export async function isUserAllowed(env: Env, email: string): Promise<boolean> {
  if (isAdminUser(email, env)) return true;

  const config = await getAccessConfig(env);
  if (config.everyone) return true;

  return config.allowedUsers.includes(usernameFromEmail(email));
}

export async function updateAccessConfig(
  env: Env,
  everyone: boolean,
  rawAllowedUsers: string,
): Promise<AccessConfig> {
  const values = rawAllowedUsers
    .split(/[\s,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const allowedUsers: string[] = [];
  for (const value of values) {
    const username = normalizeUsername(value);
    if (!username) {
      throw new Error("Ungültiger Username in der Liste: " + value);
    }
    if (!allowedUsers.includes(username)) allowedUsers.push(username);
  }

  const config: AccessConfig = { everyone, allowedUsers };
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('access_everyone', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(everyone ? "1" : "0", now),
    env.DB.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('allowed_users', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(JSON.stringify(allowedUsers), now),
  ]);

  return config;
}
