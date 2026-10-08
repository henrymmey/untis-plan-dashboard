import { connect } from "cloudflare:sockets";
import type { Env } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(value: string): string {
  return btoa(value);
}

async function readResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ code: number; text: string }> {
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SMTP connection closed unexpectedly.");
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\r\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!/^\d{3}(?: |$)/.test(line)) continue;
      const code = Number(line.slice(0, 3));
      if (code >= 400) throw new Error("SMTP error " + line);
      return { code, text: line };
    }
  }
}

async function command(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  value: string,
  expected?: number,
): Promise<void> {
  await writer.write(encoder.encode(value + "\r\n"));
  const response = await readResponse(reader);
  if (expected !== undefined && response.code !== expected) {
    throw new Error("Unexpected SMTP response: " + response.text);
  }
}

function messageText(to: string, from: string, subject: string, text: string, html: string): string {
  const boundary = "=_untis_to_api_" + crypto.randomUUID().replaceAll("-", "");
  const safeText = text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const safeHtml = html.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

  return [
    "From: " + from,
    "To: " + to,
    "Subject: " + subject,
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + crypto.randomUUID() + "@untis-to-api>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    safeText,
    "",
    "--" + boundary,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    safeHtml,
    "",
    "--" + boundary + "--",
    "",
  ].join("\r\n");
}

export async function sendSmtpMail(
  env: Env,
  message: { to: string; subject: string; text: string; html: string },
): Promise<void> {
  const host = env.SMTP_HOST.trim();
  const port = Number(env.SMTP_PORT || "465");
  const username = env.SMTP_USERNAME;
  const password = env.SMTP_PASSWORD;

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !username || !password) {
    throw new Error("SMTP configuration is incomplete.");
  }
  if (port === 25) {
    throw new Error("SMTP port 25 is not available from Cloudflare Workers.");
  }

  const security = (env.SMTP_SECURITY || (port === 465 ? "tls" : "starttls")).toLowerCase();
  if (security !== "tls" && security !== "starttls") {
    throw new Error("SMTP_SECURITY must be 'tls' or 'starttls'.");
  }

  let socket = connect(
    { hostname: host, port },
    { secureTransport: security === "tls" ? "on" : "starttls" },
  );

  await socket.opened;
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();

  try {
    await readResponse(reader);
    await command(writer, reader, "EHLO untis-to-api");

    if (security === "starttls") {
      await command(writer, reader, "STARTTLS", 220);
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      await socket.opened;
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      await command(writer, reader, "EHLO untis-to-api");
    }

    await command(writer, reader, "AUTH PLAIN " + b64("\0" + username + "\0" + password), 235);
    await command(writer, reader, "MAIL FROM:<" + env.EMAIL_FROM + ">", 250);
    await command(writer, reader, "RCPT TO:<" + message.to + ">", 250);
    await command(writer, reader, "DATA", 354);

    const body = messageText(
      message.to,
      env.EMAIL_FROM,
      message.subject,
      message.text,
      message.html,
    );
    await writer.write(encoder.encode(body + "\r\n.\r\n"));
    await readResponse(reader);

    await command(writer, reader, "QUIT", 221);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
    try {
      writer.releaseLock();
    } catch {}
    await socket.close();
  }
}
