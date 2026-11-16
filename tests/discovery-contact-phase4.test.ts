import { describe, expect, test, vi } from "vitest";
import {
  runDiscoveryJob,
  type DiscoveryJobInput,
  type DiscoveredBusiness,
} from "../packages/server/discovery-coordinator.ts";
import {
  createOsmProvider,
  createSerperProvider,
} from "../packages/server/discovery-providers.ts";
import { SearchAdapter, SearchHit } from "../packages/server/research.ts";
import { type OsmObservation } from "../packages/server/harvey-osm.ts";
import type { ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";

const leadId = "00000000-0000-4000-8000-000000000071";
const geo = { latitude: 33.45, longitude: -112.07, radiusKm: 5 };

function makeBusiness(overrides: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    provider_record_id: leadId,
    business_name: "Acme Plumbing",
    website_url: "https://acmeplumbing.com/",
    website_status: null,
    website_problem: null,
    operational_need: null,
    serviceMatches: [],
    city: "Phoenix",
    state_region: "AZ",
    country: "United States",
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
    country: "United States",
    requested_count: 10,
    osm: { discover: async () => ({ businesses: [] }) },
    serper: { search: async () => ({ businesses: [] }) },
    scrapling: { fetch: async () => ({ report: null }) },
    env: {},
    ...overrides,
  };
}

const serviceGap = [
  {
    service_key: "service_01",
    service_name: "Website",
    status: "verified_gap" as const,
    reason: "Evidence-supported website gap",
    evidence_ids: ["https://serper.example/listing-1"],
    confidence: 0.9,
  },
];

const workingAssessment = {
  assess: async () => ({
    status: "VERIFIED_WORKING" as const,
    website_status: "VERIFIED_WORKING",
    website_problem: null,
    official_url: "https://acmeplumbing.com/",
    observed_at: "2026-11-05T00:00:00+00:00",
    method: "pinned_audit",
    reason: "Permitted pinned audit observed HTTP 200.",
    evidence_url: "https://acmeplumbing.com/",
  }),
};

function serperHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    title: "Acme Plumbing | Phoenix",
    url: "https://acmeplumbing.com/",
    content: "Acme Plumbing, Phoenix, United States. Contact info@acmeplumbing.com or call +1 555 123 4567.",
    score: 1,
    ...overrides,
  };
}

function fakeSerperAdapter(hits: SearchHit[]): SearchAdapter {
  return {
    search: vi.fn(async () => hits),
    extract: vi.fn(async () => []),
  };
}

function osmObservation(overrides: Partial<OsmObservation> = {}): OsmObservation {
  return {
    name: "Acme Plumbing",
    proposed_website_url: "https://acmeplumbing.com/",
    provider_record_id: "osm:node/9",
    source_url: "https://www.openstreetmap.org/node/9",
    observed_at: "2026-11-05T00:00:00+00:00",
    category: "plumber",
    latitude: 33.45,
    longitude: -112.07,
    contacts: [],
    ...overrides,
  };
}

function osmObservationWithContacts(
  contacts: Array<{ kind: string; value: string; evidence_excerpt: string }>,
): OsmObservation {
  return osmObservation({ contacts: contacts as OsmObservation["contacts"] });
}

describe("Phase 4: primary contact discovery from Serper and OSM", () => {
  test("Serper snippet contacts are mapped with source_provider 'serper' and are never verified", async () => {
    const serper = createSerperProvider({ adapter: fakeSerperAdapter([serperHit()]), observedAt: "2026-11-05T00:00:00+00:00" });
    const job = makeInput({
      osm: { discover: async () => ({ businesses: [] }) },
      serper,
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    const serperContacts = out.merged_contacts.filter((c) => c.source_provider === "serper");
    expect(serperContacts.length).toBeGreaterThan(0);
    for (const c of serperContacts) {
      expect(c.source_provider).toBe("serper");
      expect(c.confidence).toBeLessThan(1);
      expect(c.evidence_excerpt).toContain(c.value);
    }
    const decision = out.qualification_decisions[0];
    if (decision.status === "qualified") {
      expect(decision.contact_status).toBe("unverified");
      expect(decision.contact_research_status).toBe("found_not_verified");
    }
    expect(out.contact_research_statuses.found_not_verified).toBeGreaterThanOrEqual(1);
  });

  test("OSM contact tags are mapped with provenance 'osm', never 'harvey'", async () => {
    const contacts: OsmObservation["contacts"] = [
      { kind: "email", value: "info@acmeplumbing.com", evidence_excerpt: "email=info@acmeplumbing.com" },
      { kind: "phone", value: "+1 555 123 4567", evidence_excerpt: "phone=+1 555 123 4567" },
    ];
    const collect = vi.fn(async () => [osmObservationWithContacts(contacts)]);
    const job = makeInput({
      osm: createOsmProvider({ collector: { collect }, geo, observedAt: "2026-11-05T00:00:00+00:00" }),
      serper: { search: async () => ({ businesses: [] }) },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    const osmContacts = out.merged_contacts.filter((c) => c.source_provider === "osm");
    expect(osmContacts.length).toBe(2);
    expect(out.merged_contacts.some((c) => c.source_provider === "harvey")).toBe(false);
    for (const c of osmContacts) {
      expect(c.source_provider).toBe("osm");
      expect(c.source_url).toBe("https://www.openstreetmap.org/node/9");
      expect(c.confidence).toBeLessThan(1);
    }
    const decision = out.qualification_decisions[0];
    if (decision.status === "qualified") {
      expect(decision.contact_research_status).toBe("found_not_verified");
    }
  });

  test("malformed Serper and OSM contacts are skipped, never invented", async () => {
    const osmBusinesses = [makeBusiness({ source_agent: "osm" })];
    const job = makeInput({
      osm: { discover: async () => ({ businesses: osmBusinesses }) },
      serper: createSerperProvider({
        adapter: fakeSerperAdapter([
          serperHit({ content: "Some other business, Phoenix, United States. Call 555-1234.", url: "https://other.example/" }),
        ]),
      }),
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    const valid = out.merged_contacts.filter((c) => c.source_provider === "serper");
    expect(valid).toHaveLength(0);
    const decision = out.qualification_decisions[0];
    expect(decision.contact_research_status).toBe("contact_research_incomplete");
  });

  test("conflicting contacts from multiple sources are preserved, not collapsed", async () => {
    const osmContacts: OsmObservation["contacts"] = [
      { kind: "email", value: "info@acmeplumbing.com", evidence_excerpt: "email=info@acmeplumbing.com" },
      { kind: "email", value: "billing@acmeplumbing.com", evidence_excerpt: "email=billing@acmeplumbing.com" },
    ];
    const collect = vi.fn(async () => [osmObservationWithContacts(osmContacts)]);
    const job = makeInput({
      osm: createOsmProvider({ collector: { collect }, geo }),
      serper: { search: async () => ({ businesses: [] }) },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    const emails = out.merged_contacts.filter((c) => c.kind === "email");
    expect(emails.length).toBe(2); // both conflicting values preserved
    expect(out.contact_research_statuses.conflicting_contact_evidence).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase 4: Vibe fallback gating and honest unavailability", () => {
  test("no Vibe provider contract → fallback reports provider_contract_missing", async () => {
    const osmBusinesses = [makeBusiness({ serviceMatches: serviceGap, source_agent: "osm" })];
    const job = makeInput({
      osm: { discover: async () => ({ businesses: osmBusinesses }) },
      serper: { search: async () => ({ businesses: [] }) },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    expect(out.vibe_fallback).toBe("provider_contract_missing");
    expect(out.merged_contacts).toEqual([]);
  });

  test("Vibe fallback skipped when primary contacts already complete", async () => {
    const lookup = vi.fn(async () => ([
      { lead_id: leadId, kind: "email", value: "should-not@appear.com", source_provider: "vibe",
        source_url: "https://vibe.example/", observed_at: "2026-11-05T00:00:00+00:00",
        evidence_excerpt: "x should-not@appear.com", confidence: 0.8 },
    ] as ContactObservation[]));
    const collect = vi.fn(async () => [osmObservationWithContacts([
      { kind: "email", value: "info@acmeplumbing.com", evidence_excerpt: "email=info@acmeplumbing.com" },
    ])]);
    const job = makeInput({
      osm: createOsmProvider({ collector: { collect }, geo }),
      serper: { search: async () => ({ businesses: [] }) },
      vibe_fallback: { lookup },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    expect(out.vibe_fallback).toBe("skipped");
    expect(lookup).not.toHaveBeenCalled();
    expect(out.merged_contacts.some((c) => c.value === "should-not@appear.com")).toBe(false);
  });

  test("Vibe fallback runs only when primary contact fields are incomplete", async () => {
    const lookup = vi.fn(async () => ([
      { lead_id: leadId, kind: "phone", value: "+1555010012", source_provider: "vibe",
        source_url: "https://vibe.example/", observed_at: "2026-11-05T00:00:00+00:00",
        evidence_excerpt: "phone +1555010012", confidence: 0.7 },
    ] as ContactObservation[]));
    const osmBusinesses = [makeBusiness({ serviceMatches: serviceGap, source_agent: "osm" })];
    const job = makeInput({
      osm: { discover: async () => ({ businesses: osmBusinesses }) },
      serper: { search: async () => ({ businesses: [] }) },
      vibe_fallback: { lookup },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    expect(out.vibe_fallback).toBe("used");
    expect(lookup).toHaveBeenCalledTimes(1);
    const vibeContacts = out.merged_contacts.filter((c) => c.source_provider === "vibe");
    expect(vibeContacts.length).toBe(1);
    expect(vibeContacts[0].value).toBe("+1555010012");
    expect(vibeContacts[0].confidence).toBeLessThan(1);
  });

  test("Vibe fallback failure preserves primary results", async () => {
    const lookup = vi.fn(async () => { throw new Error("VIBE_TIMEOUT"); });
    const collect = vi.fn(async () => [osmObservationWithContacts([])]);
    const job = makeInput({
      osm: createOsmProvider({ collector: { collect }, geo }),
      serper: { search: async () => ({ businesses: [] }) },
      vibe_fallback: { lookup },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    expect(out.vibe_fallback).toBe("failed");
    expect(out.merged_contacts).toEqual([]);
  });

  test("partial contact results survive a Serper provider failure", async () => {
    const collect = vi.fn(async () => [osmObservationWithContacts([
      { kind: "phone", value: "+1 555 123 4567", evidence_excerpt: "phone=+1 555 123 4567" },
    ])]);
    const job = makeInput({
      osm: createOsmProvider({ collector: { collect }, geo }),
      serper: createSerperProvider({ adapter: {
        search: vi.fn(async () => { throw new Error("SERPER_CREDITS_EXHAUSTED"); }),
        extract: vi.fn(async () => []),
      } }),
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    const serper = out.providers.find((p) => p.provider === "serper");
    expect(serper?.status).toBe("failure");
    expect(out.merged_contacts.some((c) => c.source_provider === "osm" && c.kind === "phone")).toBe(true);
  });
});

describe("Phase 4: contact statuses", () => {
  test("a business with contacts is found_not_verified, never verified", async () => {
    const collect = vi.fn(async () => [osmObservationWithContacts([
      { kind: "email", value: "info@acmeplumbing.com", evidence_excerpt: "email=info@acmeplumbing.com" },
    ])]);
    const job = makeInput({
      osm: createOsmProvider({ collector: { collect }, geo }),
      serper: { search: async () => ({ businesses: [] }) },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    expect(out.contact_research_statuses.found_not_verified).toBeGreaterThanOrEqual(1);
    expect(out.contact_research_statuses.contact_incomplete).toBe(0);
    for (const c of out.merged_contacts) {
      expect(c.confidence).toBeLessThan(1);
    }
    const decision = out.qualification_decisions[0];
    if (decision.status === "qualified") {
      expect(decision.contact_status).toBe("unverified");
      expect(decision.next_action).toBe("verify_contacts_before_outreach");
    }
  });

  test("contact_incomplete is separate from qualification", async () => {
    const job = makeInput({
      osm: {
        discover: async () => ({
          businesses: [makeBusiness({ serviceMatches: serviceGap, source_agent: "osm" })],
        }),
      },
      serper: { search: async () => ({ businesses: [] }) },
      assessment: workingAssessment,
      env: { ENABLE_SCRAPLING: "true" },
    });
    const out = await runDiscoveryJob(job);
    const decision = out.qualification_decisions[0];
    expect(decision.status).toBe("contact_incomplete");
    expect(out.total_qualified).toBe(1);
    expect(out.contact_research_statuses.contact_incomplete).toBeGreaterThanOrEqual(1);
  });
});
