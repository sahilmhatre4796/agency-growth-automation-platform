import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { emailIdentifierHash } from "../../../packages/server/gmail-multi.ts";

async function authorized(req: Request, secret: string) {
  const supplied = req.headers.get("X-Cron-Signature") ?? "";
  const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const a = new Uint8Array(expected), b = new Uint8Array(actual);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// This runner only moves reviewed drafts into the durable outbox. It never calls Gmail.
Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_EMAIL_SEQUENCES") !== "true" || Deno.env.get("ENABLE_LIVE_EMAIL") !== "true")
    return reply(503, { error: "EMAIL_SEQUENCES_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET") ?? "";
  if (secret.length < 32 || hashSecret.length < 32 || !url || !key)
    return reply(503, { error: "SEQUENCE_RUNNER_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client.rpc("lease_due_email_sequences", { p_limit: 10 });
  if (error) return reply(503, { error: "SEQUENCE_QUEUE_UNAVAILABLE" });
  const leases = z.array(z.object({
    enrollment_id: z.uuid(), org_id: z.uuid(), recipient_email: z.string().nullable(), lease_token: z.uuid(),
  })).parse(data);
  const outcomes: Record<string, number> = {};
  let failed = 0;
  for (const lease of leases) {
    try {
      const hash = lease.recipient_email
        ? await emailIdentifierHash(lease.recipient_email, hashSecret)
        : "0".repeat(64);
      const result = await client.rpc("advance_email_sequence", {
        p_enrollment: lease.enrollment_id,
        p_token: lease.lease_token,
        p_identifier_hash: hash,
        p_recipient_email: lease.recipient_email,
      });
      if (result.error) { failed++; continue; }
      const outcome = z.enum(["inactive", "queued", "pending_send", "next_step", "completed", "paused"]).parse(result.data);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    } catch {
      // Lease expiry permits a retry; no Gmail call or unreviewed draft occurs here.
      failed++;
    }
  }
  return reply(failed ? 503 : 200, { processed: leases.length, outcomes, failed });
});
