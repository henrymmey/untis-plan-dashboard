import type { Env } from "./types";

type Plan = {
  date: string;
  version: number;
  class: string;
  reportDate?: string | null;
  lessons: Array<Record<string, unknown>>;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

function lessonValue(lesson: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (lesson[key] !== undefined && lesson[key] !== null && String(lesson[key]).trim()) {
      return String(lesson[key]);
    }
  }
  return "";
}

function renderLesson(lesson: Record<string, unknown>): string {
  const period = lessonValue(lesson, ["period", "lesson", "stunde"]);
  const subject = lessonValue(lesson, ["subject", "fach"]);
  const teacher = lessonValue(lesson, ["teacher", "lehrer"]);
  const room = lessonValue(lesson, ["room", "raum"]);
  const type = lessonValue(lesson, ["type", "art"]);
  const text = lessonValue(lesson, ["text", "description", "beschreibung"]);

  return `
    <article class="lesson">
      <div class="period">${escapeHtml(period || "–")}</div>
      <div class="details">
        <strong>${escapeHtml(subject || text || "Vertretung")}</strong>
        ${teacher ? `<span>${escapeHtml(teacher)}</span>` : ""}
        ${room ? `<span>Raum ${escapeHtml(room)}</span>` : ""}
        ${type ? `<span class="tag">${escapeHtml(type)}</span>` : ""}
      </div>
    </article>
  `;
}

async function loadPlan(env: Env, date: string): Promise<Plan | null> {
  const row = await env.DB.prepare(
    "SELECT data_json FROM plans WHERE plan_date = ? AND class_name = ? ORDER BY version DESC LIMIT 1",
  ).bind(date, env.TARGET_CLASS).first();

  if (!row) return null;
  return JSON.parse(String(row.data_json)) as Plan;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function renderPage(plan: Plan | null, date: string): Response {
  const title = plan
    ? `${plan.class} · ${formatDate(plan.date)}`
    : `Kein Plan · ${formatDate(date)}`;

  const lessons = plan?.lessons ?? [];

  const lessonHtml = lessons.length
    ? lessons.map(renderLesson).join("")
    : '<div class="empty">Für diesen Tag ist kein Vertretungsplan vorhanden.</div>';

  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f6f8; color: #17181a; }
    main { max-width: 820px; margin: 0 auto; padding: 32px 18px 56px; }
    .header { margin-bottom: 22px; }
    .eyebrow { color: #68707a; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 5px 0 4px; font-size: clamp(28px, 6vw, 42px); }
    .meta { color: #68707a; }
    .nav { display: flex; gap: 10px; margin: 20px 0; }
    .nav a { flex: 1; text-align: center; padding: 11px 14px; border-radius: 10px; background: white; color: inherit; text-decoration: none; border: 1px solid #e2e5e9; }
    .card { background: white; border: 1px solid #e2e5e9; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 18px rgba(0,0,0,.04); }
    .lesson { display: grid; grid-template-columns: 76px 1fr; gap: 12px; padding: 16px 18px; border-bottom: 1px solid #eceef0; }
    .lesson:last-child { border-bottom: 0; }
    .period { font-weight: 800; color: #68707a; }
    .details { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
    .details strong { width: 100%; font-size: 17px; }
    .details span { color: #68707a; font-size: 14px; }
    .tag { padding: 3px 8px; border-radius: 999px; background: #eef0f2; }
    .empty { padding: 32px 20px; color: #68707a; text-align: center; }
    footer { margin-top: 16px; color: #7a818a; font-size: 13px; text-align: center; }
    @media (prefers-color-scheme: dark) {
      body { background: #111315; color: #f3f4f5; }
      .nav a, .card { background: #191c1f; border-color: #2b3035; }
      .lesson { border-color: #2b3035; }
      .meta, .eyebrow, .period, .details span, .empty, footer { color: #9ba3ad; }
      .tag { background: #2b3035; }
    }
  </style>
</head>
<body>
  <main>
    <header class="header">
      <div class="eyebrow">Vertretungsplan</div>
      <h1>${escapeHtml(plan?.class ?? "9-G1")}</h1>
      <div class="meta">${escapeHtml(formatDate(plan?.date ?? date))}${plan ? ` · Version ${escapeHtml(plan.version)}` : ""}</div>
    </header>

    <nav class="nav">
      <a href="/?date=${escapeHtml(addDays(date, -1))}">← Vorheriger Tag</a>
      <a href="/?date=${escapeHtml(addDays(date, 1))}">Nächster Tag →</a>
    </nav>

    <section class="card">
      ${lessonHtml}
    </section>

    <footer>OBS Hagen · automatisch aus dem Vertretungsplan erstellt</footer>
  </main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestedDate = url.searchParams.get("date");
  const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : new Date().toISOString().slice(0, 10);

  const plan = await loadPlan(env, date);
  return renderPage(plan, date);
}
