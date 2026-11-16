import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { CloudflareDnsResolver, ReacherHttpAdapter, verifyEmailAddress } from "../../../packages/server/email-verification.ts";
import { emailIdentifierHash } from "../../../packages/server/gmail-multi.ts";

async function authorized(req: Request, secret: string) {
  const values = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_EMAIL_VERIFICATION") !== "true") return reply(503, { error: "EMAIL_VERIFICATION_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "", hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "", key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (secret.length < 32 || hashSecret.length < 32 || !url || !key) return reply(503, { error: "WORKER_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  const advanced = Deno.env.get("ENABLE_REACHER_SMTP") === "true"
    ? new ReacherHttpAdapter(Deno.env.get("REACHER_ENDPOINT") ?? "", Deno.env.get("REACHER_TOKEN") ?? "") : undefined;
  const client = createClient(url, key, { auth: { persistSession: false } });
  const leased = await client.rpc("lease_email_verification_jobs", { p_limit: 10 });
  if (leased.error) return reply(503, { error: "VERIFICATION_QUEUE_UNAVAILABLE" });
  const jobs = z.array(z.object({ id: z.uuid(), lease_token: z.uuid(), email_normalized: z.string() })).parse(leased.data);
  let completed = 0, failed = 0;
  for (const job of jobs) {
    try {
      const result = await verifyEmailAddress({ email: job.email_normalized, resolver: new CloudflareDnsResolver(), advanced });
      const hash = await emailIdentifierHash(job.email_normalized, hashSecret);
      const saved = await client.rpc("finish_email_verification_job", {
        p_job: job.id, p_token: job.lease_token, p_identifier_hash: hash, p_result: result,
      });
      if (saved.error) throw new Error("VERIFICATION_PERSIST_FAILED");
      completed++;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message.slice(0, 80) : "VERIFICATION_UNAVAILABLE";
      const failure = await client.rpc("fail_email_verification_job", { p_job: job.id, p_token: job.lease_token, p_code: code });
      if (failure.error) return reply(503, { error: "VERIFICATION_FAILURE_PERSIST_FAILED" });
      failed++;
    }
  }
  return reply(200, { processed: jobs.length, completed, failed });
});
