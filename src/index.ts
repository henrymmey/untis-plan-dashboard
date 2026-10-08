import { extractText, getDocumentProxy } from "unpdf";
import PostalMime from "postal-mime";
import { parsePlanText } from "./parser";
import { handleDashboard } from "./dashboard";
import type { Env } from "./types";

const API_HOST = "api.grueneeule.de";
const DASHBOARD_HOST = "obs.henrymeyer.de";
const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
const errorJson = (message: string, status = 500, extra: HeadersInit = {}) =>
  json({ error: message }, status, extra);
const parts = (url: URL) => url.pathname.split("/").filter(Boolean);

async function parsePdf(pdf: Uint8Array) {
  const doc = await getDocumentProxy(pdf);
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

async function savePlans(
  env: Env,
  parsedPlans: ReturnType<typeof parsePlanText>,
  attachment: { filename: string; content: Uint8Array },
  meta: { messageId?: string; emailDate?: string },
) {
  if (!parsedPlans.length)
    throw new Error("No supported classes were found in the PDF.");
  const first = parsedPlans[0],
    key = "plans/" + first.planDate + "/" + first.version + "/source.pdf",
    now = new Date().toISOString();
  await env.PDF_BUCKET.put(key, attachment.content, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: {
      planDate: first.planDate,
      version: String(first.version),
      sourceFilename: attachment.filename,
    },
  });
  await env.DB.batch(
    parsedPlans.map((p) =>
      env.DB.prepare(
        "INSERT INTO plans (plan_date,version,class_name,created_at,source_filename,source_message_id,source_email_date,source_r2_key,data_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(plan_date,version,class_name) DO UPDATE SET created_at=excluded.created_at,source_filename=excluded.source_filename,source_message_id=excluded.source_message_id,source_email_date=excluded.source_email_date,source_r2_key=excluded.source_r2_key,data_json=excluded.data_json",
      ).bind(
        p.planDate,
        p.version,
        p.className,
        now,
        attachment.filename,
        meta.messageId ?? null,
        meta.emailDate ?? null,
        key,
        JSON.stringify({
          date: p.planDate,
          version: p.version,
          class: p.className,
          reportDate: p.reportDate ?? null,
          lessons: p.lessons,
        }),
      ),
    ),
  );
  return parsedPlans.length;
}

async function processEmail(message: ForwardableEmailMessage, env: Env) {
  const allowed = env.ALLOWED_SENDER.split(",")
    .map((x) => x.toLowerCase().trim())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(message.from.toLowerCase().trim())) {
    message.setReject("Sender not allowed.");
    return;
  }
  const email = await PostalMime.parse(message.raw),
    header =
      email.from && "address" in email.from ? email.from.address : undefined;
  if (
    header &&
    allowed.length &&
    !allowed.includes(header.toLowerCase().trim())
  ) {
    message.setReject("Header sender is not allowed.");
    return;
  }
  const pdfs = (email.attachments ?? [])
    .filter(
      (a) =>
        (a.mimeType ?? "").toLowerCase() === "application/pdf" ||
        (a.filename ?? "").toLowerCase().endsWith(".pdf"),
    )
    .map((a) => ({
      filename: a.filename || "attachment.pdf",
      content: new Uint8Array(a.content as ArrayBuffer),
    }));
  if (!pdfs.length)
    throw new Error("Incoming email contains no PDF attachment.");
  let processed = 0,
    classes = 0;
  for (const pdf of pdfs) {
    const text = await parsePdf(pdf.content),
      parsed = parsePlanText(text);
    if (!parsed.length) continue;
    classes += await savePlans(env, parsed, pdf, {
      messageId: email.messageId || undefined,
      emailDate: email.date || undefined,
    });
    processed++;
  }
  if (!processed)
    throw new Error(
      "No supported class rows could be processed from the incoming PDFs.",
    );
  console.log(
    "Processed " + processed + " PDF(s) and " + classes + " class plan(s).",
  );
}

async function handleApi(request: Request, env: Env) {
  if (request.headers.get("Authorization") !== "Bearer " + env.API_KEY)
    return errorJson("Unauthorized.", 401, {
      "WWW-Authenticate": 'Bearer realm="untis-to-api"',
    });
  const p = parts(new URL(request.url));
  if (p[0] !== "vertretung" || p[1] !== "plan")
    return errorJson("Not found.", 404);
  const date = p[2],
    versionText = p[3],
    className = p[4] ? decodeURIComponent(p[4]) : env.DEFAULT_CLASS;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return errorJson("Invalid date. Use YYYY-MM-DD.", 400);
  if (p.length === 3) {
    const row = await env.DB.prepare(
      "SELECT data_json FROM plans WHERE plan_date=? AND class_name=? ORDER BY version DESC LIMIT 1",
    )
      .bind(date, className)
      .first();
    if (!row) return errorJson("No plan found for this date.", 404);
    return json(JSON.parse(String(row.data_json)));
  }
  const version = Number(versionText);
  if (!Number.isInteger(version) || version < 1)
    return errorJson("Invalid version.", 400);
  const row = await env.DB.prepare(
    "SELECT data_json FROM plans WHERE plan_date=? AND version=? AND class_name=? LIMIT 1",
  )
    .bind(date, version, className)
    .first();
  if (!row) return errorJson("Plan version not found.", 404);
  return json(JSON.parse(String(row.data_json)));
}

export default {
  async fetch(request: Request, env: Env) {
    const host = new URL(request.url).hostname.toLowerCase();
    if (host === API_HOST) {
      if (request.method !== "GET")
        return errorJson("Method not allowed.", 405);
      try {
        return await handleApi(request, env);
      } catch (e) {
        console.error(e);
        return errorJson(
          e instanceof Error ? e.message : "Internal server error.",
          500,
        );
      }
    }
    if (host === DASHBOARD_HOST) {
      try {
        return await handleDashboard(request, env);
      } catch (e) {
        console.error(e);
        return new Response("Internal server error.", { status: 500 });
      }
    }
    return errorJson("Host not configured.", 404);
  },
  async email(message: ForwardableEmailMessage, env: Env) {
    try {
      await processEmail(message, env);
      console.log("Substitution plans processed successfully.");
    } catch (e) {
      console.error("Failed to process substitution plan:", e);
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;
