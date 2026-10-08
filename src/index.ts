import { CanvasFactory } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";
import PostalMime from "postal-mime";
import { parsePlanText } from "./parser";
import type { Env } from "./types";

const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
      ...extra,
    },
  });

const errorJson = (message: string, status = 500) => json({ error: message }, status);
const pathParts = (url: URL) => url.pathname.split("/").filter(Boolean);

async function parsePdf(pdf: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: pdf, CanvasFactory });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function savePlan(
  env: Env,
  parsed: ReturnType<typeof parsePlanText>,
  attachment: { filename: string; content: Uint8Array },
  meta: { messageId?: string; emailDate?: string },
) {
  const r2Key = `plans/${parsed.planDate}/${parsed.version}/${encodeURIComponent(parsed.className)}/source.pdf`;
  await env.PDF_BUCKET.put(r2Key, attachment.content, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: {
      planDate: parsed.planDate,
      version: String(parsed.version),
      className: parsed.className,
      sourceFilename: attachment.filename,
    },
  });

  await env.DB.prepare(
    `
    INSERT INTO plans (plan_date, version, class_name, created_at, source_filename, source_message_id, source_email_date, source_r2_key, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_date, version, class_name) DO UPDATE SET
      created_at=excluded.created_at, source_filename=excluded.source_filename,
      source_message_id=excluded.source_message_id, source_email_date=excluded.source_email_date,
      source_r2_key=excluded.source_r2_key, data_json=excluded.data_json
  `,
  )
    .bind(
      parsed.planDate,
      parsed.version,
      parsed.className,
      new Date().toISOString(),
      attachment.filename,
      meta.messageId ?? null,
      meta.emailDate ?? null,
      r2Key,
      JSON.stringify({
        date: parsed.planDate,
        version: parsed.version,
        class: parsed.className,
        reportDate: parsed.reportDate ?? null,
        lessons: parsed.lessons,
      }),
    )
    .run();
}

async function processEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const allowed = env.ALLOWED_SENDER.toLowerCase().trim();
  if (allowed && message.from.toLowerCase().trim() !== allowed) {
    message.setReject(`Sender not allowed. Expected ${allowed}.`);
    return;
  }

  const email = await PostalMime.parse(message.raw);
  const headerSender =
    email.from && "address" in email.from ? email.from.address : undefined;
  if (
    headerSender &&
    allowed &&
    headerSender.toLowerCase().trim() !== allowed
  ) {
    message.setReject("Header sender does not match the configured sender.");
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

  let processed = 0;
  for (const attachment of pdfs) {
    const text = await parsePdf(attachment.content);
    if (!text.includes(`K ${env.TARGET_CLASS}`)) continue;
    const parsed = parsePlanText(text, env.TARGET_CLASS);
    await savePlan(env, parsed, attachment, {
      messageId: email.messageId || undefined,
      emailDate: email.date || undefined,
    });
    processed++;
  }

  if (!processed)
    throw new Error(
      `No PDF containing class ${env.TARGET_CLASS} could be processed.`,
    );
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const parts = pathParts(new URL(request.url));
  if (parts[0] !== "vertretung" || parts[1] !== "plan")
    return errorJson("Not found.", 404);

  const date = parts[2];
  const versionText = parts[3];
  const className = parts[4] ? decodeURIComponent(parts[4]) : env.TARGET_CLASS;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return errorJson("Invalid date. Use YYYY-MM-DD.", 400);

  if (parts.length === 3) {
    const row = await env.DB.prepare(
      "SELECT data_json FROM plans WHERE plan_date = ? AND class_name = ? ORDER BY version DESC LIMIT 1",
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
    "SELECT data_json FROM plans WHERE plan_date = ? AND version = ? AND class_name = ? LIMIT 1",
  )
    .bind(date, version, className)
    .first();
  if (!row) return errorJson("Plan version not found.", 404);
  return json(JSON.parse(String(row.data_json)));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") return errorJson("Method not allowed.", 405);
    try {
      return await handleApi(request, env);
    } catch (error) {
      console.error(error);
      return errorJson(
        error instanceof Error ? error.message : "Internal server error.",
        500,
      );
    }
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      await processEmail(message, env);
      console.log("Substitution plan processed successfully.");
    } catch (error) {
      console.error("Failed to process substitution plan:", error);
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
