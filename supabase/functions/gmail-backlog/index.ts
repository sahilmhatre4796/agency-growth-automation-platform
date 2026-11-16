import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { boundedBody } from "../../../packages/server/requests.ts";
import { emailIdentifierHash } from "../../../packages/server/gmail-multi.ts";
import { scheduleApprovedDraft } from "../../../packages/server/gmail-backlog.ts";

const input = z.object({ org_id: z.uuid().optional(), dry_run: z.boolean().default(true) }).strict();

async function authorized(req: Request, secret: string) {
  const digests = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const a = new Uint8Array(digests[0]), b = new Uint8Array(digests[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

// Approved drafts are the backlog. This worker never calls Gmail and never
// changes an approved draft unless enqueue_approved_email passes every SQL gate.
Deno.serve(async (req: Request) => {
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET") ?? "";
  if (secret.length < 32 || !url || !key || hashSecret.length < 32)
    return reply(503, { error: "BACKLOG_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  let body: z.infer<typeof input>;
  try { body = input.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req, 512)))); }
  catch { return reply(422, { error: "INVALID_BACKLOG_REQUEST" }); }
  if (!body.dry_run && (Deno.env.get("ENABLE_GMAIL_BACKLOG") !== "true" || Deno.env.get("ENABLE_LIVE_EMAIL") !== "true"))
    return reply(503, { error: "BACKLOG_DISABLED" });

  const db = createClient(url, key, { auth: { persistSession: false } });
  let orgQuery = db.from("organizations")
    .select("id,outbound_paused,email_live_approved,email_daily_cap,email_monthly_cap")
    .order("id").limit(20);
  if (body.org_id) orgQuery = orgQuery.eq("id", body.org_id);
  const { data: organizations, error: orgError } = await orgQuery;
  if (orgError) return reply(503, { error: "BACKLOG_ORGANIZATIONS_UNAVAILABLE" });
  const totals = { approved: 0, ready_for_policy_check: 0, queued: 0, deferred: 0, review: 0, rolled_over: 0 };
  for (const org of organizations ?? []) {
    const { data: drafts, error: draftError } = await db.rpc("email_backlog_candidates", { p_org: org.id, p_limit: 10 });
    if (draftError) return reply(503, { error: "BACKLOG_DRAFTS_UNAVAILABLE" });
    totals.approved += drafts?.length ?? 0;
    if (body.dry_run || org.outbound_paused || !org.email_live_approved ||
      !org.email_daily_cap || !org.email_monthly_cap) {
      totals.deferred += drafts?.length ?? 0;
      continue;
    }
    const rollover = await db.rpc("rollover_email_backlog", { p_org: org.id, p_limit: 10 });
    if (rollover.error) return reply(503, { error: "BACKLOG_ROLLOVER_UNAVAILABLE" });
    totals.rolled_over += Number(rollover.data ?? 0);
    for (const draft of drafts ?? []) {
      const [{ data: lead, error: leadError }, { data: contact, error: contactError }] = await Promise.all([
        db.from("leads").select("country,is_demo,outreach_timezone,outreach_timezone_reviewed_at")
          .eq("org_id", org.id).eq("id", draft.lead_id).maybeSingle(),
        db.from("contacts").select("email_normalized")
          .eq("org_id", org.id).eq("lead_id", draft.lead_id).eq("id", draft.contact_id).maybeSingle(),
      ]);
      if (leadError || contactError) return reply(503, { error: "BACKLOG_CONTACT_UNAVAILABLE" });
      if (!draft.approval_by || !lead || lead.is_demo || !lead.outreach_timezone_reviewed_at ||
        !lead.outreach_timezone || ["india", "in", "bharat"].includes(String(lead.country ?? "").trim().toLowerCase()) ||
        !contact?.email_normalized) { totals.review++; continue; }
      totals.ready_for_policy_check++;
      const hash = await emailIdentifierHash(contact.email_normalized, hashSecret);
      const outcome = await scheduleApprovedDraft({ now: new Date(), timeZone: lead.outreach_timezone,
        enqueue: async (scheduledAt) => {
          const queued = await db.rpc("enqueue_approved_email", {
          p_org: org.id, p_draft: draft.draft_id, p_identifier_hash: hash,
          p_recipient_email: contact.email_normalized, p_schedule: scheduledAt, p_actor: draft.approval_by,
          });
          return { error: queued.error?.message ?? null };
        },
      });
      totals[outcome]++;
    }
  }
  return reply(200, { dry_run: body.dry_run, ...totals });
});
