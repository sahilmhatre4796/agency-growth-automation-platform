import { describe, expect, test, vi } from "vitest";
import {
  deduplicateBusinesses,
  mergeContacts,
  runDiscoveryJob,
  type DiscoveredBusiness,
  type DiscoveryJobInput,
} from "../packages/server/discovery-coordinator.ts";
import type { ScraplingReport } from "../packages/server/scrapling-adapter.ts";
import type { ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";

const leadId = "00000000-0000-4000-8000-000000000071";
const otherLeadId = "00000000-0000-4000-8000-000000000072";

function makeBusiness(overrides: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    provider_record_id: leadId,
    business_name: "Bob's Plumbing",
    website_url: "https://bobsplumbing.com",
    website_status: null,
    website_problem: null,
    operational_need: null,
    serviceMatches: [],
    city: "Phoenix",
    state_region: "AZ",
    country: "USA",
    location_source: "search_target",
    source_url: "https://serper.example/listing-1",
    observed_at: "2026-11-05T00:00:00+00:00",
    evidence: [],
    source_agent: "osm",
    ...overrides,
  };
}

function makeInput(overrides: Partial<DiscoveryJobInput> = {}): DiscoveryJobInput {
  return {
    org_id: "00000000-0000-4000-8000-000000000001",
    run_id: "00000000-0000-4000-8000-000000000091",
    industry: "plumber",
    city: "Phoenix",
    region: "AZ",
    country: "USA",
    requested_count: 10,
    osm: { discover: async () => ({ businesses: [] }) },
    serper: { search: async () => ({ businesses: [] }) },
    scrapling: { fetch: async () => ({ report: null }) },
    env: {},
    ...overrides,
  };
}

// Assessed outcome for tests that need a conclusive website assessment.
const workingAssessment = {
  assess: async () => ({
    status: "VERIFIED_WORKING" as const,
    website_status: "VERIFIED_WORKING",
    website_problem: null,
    official_url: "https://bobsplumbing.com",
    observed_at: "2026-11-05T00:00:00+00:00",
    method: "pinned_audit",
    reason: "Permitted pinned audit observed HTTP 200.",
    evidence_url: "https://bobsplumbing.com",
  }),
};

function makeReport(overrides: Partial<ScraplingReport> = {}): ScraplingReport {
  return {
    scraper: "scrapling",
    lead_id: leadId,
    business_name: "Bob's Plumbing",
    official_url: "https://bobsplumbing.com",
    fetched_at: "2026-11-05T00:00:00+00:00",
    pages: [
      {
        url: "https://bobsplumbing.com/contact",
        title: "Contact Bob's Plumbing",
        observed_at: "2026-11-05T00:00:00+00:00",
        text: "Email info@bobsplumbing.com for a quote. Call us today.",
        http_status: 200,
        discovered_from: "seed",
      },
    ],
    errors: [],
    ...overrides,
  };
}

describe("deduplicateBusinesses", () => {
  test("merges on canonical domain and keeps merged evidence in the unique record", () => {
    const a = makeBusiness({
      evidence: [{ kind: "serper", claim: "listing A", url: "https://serper.example/a", confidence: 0.6 }],
    });
    const b = makeBusiness({
      provider_record_id: otherLeadId,
      business_name: "Bob Plumbing LLC", // different name, same domain
      source_agent: "serper",
      evidence: [
        { kind: "serper", claim: "listing A", url: "https://serper.example/a", confidence: 0.6 },
        { kind: "serper", claim: "listing B", url: "https://serper.example/b", confidence: 0.7 },
      ],
    });
    const { unique, duplicates } = deduplicateBusinesses([a, b]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(unique[0].evidence).toHaveLength(2); // deduplicated evidence, both sources present
    expect(unique[0].evidence.map((e) => e.url)).toEqual([
      "https://serper.example/a",
      "https://serper.example/b",
    ]);
  });

  test("does not merge similar-but-not-identical names without a shared domain", () => {
    const a = makeBusiness({ website_url: null, business_name: "Phoenix Plumbers Co" });
    const b = makeBusiness({ website_url: null, business_name: "Phoenix Plumbers Company" });
    const { unique, duplicates } = deduplicateBusinesses([a, b]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });
});

describe("mergeContacts", () => {
  test("keeps one observation per lead/kind/value with the higher confidence", () => {
    const base: ContactObservation = {
      lead_id: leadId,
      kind: "email",
      value: "info@bobsplumbing.com",
      source_provider: "scrapling",
      source_url: "https://bobsplumbing.com/contact",
      observed_at: "2026-11-05T00:00:00+00:00",
      evidence_excerpt: "Email info@bobsplumbing.com for a quote",
      confidence: 0.7,
    };
    const stronger: ContactObservation = { ...base, confidence: 0.9, source_url: "https://bobsplumbing.com/about" };
    const other: ContactObservation = { ...base, lead_id: otherLeadId };
    const merged = mergeContacts([base, stronger, other]);
    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.lead_id === leadId)?.confidence).toBe(0.9);
  });
});

describe("runDiscoveryJob", () => {
  test("preserves serper results when the OSM provider fails and reports the failure", async () => {
    const input = makeInput({
      osm: { discover: async () => { throw new Error("osm unavailable"); } },
      serper: { search: async () => ({ businesses: [makeBusiness({ source_agent: "serper" })] }) },
    });
    const out = await runDiscoveryJob(input);
    const osm = out.providers.find((p) => p.provider === "osm");
    const serper = out.providers.find((p) => p.provider === "serper");
    expect(osm?.status).toBe("failure");
    expect(osm?.error).toContain("osm unavailable");
    expect(serper?.status).toBe("success");
    expect(out.total_unique).toBe(1);
  });

  test("reports a partial provider result when a provider returns businesses plus an error", async () => {
    const input = makeInput({
      osm: { discover: async () => ({ businesses: [makeBusiness()], error: "page 2 rate-limited" }) },
    });
    const out = await runDiscoveryJob(input);
    const osm = out.providers.find((p) => p.provider === "osm");
    expect(osm?.status).toBe("partial");
    expect(osm?.error).toContain("rate-limited");
    expect(out.total_unique).toBe(1);
  });

  test("never calls Scrapling when ENABLE_SCRAPLING is off", async () => {
    const fetch = vi.fn(async () => ({ report: makeReport() }));
    const input = makeInput({
      env: {},
      osm: { discover: async () => ({ businesses: [makeBusiness()] }) },
      scrapling: { fetch },
    });
    const out = await runDiscoveryJob(input);
    expect(fetch).not.toHaveBeenCalled();
    expect(out.providers.find((p) => p.provider === "scrapling")?.status).toBe("skipped");
    expect(out.merged_contacts).toHaveLength(0);
  });

  test("extracts contacts from a valid Scrapling report when enabled", async () => {
    const fetch = vi.fn(async () => ({ report: makeReport() }));
    const input = makeInput({
      env: { ENABLE_SCRAPLING: "true" },
      osm: { discover: async () => ({ businesses: [makeBusiness()] }) },
      scrapling: { fetch },
    });
    const out = await runDiscoveryJob(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.providers.find((p) => p.provider === "scrapling")?.status).toBe("success");
    expect(out.merged_contacts).toHaveLength(1);
    expect(out.merged_contacts[0]).toMatchObject({
      lead_id: leadId,
      kind: "email",
      value: "info@bobsplumbing.com",
      source_provider: "scrapling",
    });
  });

  test("records a Scrapling failure when the report identity does not match", async () => {
    const input = makeInput({
      env: { ENABLE_SCRAPLING: "true" },
      osm: { discover: async () => ({ businesses: [makeBusiness()] }) },
      scrapling: { fetch: async () => ({ report: makeReport({ lead_id: otherLeadId }) }) },
    });
    const out = await runDiscoveryJob(input);
    const scrapling = out.providers.find((p) => p.provider === "scrapling");
    expect(scrapling?.status).toBe("failure");
    expect(scrapling?.error).toContain("SCRAPLING_REPORT_IDENTITY_MISMATCH");
    expect(out.merged_contacts).toHaveLength(0);
  });

  test("does not qualify a lead with unknown website status and no independent evidence", async () => {
    const input = makeInput({
      osm: {
        discover: async () => ({
          businesses: [makeBusiness({ website_url: null, website_status: null })],
        }),
      },
    });
    const out = await runDiscoveryJob(input);
    expect(out.qualification_decisions).toHaveLength(1);
    const decision = out.qualification_decisions[0];
    expect(decision.status).toBe("not_qualified");
    if (decision.status === "not_qualified") {
      expect(decision.qualification.qualified).toBe(false);
      expect(decision.qualification.path).toBeNull();
    }
    expect(out.total_qualified).toBe(0);
  });

  test("qualifies a verified service gap but never claims a verified contact", async () => {
    const input = makeInput({
      env: { ENABLE_SCRAPLING: "true" },
      osm: {
        discover: async () => ({
          businesses: [
            makeBusiness({
              serviceMatches: [
                {
                  service_key: "service_01",
                  service_name: "Website",
                  status: "verified_gap",
                  reason: "Evidence-supported website gap",
                  evidence_ids: ["https://serper.example/listing-1"],
                  confidence: 0.9,
                },
              ],
            }),
          ],
        }),
      },
      scrapling: { fetch: async () => ({ report: makeReport() }) },
      assessment: workingAssessment,
    });
    const out = await runDiscoveryJob(input);
    const decision = out.qualification_decisions[0];
    expect(decision.status).toBe("qualified");
    if (decision.status === "qualified") {
      expect(decision.contact_status).toBe("unverified"); // Reacher not wired: never "valid"
      expect(decision.next_action).toBe("verify_contacts_before_outreach");
    }
    expect(out.total_qualified).toBe(1);
  });

  test("qualified lead with no contacts reports contact_incomplete", async () => {
    const input = makeInput({
      osm: {
        discover: async () => ({
          businesses: [
            makeBusiness({
              serviceMatches: [
                {
                  service_key: "service_01",
                  service_name: "Website",
                  status: "verified_gap",
                  reason: "Evidence-supported website gap",
                  evidence_ids: ["https://serper.example/listing-1"],
                  confidence: 0.9,
                },
              ],
            }),
          ],
        }),
      },
      assessment: workingAssessment,
    });
    const out = await runDiscoveryJob(input);
    const decision = out.qualification_decisions[0];
    expect(decision.status).toBe("contact_incomplete");
    expect(out.total_qualified).toBe(1); // qualification succeeded; contacts did not
  });
});
