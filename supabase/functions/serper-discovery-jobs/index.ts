import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { discoverSerperCandidates, discoverSerperSearchCandidates, discoverySearchLane, newDiscoveryFilterDiagnostics, type DiscoveryFilterDiagnostics } from "../../../packages/server/discovery.ts";
import { SerperSearchAdapter } from "../../../packages/server/research.ts";
import { boundedBody } from "../../../packages/server/requests.ts";

async function authorized(req: Request, secret: string) {
  const values = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

const runSchema = z.object({
  id: z.uuid(), org_id: z.uuid(), lease_token: z.uuid(), requested_limit: z.number().int().min(1).max(10),
  target_industry: z.string().min(3), target_city: z.string().min(2), target_country: z.string().min(2),
  campaign_id: z.uuid().nullable(), search_mode: z.enum(["deep", "paged_search"]), search_page: z.number().int().min(1).max(15),
});
const claimSchema = z.object({ org_id: z.uuid(), campaign_id: z.uuid(), search_page: z.number().int().min(1).max(16) });

export const handler = async (req: Request): Promise<Response> => {
  const origin = Deno.env.get("ALLOWED_ORIGIN") ?? "";
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin || "", Vary: "Origin" },
  });
  if (req.method === "OPTIONS") {
    const preflight = { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-signature",
      Vary: "Origin" } as const;
    return req.headers.get("Origin") === origin && origin
      ? new Response(null, { status: 204, headers: preflight })
      : new Response(JSON.stringify({ error: "ORIGIN_DENIED" }), { status: 403, headers: preflight });
  }
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_SERPER_DISCOVERY") !== "true") return reply(503, { error: "DISCOVERY_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  const providerKey = Deno.env.get("SERPER_API_KEY") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (secret.length < 32 || !providerKey || providerKey === "your_key_here" || !url || !key)
    return reply(503, { error: "DISCOVERY_NOT_CONFIGURED" });
  // Auth: internal cron signature OR an org-admin browser session (dashboard).
  const internal = await authorized(req, secret);
  let browserOrg: string | null = null;
  if (!internal) {
    if (origin && req.headers.get("Origin") === origin) {
      const authorization = req.headers.get("Authorization") ?? "";
      const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      if (authorization.startsWith("Bearer ") && anon) {
        const owner = createClient(url, anon, { auth: { persistSession: false },
          global: { headers: { Authorization: authorization } } });
        const { data: identity, error: identityError } = await owner.auth.getUser();
        if (!identityError && identity.user) {
          const member = await owner.from("memberships").select("org_id,role").eq("user_id", identity.user.id).maybeSingle();
          if (!member.error && member.data?.role === "admin") browserOrg = member.data.org_id as string;
        }
      }
    }
    if (!browserOrg) return reply(401, { error: "UNAUTHORIZED" });
  }
  const client = createClient(url, key, { auth: { persistSession: false } });
  // Request contract:
  //   {}                              -> background queue + armed campaign continuation
  //   {"mode":"background"}           -> background queue only
  //   {"mode":"campaign"}             -> armed campaign continuation only
  //   {"org_id","campaign_id"}        -> one explicit campaign page (owner step)
  //   {"mode":"campaign","org_id":..} -> armed continuation limited to one organization
  let body: { mode?: "campaign" | "background"; org_id?: string; campaign_id?: string } = {};
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req, 256));
    if (raw.trim()) body = z.object({
      mode: z.enum(["campaign", "background"]).optional(),
      org_id: z.uuid().optional(),
      campaign_id: z.uuid().optional(),
    }).strict().parse(JSON.parse(raw));
  }
  catch { return reply(422, { error: "INVALID_WORKER_TARGET" }); }
  if (body.campaign_id && !body.org_id) return reply(422, { error: "INVALID_WORKER_TARGET" });
  if (body.org_id && browserOrg && body.org_id !== browserOrg) return reply(403, { error: "ORG_SCOPE_DENIED" });
  const explicitTarget = Boolean(body.org_id && body.campaign_id);
  // A browser session may never lease the global background queue.
  const allowBackground = !browserOrg && body.mode !== "campaign";
  const allowCampaign = Boolean(explicitTarget) || body.mode !== "background";
  const orgScope = body.org_id ?? null;

  let createdTotal = 0, matchedTotal = 0, alreadyRecordedTotal = 0, reviewNeededTotal = 0, observationsTotal = 0;
  let completed = 0, failed = 0, processed = 0;
  const diagnostics: Array<Record<string, number | string>> = [];
  const campaignsAdvanced: string[] = [];

  const processRuns = async (rawRuns: unknown) => {
    const runs = z.array(runSchema).parse(rawRuns);
    for (const run of runs) {
      let observations = 0, newBusinesses = 0;
      try {
        let lane: "website" | "automation" = "website";
        if (run.campaign_id) {
          const campaign = await client.from("discovery_campaigns").select("website_percent")
            .eq("org_id", run.org_id).eq("id", run.campaign_id).single();
          if (campaign.error) throw new Error("DISCOVERY_CAMPAIGN_UNAVAILABLE");
          lane = discoverySearchLane(run.search_page, z.number().int().min(0).max(100).parse(campaign.data.website_percent));
        }
        const filterDiagnostics: DiscoveryFilterDiagnostics = newDiscoveryFilterDiagnostics();
        const reserved = await client.rpc("reserve_serper_discovery_credits", {
          p_run: run.id, p_token: run.lease_token,
        });
        if (reserved.error || reserved.data !== true) throw new Error("DISCOVERY_CREDIT_CAP");
        const adapter = new SerperSearchAdapter(providerKey, fetch, run.search_mode === "paged_search" ? 1 : 31);
        const candidates = run.search_mode === "paged_search"
          ? await discoverSerperSearchCandidates({ industry: run.target_industry, city: run.target_city,
            country: run.target_country, page: run.search_page, lane }, adapter, undefined, filterDiagnostics)
          : await discoverSerperCandidates({ industry: run.target_industry, city: run.target_city,
            country: run.target_country }, adapter);
        if (run.search_mode === "paged_search") {
          console.log(JSON.stringify({ event: "serper_paged_search_diagnostics",
            search_mode: run.search_mode, page: run.search_page, lane, ...filterDiagnostics }));
          diagnostics.push({ search_mode: run.search_mode, page: run.search_page, lane, ...filterDiagnostics });
        }
        for (const candidate of candidates.slice(0, run.requested_limit)) {
          const saved = await client.rpc("ingest_serper_observation", {
            p_org: run.org_id, p_run: run.id, p_name: candidate.name,
            p_city: candidate.city, p_country: run.target_country,
            p_source_url: candidate.source_url, p_observed_at: candidate.observed_at,
            p_category: candidate.category, p_evidence_quote: candidate.evidence_quote,
            p_evidence_url: candidate.source_url,
          });
          if (saved.error) throw new Error("DISCOVERY_INTAKE_FAILED");
          const intake = z.union([
            z.object({ state: z.enum(["created", "matched", "already_recorded"]), lead_id: z.uuid() }),
            z.object({ state: z.literal("review_needed"), candidate_id: z.uuid() }),
          ]).parse(saved.data);
          if (intake.state === "created") newBusinesses++;
          if (intake.state === "matched") matchedTotal++;
          else if (intake.state === "already_recorded") alreadyRecordedTotal++;
          else if (intake.state === "review_needed") reviewNeededTotal++;
          // Conflicted business identities stay in the existing review queue;
          // never attach a contact to an unresolved lookalike.
          if ("lead_id" in intake && candidate.contacts.length) {
            const contacts = await client.rpc("record_vibe_contact_observations", {
              p_org: run.org_id, p_lead: intake.lead_id, p_provider: "serper",
              p_observations: candidate.contacts.map((item) => ({ ...item,
                source_url: candidate.source_url, observed_at: candidate.observed_at,
                confidence: run.search_mode === "paged_search" ? 0.4 : 0.5 })),
            });
            if (contacts.error) throw new Error("DISCOVERY_CONTACT_PERSIST_FAILED");
          }
          if ("lead_id" in intake) {
            const queued = await client.rpc("enqueue_intake_handoff_queue", {
              p_org: run.org_id, p_lead: intake.lead_id, p_run: run.id,
            });
            if (queued.error) console.warn("INTAKE_HANDOFF_ENQUEUE_FAILED", queued.error.message);
          }
          observations++;
        }
        const finished = run.campaign_id ? await client.rpc("finish_discovery_campaign_page", {
          p_run: run.id, p_token: run.lease_token, p_observations: observations,
          p_new_businesses: newBusinesses, p_error: null,
          ...(run.search_mode === "paged_search" ? { p_diagnostics: filterDiagnostics } : {}),
        }) : await client.rpc("finish_serper_discovery_run", {
          p_run: run.id, p_token: run.lease_token, p_observations: observations, p_error: null,
          ...(run.search_mode === "paged_search" ? { p_diagnostics: filterDiagnostics } : {}),
        });
        if (finished.error) throw new Error("DISCOVERY_FINISH_FAILED");
        completed++;
        createdTotal += newBusinesses;
        observationsTotal += observations;
      } catch (cause) {
        const code = cause instanceof Error ? cause.message.slice(0, 80) : "DISCOVERY_UNAVAILABLE";
        const result = run.campaign_id ? await client.rpc("finish_discovery_campaign_page", {
          p_run: run.id, p_token: run.lease_token, p_observations: observations,
          p_new_businesses: newBusinesses, p_error: code,
        }) : await client.rpc("finish_serper_discovery_run", {
          p_run: run.id, p_token: run.lease_token, p_observations: observations, p_error: code,
        });
        if (result.error) return reply(503, { error: "DISCOVERY_FAILURE_PERSIST_FAILED" });
        failed++;
      }
      // A finished campaign page may complete its campaign or exhaust it; the
      // batch then advances to the next combination or stops. Auto-advance never
      // resumes a campaign the owner paused or cancelled.
      if (run.campaign_id) {
        const advanced = await client.rpc("advance_campaign_batch", {
          p_org: run.org_id, p_campaign: run.campaign_id,
        });
        if (advanced.error) console.warn("CAMPAIGN_ADVANCE_FAILED", advanced.error.message);
        else if (typeof advanced.data === "string") campaignsAdvanced.push(advanced.data);
      }
      processed++;
    }
  };

  // 1. Explicit owner step (one page of one campaign).
  if (explicitTarget) {
    const leased = await client.rpc("lease_serper_campaign_page", {
      p_org: body.org_id!, p_campaign: body.campaign_id!,
    });
    if (leased.error) return reply(503, { error: "DISCOVERY_QUEUE_UNAVAILABLE" });
    await processRuns(leased.data);
  }
  // 2. Background queue (internal callers only; never a browser session).
  if (allowBackground && !explicitTarget) {
    const leased = await client.rpc("lease_serper_discovery_runs", { p_limit: 1 });
    if (leased.error) return reply(503, { error: "DISCOVERY_QUEUE_UNAVAILABLE" });
    await processRuns(leased.data);
  }
  // 3. Armed campaign continuation: one armed campaign page per invocation.
  if (allowCampaign) {
    const claimed = await client.rpc("claim_campaign_continuation", {
      p_limit: 1, p_org: orgScope,
    });
    if (claimed.error) return reply(503, { error: "DISCOVERY_QUEUE_UNAVAILABLE" });
    const campaigns = z.array(claimSchema).parse(claimed.data ?? []);
    for (const campaign of campaigns) {
      const leased = await client.rpc("lease_serper_campaign_page", {
        p_org: campaign.org_id, p_campaign: campaign.campaign_id,
      });
      if (leased.error) return reply(503, { error: "DISCOVERY_QUEUE_UNAVAILABLE" });
      await processRuns(leased.data);
    }
  }
  return reply(200, { processed, completed, failed,
    created: createdTotal, matched: matchedTotal, already_recorded: alreadyRecordedTotal,
    review_needed: reviewNeededTotal, observations: observationsTotal, diagnostics,
    campaigns_advanced: campaignsAdvanced });
};

Deno.serve(handler);
