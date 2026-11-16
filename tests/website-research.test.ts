import { describe, expect, test, vi } from "vitest";
import {
  createOfficialWebsiteResearch,
  type OfficialWebsiteResearch,
} from "../packages/server/website-research.ts";
import type { SearchAdapter, SearchHit } from "../packages/server/research.ts";
import type { DiscoveredBusiness } from "../packages/server/discovery-coordinator.ts";

// Documented research protocol tests. Every adapter is an injected fake —
// no test performs a real network call, and no result here is claimed as a
// live provider outcome.

function makeBusiness(overrides: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    provider_record_id: "00000000-0000-4000-8000-000000000072",
    business_name: "Desert Pipe Works",
    website_url: null, // research only runs when no URL is recorded
    website_status: null,
    website_problem: null,
    operational_need: null,
    serviceMatches: [],
    city: "Phoenix",
    state_region: "AZ",
    country: "United States",
    location_source: "search_target",
    source_url: "https://www.openstreetmap.org/node/1",
    observed_at: "2026-11-05T00:00:00+00:00",
    evidence: [],
    source_agent: "osm",
    ...overrides,
  };
}

function hit(title: string, url: string, content: string): SearchHit {
  return { title, url, content, score: 1 };
}

// Repeats the last step when the script runs out (the protocol is bounded).
function scriptedSearch(steps: Array<SearchHit[] | Error>) {
  let index = 0;
  return vi.fn(async (): Promise<SearchHit[]> => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return step;
  });
}

function adapterWith(search: ReturnType<typeof scriptedSearch>): SearchAdapter {
  return { search, extract: vi.fn(async () => []) };
}

function expectOutcome<T extends OfficialWebsiteResearch["outcome"]>(
  research: OfficialWebsiteResearch,
  expected: T,
): Extract<OfficialWebsiteResearch, { outcome: T }> {
  if (research.outcome !== expected) {
    throw new Error(`expected research outcome ${expected}, got ${research.outcome}`);
  }
  // The outcome was just checked above; the generic guard cannot narrow it.
  return research as Extract<OfficialWebsiteResearch, { outcome: T }>;
}

const officialHit = () =>
  hit(
    "Desert Pipe Works | Phoenix",
    "https://desertpipeworks.com/",
    "Desert Pipe Works, Phoenix, United States. Address and phone are publicly listed.",
  );

describe("documented official-website research protocol", () => {
  test("without a configured search adapter the protocol is incomplete, never negative", async () => {
    const research = createOfficialWebsiteResearch({ adapter: null });
    const out = expectOutcome(await research(makeBusiness()), "incomplete");
    expect(out.queries).toEqual([]);
    expect(out.reason).toContain("SERPER_NOT_CONFIGURED");
  });

  test("a completed protocol with zero candidates is no_candidate: documented, not proof", async () => {
    const search = scriptedSearch([[]]);
    const research = createOfficialWebsiteResearch({
      adapter: adapterWith(search),
      now: () => new Date("2026-11-05T12:00:00.000Z"),
    });
    const out = expectOutcome(await research(makeBusiness()), "no_candidate");
    expect(search).toHaveBeenCalledTimes(3); // bounded default protocol
    expect(out.queries).toHaveLength(3);
    expect(out.queries.every((q) => q.error === null)).toBe(true);
    expect(out.queries.every((q) => q.observed_at === "2026-11-05T12:00:00.000Z")).toBe(true);
    expect(out.reason).toContain("not proof that no website exists");
  });

  test("the protocol is bounded: at least two queries, at most five", async () => {
    const few = scriptedSearch([[]]);
    await createOfficialWebsiteResearch({ adapter: adapterWith(few), maxQueries: 1 })(makeBusiness());
    expect(few).toHaveBeenCalledTimes(2); // one empty query can never conclude absence

    const many = scriptedSearch([[]]);
    await createOfficialWebsiteResearch({ adapter: adapterWith(many), maxQueries: 9 })(makeBusiness());
    expect(many).toHaveBeenCalledTimes(5);
  });

  test("a failed query with no candidate is incomplete, never a negative finding", async () => {
    const search = scriptedSearch([[], new Error("SERPER_UNAVAILABLE"), []]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "incomplete");
    expect(out.reason).toContain("SERPER_UNAVAILABLE");
    expect(out.reason).toContain("no website conclusion");
    expect(out.queries.filter((q) => q.error !== null)).toHaveLength(1);
  });

  test("a positive identity candidate survives a later query failure", async () => {
    const search = scriptedSearch([[officialHit()], new Error("SERPER_UNAVAILABLE"), []]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "verified_candidate");
    expect(out.official_url).toBe("https://desertpipeworks.com/");
    expect(out.queries.some((q) => q.error === "SERPER_UNAVAILABLE")).toBe(true);
  });

  test("an identity-correlated host becomes the verified candidate", async () => {
    const search = scriptedSearch([[officialHit()]]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "verified_candidate");
    expect(out.official_url).toBe("https://desertpipeworks.com/");
    expect(out.source_url).toBe("https://desertpipeworks.com/");
    expect(search).toHaveBeenCalledTimes(3);
  });

  test("conflicting identity-correlated hosts stay ambiguous, never silently picked", async () => {
    const search = scriptedSearch([[
      officialHit(),
      hit("Desert Pipe Works official site", "https://desert-pipe.works/", "Desert Pipe Works home page."),
    ]]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "unverified_candidates");
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates).toContain("https://desertpipeworks.com/");
    expect(out.candidates).toContain("https://desert-pipe.works/");
    expect(out.reason).toContain("Conflicting identity-correlated candidates");
  });

  test("social and directory hosts are consulted sources only, never candidates", async () => {
    const search = scriptedSearch([[
      hit(
        "Desert Pipe Works (@desertpipe) • Instagram",
        "https://www.instagram.com/desertpipeworks/",
        "Desert Pipe Works, Phoenix. Plumbing and repairs.",
      ),
    ]]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "no_candidate");
    expect(out.sources).toContain("https://www.instagram.com/desertpipeworks/");
  });

  test("a name-mentioning host without identity correlation stays unverified", async () => {
    const search = scriptedSearch([[
      hit(
        "Desert Pipe Works - Phoenix AZ | Local Listings",
        "https://listings.example.org/desert-pipe-works",
        "Desert Pipe Works is a plumbing company in Phoenix, United States.",
      ),
    ]]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "unverified_candidates");
    expect(out.candidates).toContain("https://listings.example.org/desert-pipe-works");
    expect(out.reason).toContain("ownership is unverified");
  });

  test("unsafe candidate URLs are never counted as candidates or sources", async () => {
    const search = scriptedSearch([[
      hit("Desert Pipe Works", "https://127.0.0.1/desert-pipe-works", "Desert Pipe Works, Phoenix, United States."),
    ]]);
    const research = createOfficialWebsiteResearch({ adapter: adapterWith(search) });
    const out = expectOutcome(await research(makeBusiness()), "no_candidate");
    expect(out.sources).toEqual([]);
    expect(out.queries.every((q) => q.error === null)).toBe(true);
  });
});
