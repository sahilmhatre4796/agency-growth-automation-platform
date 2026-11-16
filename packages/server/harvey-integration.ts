// Harvey → ChainCraft intake integration.
//
// Harvey (https://github.com/ethanplusai/harvey) is a separate local Python
// application that discovers businesses, profiles them, qualifies them and
// decides what to pitch. It is NOT imported into ChainCraft's Node/Deno
// runtime (incompatible: Python, Playwright, SQLite, local heartbeat loop).
//
// Integration contract: Harvey runs on the owner's machine and feeds
// qualified leads into ChainCraft through the existing
// `public.ingest_discovered_business(org_id, run_id, source, provider, name,
// website, city, state, country, source_url, provider_record_id, observed_at)`
// RPC. ChainCraft's `intake-handoff.ts` then runs each lead through website
// assessment, qualification, contact, verification and outbound stages.
//
// Nothing in this module calls Harvey or makes any live request. It defines
// the data contract and a fail-closed client wrapper.
import { z } from "zod";

// Shape of a lead Harvey submits to ChainCraft intake.
export type HarveyLead = {
  provider_record_id: string; // Harvey's own record id (dedup key)
  business_name: string;
  website_url: string | null;
  city: string | null;
  state_region: string | null;
  country: string;
  source_url: string; // Harvey's discovery source URL (OSM/Serper listing)
  observed_at: string; // ISO timestamp
  evidence: Array<{ kind: string; claim: string; url: string; confidence: number }>;
  qualification?: {
    is_genuine_business: boolean;
    meets_target_criteria: boolean;
    has_official_website: boolean;
    website_status:
      | "VERIFIED_WORKING"
      | "VERIFIED_OUTDATED"
      | "VERIFIED_SLOW"
      | "VERIFIED_SERIOUS_ISSUE"
      | "NO_OFFICIAL_WEBSITE_FOUND"
      | "UNKNOWN";
    recommended_service?: string;
    service_reason?: string;
    worth_contacting: boolean;
    additional_research?: string[];
  };
};

// Shape of the RPC call Harvey makes into ChainCraft.
export type IntakeRpcCall = {
  p_org: string;
  p_run: string;
  p_source: "harvey";
  p_provider: "harvey_osm";
  p_name: string;
  p_website: string | null;
  p_city: string | null;
  p_state: string | null;
  p_country: string;
  p_source_url: string;
  p_provider_record_id: string;
  p_observed_at: string;
};

// Validate a Harvey lead before submission.
export const harveyLeadSchema = z.object({
  provider_record_id: z.string().min(1).max(300),
  business_name: z.string().min(2).max(200),
  website_url: z.string().url().max(2000).nullable().optional(),
  city: z.string().min(1).max(100).nullable().optional(),
  state_region: z.string().min(1).max(120).nullable().optional(),
  country: z.string().min(2).max(120),
  source_url: z.string().url().max(2000),
  observed_at: z.string().datetime({ offset: true }),
  evidence: z
    .array(
      z.object({
        kind: z.string().min(1).max(50),
        claim: z.string().min(1).max(500),
        url: z.string().url().max(2000),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20)
    .default([]),
  qualification: z
    .object({
      is_genuine_business: z.boolean(),
      meets_target_criteria: z.boolean(),
      has_official_website: z.boolean(),
      website_status: z.string(),
      recommended_service: z.string().nullable().optional(),
      service_reason: z.string().nullable().optional(),
      worth_contacting: z.boolean(),
      additional_research: z.array(z.string()).max(10).default([]),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Injected dependency port
// ---------------------------------------------------------------------------

export type IntakeRpcPort = {
  // Calls public.ingest_discovered_business. Returns the created/matched lead.
  call(input: IntakeRpcCall): Promise<{ state: string; lead_id: string }>;
};

// ---------------------------------------------------------------------------
// Map a Harvey lead into a ChainCraft intake RPC call
// ---------------------------------------------------------------------------

export function mapHarveyLeadToIntake(input: {
  org_id: string;
  run_id: string;
  lead: HarveyLead;
}): IntakeRpcCall {
  const parsed = harveyLeadSchema.parse(input.lead);
  return {
    p_org: input.org_id,
    p_run: input.run_id,
    p_source: "harvey",
    p_provider: "harvey_osm",
    p_name: parsed.business_name,
    p_website: parsed.website_url ?? null,
    p_city: parsed.city ?? null,
    p_state: parsed.state_region ?? null,
    p_country: parsed.country,
    p_source_url: parsed.source_url,
    p_provider_record_id: parsed.provider_record_id,
    p_observed_at: parsed.observed_at,
  };
}

// ---------------------------------------------------------------------------
// Decide whether a Harvey lead should be submitted to ChainCraft intake.
// Only genuine, target-criteria businesses worth contacting are submitted.
// ---------------------------------------------------------------------------

export function shouldSubmitToChainCraft(lead: HarveyLead): {
  submit: boolean;
  reason: string;
} {
  const q = lead.qualification;
  if (!q) {
    return { submit: false, reason: "No qualification decision from Harvey" };
  }
  if (!q.is_genuine_business) {
    return { submit: false, reason: "Not a genuine business" };
  }
  if (!q.meets_target_criteria) {
    return { submit: false, reason: "Does not meet target criteria" };
  }
  if (!q.worth_contacting) {
    return { submit: false, reason: "Not worth contacting" };
  }
  return { submit: true, reason: "Qualified by Harvey" };
}

// ---------------------------------------------------------------------------
// Fail-closed client: submits one qualified Harvey lead to ChainCraft intake.
// Returns null when the intake RPC port is unavailable (e.g. Supabase down).
// ---------------------------------------------------------------------------

export async function submitHarveyLeadToChainCraft(input: {
  org_id: string;
  run_id: string;
  lead: HarveyLead;
  rpc: IntakeRpcPort;
}): Promise<{ submitted: boolean; lead_id?: string; reason: string }> {
  const decision = shouldSubmitToChainCraft(input.lead);
  if (!decision.submit) {
    return { submitted: false, reason: decision.reason };
  }

  try {
    const call = mapHarveyLeadToIntake({
      org_id: input.org_id,
      run_id: input.run_id,
      lead: input.lead,
    });
    const result = await input.rpc.call(call);
    return { submitted: true, lead_id: result.lead_id, reason: "submitted" };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { submitted: false, reason: `intake_rpc_failed: ${message}` };
  }
}

