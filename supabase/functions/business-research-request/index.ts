import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { boundedBody } from "../../../packages/server/requests.ts";
import { emailIdentifierHash } from "../../../packages/server/gmail-multi.ts";

const schema = z.object({ org_id: z.uuid(), lead_id: z.uuid(), contact_id: z.uuid().optional(), force: z.boolean().default(false) }).strict();
Deno.serve(async (req: Request) => {
  const origin = Deno.env.get("ALLOWED_ORIGIN"), url = Deno.env.get("SUPABASE_URL"),
    anon = Deno.env.get("SUPABASE_ANON_KEY"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    secret = Deno.env.get("SUPPRESSION_HMAC_SECRET");
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin ?? "",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", Vary: "Origin" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (!origin || !url || !anon || !key || !secret || secret.length < 32) return reply(503, { error: "RESEARCH_NOT_CONFIGURED" });
  if (req.headers.get("Origin") !== origin) return reply(403, { error: "ORIGIN_DENIED" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return reply(401, { error: "UNAUTHENTICATED" });
  try {
    const input = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req, 2048))));
    const user = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
    const { data: identity, error: identityError } = await user.auth.getUser();
    if (identityError || !identity.user) return reply(401, { error: "UNAUTHENTICATED" });
    const { data: member } = await user.from("memberships").select("role").eq("org_id", input.org_id).eq("user_id", identity.user.id).maybeSingle();
    if (member?.role !== "admin") return reply(403, { error: "FORBIDDEN" });
    const service = createClient(url, key, { auth: { persistSession: false } });
    let result;
    if (input.contact_id) {
      const { data: contact } = await user.from("contacts").select("id,email_normalized").eq("org_id", input.org_id).eq("lead_id", input.lead_id).eq("id", input.contact_id).maybeSingle();
      if (!contact?.email_normalized) return reply(422, { error: "EMAIL_CONTACT_REQUIRED" });
      const hash = await emailIdentifierHash(contact.email_normalized, secret);
      result = await service.rpc("request_business_research", {
        p_org: input.org_id, p_lead: input.lead_id, p_contact: input.contact_id,
        p_email: contact.email_normalized, p_identifier_hash: hash,
        p_actor: identity.user.id, p_force: input.force,
      });
    } else {
      result = await service.rpc("request_lead_research", {
        p_org: input.org_id, p_lead: input.lead_id, p_actor: identity.user.id, p_force: input.force,
      });
    }
    const { data, error } = result;
    if (error) return reply(409, { error: ["LEAD_SUPPRESSED", "CONTACT_SUPPRESSED", "EMAIL_VERIFICATION_REQUIRED", "EMAIL_VERIFICATION_REVIEW_REQUIRED", "EMAIL_VERIFICATION_BLOCKED", "RESEARCH_CREDIT_CAP"].find((code) => error.message.includes(code)) ?? "RESEARCH_POLICY_BLOCKED" });
    const org = await user.from("organizations").select("research_provider").eq("id", input.org_id).single();
    const provider = org.data?.research_provider ?? "serper";
    return reply(200, { data, provider, live_research_enabled: Deno.env.get(provider === "serper" ? "ENABLE_SERPER_RESEARCH" : "ENABLE_TAVILY_RESEARCH") === "true" });
  } catch { return reply(422, { error: "INVALID_RESEARCH_REQUEST" }); }
});
