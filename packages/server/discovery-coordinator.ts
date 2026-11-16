// Coordinated discovery: OpenStreetMap listings (provider "osm") + Serper
// search evidence + Scrapling official-domain contact extraction. Discovery and
// qualification NEVER automatically trigger email sending (ENABLE_LIVE_EMAIL
// stays authoritative). Every qualification rule is delegated to
// qualifyLeadStrictly; this module adds none, and website assessment (when
// wired) only supplies evidence through the assessment port below.
//
// The external Harvey application remains UNAVAILABLE: no callable research
// contract exists in this repository (it pushes leads via the intake RPC,
// harvey-integration.ts, which is downstream and unused here).
//
// Explicitly NOT implemented here (reported as blockers, never simulated):
// Reacher verification, Vibe Prospecting fallback, CRM persistence —
// providers are injected, so tests run on fakes.

import {
  qualifyLeadStrictly,
  type OperationalNeed,
  type StrictQualificationResult,
  type WebsiteProblem,
} from "./qualification.ts";
import {
  extractScraplingObservations,
  scraplingEnabled,
  type ScraplingReport,
} from "./scrapling-adapter.ts";
import type { ContactObservation } from "./vibe-contact-enrichment.ts";
import { discoverAuditedOfficialContacts } from "./vibe-contact-discovery.ts";
import type { BusinessWebsiteAssessment } from "./website-assessment.ts";

export type ProviderName = "osm" | "serper" | "scrapling";

// Input contract taken from the real qualifyLeadStrictly signature.
export type ServiceMatch = Parameters<typeof qualifyLeadStrictly>[0]["serviceMatches"][number];

export type EvidenceItem = { kind: string; claim: string; url: string; confidence: number };

export type DiscoveredBusiness = {
  provider_record_id: string;
  business_name: string;
  website_url: string | null;
  // Assessment-derived; null means UNKNOWN until independently verified.
  website_status: string | null;
  website_problem: WebsiteProblem | null;
  operational_need: OperationalNeed | null;
  serviceMatches: ServiceMatch[];
  city: string | null;
  state_region: string | null;
  country: string;
  // Where city/state came from: "search_target" = search-area metadata from
  // the discovery target (OSM/Serper candidates carry no verified address);
  // "provider_record" = the provider's own record. Never a verified address
  // unless a provider record actually contains one.
  location_source: "search_target" | "provider_record";
  source_url: string;
  observed_at: string;
  evidence: EvidenceItem[];
  source_agent: ProviderName;
};

export type ProviderResult = {
  provider: ProviderName;
  status: "success" | "partial" | "failure" | "skipped";
  businesses: DiscoveredBusiness[];
  error?: string;
  durationMs: number;
};

// Both search providers receive the same target so each adapter can apply its
// own existing query contract (Serper builds its query internally; the OSM
// collector resolves category/geo from the target).
export type DiscoveryTarget = {
  industry: string | null;
  city: string | null;
  region: string | null;
  country: string;
  requested_count: number;
};

export type DiscoveryJobInput = {
  org_id: string;
  run_id: string;
  industry: string | null;
  city: string | null;
  region: string | null;
  country: string;
  requested_count: number;
  // OpenStreetMap listing provider (reported as "osm"). Not the external
  // Harvey application, which has no callable contract in this repository.
  osm: {
    discover(target: DiscoveryTarget): Promise<{
      businesses: DiscoveredBusiness[];
      contacts?: ContactObservation[];
      error?: string;
    }>;
  };
  serper: {
    search(target: DiscoveryTarget): Promise<{
      businesses: DiscoveredBusiness[];
      contacts?: ContactObservation[];
      error?: string;
    }>;
  };
  scrapling: {
    fetch(input: { official_url: string; lead_id: string }): Promise<{ report: ScraplingReport | null; error?: string }>;
  };
  // Optional Vibe Prospecting fallback port. This repository contains no
  // callable ContactEnrichmentProvider implementation — only local
  // extraction/classification helpers — so production wiring must leave
  // this absent and report the missing contract explicitly. Tests may
  // inject a fake to exercise the fallback path.
  vibe_fallback?: {
    lookup(input: { business_name: string; domain: string; maximum_cost: number }): Promise<ContactObservation[]>;
  };
  // Optional website assessment layer (see website-assessment.ts). When absent
  // or failing, website_status stays null (unknown) and no business is
  // counted as qualified on website evidence.
  assessment?: {
    assess(input: { business: DiscoveredBusiness }): Promise<BusinessWebsiteAssessment>;
  };
  env?: Record<string, string | undefined>;
  // Per-provider timeout; defaults to 30s. Tests use a short value.
  timeout_ms?: number;
};

export type QualificationDecision =
  | {
      status: "qualified";
      business: DiscoveredBusiness;
      qualification: StrictQualificationResult;
      // Contacts exist but Reacher verification is not wired: never "valid".
      contact_status: "unverified";
      contact_research_status: ContactResearchStatus;
      next_action: "verify_contacts_before_outreach";
    }
  | {
      status: "contact_incomplete";
      business: DiscoveredBusiness;
      qualification: StrictQualificationResult;
      contacts: ContactObservation[];
      contact_research_status: ContactResearchStatus;
      reason: string;
    }
  | {
      // Strict-qualified, but the website assessment is missing, failed,
      // inconclusive or timed out: held for manual review and never counted
      // as qualified.
      status: "hold_unassessed";
      business: DiscoveredBusiness;
      qualification: StrictQualificationResult;
      assessment_status: BusinessWebsiteAssessment["status"] | "not_configured";
      contact_research_status: ContactResearchStatus;
      reason: string;
    }
  | {
      status: "not_qualified";
      business: DiscoveredBusiness;
      qualification: StrictQualificationResult;
      contact_research_status: ContactResearchStatus;
    };

export type ContactResearchStatus =
  | "found_not_verified"
  | "contact_incomplete"
  | "contact_research_incomplete"
  | "contact_discovery_failed"
  | "conflicting_contact_evidence"
  | "no_public_contact_after_research";

export type DiscoveryJobOutput = {
  run_id: string;
  providers: ProviderResult[];
  raw_businesses: DiscoveredBusiness[];
  deduplicated_businesses: DiscoveredBusiness[];
  merged_contacts: ContactObservation[];
  qualification_decisions: QualificationDecision[];
  total_discovered: number;
  total_unique: number;
  total_qualified: number;
  // Vibe Prospecting external fallback status. Only a genuine callable
  // ContactEnrichmentProvider implementation can make this "used"; this
  // repository contains no such implementation, so production runs report
  // "provider_contract_missing" until one is wired.
  vibe_fallback: "used" | "skipped" | "provider_contract_missing" | "failed";
  // Roll-up of per-decision contact research statuses.
  contact_research_statuses: Record<ContactResearchStatus, number>;
};

function normalizeDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name.toLocaleLowerCase("en").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

// Identity = exact canonical domain, or an exactly identical normalized
// name + city + country. Similar-sounding names are never merged.
function businessIdentityKey(b: DiscoveredBusiness): string {
  const domain = normalizeDomain(b.website_url);
  if (domain) return `domain:${domain}`;
  return `name:${normalizeName(b.business_name)}|city:${(b.city ?? "").toLocaleLowerCase("en")}|country:${b.country}`;
}

export function deduplicateBusinesses(businesses: DiscoveredBusiness[]): {
  unique: DiscoveredBusiness[];
  duplicates: Array<{ duplicate: DiscoveredBusiness; canonical: DiscoveredBusiness; reason: string }>;
} {
  const unique: DiscoveredBusiness[] = [];
  const indexByKey = new Map<string, number>();
  const duplicates: Array<{ duplicate: DiscoveredBusiness; canonical: DiscoveredBusiness; reason: string }> = [];
  for (const business of businesses) {
    const key = businessIdentityKey(business);
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, unique.length);
      unique.push(business);
      continue;
    }
    const existing = unique[idx];
    const mergedEvidence = [...existing.evidence];
    for (const ev of business.evidence) {
      if (!mergedEvidence.some((m) => m.url === ev.url && m.claim === ev.claim)) mergedEvidence.push(ev);
    }
    const canonical = { ...existing, evidence: mergedEvidence };
    unique[idx] = canonical; // merged evidence must be visible in the returned unique record
    duplicates.push({ duplicate: business, canonical, reason: "Same canonical identity" });
  }
  return { unique, duplicates };
}

// Keep the higher-confidence observation per (lead, kind, value); never build
// a combined source_url because the ContactObservation schema demands one URL.
export function mergeContacts(observations: ContactObservation[]): ContactObservation[] {
  const byKey = new Map<string, ContactObservation>();
  for (const o of observations) {
    const key = `${o.lead_id}:${o.kind}:${o.value.toLocaleLowerCase("en")}`;
    const prev = byKey.get(key);
    if (!prev || o.confidence > prev.confidence) byKey.set(key, o);
  }
  return [...byKey.values()];
}

const DEFAULT_TIMEOUT_MS = 30000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ result: T | null; error: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ result: null; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ result: null, error: `timeout_after_${ms}ms` }), ms);
  });
  const settled = promise.then(
    (result) => ({ result, error: null }),
    (err: unknown) => ({ result: null, error: err instanceof Error ? err.message : String(err) }),
  );
  const raced = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return raced;
}

function providerStatus(businesses: DiscoveredBusiness[], error: string | undefined): ProviderResult["status"] {
  if (!error) return "success";
  return businesses.length > 0 ? "partial" : "failure";
}

async function runDiscoveryProviders(input: DiscoveryJobInput): Promise<{
  results: ProviderResult[];
  providerContacts: ContactObservation[];
}> {
  const start = Date.now();
  const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const target: DiscoveryTarget = {
    industry: input.industry,
    city: input.city,
    region: input.region,
    country: input.country,
    requested_count: input.requested_count,
  };
  const [osm, serper] = await Promise.all([
    withTimeout(input.osm.discover(target), timeout),
    withTimeout(input.serper.search(target), timeout),
  ]);
  const durationMs = Date.now() - start;
  const results: ProviderResult[] = [];
  const providerContacts: ContactObservation[] = [];
  const pairs: Array<["osm" | "serper", typeof osm]> = [["osm", osm], ["serper", serper]];
  for (const [provider, outcome] of pairs) {
    if (outcome.error || !outcome.result) {
      results.push({ provider, status: "failure", businesses: [], error: outcome.error ?? "no result", durationMs });
      continue;
    }
    const { businesses, contacts, error } = outcome.result;
    if (contacts?.length) providerContacts.push(...contacts);
    results.push({ provider, status: providerStatus(businesses, error), businesses, error, durationMs });
  }
  return { results, providerContacts };
}

// shortcut: caps Scrapling fetches per job at 5 sites; raise when the local
// worker gains rate limiting for larger runs.
const MAX_SCRAPLED_SITES = 5;

async function runScraplingPhase(
  businesses: DiscoveredBusiness[],
  input: DiscoveryJobInput,
): Promise<{ observations: ContactObservation[]; result: ProviderResult }> {
  const env = input.env ?? process.env;
  const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  // Flag checked BEFORE any fetch; when off, no network request is made.
  if (!scraplingEnabled(env)) {
    return {
      observations: [],
      result: { provider: "scrapling", status: "skipped", businesses: [], durationMs: Date.now() - start },
    };
  }
  const sites = businesses
    .filter((b): b is DiscoveredBusiness & { website_url: string } => b.website_url !== null)
    .slice(0, MAX_SCRAPLED_SITES);
  if (sites.length === 0) {
    return {
      observations: [],
      result: { provider: "scrapling", status: "skipped", businesses: [], durationMs: Date.now() - start },
    };
  }
  const observations: ContactObservation[] = [];
  const failures: string[] = [];
  let completed = 0;
  for (const business of sites) {
    const outcome = await withTimeout(
      input.scrapling.fetch({ official_url: business.website_url, lead_id: business.provider_record_id }),
      timeout,
    );
    if (outcome.error || !outcome.result || !outcome.result.report) {
      failures.push(`${business.provider_record_id}: ${outcome.error ?? outcome.result?.error ?? "no report"}`);
      continue;
    }
    if (outcome.result.error) failures.push(`${business.provider_record_id}: ${outcome.result.error}`);
    try {
      observations.push(
        ...extractScraplingObservations(outcome.result.report, {
          lead_id: business.provider_record_id,
          official_url: business.website_url,
          business_name: business.business_name,
          env,
        }),
      );
      completed++;
    } catch (err) {
      failures.push(`${business.provider_record_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const status: ProviderResult["status"] =
    failures.length === 0 ? "success" : completed > 0 ? "partial" : "failure";
  return {
    observations,
    result: {
      provider: "scrapling",
      status,
      businesses: [],
      error: failures.length > 0 ? failures.join("; ") : undefined,
      durationMs: Date.now() - start,
    },
  };
}

// Thin mapping only: all qualification rules live in qualifyLeadStrictly.
function decideForBusiness(
  business: DiscoveredBusiness,
  contacts: ContactObservation[],
  assessment: BusinessWebsiteAssessment | null,
  contact_research_status: ContactResearchStatus,
): QualificationDecision {
  const qualification = qualifyLeadStrictly({
    website_url: business.website_url,
    website_status: business.website_status,
    website_problem: business.website_problem,
    operational_need: business.operational_need,
    serviceMatches: business.serviceMatches,
  });
  if (!qualification.qualified) return { status: "not_qualified", business, qualification, contact_research_status };
  // An assessment that is missing, failed, timed out or inconclusive must
  // never count as qualified — hold for manual review instead.
  if (!assessment || assessment.status === "ASSESSMENT_FAILED" || assessment.status === "UNKNOWN") {
    return {
      status: "hold_unassessed",
      business,
      qualification,
      assessment_status: assessment?.status ?? "not_configured",
      contact_research_status: "contact_research_incomplete",
      reason: assessment
        ? `Website assessment ${assessment.status}: ${assessment.reason}`
        : "No website assessment was run; website status remains unknown.",
    };
  }
  if (contacts.length === 0) {
    return {
      status: "contact_incomplete",
      business,
      qualification,
      contacts,
      // Qualified on website evidence, but no contact was discovered: research
      // is complete and found nothing. Reacher verification is not implemented.
      contact_research_status: "contact_incomplete",
      reason: "Qualified, but no contact was discovered; enrichment and Reacher verification are not implemented in this coordinator.",
    };
  }
  return {
    status: "qualified",
    business,
    qualification,
    contact_status: "unverified",
    contact_research_status,
    next_action: "verify_contacts_before_outreach",
  };
}

// Runs the injected assessment layer. Absence or failure never becomes
// evidence about the business: website_status stays null (unknown).
async function runAssessment(
  input: DiscoveryJobInput,
  business: DiscoveredBusiness,
): Promise<BusinessWebsiteAssessment | null> {
  if (!input.assessment) return null;
  try {
    return await input.assessment.assess({ business });
  } catch (err) {
    const observedAt = new Date().toISOString();
    return {
      status: "ASSESSMENT_FAILED",
      website_status: null,
      website_problem: null,
      official_url: business.website_url,
      observed_at: observedAt,
      method: "none",
      reason: `Assessment failed (${err instanceof Error ? err.message : String(err)}); no website conclusion was recorded.`,
      evidence_url: null,
    };
  }
}

export async function runDiscoveryJob(input: DiscoveryJobInput): Promise<DiscoveryJobOutput> {
  const { results, providerContacts } = await runDiscoveryProviders(input);
  const raw_businesses = results.flatMap((p) => p.businesses);
  const { unique } = deduplicateBusinesses(raw_businesses);
  const { observations, result: scraplingResult } = await runScraplingPhase(unique, input);
  results.push(scraplingResult);

  // Website assessment runs before contact extraction so the audited official
  // page (already fetched under the pinned-audit protections) is available as
  // a primary contact source with no additional request.
  const assessed = await Promise.all(unique.map(async (business) => {
    const outcome = await runAssessment(input, business);
    return {
      business: outcome
        ? { ...business, website_status: outcome.website_status, website_problem: outcome.website_problem }
        : business,
      outcome,
    };
  }));

  // Official-website contacts come from the page ALREADY fetched by the
  // permitted pinned audit — no second request, no search API, no inference.
  // The audited URL must be the official domain (enforced by
  // discoverAuditedOfficialContacts), so directory info is never attributed
  // to the official website.
  const officialContacts: ContactObservation[] = [];
  for (const { business, outcome } of assessed) {
    if (!outcome?.audited_page || !business.website_url) continue;
    try {
      officialContacts.push(
        ...discoverAuditedOfficialContacts({
          lead_id: business.provider_record_id,
          business_name: business.business_name,
          official_url: business.website_url,
          audited_url: outcome.audited_page.url,
          page_text: outcome.audited_page.public_page_text,
          observed_at: outcome.audited_page.observed_at,
          country: business.country,
        }),
      );
    } catch { /* official page contact extraction failed: skip */ }
  }

  // Primary contacts come from every provider that returned them (Serper
  // snippets, OSM tags, Scrapling official-domain pages, official website).
  // Conflicts are preserved: mergeContacts keeps one observation per
  // (lead, kind, value) but never collapses distinct values for the same kind.
  const allPrimaryContacts = [...providerContacts, ...observations, ...officialContacts];
  let merged_contacts = mergeContacts(allPrimaryContacts);

  // Per-business contact research status before any Vibe fallback.
  const contactStatusByLead = new Map<string, ContactResearchStatus>();
  for (const business of unique) {
    const contacts = merged_contacts.filter((c) => c.lead_id === business.provider_record_id);
    if (contacts.length > 0) {
      contactStatusByLead.set(business.provider_record_id, hasContactConflict(contacts)
        ? "conflicting_contact_evidence"
        : "found_not_verified");
    } else {
      // No contacts for this business: a provider covering its source agent
      // failed → discovery failed; otherwise research is incomplete.
      const providerFailed = results.some((p) => p.status === "failure"
        && p.provider === business.source_agent);
      contactStatusByLead.set(business.provider_record_id, providerFailed ? "contact_discovery_failed"
        : "contact_research_incomplete");
    }
  }

  // Vibe Prospecting fallback: only when primary discovery left required
  // contact fields incomplete and a callable provider port is injected.
  // No genuine provider implementation exists in this repository, so without
  // an injected port the external fallback is explicitly unavailable.
  let vibe_fallback: DiscoveryJobOutput["vibe_fallback"] = "provider_contract_missing";
  const fallbackNeeded = unique.some((b) => {
    const status = contactStatusByLead.get(b.provider_record_id);
    return status === "contact_research_incomplete" || status === "contact_discovery_failed"
      || status === "no_public_contact_after_research";
  });
  if (input.vibe_fallback) {
    if (!fallbackNeeded) {
      vibe_fallback = "skipped";
    } else {
      try {
        const fallbackObservations: ContactObservation[] = [];
        for (const business of unique) {
          const status = contactStatusByLead.get(business.provider_record_id);
          if (!status || status === "found_not_verified" || status === "conflicting_contact_evidence")
            continue; // primary results already present: do not overwrite
          const domain = business.website_url ? new URL(business.website_url).hostname.replace(/^www\./, "") : "";
          if (!domain) continue;
          const lookedUp = await input.vibe_fallback.lookup({
            business_name: business.business_name,
            domain,
            maximum_cost: 10,
          });
          for (const o of lookedUp) {
            fallbackObservations.push({ ...o, lead_id: business.provider_record_id });
          }
        }
        if (fallbackObservations.length) {
          merged_contacts = mergeContacts([...allPrimaryContacts, ...fallbackObservations]);
          for (const business of unique) {
            const contacts = merged_contacts.filter((c) => c.lead_id === business.provider_record_id);
            if (contacts.length > 0) {
              contactStatusByLead.set(business.provider_record_id, hasContactConflict(contacts)
                ? "conflicting_contact_evidence"
                : "found_not_verified");
            }
          }
        }
        vibe_fallback = "used";
      } catch {
        // Vibe failure preserves primary results; never invents contacts.
        vibe_fallback = "failed";
      }
    }
  }

  const qualification_decisions = assessed.map(({ business, outcome }) =>
    decideForBusiness(
      business,
      merged_contacts.filter((c) => c.lead_id === business.provider_record_id),
      outcome,
      contactStatusByLead.get(business.provider_record_id) ?? "contact_research_incomplete",
    ),
  );

  const contact_research_statuses: Record<ContactResearchStatus, number> = {
    found_not_verified: 0, contact_incomplete: 0, contact_research_incomplete: 0,
    contact_discovery_failed: 0, conflicting_contact_evidence: 0, no_public_contact_after_research: 0,
  };
  for (const d of qualification_decisions) {
    contact_research_statuses[d.contact_research_status]++;
  }

  return {
    run_id: input.run_id,
    providers: results,
    raw_businesses,
    deduplicated_businesses: unique,
    merged_contacts,
    qualification_decisions,
    total_discovered: raw_businesses.length,
    total_unique: unique.length,
    total_qualified: qualification_decisions.filter(
      (d) => d.status === "qualified" || d.status === "contact_incomplete",
    ).length,
    vibe_fallback,
    contact_research_statuses,
  };
}

// Preserves conflicting values for the same contact kind rather than choosing
// one: after mergeContacts, distinct values for a kind remain separate rows.
function hasContactConflict(contacts: ContactObservation[]): boolean {
  const byKind = new Map<string, Set<string>>();
  for (const c of contacts) {
    const values = byKind.get(c.kind) ?? new Set<string>();
    values.add(c.value.toLocaleLowerCase("en"));
    byKind.set(c.kind, values);
  }
  return [...byKind.values()].some((values) => values.size > 1);
}
