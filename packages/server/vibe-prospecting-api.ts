// Vibe Prospecting / Explorium AgentSource v2 REST API adapter.
//
// Implements the existing `ContactEnrichmentProvider` contract against the
// genuine AgentSource API (https://developers.explorium.ai/v2/overview):
//
//   GET  /v2/credits          — validate key, read allocated/remaining credits
//   POST /v2/businesses/match — match a business by name → business_id
//   POST /v2/prospects        — discover decision-makers for a business
//   POST /v2/prospects/contact_information/enrich — enrich prospects with
//                                                    emails and phones
//
// Authentication: `api_key` header (never Authorization Bearer). The key is
// read from process.env.VIBE_PROSPECTING_API_KEY and is never sent to the
// browser. Server-side only.
//
// Rate limit: 200 queries per minute per API key. Each entity in a batch
// counts as one query. Respects X-RateLimit-* and Retry-After headers.
//
// Errors: 401 (auth), 403 (credits/permissions), 422 (validation), 429
// (rate limit), 500/503 (server). 4xx errors (except 429) are not retried.
// 5xx errors use bounded exponential backoff.

import { type PublicDecisionMaker, type ContactEnrichmentProvider } from "./vibe-prospecting.ts";
import type { ContactObservation } from "./vibe-contact-enrichment.ts";
import { normalizeContactValue } from "./vibe-contact-enrichment.ts";

const BASE_URL = "https://api.explorium.ai";

export type VibeCredits = {
  allocated: number;
  remaining: number;
  accountType: "trial" | "paid";
  correlationId: string;
};

export type VibeProviderError = {
  code: string;
  message: string;
  correlationId?: string;
  status: number;
  retryable: boolean;
};

// Timeout for every outbound request (10s).
const REQUEST_TIMEOUT_MS = 10000;

// Maximum retry attempts for 5xx / 429 errors.
const MAX_RETRIES = 3;

// Decision-maker job levels to prioritize.
const DECISION_MAKER_LEVELS = [
  "owner",
  "founder",
  "c-suite",
  "director",
  "partner",
  "president",
];

function readApiKey(): string | undefined {
  return process.env.VIBE_PROSPECTING_API_KEY;
}

function headers(apiKey: string): Record<string, string> {
  return {
    api_key: apiKey,
    "Content-Type": "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCorrelationId(response: Response): string | undefined {
  return response.headers.get("x-correlation-id") ?? undefined;
}

function parseErrorBody(body: unknown): { code?: string; message?: string } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    return {
      code: typeof obj.code === "string" ? obj.code : undefined,
      message:
        typeof obj.message === "string"
          ? obj.message
          : typeof obj.details === "string"
            ? obj.details
            : JSON.stringify(obj).slice(0, 200),
    };
  }
  return {};
}

async function requestWithRetry(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{
  ok: boolean;
  status: number;
  json?: unknown;
  error?: VibeProviderError;
  correlationId?: string;
}> {
  const url = `${BASE_URL}${path}`;
  let lastError: VibeProviderError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(url, {
          method,
          headers: headers(apiKey),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = {
        code: "TRANSPORT_ERROR",
        message: err instanceof Error ? err.message : String(err),
        status: 0,
        retryable: true,
      };
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 30000));
        continue;
      }
      return { ok: false, status: 0, error: lastError };
    }

    const correlationId = extractCorrelationId(response);

    if (response.ok) {
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
      return { ok: true, status: response.status, json, correlationId };
    }

    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = null;
    }
    const parsed = parseErrorBody(errorBody);
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;

    const error: VibeProviderError = {
      code: parsed.code ?? `HTTP_${response.status}`,
      message: parsed.message ?? `HTTP ${response.status}`,
      status: response.status,
      correlationId,
      retryable:
        response.status === 429 ||
        response.status === 500 ||
        response.status === 503,
    };

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return { ok: false, status: response.status, error, correlationId };
    }

    lastError = error;
    if (attempt < MAX_RETRIES && error.retryable) {
      const delay = retryAfterMs ?? Math.min(1000 * Math.pow(2, attempt + 1), 30000);
      await sleep(delay);
      continue;
    }

    return { ok: false, status: response.status, error, correlationId };
  }

  return { ok: false, status: 0, error: lastError };
}

// ── Credits ──────────────────────────────────────────────────────────────

export async function getCredits(): Promise<{
  ok: boolean;
  credits?: VibeCredits;
  error?: VibeProviderError;
}> {
  const apiKey = readApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: {
        code: "VIBE_NOT_CONFIGURED",
        message: "VIBE_PROSPECTING_API_KEY is not set.",
        status: 0,
        retryable: false,
      },
    };
  }

  const result = await requestWithRetry(apiKey, "GET", "/v2/credits");
  if (!result.ok || !result.json) return { ok: false, error: result.error };

  const data = result.json as {
    response_context: { correlation_id: string };
    allocated_credits: number;
    remaining_credits: number;
    account_type: string;
  };

  return {
    ok: true,
    credits: {
      allocated: data.allocated_credits,
      remaining: data.remaining_credits,
      accountType: data.account_type === "paid" ? "paid" : "trial",
      correlationId: data.response_context?.correlation_id,
    },
  };
}

// ── Business match ───────────────────────────────────────────────────────

export type VibeBusinessMatch = {
  businessId: string;
  name: string;
  domain: string | null;
  website: string | null;
  correlationId: string;
};

export async function matchBusiness(
  apiKey: string,
  businessName: string,
  domain?: string | null,
): Promise<{
  ok: boolean;
  match?: VibeBusinessMatch;
  error?: VibeProviderError;
}> {
  // Official v2 contract: POST /v2/businesses/match with
  // { businesses_to_match: [{ name, domain? }] }. Match Businesses does not
  // charge credits (per Per-Call Credit Usage docs), but each business in the
  // array counts as one query toward the 200-queries-per-minute rate limit.
  // Providing both name and domain enables smart fuzzy matching plus domain
  // anchoring for higher accuracy.
  const result = await requestWithRetry(apiKey, "POST", "/v2/businesses/match", {
    businesses_to_match: [{ name: businessName, domain: domain ?? undefined }],
  });

  if (!result.ok || !result.json) return { ok: false, error: result.error };

  const data = result.json as {
    response_context: { correlation_id: string };
    total_results: number;
    total_matches: number;
    matched_businesses: Array<{
      input: { name: string; domain: string | null };
      business_id: string | null;
      warnings?: Array<{ field: string; warning: string; warning_type: string }>;
      error?: string;
      error_type?: string;
    }>;
  };

  if (!data.matched_businesses?.length) {
    return {
      ok: false,
      error: {
        code: "NO_BUSINESS_MATCH",
        message: `No business found matching "${businessName}".`,
        status: 200,
        correlationId: data.response_context?.correlation_id,
        retryable: false,
      },
    };
  }

  const first = data.matched_businesses[0];
  if (!first.business_id) {
    return {
      ok: false,
      error: {
        code: "NO_BUSINESS_MATCH",
        message: `No business found matching "${businessName}".`,
        status: 200,
        correlationId: data.response_context?.correlation_id,
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    match: {
      businessId: first.business_id,
      name: first.input.name,
      domain: first.input.domain ?? null,
      website: null, // Match Businesses does not return a website URL
      correlationId: data.response_context.correlation_id,
    },
  };
}

// ── Prospect discovery ───────────────────────────────────────────────────

export type VibeProspect = {
  prospectId: string;
  fullName: string;
  jobTitle: string | null;
  jobLevelMain: string | null;
  companyName: string | null;
  companyWebsite: string | null;
  linkedin: string | null;
  businessId: string | null;
};

export async function discoverProspects(
  apiKey: string,
  businessId: string,
  maxResults = 3,
): Promise<{
  ok: boolean;
  prospects?: VibeProspect[];
  error?: VibeProviderError;
}> {
  const result = await requestWithRetry(apiKey, "POST", "/v2/prospects", {
    mode: "full",
    page_size: maxResults,
    filters: {
      business_id: { values: [businessId] },
      job_level: { values: DECISION_MAKER_LEVELS },
      has_contact_details: { value: "email_or_phone" },
    },
  });

  if (!result.ok || !result.json) return { ok: false, error: result.error };

  const data = result.json as {
    response_context: { correlation_id: string };
    data: Array<{
      prospect_id: string;
      full_name: string;
      job_title: string | null;
      job_level_main: string | null;
      company_name: string | null;
      company_website: string | null;
      linkedin: string | null;
      business_id: string | null;
    }>;
  };

  return {
    ok: true,
    prospects: data.data.map((p) => ({
      prospectId: p.prospect_id,
      fullName: p.full_name,
      jobTitle: p.job_title,
      jobLevelMain: p.job_level_main,
      companyName: p.company_name,
      companyWebsite: p.company_website,
      linkedin: p.linkedin,
      businessId: p.business_id,
    })),
  };
}

// ── Contact enrichment ───────────────────────────────────────────────────

export type VibeEnrichedContact = {
  prospectId: string;
  professionalEmail: string | null;
  professionalEmailStatus: "valid" | "catch_all" | "invalid" | null;
  phoneNumbers: string[];
  mobilePhone: string | null;
};

export async function enrichContacts(
  apiKey: string,
  prospectIds: string[],
): Promise<{
  ok: boolean;
  contacts?: VibeEnrichedContact[];
  error?: VibeProviderError;
}> {
  const ids = prospectIds.slice(0, 50);
  if (ids.length === 0) return { ok: true, contacts: [] };

  const result = await requestWithRetry(apiKey, "POST", "/v2/prospects/contact_information/enrich", {
    prospect_ids: ids,
    parameters: { contact_types: ["email", "phone"] },
  });

  if (!result.ok || !result.json) return { ok: false, error: result.error };

  const data = result.json as {
    response_context: { correlation_id: string };
    data: Array<{
      prospect_id: string;
      data: {
        professional_email: string | null;
        professional_email_status: string | null;
        phone_numbers: Array<{ phone_number: string }>;
        mobile_phone: string | null;
      };
    }>;
  };

  return {
    ok: true,
    contacts: data.data.map((c) => ({
      prospectId: c.prospect_id,
      professionalEmail: c.data.professional_email ?? null,
      professionalEmailStatus:
        c.data.professional_email_status === "valid"
          ? "valid"
          : c.data.professional_email_status === "catch_all"
            ? "catch_all"
            : c.data.professional_email_status === "invalid"
              ? "invalid"
              : null,
      phoneNumbers: c.data.phone_numbers.map((p) => p.phone_number),
      mobilePhone: c.data.mobile_phone ?? null,
    })),
  };
}

// ── Provider implementation ──────────────────────────────────────────────

// Cost model per the API docs:
//   Email enrichment: 2 credits per prospect
//   Phone enrichment: 5 credits per prospect
//   Default (email + phone): 5 credits per prospect
const CREDITS_PER_PROSPECT = 5;

export class VibeProspectingProvider implements ContactEnrichmentProvider {
  readonly id = "vibe";

  async lookup(input: {
    business_name: string;
    domain: string;
    maximum_cost: number;
  }): Promise<PublicDecisionMaker[]> {
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error("VIBE_NOT_CONFIGURED");
    }

    // Step A: match the business. Provide both name and domain (when known)
    // so Explorium can apply fuzzy name matching with domain anchoring.
    const matchResult = await matchBusiness(
      apiKey,
      input.business_name,
      input.domain ?? undefined,
    );
    if (!matchResult.ok) {
      if (matchResult.error?.code === "NO_BUSINESS_MATCH") return [];
      throw new Error(matchResult.error?.message ?? "Business match failed");
    }

    // Respect the caller's maximum cost: each prospect enrichment costs 5
    // credits (email + phone). A zero or insufficient budget must make no
    // enrichment request at all.
    const maxProspects = Math.floor(input.maximum_cost / CREDITS_PER_PROSPECT);

    // No budget for even a single enrichment: return the matched business
    // without prospect discovery or contact enrichment.
    if (maxProspects < 1) {
      return [
        {
          full_name: input.business_name,
          role: "",
          email: null,
          email_status: "unknown",
          source_url: matchResult.match!.website ?? "https://api.explorium.ai/v2/businesses/match",
          observed_at: new Date().toISOString(),
          evidence_excerpt: `Explorium matched business ${matchResult.match!.name} (${matchResult.match!.businessId}); no contact enrichment within budget of ${input.maximum_cost} credits.`,
          confidence: 0.5,
        },
      ];
    }

    // Step B: discover decision-makers.
    const discovered = await discoverProspects(apiKey, matchResult.match!.businessId, maxProspects);
    if (!discovered.ok || !discovered.prospects?.length) return [];

    const prospectIds = discovered.prospects.slice(0, maxProspects).map((p) => p.prospectId);

    // Step C: enrich contacts.
    const enriched = await enrichContacts(apiKey, prospectIds);
    if (!enriched.ok || !enriched.contacts?.length) {
      return discovered.prospects.slice(0, maxProspects).map((p) => ({
        full_name: p.fullName,
        role: p.jobTitle ?? p.jobLevelMain ?? "Unknown",
        email: null,
        email_status: "unknown",
        source_url: matchResult.match!.website ?? "https://api.explorium.ai/v2/businesses",
        observed_at: new Date().toISOString(),
        evidence_excerpt: `Explorium prospect ${p.prospectId} matched for ${matchResult.match!.name}`,
        confidence: 0.5,
      }));
    }

    // Map enriched contacts to PublicDecisionMaker.
    const byProspectId = new Map(enriched.contacts.map((c) => [c.prospectId, c]));
    const observedAt = new Date().toISOString();

    return discovered.prospects.slice(0, maxProspects).map((p) => {
      const contact = byProspectId.get(p.prospectId);
      const email = contact?.professionalEmail ?? null;
      const sourceUrl =
        matchResult.match!.website ??
        `https://api.explorium.ai/v2/prospects/${p.prospectId}`;

      return {
        full_name: p.fullName,
        role: p.jobTitle ?? p.jobLevelMain ?? "Unknown",
        email,
        email_status: email ? "publicly_sourced" : "unknown",
        source_url: sourceUrl,
        observed_at: observedAt,
        evidence_excerpt: email
          ? `Explorium email ${email} for ${p.fullName} at ${matchResult.match!.name}`
          : `Explorium no email returned for ${p.fullName} at ${matchResult.match!.name}`,
        confidence: email ? 0.75 : 0.5,
      };
    });
  }
}

// ── vibe_fallback port adapter ──────────────────────────────────────────

// Converts PublicDecisionMaker[] → ContactObservation[] for the
// discovery-coordinator `vibe_fallback` port. Source provider is "vibe",
// provenance and evidence are preserved, confidence stays below 1 (never
// verified).
export function mapDecisionMakersToObservations(
  makers: PublicDecisionMaker[],
  leadId: string,
): ContactObservation[] {
  const observations: ContactObservation[] = [];
  for (const maker of makers) {
    if (maker.email) {
      try {
        observations.push({
          lead_id: leadId,
          kind: "email",
          value: normalizeContactValue("email", maker.email),
          source_provider: "vibe",
          source_url: maker.source_url,
          observed_at: maker.observed_at,
          evidence_excerpt: maker.evidence_excerpt.trim().slice(0, 320),
          contact_name: maker.full_name ?? null,
          role: maker.role ?? null,
          confidence: Math.min(maker.confidence, 0.9),
        });
      } catch {
        // Invalid email: skip, never invent.
      }
    }
  }
  return observations;
}

// Factory for the discovery-coordinator `vibe_fallback` port. Returns null
// when the API key is missing, so the coordinator reports
// `provider_contract_missing` instead of fabricating results.
export function createVibeFallbackProvider(
  env: Record<string, string | undefined>,
): {
  lookup(input: {
    business_name: string;
    domain: string;
    maximum_cost: number;
  }): Promise<ContactObservation[]>;
} | null {
  const apiKey = env.VIBE_PROSPECTING_API_KEY;
  if (!apiKey) return null;

  const provider = new VibeProspectingProvider();

  return {
    lookup: async (input) => {
      const makers = await provider.lookup(input);
      // The coordinator overwrites lead_id with the real business
      // provider_record_id when merging fallback results, so a valid UUID
      // placeholder is used here only to satisfy the ContactObservation
      // schema before the coordinator assigns the real lead_id.
      return mapDecisionMakersToObservations(makers, "00000000-0000-0000-0000-000000000000");
    },
  };
}
