import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { HarveyOsmCollector } from "../../../packages/server/harvey-osm.ts";
import { normalizeContactValue } from "../../../packages/server/vibe-contact-enrichment.ts";
import { boundedBody } from "../../../packages/server/requests.ts";

async function authorized(req: Request, secret: string) {
  const values = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export const handler = async (req: Request): Promise<Response> => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_HARVEY_OSM_DISCOVERY") !== "true") return reply(503, { error: "DISCOVERY_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (secret.length < 32 || !url || !key) return reply(503, { error: "DISCOVERY_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  let target: { org_id: string; run_id: string } | null = null;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req, 256));
    if (raw) target = z.object({ org_id: z.uuid(), run_id: z.uuid() }).strict().parse(JSON.parse(raw));
  }
  catch { return reply(422, { error: "INVALID_WORKER_TARGET" }); }
  const leased = target ? await client.rpc("lease_harvey_osm_owner_run", {
    p_org: target.org_id, p_run: target.run_id,
  }) : await client.rpc("lease_harvey_osm_discovery_runs", { p_limit: 1 });
  if (leased.error) return reply(503, { error: "DISCOVERY_QUEUE_UNAVAILABLE" });
  const runs = z.array(z.object({
    id: z.uuid(), org_id: z.uuid(), lease_token: z.uuid(), requested_limit: z.number().int().min(1).max(3),
    target_industry: z.enum(["dentist", "plumber", "electrician", "roofer", "gardener"]),
    target_city: z.string().min(2), target_country: z.string().min(2),
    target_latitude: z.coerce.number(), target_longitude: z.coerce.number(), target_radius_km: z.coerce.number(),
  })).parse(leased.data);
  let completed = 0;
  const failed = 0;
  for (const run of runs) {
    if (target && (run.id !== target.run_id || run.org_id !== target.org_id))
      return reply(503, { error: "DISCOVERY_SCOPE_MISMATCH" });
    let observations = 0;
    try {
      const listings = await new HarveyOsmCollector(fetch).collect({
        category: run.target_industry, latitude: run.target_latitude, longitude: run.target_longitude,
        radiusKm: run.target_radius_km, limit: run.requested_limit,
      });
      for (const listing of listings) {
        const saved = await client.rpc("ingest_discovered_business", {
          p_org: run.org_id, p_run: run.id, p_source: "harvey", p_provider: "harvey_osm",
          p_name: listing.name, p_website: listing.proposed_website_url,
          p_city: run.target_city, p_state: null, p_country: run.target_country,
          p_source_url: listing.source_url, p_provider_record_id: listing.provider_record_id,
          p_observed_at: listing.observed_at,
        });
        if (saved.error) throw new Error("DISCOVERY_INTAKE_FAILED");
        const intake = z.union([z.object({ state: z.enum(["created", "matched", "already_recorded"]), lead_id: z.uuid() }),
          z.object({ state: z.literal("review_needed"), candidate_id: z.uuid() })]).parse(saved.data);
        if ("lead_id" in intake && listing.contacts.length) {
          const valid = listing.contacts.filter((item) => {
            try { normalizeContactValue(item.kind, item.value); return true; } catch { return false; }
          });
          if (valid.length) {
            const contacts = await client.rpc("record_vibe_contact_observations", {
              p_org: run.org_id, p_lead: intake.lead_id, p_provider: "harvey",
              p_observations: valid.map((item) => ({ ...item, source_url: listing.source_url,
                observed_at: listing.observed_at, confidence: 0.45 })),
            });
            if (contacts.error) throw new Error("DISCOVERY_CONTACT_PERSIST_FAILED");
          }
        }
        if ("lead_id" in intake) {
          const queued = await client.rpc("enqueue_intake_handoff_queue", {
            p_org: run.org_id, p_lead: intake.lead_id, p_run: run.id,
          });
          if (queued.error) console.warn("INTAKE_HANDOFF_ENQUEUE_FAILED", queued.error.message);
        }
        observations++;
      }
      const finished = await client.rpc("finish_harvey_osm_discovery_run", {
        p_run: run.id, p_token: run.lease_token, p_observations: observations, p_error: null,
      });
      if (finished.error) throw new Error("DISCOVERY_FINISH_FAILED");
      completed++;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message.slice(0, 80) : "DISCOVERY_UNAVAILABLE";
      const finished = await client.rpc("finish_harvey_osm_discovery_run", {
        p_run: run.id, p_token: run.lease_token, p_observations: observations, p_error: code,
      });
      if (finished.error) return reply(503, { error: "DISCOVERY_FAILURE_PERSIST_FAILED" });
      completed++;
    }
  }
  return reply(200, { processed: runs.length, completed, failed });
};

Deno.serve(handler);
