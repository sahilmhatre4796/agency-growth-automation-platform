import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { boundedBody } from "../../../packages/server/requests.ts";
import { emailIdentifierHash } from "../../../packages/server/gmail-multi.ts";

const input = z.object({
  org_id: z.uuid(), draft_id: z.uuid(), scheduled_at: z.iso.datetime({ offset: true }),
}).strict();
Deno.serve(async (req: Request) => {
  const origin = Deno.env.get("ALLOWED_ORIGIN"),
    url = Deno.env.get("SUPABASE_URL"),
    anon = Deno.env.get("SUPABASE_ANON_KEY"),
    serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET");
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin ?? "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    Vary: "Origin",
  };
  const reply = (status: number, error: string | null, data: unknown = null) =>
    new Response(JSON.stringify({ error, data }), { status, headers });
  if (!origin || !url || !anon || !serviceKey || !hashSecret || hashSecret.length < 32)
    return reply(503, "QUEUE_NOT_CONFIGURED");
  if (req.headers.get("Origin") !== origin) return reply(403, "ORIGIN_DENIED");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, "METHOD_NOT_ALLOWED");
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return reply(401, "UNAUTHENTICATED");
  try {
    const body = input.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBody(req, 2048),
    )));
    const user = createClient(url, anon, {
      auth: { persistSession: false }, global: { headers: { Authorization: authorization } },
    });
    const { data: identity, error: authError } = await user.auth.getUser();
    if (authError || !identity.user) return reply(401, "UNAUTHENTICATED");
    const { data: membership } = await user.from("memberships").select("role")
      .eq("org_id", body.org_id).eq("user_id", identity.user.id).maybeSingle();
    if (membership?.role !== "admin") return reply(403, "FORBIDDEN");
    const { data: draft } = await user.from("outbound_drafts").select("contact_id")
      .eq("org_id", body.org_id).eq("id", body.draft_id).maybeSingle();
    if (!draft) return reply(404, "DRAFT_NOT_FOUND");
    const { data: contact } = await user.from("contacts").select("email,email_normalized")
      .eq("org_id", body.org_id).eq("id", draft.contact_id).maybeSingle();
    if (!contact?.email_normalized && !contact?.email)
      return reply(422, "EMAIL_CONTACT_REQUIRED");
    const hash = await emailIdentifierHash(contact.email_normalized ?? contact.email, hashSecret);
    const service = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await service.rpc("enqueue_approved_email", {
      p_org: body.org_id, p_draft: body.draft_id, p_identifier_hash: hash,
      p_recipient_email: contact.email_normalized ?? contact.email,
      p_schedule: body.scheduled_at, p_actor: identity.user.id,
    });
    if (error) {
      const code = ["EMAIL_NOT_ENABLED", "EMAIL_PERMISSION_REQUIRED", "EMAIL_SUPPRESSED",
        "ORGANIZATION_DAILY_CAP", "ORGANIZATION_MONTHLY_CAP", "CAMPAIGN_DAILY_CAP",
        "NO_ELIGIBLE_SENDER", "SIGNATURE_REVIEW_REQUIRED", "STALE_APPROVAL", "CONTACT_EMAIL_CHANGED",
      ].find((item) => error.message.includes(item)) ?? "QUEUE_POLICY_BLOCKED";
      return reply(409, code);
    }
    return reply(201, null, { outbox_id: data, live_send_enabled: false });
  } catch {
    return reply(422, "INVALID_QUEUE_REQUEST");
  }
});
