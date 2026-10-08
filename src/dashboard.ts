import type { Env } from "./types";
import {
  consumeLoginChallenge,
  createLoginChallenge,
  destroySession,
  getSession,
  parseIservEmail,
  requestLoginCode,
  setSessionCookie,
  clearSessionCookie,
  updateClass,
  verifyLoginCode,
} from "./auth";
import { finishOidcLogin, isMeyerAuthUser, startOidcLogin } from "./oidc";
import { getAccessConfig, isAdminUser, isUserAllowed, updateAccessConfig } from "./access";

type Plan = {
  date: string;
  version: number;
  class: string;
  lessons: Array<Record<string, unknown>>;
};

const esc = (v: unknown) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const cookies = (r: Request) => {
  const result: Record<string, string> = {};
  for (const p of (r.headers.get("Cookie") ?? "").split(";")) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (key) result[key] = decodeURIComponent(valueParts.join("=") || "");
  }
  return result;
};

const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });

const page = (title: string, body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(
    '<!doctype html><html lang="de"><head><meta charset="utf-8"><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111315"><title>' +
      esc(title) +
      '</title><style>' +
      css +
      '</style></head><body><main>' +
      body +
      '</main></body></html>',
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      },
    },
  );

const dateText = (d: string) =>
  new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(
    new Date(d + "T12:00:00Z"),
  );

const addDays = (d: string, n: number) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const addSchoolDay = (d: string, direction: 1 | -1) => {
  let next = addDays(d, direction);
  const weekday = new Date(next + "T12:00:00Z").getUTCDay();
  while (weekday === 0 || weekday === 6) {
    next = addDays(next, direction);
    const day = new Date(next + "T12:00:00Z").getUTCDay();
    if (day !== 0 && day !== 6) break;
  }
  return next;
};

const errorBox = (e?: string) => (e ? '<div class="error">' + esc(e) + "</div>" : "");

function login(env: Env, error?: string) {
  return page(
    "Anmelden · Vertretungsplan",
    '<section class="auth"><div class="brand">Vertretungsplan</div><h1>Anmelden</h1><p class="muted">Melde dich mit deinem IServ-Benutzername an. Wir schicken dir einen einmaligen Code per E-Mail.</p>' +
      errorBox(error) +
      '<form method="post" action="/login"><div class="cf-turnstile" data-sitekey="' +
      esc(env.TURNSTILE_SITEKEY) +
      '" data-action="login"></div><label>IServ-Benutzername</label><div class="email"><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required placeholder="vorname.nachname"><span>@obs-hagen-atw.de</span></div><button>Weiter</button></form></section>',
  );
}

function code(email: string, error?: string) {
  return page(
    "Code eingeben · Vertretungsplan",
    '<section class="auth"><div class="brand">Vertretungsplan</div><h1>Code eingeben</h1><p class="muted">Wir haben dir einen 6-stelligen Code an <strong>' +
      esc(email) +
      '</strong> gesendet.</p>' +
      errorBox(error) +
      '<form method="post" action="/login/verify"><input type="hidden" name="email" value="' +
      esc(email) +
      '"><label>Code</label><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="123456" autocomplete="one-time-code"><button>Anmelden</button></form><a class="back" href="/">Zurück</a></section>',
  );
}

function accessDenied() {
  return page(
    "Kein Zugriff · Vertretungsplan",
    '<section class="auth"><div class="brand">Vertretungsplan</div><h1>Kein Zugriff</h1><p class="muted">Dein Konto ist für den Vertretungsplan derzeit nicht freigeschaltet.</p><a class="back" href="/">Zur Anmeldung</a></section>',
  );
}

function adminPage(config: { everyone: boolean; allowedUsers: string[] }, error?: string) {
  const users = config.allowedUsers.join("\n");
  return page(
    "Admin · Vertretungsplan",
    '<section class="settings"><div class="top"><a class="back" href="/">← Plan</a><form method="post" action="/logout"><button class="secondary">Abmelden</button></form></div><div class="brand">Administration</div><h1>Zugriff</h1><p class="muted">Hier legst du fest, wer den Vertretungsplan verwenden darf.</p>' +
      errorBox(error) +
      '<form method="post" action="/admin"><label class="check"><input id="access-everyone" type="checkbox" name="everyone" value="1" ' +
      (config.everyone ? "checked" : "") +
      '><span>Access for everyone</span></label><div id="allowed-users-wrap" class="allowed-users"><label>Allowed users</label><textarea name="allowed_users" rows="8" placeholder="max.mustermann\nanna.beispiel">' +
      esc(users) +
      '</textarea><p class="small">Nur Usernames eingeben, ohne @ und ohne Domain. Beispiel: <code>max.mustermann</code>. <strong>henry.meyer</strong> ist immer zugelassen.</p></div><button>Speichern</button></form></section><script>const c=document.getElementById("access-everyone"),w=document.getElementById("allowed-users-wrap");function sync(){w.style.display=c.checked?"none":"block"}c.addEventListener("change",sync);sync();</script>',
  );
}

function loginMethod(email: string, env: Env, error?: string) {
  const meyerAuth = isMeyerAuthUser(email, env);
  return page(
    "Anmeldemethode · Vertretungsplan",
    '<section class="auth"><div class="brand">Vertretungsplan</div><h1>Anmeldemethode</h1><p class="muted">Wie möchtest du dich als <strong>' +
      esc(email) +
      "</strong> anmelden?</p>" +
      errorBox(error) +
      '<div class="method-list"><form method="post" action="/login/method"><input type="hidden" name="method" value="code"><button>E-Mail-Code</button></form>' +
      (meyerAuth ? '<form method="post" action="/login/method"><input type="hidden" name="method" value="meyerauth"><button class="secondary">MeyerAuth</button></form>' : "") +
      '</div><a class="back" href="/">Anderes Konto verwenden</a></section>',
  );
}

function setup(email: string, error?: string) {
  return page(
    "Klasse auswählen · Vertretungsplan",
    '<section class="auth"><div class="brand">Vertretungsplan</div><h1>Deine Klasse</h1><p class="muted">Wähle deine Klasse. Du kannst sie später jederzeit ändern.</p>' +
      errorBox(error) +
      '<form method="post" action="/setup"><label>Klassenstufe</label><select name="grade">' +
      [5, 6, 7, 8, 9, 10].map((n) => '<option value="' + n + '">' + n + "</option>").join("") +
      '</select><label>Schulform</label><select name="form"><option value="G">Gymnasium (G)</option><option value="O">Oberschule (O)</option><option value="R">Realschule (R)</option><option value="H">Hauptschule (H)</option></select><label>Klassennummer</label><input name="number" inputmode="numeric" pattern="[0-9]+" maxlength="2" required placeholder="1"><button>Klasse speichern</button></form><p class="small">' +
      esc(email) +
      "</p></section>",
  );
}

function classValue(form: FormData) {
  const grade = String(form.get("grade") ?? "");
  const type = String(form.get("form") ?? "");
  const num = String(form.get("number") ?? "").trim();
  if (!/^(5|6|7|8|9|10)$/.test(grade) || !/^[GORH]$/.test(type) || !/^[0-9]+$/.test(num) || Number(num) < 1 || Number(num) > 99) {
    throw new Error("Bitte wähle eine gültige Klasse.");
  }
  return grade + "-" + type + num;
}

function settings(email: string, current: string | null, error?: string) {
  const m = current?.match(/^(5|6|7|8|9|10)-([GORH])([0-9]+)$/);
  const grade = m?.[1] ?? "5";
  const type = m?.[2] ?? "G";
  const num = m?.[3] ?? "1";
  return page(
    "Einstellungen · Vertretungsplan",
    '<section class="settings"><div class="top"><a class="back" href="/">← Plan</a><form method="post" action="/logout"><button class="secondary">Abmelden</button></form></div><div class="brand">Einstellungen</div><h1>Deine Klasse</h1><p class="muted">Angemeldet als <strong>' +
      esc(email) +
      "</strong></p>" +
      errorBox(error) +
      '<form method="post" action="/settings"><label>Klassenstufe</label><select name="grade">' +
      [5, 6, 7, 8, 9, 10].map((n) => '<option value="' + n + '" ' + (grade === String(n) ? "selected" : "") + ">" + n + "</option>").join("") +
      '</select><label>Schulform</label><select name="form">' +
      [["G", "Gymnasium (G)"], ["O", "Oberschule (O)"], ["R", "Realschule (R)"], ["H", "Hauptschule (H)"]].map(([v, l]) => '<option value="' + v + '" ' + (type === v ? "selected" : "") + ">" + l + "</option>").join("") +
      '</select><label>Klassennummer</label><input name="number" inputmode="numeric" pattern="[0-9]+" maxlength="2" required value="' +
      esc(num) +
      '"><button>Klasse speichern</button></form></section>',
  );
}

const lesson = (l: Record<string, unknown>) => {
  const v = (...ks: string[]) => ks.map((k) => l[k]).find((x) => x !== undefined && x !== null && String(x).trim()) as string | undefined;
  const p = v("period", "lesson", "stunde");
  const s = v("subject", "fach");
  const t = v("teacher", "lehrer");
  const r = v("room", "raum");
  const ty = v("type", "art");
  const tx = v("text", "description", "beschreibung");
  const meta =
    (t ? '<span class="lesson-meta">Lehrer: ' + esc(t) + "</span>" : "") +
    (r ? '<span class="lesson-meta">Raum: ' + esc(r) + "</span>" : "") +
    (ty ? '<span class="lesson-type">' + esc(ty) + "</span>" : "");
  return (
    '<article class="lesson"><div class="period"><strong>' +
    esc(p || "–") +
    '</strong><span>Stunde</span></div><div class="lesson-content"><div class="subject">' +
    esc(s || tx || "Vertretung") +
    '</div>' +
    (meta ? '<div class="lesson-meta-row">' + meta + "</div>" : "") +
    "</div></article>"
  );
};

async function plan(env: Env, className: string, date: string) {
  const row = await env.DB.prepare("SELECT data_json FROM plans WHERE plan_date = ? AND class_name = ? ORDER BY version DESC LIMIT 1")
    .bind(date, className)
    .first();
  return row ? (JSON.parse(String(row.data_json)) as Plan) : null;
}

async function home(env: Env, className: string, date: string, email: string) {
  const p = await plan(env, className, date);
  const adminLink = isAdminUser(email, env) ? '<a class="settings-link" href="/admin">Admin</a>' : "";
  const body =
    '<header><div><div class="brand">Vertretungsplan</div><h1>' +
    esc(className) +
    '</h1><div class="muted">' +
    esc(dateText(p?.date ?? date)) +
    (p ? " · Version " + esc(p.version) : "") +
    '</div></div><div class="header-actions">' +
    adminLink +
    '<a class="settings-link" href="/settings">Einstellungen</a><form method="post" action="/logout"><button class="secondary logout-button">Abmelden</button></form></div></header><nav><a href="/?date=' +
    esc(addSchoolDay(date, -1)) +
    '">← Vorheriger Tag</a><a href="/?date=' +
    esc(addSchoolDay(date, 1)) +
    '">Nächster Tag →</a></nav><section class="card">' +
    (p?.lessons?.length ? p.lessons.map(lesson).join("") : '<div class="empty">Für ' + esc(className) + " ist an diesem Tag kein Plan vorhanden.</div>") +
    '</section><footer><a href="https://github.com/henrymmey/untis-to-api" target="_blank" rel="noopener noreferrer">GitHub Repository</a> · <a href="https://henrymeyer.de/" target="_blank" rel="noopener noreferrer">Developed by Henry Meyer</a></footer>';
  return page("Vertretungsplan · " + className, body);
}

async function verifyTurnstile(request: Request, env: Env, token: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) return false;
    const result = (await r.json()) as { success?: boolean; hostname?: string; action?: string };
    return result.success === true && result.hostname === "obs.henrymeyer.de" && result.action === "login";
  } catch {
    return false;
  }
}

export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    const s = await getSession(request, env);
    if (!s) return login(env);
    if (!(await isUserAllowed(env, s.user.email))) return accessDenied();
    if (!s.user.className) return setup(s.user.email);
    const d = url.searchParams.get("date");
    const date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
    return home(env, s.user.className, date, s.user.email);
  }

  if (request.method === "GET" && url.pathname === "/setup") {
    const s = await getSession(request, env);
    if (!s) return redirect("/");
    if (!(await isUserAllowed(env, s.user.email))) return accessDenied();
    if (s.user.className) return redirect("/");
    return setup(s.user.email);
  }

  if (request.method === "GET" && url.pathname === "/login/code") {
    const e = cookies(request)["__Host-login-email"];
    return e ? code(e) : redirect("/");
  }

  if (request.method === "POST" && url.pathname === "/login") {
    try {
      const f = await request.formData();
      const token = String(f.get("cf-turnstile-response") ?? "");
      if (!(await verifyTurnstile(request, env, token))) return login(env, "Bitte bestätige, dass du kein Bot bist.");
      const email = parseIservEmail(String(f.get("username") ?? ""), env);
      if (!email) throw new Error("Ungültiger IServ-Benutzername.");
      if (!(await isUserAllowed(env, email))) return accessDenied();
      const challenge = await createLoginChallenge(env, email);
      const x = redirect("/login/method");
      const h = new Headers(x.headers);
      h.append("Set-Cookie", "__Host-login-challenge=" + encodeURIComponent(challenge) + "; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax");
      return new Response(x.body, { status: x.status, headers: h });
    } catch (e) {
      return login(env, e instanceof Error ? e.message : "Anmeldung fehlgeschlagen.");
    }
  }

  if (request.method === "GET" && url.pathname === "/login/method") {
    const token = cookies(request)["__Host-login-challenge"];
    if (!token) return redirect("/");
    const row = await env.DB.prepare("SELECT email, expires_at FROM login_challenges WHERE token = ? LIMIT 1")
      .bind(token)
      .first<{ email: string; expires_at: string }>();
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) return redirect("/");
    if (!(await isUserAllowed(env, row.email))) return accessDenied();
    return loginMethod(row.email, env);
  }

  if (request.method === "POST" && url.pathname === "/login/method") {
    try {
      const token = cookies(request)["__Host-login-challenge"];
      const row = token ? await env.DB.prepare("SELECT email FROM login_challenges WHERE token = ? LIMIT 1").bind(token).first<{ email: string }>() : null;
      if (!row) return redirect("/");
      if (!(await isUserAllowed(env, row.email))) return accessDenied();
      if (!(await consumeLoginChallenge(env, token, row.email))) return redirect("/");

      const method = String((await request.formData()).get("method") ?? "");
      if (method === "code") {
        const r = await requestLoginCode(request, env, row.email.split("@")[0]);
        const x = redirect("/login/code");
        const h = new Headers(x.headers);
        h.append("Set-Cookie", "__Host-login-email=" + encodeURIComponent(r.email) + "; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax");
        h.append("Set-Cookie", "__Host-login-challenge=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax");
        return new Response(x.body, { status: x.status, headers: h });
      }

      if (method === "meyerauth") {
        if (!isMeyerAuthUser(row.email, env)) return loginMethod(row.email, env, "MeyerAuth ist für dieses Konto nicht verfügbar.");
        const target = await startOidcLogin(env, row.email);
        const x = redirect(target);
        const h = new Headers(x.headers);
        h.append("Set-Cookie", "__Host-login-challenge=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax");
        return new Response(x.body, { status: x.status, headers: h });
      }

      return loginMethod(row.email, env, "Ungültige Anmeldemethode.");
    } catch {
      return redirect("/");
    }
  }

  if (request.method === "GET" && url.pathname === "/auth/oidc/callback") {
    try {
      const r = await finishOidcLogin(env, url.toString());
      return setSessionCookie(r.user.className ? redirect("/") : redirect("/setup"), r.sessionToken);
    } catch (e) {
      return login(env, e instanceof Error ? e.message : "MeyerAuth-Anmeldung fehlgeschlagen.");
    }
  }

  if (request.method === "POST" && url.pathname === "/login/verify") {
    const f = await request.formData();
    const e = String(f.get("email") ?? cookies(request)["__Host-login-email"] ?? "");
    try {
      const r = await verifyLoginCode(env, e, String(f.get("code") ?? ""));
      const x = setSessionCookie(r.user.className ? redirect("/") : redirect("/setup"), r.sessionToken);
      const h = new Headers(x.headers);
      h.append("Set-Cookie", "__Host-login-email=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax");
      return new Response(x.body, { status: x.status, headers: h });
    } catch (err) {
      return code(e, err instanceof Error ? err.message : "Anmeldung fehlgeschlagen.");
    }
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    const s = await getSession(request, env);
    if (!s) return redirect("/");
    if (!isAdminUser(s.user.email, env)) return new Response("Forbidden.", { status: 403 });
    return adminPage(await getAccessConfig(env));
  }

  if (request.method === "POST" && url.pathname === "/admin") {
    const s = await getSession(request, env);
    if (!s) return redirect("/");
    if (!isAdminUser(s.user.email, env)) return new Response("Forbidden.", { status: 403 });
    try {
      const f = await request.formData();
      const config = await updateAccessConfig(env, f.get("everyone") === "1", String(f.get("allowed_users") ?? ""));
      return adminPage(config);
    } catch (e) {
      return adminPage(await getAccessConfig(env), e instanceof Error ? e.message : "Einstellungen konnten nicht gespeichert werden.");
    }
  }

  if (request.method === "POST" && (url.pathname === "/setup" || url.pathname === "/settings")) {
    const s = await getSession(request, env);
    if (!s) return redirect("/");
    try {
      const c = classValue(await request.formData());
      await updateClass(env, s.user.id, c);
      return redirect("/");
    } catch (e) {
      return url.pathname === "/setup"
        ? setup(s.user.email, e instanceof Error ? e.message : "Klasse konnte nicht gespeichert werden.")
        : settings(s.user.email, s.user.className, e instanceof Error ? e.message : "Klasse konnte nicht gespeichert werden.");
    }
  }

  if (request.method === "GET" && url.pathname === "/settings") {
    const s = await getSession(request, env);
    return s ? settings(s.user.email, s.user.className) : redirect("/");
  }

  if (request.method === "POST" && url.pathname === "/logout") {
    await destroySession(request, env);
    return clearSessionCookie(redirect("/"));
  }

  return new Response("Not found.", { status: 404 });
}

const css = ':root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark;--bg:#090b0f;--surface:#11151b;--surface-2:#171c23;--border:#252c35;--text:#f3f5f7;--muted:#929ba8;--accent:#7c9cff;--accent-hover:#91aaff;--warning:#f0bd5c}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:radial-gradient(circle at 50% -10%,#182131 0,#090b0f 42%);color:var(--text);min-height:100vh}main{max-width:920px;margin:auto;padding:28px 18px 64px}.auth,.settings{max-width:500px;margin:8vh auto 0;background:rgba(17,21,27,.94);border:1px solid var(--border);border-radius:22px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,.35)}.brand{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:9px}h1{margin:0 0 9px;font-size:clamp(28px,6vw,42px);letter-spacing:-.025em}.muted{color:var(--muted);line-height:1.55}.small{color:var(--muted);font-size:13px;margin-top:18px}form{display:grid;gap:9px;margin-top:22px}label{font-size:14px;font-weight:700;margin-top:4px}input,select,textarea{width:100%;border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:12px;padding:12px 13px;font:inherit;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,156,255,.14)}button{border:1px solid transparent;border-radius:12px;padding:12px 16px;background:var(--accent);color:#08101f;font:inherit;font-weight:800;cursor:pointer;margin-top:8px;transition:transform .15s ease,background .15s ease,box-shadow .15s ease}button:hover{background:var(--accent-hover);transform:translateY(-1px);box-shadow:0 8px 22px rgba(124,156,255,.18)}button.secondary{background:#20262f;color:var(--text)!important;border-color:#303944;margin:0}button.secondary:hover{background:#2a323d}.logout-button{padding:9px 13px}.email{display:flex;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--surface-2)}.email input{border:0;border-radius:0;min-width:0}.email span{display:flex;align-items:center;padding:0 12px;color:var(--muted);background:#1d232b;font-size:14px;white-space:nowrap}.code{text-align:center;font-size:24px;letter-spacing:7px}.error{margin-top:16px;padding:12px 14px;border-radius:11px;background:#32191c;color:#ff9b9b;border:1px solid #613038}.method-list{display:grid;gap:10px;margin-top:22px}.method-list form{margin:0}.method-list button{width:100%}.back{color:var(--muted);text-decoration:none;font-size:14px}.back:hover{color:var(--text)}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:24px}.header-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.header-actions form{display:block;margin:0}.header-actions .settings-link,.header-actions .logout-button{display:inline-flex;align-items:center;justify-content:center;height:42px;min-height:42px;padding:0 14px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--text);text-decoration:none;font-weight:750;line-height:1}.header-actions .settings-link:hover{background:var(--surface-2);border-color:#394351;transform:translateY(-1px)}.header-actions .logout-button{background:#20262f;color:var(--text)!important;margin:0}.header-actions .logout-button:hover{background:#2a323d;box-shadow:none}.check{display:flex;align-items:center;gap:10px;cursor:pointer}.check input{width:auto}.allowed-users{display:none}.allowed-users textarea{resize:vertical;min-height:150px}.settings .top{display:flex;justify-content:space-between;align-items:center;gap:12px}.card{display:grid;gap:12px}.lesson{display:grid;grid-template-columns:104px minmax(0,1fr);min-height:118px;border:1px solid var(--border);border-radius:16px;background:linear-gradient(135deg,rgba(23,28,35,.98),rgba(15,19,25,.98));box-shadow:0 8px 24px rgba(0,0,0,.16);overflow:hidden}.period{display:flex;flex-direction:column;justify-content:center;padding:20px 22px;border-right:1px solid var(--border);background:rgba(124,156,255,.045)}.period strong{font-size:30px;line-height:1;font-weight:900;color:var(--accent);letter-spacing:-.04em}.period span{margin-top:7px;color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.lesson-content{display:flex;flex-direction:column;justify-content:center;min-width:0;padding:20px 24px}.subject{font-size:22px;line-height:1.2;font-weight:850;letter-spacing:-.02em}.lesson-meta-row{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.lesson-meta,.lesson-type{display:inline-flex;align-items:center;min-height:28px;padding:5px 9px;border:1px solid var(--border);border-radius:8px;background:#1a2028;color:var(--muted);font-size:12px;font-weight:650}.lesson-type{color:var(--warning);border-color:rgba(240,189,92,.25);background:rgba(240,189,92,.07)}.empty{padding:28px 0;color:var(--muted);text-align:center}.settings-link{color:inherit;text-decoration:none;font-weight:700}nav{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}nav a{display:flex;align-items:center;justify-content:center;min-height:48px;padding:12px 16px;border:1px solid var(--border);border-radius:13px;background:var(--surface);color:var(--text);text-decoration:none;font-weight:750;transition:background .15s ease,border-color .15s ease,transform .15s ease}nav a:hover{background:var(--surface-2);border-color:#3a4552;transform:translateY(-1px)}nav a:first-child{justify-content:flex-start}nav a:last-child{justify-content:flex-end}footer{margin-top:22px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;justify-content:center;font-size:13px}footer a{color:var(--muted);text-decoration:none}footer a:hover{color:var(--text)}.cf-turnstile{margin-top:4px}@media(max-width:700px){main{padding:18px 13px 44px}.auth,.settings{margin-top:4vh;padding:24px 20px;border-radius:18px}header{align-items:stretch;flex-direction:column}.header-actions{justify-content:stretch}.header-actions .settings-link,.header-actions form{flex:1}.header-actions .settings-link,.header-actions .logout-button{width:100%}.lesson{grid-template-columns:72px minmax(0,1fr);min-height:108px}.period{padding:16px}.period strong{font-size:25px}.lesson-content{padding:17px 18px}.subject{font-size:19px}.lesson-meta-row{margin-top:9px}nav{grid-template-columns:1fr}.header-actions .settings-link{min-width:0}}';
