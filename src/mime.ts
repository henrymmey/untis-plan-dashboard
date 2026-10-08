import PostalMime from "postal-mime";

export async function parseIncomingEmail(raw: ReadableStream<Uint8Array>) {
  const parser = new PostalMime();
  const email = await parser.parse(await new Response(raw).arrayBuffer());

  const attachments = (email.attachments ?? [])
    .filter((attachment) => {
      const name = attachment.filename ?? "";
      const contentType = attachment.mimeType ?? "";
      return contentType.toLowerCase() === "application/pdf" || name.toLowerCase().endsWith(".pdf");
    })
    .map((attachment) => ({
      filename: attachment.filename || "attachment.pdf",
      contentType: attachment.mimeType || "application/pdf",
      content: attachment.content as Uint8Array,
    }));

  return {
    subject: email.subject || "",
    messageId: email.messageId || undefined,
    date: email.date || undefined,
    from: email.from?.address || undefined,
    attachments,
  };
}
