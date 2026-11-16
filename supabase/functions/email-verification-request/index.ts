import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { boundedBody } from "../../../packages/server/requests.ts";
import { emailIdentifierHash } from "../../../packages/server/gmail-multi.ts";

const schema = z.object({ org_id: z.uuid(), contact_ids: z.array(z.uuid()).min(1).max(25), force: z.boolean().default(false) }).strict();
Deno.serve(async (req: Request) => {
  const origin = Deno.env.get("ALLOWED_ORIGIN"), url = Deno.env.get("SUPABASE_URL"),
    anon = Deno.env.get("SUPABASE_ANON_KEY"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET");
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin ?? "",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", Vary: "Origin" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (!origin || !url || !anon || !serviceKey || !hashSecret || hashSecret.length < 32) return reply(503, { error: "VERIFICATION_NOT_CONFIGURED" });
  if (req.headers.get("Origin") !== origin) return reply(403, { error: "ORIGIN_DENIED" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return reply(401, { error: "UNAUTHENTICATED" });
  try {
    const input = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req, 4096))));
    const user = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
    const { data: identity, error: identityError } = await user.auth.getUser();
    if (identityError || !identity.user) return reply(401, { error: "UNAUTHENTICATED" });
    const { data: membership } = await user.from("memberships").select("role").eq("org_id", input.org_id).eq("user_id", identity.user.id).maybeSingle();
    if (membership?.role !== "admin") return reply(403, { error: "FORBIDDEN" });
    const contacts = await user.from("contacts").select("id,email_normalized").eq("org_id", input.org_id).in("id", [...new Set(input.contact_ids)]);
    if (contacts.error || (contacts.data?.length ?? 0) !== new Set(input.contact_ids).size) return reply(404, { error: "CONTACT_NOT_FOUND" });
    const service = createClient(url, serviceKey, { auth: { persistSession: false } });
    const results: Array<{ contact_id: string; state: string }> = [];
    for (const contact of contacts.data ?? []) {
      if (!contact.email_normalized) { results.push({ contact_id: contact.id, state: "EMAIL_CONTACT_REQUIRED" }); continue; }
      const hash = await emailIdentifierHash(contact.email_normalized, hashSecret);
      const { data, error } = await service.rpc("request_email_verification", {
        p_org: input.org_id, p_contact: contact.id, p_email: contact.email_normalized,
        p_identifier_hash: hash, p_actor: identity.user.id, p_force: input.force,
      });
      results.push({ contact_id: contact.id, state: error ? "REQUEST_REJECTED" : String(data?.state ?? "unknown") });
    }
    return reply(200, { results });
  } catch { return reply(422, { error: "INVALID_VERIFICATION_REQUEST" }); }
});
