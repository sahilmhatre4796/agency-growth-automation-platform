import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { GmailAdapter, GoogleAPIError } from "../../../packages/server/google.ts";
import { emailIdentifierHash, gmailParseReviewReason, parseGmailMessage, syncGmailPage, type GmailMessage } from "../../../packages/server/gmail-multi.ts";
import { loadGmailAccount } from "../_shared/gmail-auth.ts";

async function authorized(req: Request, secret: string) {
  const values = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map(
    (value) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_GMAIL_SYNC") !== "true") return reply(503, { error: "GMAIL_SYNC_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (secret.length < 32 || hashSecret.length < 32 || !url || !key)
    return reply(503, { error: "SYNC_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client.rpc("lease_gmail_sync", { p_limit: 2 });
  if (error) return reply(503, { error: "SYNC_QUEUE_UNAVAILABLE" });
  const cursors = z.array(z.object({
    connection_id: z.uuid(), lease_token: z.uuid(), bootstrap_history_id: z.string().nullable(),
    history_id: z.string().nullable(), inbox_page_token: z.string().nullable(),
    sent_page_token: z.string().nullable(), history_page_token: z.string().nullable(),
    initial_inbox_complete: z.boolean(), initial_sent_complete: z.boolean(),
  })).parse(data);
  let completed = 0, failed = 0;
  for (const cursor of cursors) {
    const advance = async (kind: string, nextPage: string | null, history: string | null, code: string | null = null) => {
      const result = await client.rpc("advance_gmail_sync", {
        p_connection: cursor.connection_id, p_token: cursor.lease_token,
        p_kind: kind, p_next_page: nextPage, p_history: history, p_error: code,
      });
      if (result.error) throw new Error("SYNC_PROGRESS_FAILED");
    };
    try {
      const { api, account } = await loadGmailAccount(client, cursor.connection_id);
      const adapter = new GmailAdapter(api);
      const accept = async (message: ReturnType<typeof parseGmailMessage>) => {
        const hash = await emailIdentifierHash(message.peer, hashSecret);
        const { error } = await client.rpc("accept_gmail_message", {
          p_connection: cursor.connection_id, p_provider_id: message.providerId,
          p_provider_thread: message.providerThread, p_rfc_id: message.rfcId,
          p_reply_to: message.replyTo, p_direction: message.direction,
          p_peer: message.peer, p_subject: message.subject, p_body: message.body,
          p_classification: message.classification, p_at: message.occurredAt,
          p_identifier_hash: hash,
        });
        if (error) throw new Error("MESSAGE_PERSIST_FAILED");
      };
      const onParseError = async (message: GmailMessage, reason: string) => {
        const { error } = await client.rpc("record_gmail_parse_review", {
          p_connection: cursor.connection_id, p_provider_id: message.id,
          p_thread: message.threadId, p_reason: reason,
        });
        if (error) throw new Error("PARSE_REVIEW_PERSIST_FAILED");
      };
      if (!cursor.bootstrap_history_id) {
        const profile = await adapter.profile();
        if (profile.emailAddress.toLowerCase() !== account.toLowerCase())
          throw new Error("ACCOUNT_IDENTITY_MISMATCH");
        await advance("bootstrap", null, profile.historyId);
      } else if (!cursor.initial_inbox_complete) {
        const next = await syncGmailPage({ adapter, account, label: "INBOX",
          pageToken: cursor.inbox_page_token ?? undefined, accept, onParseError });
        await advance("inbox", next, null);
      } else if (!cursor.initial_sent_complete) {
        const next = await syncGmailPage({ adapter, account, label: "SENT",
          pageToken: cursor.sent_page_token ?? undefined, accept, onParseError });
        await advance("sent", next, null);
      } else if (cursor.history_id) {
        const page = await adapter.history(cursor.history_id, cursor.history_page_token ?? undefined);
        const ids = new Set((page.history ?? []).flatMap((entry) =>
          (entry.messagesAdded ?? []).map((added) => added.message.id)));
        for (const id of ids) {
          const raw = await adapter.message(id);
          if (!raw.labelIds?.some((label) => label === "INBOX" || label === "SENT")) continue;
          let parsed: ReturnType<typeof parseGmailMessage>;
          try { parsed = parseGmailMessage(raw, account); }
          catch (cause) { await onParseError(raw, gmailParseReviewReason(cause)); continue; }
          await accept(parsed);
        }
        await advance("history", page.nextPageToken ?? null, page.historyId);
      } else {
        throw new Error("SYNC_CURSOR_INCOMPLETE");
      }
      completed++;
    } catch (cause) {
      failed++;
      const code = cause instanceof GoogleAPIError ? cause.code : cause instanceof Error ? cause.message : "SYNC_ERROR";
      if (cause instanceof GoogleAPIError && cause.status === 404 && cursor.history_id) {
        await advance("reset", null, null, "HISTORY_EXPIRED_RESCAN");
      } else if (["GOOGLE_REVOKED", "GOOGLE_DISCONNECTED", "GOOGLE_FORBIDDEN", "ACCOUNT_IDENTITY_MISMATCH"].includes(code)) {
        await client.rpc("mark_gmail_account_error", {
          p_connection: cursor.connection_id, p_code: code, p_revoked: code === "GOOGLE_REVOKED",
        });
      } else {
        await advance("error", null, null, code.slice(0, 80));
      }
    }
  }
  return reply(200, { processed: cursors.length, completed, failed });
});
