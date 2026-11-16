import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { GmailAdapter, GoogleAPIError } from "../../../packages/server/google.ts";
import { emailIdentifierHash, sendOnce } from "../../../packages/server/gmail-multi.ts";
import { loadGmailAccount } from "../_shared/gmail-auth.ts";

async function authorized(req: Request, secret: string) {
  const supplied = req.headers.get("X-Cron-Signature") ?? "";
  const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const a = new Uint8Array(expected), b = new Uint8Array(actual);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_LIVE_EMAIL") !== "true") return reply(503, { error: "LIVE_EMAIL_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET") ?? "";
  if (secret.length < 32 || hashSecret.length < 32 || !url || !key)
    return reply(503, { error: "WORKER_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client.rpc("lease_email_outbox", { p_limit: 10 });
  if (error) return reply(503, { error: "QUEUE_UNAVAILABLE" });
  const jobs = z.array(z.object({
    id: z.uuid(), lease_token: z.uuid(), sender_connection_id: z.uuid(),
    recipient_email: z.email(), subject: z.string(), body: z.string(), sender_name: z.string(),
    provider_thread_id: z.string().nullable(), reply_to_rfc_id: z.string().nullable(),
  })).parse(data);
  const results: Record<string, number> = { sent: 0, held: 0, uncertain: 0, deferred: 0 };
  const rateLimited = new Set<string>();
  for (const job of jobs) {
    if (rateLimited.has(job.sender_connection_id)) {
      const deferred = await client.rpc("finish_email_outbox", {
        p_id: job.id, p_token: job.lease_token, p_state: "queued",
        p_error: "ACCOUNT_RATE_BACKOFF", p_provider_id: null, p_thread_id: null,
      });
      if (deferred.error || !deferred.data) return reply(503, { error: "BACKOFF_PERSISTENCE_FAILED" });
      results.deferred++;
      continue;
    }
    let state: "sent" | "held" | "uncertain" = "uncertain";
    let code: string | null = null, providerId: string | null = null, threadId: string | null = null;
    try {
      const identifierHash = await emailIdentifierHash(job.recipient_email, hashSecret);
      const gate = await client.rpc("check_email_send_policy", {
        p_id: job.id, p_token: job.lease_token, p_identifier_hash: identifierHash,
      });
      if (gate.error) throw new Error("POLICY_CHECK_FAILED");
      if (gate.data !== "eligible") {
        results.held++;
        continue;
      }
      const { api, account } = await loadGmailAccount(client, job.sender_connection_id);
      const profile = await new GmailAdapter(api).profile();
      if (profile.emailAddress.toLowerCase() !== account.toLowerCase())
        throw new Error("ACCOUNT_IDENTITY_MISMATCH");
      const receipt = await sendOnce({
        adapter: new GmailAdapter(api, true), outboxId: job.id, from: account,
        senderName: job.sender_name, to: job.recipient_email,
        subject: job.subject, body: job.body,
        threadId: job.provider_thread_id, replyToId: job.reply_to_rfc_id,
        beforeSend: async () => {
          const finalGate = await client.rpc("check_email_send_policy", {
            p_id: job.id, p_token: job.lease_token, p_identifier_hash: identifierHash,
          });
          if (finalGate.error) throw new Error("POLICY_RECHECK_FAILED");
          if (finalGate.data !== "eligible") throw new Error("POLICY_BLOCKED");
        },
      });
      state = "sent"; providerId = receipt.id; threadId = receipt.threadId;
    } catch (cause) {
      code = cause instanceof GoogleAPIError ? cause.code : cause instanceof Error ? cause.message : "UNKNOWN";
      if (code === "POLICY_BLOCKED") { results.held++; continue; }
      if (code === "GOOGLE_RATE_LIMITED") {
        rateLimited.add(job.sender_connection_id);
        const backoff = await client.rpc("backoff_gmail_account", {
          p_connection: job.sender_connection_id, p_code: code, p_minutes: 15,
        });
        if (backoff.error) return reply(503, { error: "ACCOUNT_BACKOFF_FAILED" });
      } else if (["GOOGLE_REVOKED", "GOOGLE_DISCONNECTED", "GOOGLE_FORBIDDEN", "GOOGLE_SECRETS_UNAVAILABLE", "OAUTH_SECRET_UNAVAILABLE", "ACCOUNT_IDENTITY_MISMATCH"].includes(code)) {
        const marked = await client.rpc("mark_gmail_account_error", {
          p_connection: job.sender_connection_id, p_code: code,
          p_revoked: code === "GOOGLE_REVOKED",
        });
        if (marked.error) return reply(503, { error: "ACCOUNT_HOLD_FAILED" });
        results.held++;
        continue;
      }
    }
    const finish = await client.rpc("finish_email_outbox", {
      p_id: job.id, p_token: job.lease_token, p_state: state,
      p_error: code, p_provider_id: providerId, p_thread_id: threadId,
    });
    if (finish.error || !finish.data) return reply(503, { error: "RECEIPT_PERSISTENCE_FAILED" });
    results[state]++;
  }
  return reply(200, { processed: jobs.length, ...results });
});
