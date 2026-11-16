import { z } from "zod";
import { GmailAdapter } from "./google.ts";

const mailAddress = z.email();
export type GmailMessage = Awaited<ReturnType<GmailAdapter["message"]>>;
export function gmailParseReviewReason(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  return ["RECIPIENT_REVIEW_REQUIRED", "MESSAGE_NOT_FOR_ACCOUNT", "INVALID_MESSAGE_DATE"].includes(code)
    ? code : "MESSAGE_PARSE_REVIEW_REQUIRED";
}

function header(message: GmailMessage, name: string) {
  return message.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}
function extractAddress(raw: string) {
  const candidate = raw.match(/<([^<>]+)>/)?.[1] ?? raw.trim();
  return mailAddress.parse(candidate.toLowerCase());
}
function decodeBody(message: GmailMessage) {
  const parts = (message.payload.parts ?? []) as Array<{
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  }>;
  const plain = (nodes: typeof parts): string | undefined => {
    for (const part of nodes) {
      if (part.mimeType === "text/plain" && part.body?.data) return part.body.data;
      if (part.parts) {
        const found = plain(part.parts as typeof parts);
        if (found) return found;
      }
    }
    return undefined;
  };
  const encoded = message.payload.body?.data ?? plain(parts);
  if (!encoded) return (message.snippet ?? "").slice(0, 10000);
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 10000);
}
export function classifyGmailReply(body: string) {
  const text = body.slice(0, 10000);
  if (/\b(unsubscribe|stop emailing|remove me|do not contact|don't contact|opt.?out)\b|संपर्क न करें|band karo/i.test(text))
    return "opt_out" as const;
  if (/\b(meeting|book a call|schedule a call|available to talk|appointment)\b/i.test(text))
    return "meeting_request" as const;
  if (/\b(not interested|no thanks|please don't|not relevant)\b/i.test(text))
    return "not_interested" as const;
  if (/\b(interested|tell me more|let's discuss|sounds good)\b/i.test(text))
    return "interested" as const;
  if (text.includes("?")) return "question" as const;
  return "unknown" as const;
}
export function parseGmailMessage(message: GmailMessage, account: string) {
  const from = extractAddress(header(message, "from"));
  const toHeader = header(message, "to");
  const to = toHeader ? mailAddress.safeParse((toHeader.match(/<([^<>]+)>/)?.[1] ?? toHeader.split(",")[0]).trim().toLowerCase()).data : undefined;
  const own = mailAddress.parse(account.toLowerCase());
  const labels = new Set(message.labelIds ?? []);
  // Gmail's account-scoped INBOX/SENT labels also cover aliases and BCC mail
  // whose visible To/From headers do not equal the primary account address.
  const outbound = from === own || labels.has("SENT");
  if (!outbound && to !== own && !labels.has("INBOX")) throw new Error("MESSAGE_NOT_FOR_ACCOUNT");
  // A sent copy with several recipients (including Cc/Bcc) cannot be safely
  // attributed to one CRM contact. Hold the sync cursor for owner review.
  if (outbound && (!to || to === own || (toHeader.match(/@/g) ?? []).length !== 1 ||
    header(message, "cc").trim() || header(message, "bcc").trim()))
    throw new Error("RECIPIENT_REVIEW_REQUIRED");
  const peer = outbound ? to! : from;
  const body = decodeBody(message);
  const occurredAt = new Date(Number(message.internalDate));
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("INVALID_MESSAGE_DATE");
  return {
    providerId: message.id,
    providerThread: message.threadId,
    rfcId: header(message, "message-id"),
    replyTo: header(message, "in-reply-to"),
    direction: outbound ? "outbound" as const : "inbound" as const,
    peer,
    subject: header(message, "subject").slice(0, 300),
    body,
    classification: outbound ? "unknown" as const : classifyGmailReply(body),
    occurredAt: occurredAt.toISOString(),
  };
}
export async function emailIdentifierHash(email: string, secret: string) {
  if (secret.length < 32) throw new Error("HASH_SECRET_NOT_CONFIGURED");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(mailAddress.parse(email.toLowerCase())));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function syncGmailPage(input: {
  adapter: GmailAdapter;
  account: string;
  label: "INBOX" | "SENT";
  pageToken?: string;
  accept: (message: ReturnType<typeof parseGmailMessage>) => Promise<void>;
  onParseError?: (message: GmailMessage, reason: string) => Promise<void>;
}) {
  const page = await input.adapter.list(input.label, input.pageToken);
  for (const ref of page.messages ?? []) {
    const raw = await input.adapter.message(ref.id);
    let message: ReturnType<typeof parseGmailMessage>;
    try { message = parseGmailMessage(raw, input.account); }
    catch (cause) {
      if (!input.onParseError) throw cause;
      await input.onParseError(raw, gmailParseReviewReason(cause));
      continue;
    }
    await input.accept(message);
  }
  return page.nextPageToken ?? null;
}
export async function sendOnce(input: {
  adapter: GmailAdapter;
  outboxId: string;
  from: string;
  senderName: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
  replyToId?: string | null;
  beforeSend?: () => Promise<void>;
}) {
  const domain = mailAddress.parse(input.from).split("@")[1];
  const stableMessageId = `<${z.uuid().parse(input.outboxId)}@${domain}>`;
  const found = await input.adapter.lookup(stableMessageId);
  if (found) {
    const prior = await input.adapter.message(found);
    return { id: prior.id, threadId: prior.threadId, reconciled: true };
  }
  await input.beforeSend?.();
  const receipt = await input.adapter.send({
    from: input.from,
    senderName: input.senderName,
    to: input.to,
    subject: input.subject,
    body: input.body,
    stableMessageId,
    threadId: input.threadId,
    replyToId: input.replyToId,
  });
  return { ...receipt, reconciled: false };
}
