import { describe, expect, test, vi } from "vitest";
import {
  createOsmCollectorFromEnv,
  createOsmProvider,
  createSerperAdapterFromEnv,
  createSerperProvider,
} from "../packages/server/discovery-providers.ts";
import {
  runDiscoveryJob,
  type DiscoveryJobInput,
} from "../packages/server/discovery-coordinator.ts";
import { SerperSearchAdapter, type SearchAdapter, type SearchHit } from "../packages/server/research.ts";
import { OsmCollector, type OsmObservation } from "../packages/server/harvey-osm.ts";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const observedAt = "2026-11-05T01:02:03+00:00";
const geo = { latitude: 33.45, longitude: -112.07, radiusKm: 5 };

// Passes every discovery filter: unique city mention, single-country evidence,
// business token present in the host.
const serperHits: SearchHit[] = [
  {
    title: "Desert Pipe Works | Phoenix",
    url: "https://desertpipeworks.com/",
    content: "Desert Pipe Works, Phoenix, United States. Address and phone are publicly listed.",
    score: 1,
  },
];

const osmObservation: OsmObservation = {
  name: "Desert Pipe Works Phoenix",
  proposed_website_url: "https://desertpipeworks.com/",
  provider_record_id: "osm:way/7",
  source_url: "https://www.openstreetmap.org/way/7",
  observed_at: observedAt,
  category: "plumber",
  latitude: 33.45,
  longitude: -112.07,
  contacts: [],
};

function fakeAdapter(hits: SearchHit[]): SearchAdapter {
  return { search: vi.fn(async () => hits), extract: vi.fn(async () => []) };
}

function makeJob(overrides: Partial<DiscoveryJobInput> = {}): DiscoveryJobInput {
  return {
    org_id: "00000000-0000-4000-8000-000000000001",
    run_id: "00000000-0000-4000-8000-000000000092",
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

describe("Serper provider integration", () => {
  test("maps real search candidates with evidence and provenance preserved", async () => {
    const job = makeJob({
      serper: createSerperProvider({ adapter: fakeAdapter(serperHits), observedAt }),
    });
    const out = await runDiscoveryJob(job);
    expect(out.providers.find((p) => p.provider === "serper")?.status).toBe("success");
    expect(out.deduplicated_businesses).toHaveLength(1);
    const business = out.deduplicated_businesses[0];
    expect(business).toMatchObject({
      business_name: "Desert Pipe Works",
      website_url: "https://desertpipeworks.com/",
      website_status: null, // UNKNOWN until a real assessment runs
      city: "Phoenix",
      country: "United States",
      location_source: "search_target", // search-area metadata, not a verified address
      source_url: "https://desertpipeworks.com/",
      observed_at: observedAt,
      source_agent: "serper",
    });
    expect(business.provider_record_id).toMatch(uuidRe);
    expect(business.evidence[0]).toMatchObject({ kind: "serper", url: "https://desertpipeworks.com/" });
    expect(business.evidence[0].claim).toContain("Desert Pipe Works, Phoenix, United States");
    // A search snippet alone must never qualify a lead.
    expect(out.qualification_decisions[0].status).toBe("not_qualified");
  });

  test("missing credentials fail closed as an explicit provider error", async () => {
    const job = makeJob({ serper: createSerperProvider({ adapter: null }) });
    const out = await runDiscoveryJob(job);
    const serper = out.providers.find((p) => p.provider === "serper");
    expect(serper?.status).toBe("failure");
    expect(serper?.error).toBe("SERPER_NOT_CONFIGURED");
    expect(out.total_discovered).toBe(0);
  });

  test("env factory stays fail-closed and construction never touches the network", () => {
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error("LIVE_NETWORK_CALL");
    });
    expect(createSerperAdapterFromEnv({}, transport)).toBeNull();
    expect(createSerperAdapterFromEnv({ ENABLE_SERPER_DISCOVERY: "true" }, transport)).toBeNull();
    expect(
      createSerperAdapterFromEnv({ ENABLE_SERPER_DISCOVERY: "true", SERPER_API_KEY: "your_key_here" }, transport),
    ).toBeNull();
    const adapter = createSerperAdapterFromEnv(
      { ENABLE_SERPER_DISCOVERY: "true", SERPER_API_KEY: "unit-test-key" },
      transport,
    );
    expect(adapter).toBeInstanceOf(SerperSearchAdapter);
    expect(createOsmCollectorFromEnv({}, transport)).toBeNull();
    expect(createOsmCollectorFromEnv({ ENABLE_OSM_DISCOVERY: "true" }, transport)).not.toBeNull();
    // Legacy flag alias still honored for existing configuration.
    expect(createOsmCollectorFromEnv({ ENABLE_HARVEY_OSM_DISCOVERY: "true" }, transport)).not.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  test("quota exhaustion from the existing adapter path surfaces as a provider failure", async () => {
    const adapter: SearchAdapter = {
      search: vi.fn(async () => {
        throw new Error("SERPER_CREDITS_OR_RATE_EXHAUSTED");
      }),
      extract: vi.fn(async () => []),
    };
    const job = makeJob({ serper: createSerperProvider({ adapter }) });
    const out = await runDiscoveryJob(job);
    const serper = out.providers.find((p) => p.provider === "serper");
    expect(serper?.status).toBe("failure");
    expect(serper?.error).toBe("SERPER_CREDITS_OR_RATE_EXHAUSTED");
  });

  test("malformed search hits are dropped without failing the provider", async () => {
    const adapter = fakeAdapter([
      { title: "Truncated listing...", url: "https://broken.example.com/", content: "short", score: 1 },
      { title: "Bad URL", url: "not-a-url", content: "Content long enough to parse but the url is invalid.", score: 1 },
    ]);
    const job = makeJob({ serper: createSerperProvider({ adapter }) });
    const out = await runDiscoveryJob(job);
    const serper = out.providers.find((p) => p.provider === "serper");
    expect(serper?.status).toBe("success");
    expect(serper?.businesses).toHaveLength(0);
  });
});

describe("OpenStreetMap provider integration", () => {
  test("maps OSM observations as provider 'osm' with identity, coordinates and search-area location", async () => {
    const collect = vi.fn(async () => [osmObservation]);
    const job = makeJob({
      osm: createOsmProvider({ collector: { collect }, geo, observedAt }),
    });
    const out = await runDiscoveryJob(job);
    expect(out.providers.find((p) => p.provider === "osm")?.status).toBe("success");
    const business = out.deduplicated_businesses[0];
    expect(business).toMatchObject({
      provider_record_id: "osm:way/7", // OSM node identity preserved
      business_name: "Desert Pipe Works Phoenix",
      website_url: "https://desertpipeworks.com/",
      website_status: null, // an OSM tag claim, never an assessment
      city: "Phoenix",
      state_region: "AZ",
      country: "United States",
      location_source: "search_target", // target location is search-area metadata, NOT a verified address
      source_url: "https://www.openstreetmap.org/way/7",
      observed_at: observedAt,
      source_agent: "osm", // never "harvey"
    });
    expect(business.evidence[0]).toMatchObject({ kind: "osm", url: "https://www.openstreetmap.org/way/7" });
    // Coordinates preserved as source evidence.
    expect(business.evidence[0].claim).toContain("at 33.45,-112.07");
    expect(collect).toHaveBeenCalledWith(
      { category: "plumber", latitude: geo.latitude, longitude: geo.longitude, radiusKm: 5, limit: 3 },
      observedAt,
    );
  });

  test("disabled collector reports an explicit error", async () => {
    const job = makeJob({
      osm: createOsmProvider({ collector: null, geo }),
    });
    const out = await runDiscoveryJob(job);
    const osm = out.providers.find((p) => p.provider === "osm");
    expect(osm?.status).toBe("failure");
    expect(osm?.error).toBe("OSM_DISCOVERY_DISABLED");
  });

  test("unsupported OSM industry fails before any transport call", async () => {
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error("LIVE_NETWORK_CALL");
    });
    const job = makeJob({
      industry: "florist",
      osm: createOsmProvider({ collector: new OsmCollector(transport), geo }),
    });
    const out = await runDiscoveryJob(job);
    const osm = out.providers.find((p) => p.provider === "osm");
    expect(osm?.status).toBe("failure");
    expect(osm?.error).toBe("INVALID_OSM_TARGET");
    expect(transport).not.toHaveBeenCalled(); // validation happens before the request
  });
});

describe("coordinated multi-provider behavior", () => {
  test("identical businesses found by OSM and Serper deduplicate to one record", async () => {
    const job = makeJob({
      osm: createOsmProvider({
        collector: { collect: vi.fn(async () => [osmObservation]) },
        geo,
      }),
      serper: createSerperProvider({ adapter: fakeAdapter(serperHits), observedAt }),
    });
    const out = await runDiscoveryJob(job);
    expect(out.total_discovered).toBe(2);
    expect(out.total_unique).toBe(1);
    expect(out.raw_businesses.map((b) => b.source_agent).sort()).toEqual(["osm", "serper"]);
    expect(out.deduplicated_businesses[0].source_agent).toBe("osm"); // first provider wins the canonical slot
  });

  test("Serper failure does not discard OSM results", async () => {
    const failingAdapter: SearchAdapter = {
      search: vi.fn(async () => {
        throw new Error("SERPER_UNAVAILABLE");
      }),
      extract: vi.fn(async () => []),
    };
    const job = makeJob({
      osm: createOsmProvider({
        collector: { collect: vi.fn(async () => [osmObservation]) },
        geo,
      }),
      serper: createSerperProvider({ adapter: failingAdapter }),
    });
    const out = await runDiscoveryJob(job);
    expect(out.providers.find((p) => p.provider === "serper")?.error).toBe("SERPER_UNAVAILABLE");
    expect(out.providers.find((p) => p.provider === "osm")?.status).toBe("success");
    expect(out.total_unique).toBe(1);
  });

  test("provider timeout is reported and the other provider's results survive", async () => {
    const job = makeJob({
      timeout_ms: 30,
      osm: { discover: () => new Promise<never>(() => {}) }, // never settles
      serper: createSerperProvider({ adapter: fakeAdapter(serperHits), observedAt }),
    });
    const out = await runDiscoveryJob(job);
    const osm = out.providers.find((p) => p.provider === "osm");
    expect(osm?.status).toBe("failure");
    expect(osm?.error).toBe("timeout_after_30ms");
    expect(out.providers.find((p) => p.provider === "serper")?.status).toBe("success");
    expect(out.total_unique).toBe(1);
  });
});
