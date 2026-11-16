import { describe, expect, test, vi } from "vitest";
import {
  createWebsiteAssessor,
  domainIdentityMatches,
  type OfficialWebsiteResearch,
} from "../packages/server/website-assessment.ts";
import { isVerifiedWebsiteProblem } from "../packages/server/qualification.ts";
import type { PinnedAuditTransport } from "../packages/server/audit.ts";
import {
  runDiscoveryJob,
  type DiscoveredBusiness,
  type DiscoveryJobInput,
} from "../packages/server/discovery-coordinator.ts";

const observedAt = "2026-11-05T00:00:00+00:00";

function makeBusiness(overrides: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    provider_record_id: "00000000-0000-4000-8000-000000000071",
    business_name: "Desert Pipe Works",
    website_url: "https://desertpipeworks.com/",
    website_status: null,
    website_problem: null,
    operational_need: null,
    serviceMatches: [],
    city: "Phoenix",
    state_region: "AZ",
    country: "United States",
    location_source: "search_target",
    source_url: "https://serper.example/listing-1",
    observed_at: observedAt,
    evidence: [{ kind: "serper", claim: "Search snippet", url: "https://serper.example/listing-1", confidence: 0.5 }],
    source_agent: "serper",
    ...overrides,
  };
}

// Injected pinned transport: robots.txt answered first, then the page.
// No test performs a real network call.
function fakeTransport(
  page: { status: number; body?: string } | { throws: string },
  robots: { status: number; body: string } = { status: 404, body: "" },
): PinnedAuditTransport {
  return {
    resolve: vi.fn(async () => ["93.184.216.34"]),
    fetchPinned: vi.fn(async (url: string) => {
      if (url.includes("/robots.txt")) {
        return { status: robots.status, headers: {}, body: robots.body, remoteAddress: "93.184.216.34" };
      }
      if ("throws" in page) throw new Error(page.throws);
      return {
        status: page.status,
        headers: {},
        body: page.body ?? "<html><title>Desert Pipe Works</title></html>",
        remoteAddress: "93.184.216.34",
      };
    }),
  };
}

function assessorWith(page: Parameters<typeof fakeTransport>[0], extra: Partial<Parameters<typeof createWebsiteAssessor>[0]> = {}) {
  return createWebsiteAssessor({ transport: fakeTransport(page), permissionReference: "unit-test", ...extra });
}

describe("website assessment: identity and reachability", () => {
  test("verified official domain is distinguished from an unrelated domain", async () => {
    const assessor = assessorWith({ status: 200 });
    const verified = await assessor.assess({ business: makeBusiness() });
    expect(verified.status).toBe("VERIFIED_WORKING");
    expect(verified.website_status).toBe("VERIFIED_WORKING");
    expect(verified.website_problem).toBeNull();
    expect(verified.method).toBe("pinned_audit");
    expect(verified.reason).toContain("HTTP 200");

    // Same business, unrelated domain: identity gate, no probe at all.
    const probeTransport = fakeTransport({ status: 200 });
    const unrelated = await createWebsiteAssessor({ transport: probeTransport, permissionReference: "unit-test" })
      .assess({ business: makeBusiness({ website_url: "https://organic-glazing.example.com/" }) });
    expect(unrelated.status).toBe("CANDIDATE_DOMAIN_UNVERIFIED");
    expect(unrelated.website_status).toBe(null);
    expect(unrelated.website_problem).toBe(null);
    expect(unrelated.reason).toContain("Ownership is unverified");
    expect(probeTransport.fetchPinned).not.toHaveBeenCalled();
  });

  test("search snippets never establish website ownership", async () => {
    // Candidate carries a confident snippet and a proposed URL, but the host
    // does not correlate with the business identity.
    const probeTransport = fakeTransport({ status: 200 });
    const assessor = createWebsiteAssessor({ transport: probeTransport, permissionReference: "unit-test" });
    const business = makeBusiness({
      business_name: "Phoenix Fine Art Framing",
      website_url: "https://desertpipeworks.com/",
      evidence: [
        { kind: "serper", claim: "Phoenix Fine Art Framing, Phoenix, United States. Fine art framing since 1998.", url: "https://serper.example/listing-9", confidence: 0.9 },
      ],
    });
    const out = await assessor.assess({ business });
    expect(out.status).toBe("CANDIDATE_DOMAIN_UNVERIFIED");
    expect(out.website_status).toBe(null);
    expect(probeTransport.fetchPinned).not.toHaveBeenCalled(); // snippet confidence buys no probe
  });

  test("domainIdentityMatches requires a business-name token in the hostname", () => {
    expect(domainIdentityMatches("Desert Pipe Works", new URL("https://www.desertpipeworks.com/"))).toBe(true);
    expect(domainIdentityMatches("Desert Pipe Works", new URL("https://unrelated-host.example.com/"))).toBe(false);
    expect(domainIdentityMatches("ab", new URL("https://ab.example.com/"))).toBe(false);
  });
});

describe("website assessment: absence, failure and ambiguity", () => {
  test("a missing URL is unknown until documented research proves absence", async () => {
    const noResearch = await assessorWith({ status: 200 }).assess({
      business: makeBusiness({ website_url: null }),
    });
    expect(noResearch.status).toBe("UNKNOWN");
    expect(noResearch.website_status).toBe(null);
    expect(noResearch.reason).toContain("never establishes");

    const research = vi.fn(async (): Promise<OfficialWebsiteResearch> => ({
      outcome: "no_candidate",
      queries: [
        { query: '"desert pipe works" phoenix az official website', hits: 2, observed_at: observedAt, error: null },
        { query: "desert pipe works phoenix az website", hits: 1, observed_at: observedAt, error: null },
      ],
      sources: ["https://serper.example/listing-1"],
      reason: "Documented research completed across 2+ queries with no official domain candidate. "
        + "This records the completed research protocol, not proof that no website exists.",
    }));
    const withResearch = await createWebsiteAssessor({
      transport: fakeTransport({ status: 200 }),
      permissionReference: "unit-test",
      researchOfficialWebsite: research,
    }).assess({ business: makeBusiness({ website_url: null }) });
    expect(withResearch.status).toBe("NO_OFFICIAL_WEBSITE_FOUND"); // only after documented research
    expect(withResearch.website_status).toBe("NO_OFFICIAL_WEBSITE_FOUND");
    expect(withResearch.method).toBe("documented_research");
    expect(withResearch.evidence_url).toContain("serper.example");
    expect(research).toHaveBeenCalledTimes(1);
  });

  test("documented research that finds a URL continues into identity and reachability", async () => {
    const assessor = createWebsiteAssessor({
      transport: fakeTransport({ status: 200 }),
      permissionReference: "unit-test",
      researchOfficialWebsite: async () => ({
        outcome: "verified_candidate",
        official_url: "https://desertpipeworks.com/",
        source_url: "https://serper.example/listing-1",
        queries: [{ query: "desert pipe works phoenix official website", hits: 3, observed_at: observedAt, error: null }],
        rejected: [],
      }),
    });
    const out = await assessor.assess({ business: makeBusiness({ website_url: null }) });
    expect(out.status).toBe("VERIFIED_WORKING");
  });

  test("an unreachable website is distinguished from confirmed absence", async () => {
    const out = await assessorWith({ status: 503 }).assess({ business: makeBusiness() });
    expect(out.status).toBe("VERIFIED_SERIOUS_ISSUE"); // verified + currently unreachable
    expect(out.website_status).toBe("VERIFIED_SERIOUS_ISSUE");
    expect(out.website_problem).not.toBeNull();
    expect(out.website_problem?.type).toBe("serious_issue");
    expect(out.website_problem?.evidence_claim).toContain("HTTP 503");
    expect(out.website_problem?.details).toContain("reproducible");
    // Confirmed absence exists only as NO_OFFICIAL_WEBSITE_FOUND (previous
    // test) — an unreachable site never produces it.
    expect(out.website_status).not.toBe("NO_OFFICIAL_WEBSITE_FOUND");
  });

  test("an actual broken-page observation is recorded with reproducible evidence", async () => {
    const out = await assessorWith({ status: 404 }).assess({ business: makeBusiness() });
    expect(out.status).toBe("VERIFIED_SERIOUS_ISSUE");
    expect(out.website_problem?.type).toBe("broken");
    expect(out.website_problem?.method).toBe("automated_check");
    expect(isVerifiedWebsiteProblem(out.website_problem)).toBe(true); // clears the strict verified bar
    expect(out.website_problem?.observed_at).toBeTruthy();
    expect(out.website_problem?.confidence).toBeGreaterThanOrEqual(0.6);
    // Bounded repeat observations are preserved in the evidence, not just the last status.
    expect(out.website_problem?.evidence_claim).toContain("404, 404, 404");
    expect(out.website_problem?.evidence_claim).toContain("3 observation(s)");
  });

  // One status per bounded attempt (the last repeats); no real network calls.
  function sequenceTransport(pages: { status: number }[]): PinnedAuditTransport {
    let page = 0;
    return {
      resolve: vi.fn(async () => ["93.184.216.34"]),
      fetchPinned: vi.fn(async (url: string) => {
        if (url.includes("/robots.txt")) return { status: 404, headers: {}, body: "", remoteAddress: "93.184.216.34" };
        const current = pages[Math.min(page, pages.length - 1)];
        page += 1;
        return {
          status: current.status,
          headers: {},
          body: "<html><title>Desert Pipe Works</title></html>",
          remoteAddress: "93.184.216.34",
        };
      }),
    };
  }

  test("a transient 5xx that recovers is VERIFIED_WORKING, not a serious issue", async () => {
    const transport = sequenceTransport([{ status: 503 }, { status: 200 }]);
    const out = await createWebsiteAssessor({ transport, permissionReference: "unit-test" })
      .assess({ business: makeBusiness() });
    expect(out.status).toBe("VERIFIED_WORKING");
    expect(out.website_status).toBe("VERIFIED_WORKING");
    expect(out.website_problem).toBeNull();
    // The non-reproducing earlier status is disclosed in the reason.
    expect(out.reason).toContain("did not reproduce");
    expect(out.reason).toContain("HTTP 503");
    expect(transport.fetchPinned).toHaveBeenCalledTimes(4); // 2 attempts × (robots + page)
  });

  test("a single 5xx that reproduces on every bounded observation is a persistent issue", async () => {
    const out = await assessorWith({ status: 503 }).assess({ business: makeBusiness() });
    expect(out.status).toBe("VERIFIED_SERIOUS_ISSUE");
    expect(out.website_problem?.type).toBe("serious_issue");
    expect(out.website_problem?.evidence_claim).toContain("HTTP 503, 503, 503");
    expect(out.website_problem?.evidence_claim).toContain("3 observation(s)");
    expect(out.website_problem?.details).toContain("reproducible");
  });

  test("a sub-page failure never becomes a whole-site verdict", async () => {
    const out = await assessorWith({ status: 404 }).assess({
      business: makeBusiness({ website_url: "https://desertpipeworks.com/old-page" }),
    });
    expect(out.status).toBe("UNKNOWN"); // identity-correlated, but not the domain root
    expect(out.website_status).toBe(null);
    expect(out.website_problem).toBeNull();
    expect(out.reason).toContain("not the domain root");
  });

  test("inconsistent bounded observations are inconclusive, never a verdict", async () => {
    const out = await createWebsiteAssessor({
      transport: sequenceTransport([{ status: 503 }, { status: 404 }, { status: 503 }]),
      permissionReference: "unit-test",
    }).assess({ business: makeBusiness() });
    expect(out.status).toBe("ASSESSMENT_FAILED");
    expect(out.website_status).toBe(null);
    expect(out.website_problem).toBeNull();
    expect(out.reason).toContain("inconsistent");
  });

  test("timeout and transport failure are assessment failures, never website conclusions", async () => {
    const timedOut = await assessorWith({ throws: "AUDIT_TIMEOUT" }).assess({ business: makeBusiness() });
    expect(timedOut.status).toBe("ASSESSMENT_FAILED");
    expect(timedOut.website_status).toBe(null);
    expect(timedOut.website_problem).toBe(null);
    expect(timedOut.reason).toContain("timed out");

    const generic = await assessorWith({ throws: "socket hang up" }).assess({ business: makeBusiness() });
    expect(generic.status).toBe("ASSESSMENT_FAILED");
    expect(generic.website_status).toBe(null);
    expect(generic.website_problem).toBe(null);
    expect(generic.reason).toContain("NETWORK_OR_POLICY_REVIEW_REQUIRED");
  });

  test("robots/policy blocks are assessment failures, never a broken-website label", async () => {
    const transport = fakeTransport({ status: 200 }, { status: 200, body: "User-agent: *\nDisallow: /" });
    const out = await createWebsiteAssessor({ transport, permissionReference: "unit-test" })
      .assess({ business: makeBusiness() });
    expect(out.status).toBe("ASSESSMENT_FAILED");
    expect(out.website_status).toBe(null);
    expect(out.website_problem).toBe(null);
    expect(out.reason).toContain("ROBOTS_DISALLOWED");
  });

  test("a throwing research port fails the assessment without concluding absence", async () => {
    const out = await createWebsiteAssessor({
      transport: fakeTransport({ status: 200 }),
      permissionReference: "unit-test",
      researchOfficialWebsite: async () => {
        throw new Error("research worker down");
      },
    }).assess({ business: makeBusiness({ website_url: null }) });
    expect(out.status).toBe("ASSESSMENT_FAILED");
    expect(out.website_status).toBe(null);
    expect(out.reason).toContain("research worker down");
  });
});

describe("coordinator qualification integration", () => {
  const websiteGapMatch = [
    {
      service_key: "service_01",
      service_name: "Website",
      status: "verified_gap" as const,
      reason: "Evidence-supported website gap",
      evidence_ids: ["https://serper.example/listing-1"],
      confidence: 0.9,
    },
  ];

  function makeJob(overrides: Partial<DiscoveryJobInput> = {}): DiscoveryJobInput {
    return {
      org_id: "00000000-0000-4000-8000-000000000001",
      run_id: "00000000-0000-4000-8000-000000000093",
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

  test("an observed broken page alone does not qualify; strict rules still apply", async () => {
    const assessor = assessorWith({ status: 404 });
    const job = makeJob({
      assessment: { assess: assessor.assess },
      osm: {
        discover: async () => ({
          // Observed 404 problem, but NO service match: Path 1 must not fire.
          businesses: [makeBusiness({ provider_record_id: "00000000-0000-4000-8000-0000000000a1" })],
        }),
      },
    });
    const out = await runDiscoveryJob(job);
    const decision = out.qualification_decisions[0];
    expect(decision.status).toBe("not_qualified");
    if (decision.status === "not_qualified") {
      expect(decision.qualification.path).toBeNull();
    }
    // The assessment result still feeds the strict contract as evidence.
    expect(decision.business.website_status).toBe("VERIFIED_SERIOUS_ISSUE");
    expect(decision.business.website_problem?.type).toBe("broken");
    expect(out.total_qualified).toBe(0);
  });

  test("unassessed or failed assessments are held, and partial results survive", async () => {
    const assessor = assessorWith({ status: 404 });
    const failingId = "00000000-0000-4000-8000-0000000000c3";
    const job = makeJob({
      assessment: {
        assess: async (input) => {
          if (input.business.provider_record_id === failingId) throw new Error("assessor crashed");
          return assessor.assess(input);
        },
      },
      osm: {
        discover: async () => ({
          businesses: [
            // Assessed (404) + strict service match: counts.
            makeBusiness({
              provider_record_id: "00000000-0000-4000-8000-0000000000b2",
              business_name: "Second Chance Roofing",
              website_url: "https://secondchanceroofing.com/",
              serviceMatches: websiteGapMatch,
            }),
            // Assessment port throws: held for review, never counted.
            makeBusiness({
              provider_record_id: failingId,
              business_name: "Copper Kettle Bakery",
              website_url: "https://copperkettlebaking.example.com/",
              serviceMatches: websiteGapMatch,
            }),
          ],
        }),
      },
    });
    const out = await runDiscoveryJob(job);
    // Partial results survive the assessment failure.
    expect(out.providers.find((p) => p.provider === "osm")?.status).toBe("success");
    expect(out.total_unique).toBe(2);

    const assessed = out.qualification_decisions.find(
      (d) => d.business.provider_record_id === "00000000-0000-4000-8000-0000000000b2",
    );
    expect(assessed?.status).toBe("contact_incomplete"); // strict-qualified, assessed, no contacts

    const held = out.qualification_decisions.find((d) => d.business.provider_record_id === failingId);
    expect(held?.status).toBe("hold_unassessed");
    if (held?.status === "hold_unassessed") {
      expect(held.assessment_status).toBe("ASSESSMENT_FAILED");
    }
    // Only the assessed strict-qualified business counts.
    expect(out.total_qualified).toBe(1);
  });

  test("a strictly qualified business with no assessment port is held, not counted", async () => {
    const job = makeJob({
      osm: {
        discover: async () => ({
          businesses: [makeBusiness({ serviceMatches: websiteGapMatch })],
        }),
      },
    });
    const out = await runDiscoveryJob(job);
    const decision = out.qualification_decisions[0];
    expect(decision.status).toBe("hold_unassessed");
    if (decision.status === "hold_unassessed") {
      expect(decision.assessment_status).toBe("not_configured");
    }
    expect(out.total_qualified).toBe(0);
  });
});
