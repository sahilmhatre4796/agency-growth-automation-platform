import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { SerperSearchAdapter } from "../../../packages/server/research.ts";
import { discoverVibePublicContacts, discoverVibeListingContacts, VIBE_CONTACT_MAX_SERPER_CREDITS } from "../../../packages/server/vibe-contact-discovery.ts";

async function authorized(req: Request, secret: string) {
  const digests = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const a = new Uint8Array(digests[0]), b = new Uint8Array(digests[1]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_VIBE_CONTACT_DISCOVERY") !== "true") return reply(503, { error: "VIBE_CONTACT_DISCOVERY_DISABLED" });
  const cron = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const serper = Deno.env.get("SERPER_API_KEY") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (cron.length < 32 || !serper || serper === "your_key_here" || !url || !key)
    return reply(503, { error: "VIBE_CONTACT_DISCOVERY_NOT_CONFIGURED" });
  if (!(await authorized(req, cron))) return reply(401, { error: "UNAUTHORIZED" });
  const db = createClient(url, key, { auth: { persistSession: false } });
  const leased = await db.rpc("lease_vibe_contact_discovery_job");
  if (leased.error) return reply(503, { error: "VIBE_CONTACT_QUEUE_UNAVAILABLE" });
  if (!leased.data) return reply(200, { processed: 0 });
  const job = z.object({ id: z.uuid(), org_id: z.uuid(), lead_id: z.uuid(),
    lease_token: z.uuid(), target_url: z.url(), source_kind: z.enum(["official", "listing"]) }).parse(leased.data);
  try {
    const reserved = await db.rpc("reserve_vibe_contact_discovery_credits", {
      p_job: job.id, p_token: job.lease_token,
    });
    if (reserved.error || reserved.data !== true) throw new Error("VIBE_CONTACT_CREDIT_CAP");
    const lead = await db.from("leads").select("business_name,city,country,website_url,is_demo")
      .eq("org_id", job.org_id).eq("id", job.lead_id).single();
    if (lead.error || !lead.data || lead.data.is_demo ||
      (job.source_kind === "official" && lead.data.website_url !== job.target_url) ||
      (job.source_kind === "listing" && (lead.data.website_url !== null || !lead.data.city)))
      throw new Error("CONTACT_SOURCE_CHANGED");
    const adapter = new SerperSearchAdapter(serper, fetch, VIBE_CONTACT_MAX_SERPER_CREDITS, 100000);
    const observations = job.source_kind === "official" ? await discoverVibePublicContacts({
      lead_id: job.lead_id, business_name: lead.data.business_name,
      official_website_url: job.target_url, country: lead.data.country,
    }, adapter) : await discoverVibeListingContacts({
      lead_id: job.lead_id, business_name: lead.data.business_name,
      city: lead.data.city!, country: lead.data.country, reviewed_listing_url: job.target_url,
    }, adapter);
    const finished = await db.rpc("finish_vibe_contact_discovery_job", {
      p_job: job.id, p_token: job.lease_token,
      p_observations: observations.map(({ kind, value, source_url, observed_at, evidence_excerpt, confidence, contact_name, role }) =>
        ({ kind, value, source_url, observed_at, evidence_excerpt, confidence, contact_name, role })),
      p_error: null,
    });
    if (finished.error) throw new Error("VIBE_CONTACT_RESULT_REVIEW_REQUIRED");
    return reply(200, { processed: 1, observations: finished.data });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message.slice(0, 80) : "VIBE_CONTACT_DISCOVERY_UNAVAILABLE";
    const failed = await db.rpc("finish_vibe_contact_discovery_job", {
      p_job: job.id, p_token: job.lease_token, p_observations: [], p_error: code,
    });
    if (failed.error) return reply(503, { error: "VIBE_CONTACT_FAILURE_PERSIST_FAILED" });
    return reply(200, { processed: 1, failed: true, error: code });
  }
});
