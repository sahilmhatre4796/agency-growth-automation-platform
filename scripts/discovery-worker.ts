// Queue-backed discovery worker: leases a queued discovery run from
// discovery_runs, runs runConfiguredDiscoveryJob, persists results via the
// intake/contact RPCs, and finishes the job atomically. Two modes:
//
//   One-shot (existing):   npm run worker:discovery -- '<target json>'
//   Lease-and-process:     npm run worker:discovery -- lease server
//                          npm run worker:discovery -- lease harvey
//
// No process-specific run-ID mode: that would bypass org ownership, lease
// tokens, and attempt counting. All queue access goes through the provider-
// specific lease/finish RPCs which enforce org scoping and RLS.
//
// Persistence path (serper):
//   1. lease_serper_discovery_runs -> leased run (attempts incremented atomically)
//   2. runConfiguredDiscoveryJob -> DiscoveryJobOutput
//   3. ingest_serper_observation per deduplicated_business -> {state, lead_id}
//   4. record_vibe_contact_observations per resolved lead, p_provider='serper'
//   5. finish_serper_discovery_run -> completed/queued(retry)/failed
//
// RPC signatures match the SQL definitions exactly:
//   ingest_serper_observation(p_org, p_run, p_name, p_city, p_country,
//     p_source_url, p_observed_at, p_category, p_evidence_quote, p_evidence_url)
//   record_vibe_contact_observations(p_org, p_lead, p_provider, p_observations)
//   finish_serper_discovery_run(p_run, p_token, p_observations, p_error)
//
// Provider provenance preserved exactly:
//   ingestion: source='serper', provider='serper'  (via ingest_serper_observation)
//   contacts:  p_provider='serper'                 (via record_vibe_contact_observations)
//   OSM:       source='harvey', provider='harvey_osm'; contacts p_provider='harvey'

import { createClient } from "@supabase/supabase-js";
import { runConfiguredDiscoveryJob, type DiscoveryRunTarget } from "../packages/server/discovery-entrypoint.ts";
import type { ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";

// Provider lease/finish RPC names mapped to provider value.
type Provider = "server" | "harvey";
const leaseRpc: Record<Provider, string> = {
  server: "lease_serper_discovery_runs",
  harvey: "lease_harvey_osm_discovery_runs",
};
const finishRpc: Record<Provider, string> = {
  server: "finish_serper_discovery_run",
  harvey: "finish_harvey_osm_discovery_run",
};

const requiredEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`MISSING_ENV:${name}`);
}

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const raw = process.argv[2];
if (!raw) throw new Error("DISCOVERY_TARGET_OR_MODE_REQUIRED");

async function finishRun(provider: Provider, runId: string, token: string, observations: number, error: string | null) {
  const { error: rpcError } = await db.rpc(finishRpc[provider], {
    p_run: runId,
    p_token: token,
    p_observations: observations,
    p_error: error ?? null,
  });
  if (rpcError) throw new Error(`FINISH_FAILED:${rpcError.message}`);
}

interface LeasedRun {
  id: string;
  org_id: string;
  provider: string;
  state: string;
  requested_limit: number;
  target_industry: string;
  target_city: string;
  target_country: string;
  lease_token: string;
  lease_until: string;
  next_run_at: string;
  attempts: number;
  max_attempts: number;
}
async function processRun(provider: Provider, run: LeasedRun) {
  const target: DiscoveryRunTarget = {
    industry: run.target_industry,
    city: run.target_city,
    region: null,
    country: run.target_country,
    requested_count: run.requested_limit,
  };

  // ENABLE_DISCOVERY_RUN gate is enforced inside runConfiguredDiscoveryJob.
  const output = await runConfiguredDiscoveryJob({
    env: process.env,
    target,
    httpTransport: fetch,
    run_id: run.id,
  });

  let observations = 0;
  // Map business -> lead_id from ingestion result for contact persistence.
  const leadByProviderRecordId = new Map<string, string>();

  for (const business of output.deduplicated_businesses) {
    if (business.source_agent === "osm") {
      // OSM-sourced businesses ingest via ingest_discovered_business with
      // p_source='harvey', p_provider='harvey_osm'. Never route OSM through
      // Serper ingestion (which has no p_provider/p_provider_record_id params).
      const { data: saved, error: savedError } = await db.rpc("ingest_discovered_business", {
        p_org: run.org_id,
        p_run: run.id,
        p_source: "harvey",
        p_provider: "harvey_osm",
        p_name: business.business_name,
        p_website: business.website_url,
        p_city: business.city,
        p_state: null,
        p_country: business.country,
        p_source_url: business.source_url,
        p_provider_record_id: business.provider_record_id,
        p_observed_at: business.observed_at,
      });
      if (savedError) throw new Error(`OSM_INGEST_FAILED:${savedError.message}`);

      const result = saved.data as { state: string; lead_id?: string; candidate_id?: string };
      if (result.state === "review_needed") {
        observations++;
        continue;
      }
      if (result.state === "created" || result.state === "matched" || result.state === "already_recorded") {
        if (result.lead_id) {
          leadByProviderRecordId.set(business.provider_record_id, result.lead_id);
        }
        observations++;
      }
      continue;
    }

    if (business.source_agent !== "serper") {
      throw new Error(`UNKNOWN_SOURCE_AGENT:${business.source_agent}`);
    }

    // ingest_serper_observation signature (exact, no p_provider/p_website/p_provider_record_id):
    // p_org, p_run, p_name, p_city, p_country, p_source_url, p_observed_at,
    // p_category, p_evidence_quote, p_evidence_url
    const evidence = business.evidence?.[0];
    const { data: saved, error: savedError } = await db.rpc("ingest_serper_observation", {
      p_org: run.org_id,
      p_run: run.id,
      p_name: business.business_name,
      p_city: business.city,
      p_country: business.country,
      p_source_url: business.source_url,
      p_observed_at: business.observed_at,
      p_category: business.source_agent,
      p_evidence_quote: evidence?.claim ?? "",
      p_evidence_url: evidence?.url ?? "",
    });
    if (savedError) throw new Error(`INGEST_FAILED:${savedError.message}`);

    const result = saved.data as { state: string; lead_id?: string; candidate_id?: string };
    if (result.state === "review_needed") {
      observations++;
      continue;
    }
    if (result.state === "created" || result.state === "matched" || result.state === "already_recorded") {
      if (result.lead_id) {
        leadByProviderRecordId.set(business.provider_record_id, result.lead_id);
      }
      observations++;
    }
  }

  // Persist contacts per resolved lead. Merge contacts whose lead_id matches
  // the business's provider_record_id (set by the coordinator at map time),
  // then re-point to the real CRM lead_id returned by ingestion.
  const contactsByLead = new Map<string, ContactObservation[]>();
  for (const contact of output.merged_contacts) {
    const realLeadId = leadByProviderRecordId.get(contact.lead_id);
    if (!realLeadId) continue; // contact belongs to an unresolved/review_needed business
    const bucket = contactsByLead.get(realLeadId) ?? [];
    bucket.push({ ...contact, lead_id: realLeadId });
    contactsByLead.set(realLeadId, bucket);
  }

  for (const [leadId, contacts] of contactsByLead) {
    // Discovery source must exist for record_vibe_contact_observations to pass
    // its DISCOVERY_SOURCE_NOT_MATCHED check (created by ingest path).
    const observationsPayload = contacts.map((c) => ({
      kind: c.kind,
      value: c.value,
      source_url: c.source_url,
      observed_at: c.observed_at,
      evidence_excerpt: c.evidence_excerpt,
      confidence: c.confidence,
      contact_name: c.contact_name ?? null,
      role: c.role ?? null,
    }));
    const { error: contactError } = await db.rpc("record_vibe_contact_observations", {
      p_org: run.org_id,
      p_lead: leadId,
      p_provider: provider === "server" ? "serper" : "harvey",
      p_observations: observationsPayload,
    });
    if (contactError) throw new Error(`CONTACT_PERSIST_FAILED:${contactError.message}`);
  }

  await finishRun(provider, run.id, run.lease_token, observations, null);
  return { processed: 1, observations, provider };
}

async function main() {
  if (raw === "lease") {
    const providerRaw = process.argv[3];
    if (providerRaw !== "server" && providerRaw !== "harvey") {
      throw new Error("PROVIDER_REQUIRED: server | harvey");
    }
    const provider: Provider = providerRaw;
    const { data: leased, error: leaseError } = await db.rpc(leaseRpc[provider], { p_limit: 1 });
    if (leaseError) throw new Error(`LEASE_FAILED:${leaseError.message}`);
    const runs = Array.isArray(leased) ? (leased as LeasedRun[]) : (leased ? [leased as LeasedRun] : []);
    if (runs.length === 0) {
      process.stdout.write(JSON.stringify({ processed: 0, provider }) + "\n");
      return;
    }
    for (const run of runs) {
      try {
        const result = await processRun(provider, run);
        process.stdout.write(JSON.stringify(result) + "\n");
      } catch (cause) {
        const code = cause instanceof Error ? cause.message.slice(0, 80) : "DISCOVERY_UNAVAILABLE";
        await finishRun(provider, run.id, run.lease_token, 0, code);
        process.stdout.write(
          JSON.stringify({ processed: 1, failed: true, error: code, provider }) + "\n",
        );
      }
    }
    return;
  }

  // One-shot mode: target JSON from argv, no DB access, no persistence.
  const output = await runConfiguredDiscoveryJob({
    env: process.env,
    target: JSON.parse(raw) as DiscoveryRunTarget,
    httpTransport: fetch,
  });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
