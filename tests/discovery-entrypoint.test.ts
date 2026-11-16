import { describe, expect, test, vi } from "vitest";
import {
  runConfiguredDiscoveryJob,
  type DiscoveryRunTarget,
} from "../packages/server/discovery-entrypoint.ts";
import type { PinnedAuditTransport } from "../packages/server/audit.ts";

// Entrypoint tests run fully offline: provider traffic goes to an injected
// fetch transport that serves canned Serper/Overpass payloads, and audits go
// to an injected pinned transport. Production defaults (real fetch, real
// NodePinnedAuditTransport) are never exercised here, so no result below is a
// live provider observation.

const target: DiscoveryRunTarget = {
  industry: "plumber",
  city: "Phoenix",
  region: "AZ",
  country: "United States",
  requested_count: 5,
  latitude: 33.45,
  longitude: -112.07,
  radius_km: 5,
};

const configuredEnv = {
  ENABLE_DISCOVERY_RUN: "true",
  ENABLE_SERPER_DISCOVERY: "true",
  SERPER_API_KEY: "unit-test-key",
  ENABLE_OSM_DISCOVERY: "true",
  AUDIT_PERMISSION_REFERENCE: "unit-test",
};

// Passes every discovery filter (city mention, single-country evidence,
// business token in the host) — same shape as the provider tests use.
const serperOrganic = {
  organic: [
    {
      title: "Desert Pipe Works | Phoenix",
      link: "https://desertpipeworks.com/",
      snippet: "Desert Pipe Works, Phoenix, United States. Address and phone are publicly listed.",
      position: 1,
    },
  ],
};

const osmElementNoWebsite = {
  type: "node",
  id: 4242,
  lat: 33.45,
  lon: -112.07,
  tags: { craft: "plumber", name: "Phoenix Plumbing Pros" },
};

const osmElementWithWebsite = {
  type: "node",
  id: 777,
  lat: 33.5,
  lon: -112.1,
  tags: {
    craft: "plumber",
    name: "Phoenix Plumbing Pros",
    website: "https://phoenixplumbingpros.com/",
  },
};

type FakeRoutes = {
  serper?: () => { status: number; json: unknown };
  osm?: () => { status: number; json: unknown };
};

// Injected fetch: answers only the two real provider endpoints, records every
// URL, and fails the test loudly on anything else.
function fakeHttp(routes: FakeRoutes = {}) {
  const calls: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("google.serper.dev")) {
      const result = routes.serper ? routes.serper() : { status: 200, json: { organic: [] } };
      return new Response(JSON.stringify(result.json), { status: result.status });
    }
    if (url.includes("overpass.private.coffee")) {
      const result = routes.osm ? routes.osm() : { status: 200, json: { elements: [] } };
      return new Response(JSON.stringify(result.json), { status: result.status });
    }
    throw new Error(`UNEXPECTED_PROVIDER_REQUEST ${url}`);
  };
  return { transport, calls };
}

// robots.txt answered 404 (no rules), then the page with pageStatus.
function fakeAudit(pageStatus = 200): PinnedAuditTransport {
  return {
    resolve: vi.fn(async () => ["93.184.216.34"]),
    fetchPinned: vi.fn(async (url: string) => ({
      status: url.includes("/robots.txt") ? 404 : pageStatus,
      headers: {},
      body: url.includes("/robots.txt") ? "" : "<html><title>Site</title></html>",
      remoteAddress: "93.184.216.34",
    })),
  };
}

describe("discovery entrypoint gates", () => {
  test("the owner-invocation gate fails closed before any provider runs", async () => {
    const { transport, calls } = fakeHttp();
    await expect(
      runConfiguredDiscoveryJob({ env: {}, target, httpTransport: transport }),
    ).rejects.toThrow("DISCOVERY_RUN_DISABLED");
    await expect(
      runConfiguredDiscoveryJob({ env: { ENABLE_DISCOVERY_RUN: "false" }, target, httpTransport: transport }),
    ).rejects.toThrow("DISCOVERY_RUN_DISABLED");
    expect(calls).toHaveLength(0);
  });

  test("an invalid target is rejected before any provider runs", async () => {
    const { transport, calls } = fakeHttp();
    await expect(
      runConfiguredDiscoveryJob({
        env: { ENABLE_DISCOVERY_RUN: "true" },
        target: { ...target, industry: "pl" }, // shorter than the 3-char minimum
        httpTransport: transport,
      }),
    ).rejects.toThrow("INVALID_DISCOVERY_TARGET");
    expect(calls).toHaveLength(0);
  });

  test("OSM without a valid owner-approved search area fails before any request", async () => {
    const { transport, calls } = fakeHttp();
    const env = { ENABLE_DISCOVERY_RUN: "true", ENABLE_OSM_DISCOVERY: "true" };
    await expect(
      runConfiguredDiscoveryJob({
        env,
        target: { ...target, latitude: undefined, longitude: undefined, radius_km: undefined },
        httpTransport: transport,
      }),
    ).rejects.toThrow("OSM_GEO_REQUIRED");
    await expect(
      runConfiguredDiscoveryJob({ env, target: { ...target, latitude: 999 }, httpTransport: transport }),
    ).rejects.toThrow("OSM_GEO_REQUIRED");
    expect(calls).toHaveLength(0);
  });

  test("unconfigured providers surface explicit statuses and never fake a result", async () => {
    const { transport, calls } = fakeHttp();
    const out = await runConfiguredDiscoveryJob({
      env: { ENABLE_DISCOVERY_RUN: "true" },
      target,
      httpTransport: transport,
    });
    const serper = out.providers.find((p) => p.provider === "serper");
    expect(serper?.status).toBe("failure");
    expect(serper?.error).toBe("SERPER_NOT_CONFIGURED");
    const osm = out.providers.find((p) => p.provider === "osm");
    expect(osm?.status).toBe("failure");
    expect(osm?.error).toBe("OSM_DISCOVERY_DISABLED");
    expect(out.total_unique).toBe(0);
    expect(out.total_qualified).toBe(0);
    expect(out.configuration).toEqual({
      serper: "not_configured",
      osm: "disabled",
      assessment: "not_configured",
      research: "assessment_not_wired",
      scrapling: "disabled",
      vibe_fallback: "not_configured",
    });
    expect(calls).toHaveLength(0); // fail-closed wiring made no request
  });
});

describe("discovery entrypoint configured flow", () => {
  test("Serper and OSM flow through assessment with honest provenance and configuration", async () => {
    const { transport, calls } = fakeHttp({
      serper: () => ({ status: 200, json: serperOrganic }),
      osm: () => ({ status: 200, json: { elements: [osmElementNoWebsite] } }),
    });
    const audit = fakeAudit(200);
    const out = await runConfiguredDiscoveryJob({
      env: configuredEnv,
      target,
      httpTransport: transport,
      auditTransport: audit,
      retryDelayMs: 0,
    });

    expect(out.configuration).toEqual({
      serper: "configured",
      osm: "configured",
      assessment: "configured",
      research: "configured",
      scrapling: "disabled",
      vibe_fallback: "not_configured",
    });

    // Traffic went only to the real provider endpoints (served by the fake).
    expect(calls.every((url) => url.includes("google.serper.dev") || url.includes("overpass.private.coffee"))).toBe(true);
    expect(calls.filter((url) => url.includes("overpass.private.coffee"))).toHaveLength(1);
    // 1 discovery search + 3 documented research queries for the URL-less
    // OSM business: the negative verdict below was earned by real queries.
    expect(calls.filter((url) => url.includes("google.serper.dev"))).toHaveLength(4);

    expect(out.providers.find((p) => p.provider === "serper")?.status).toBe("success");
    expect(out.providers.find((p) => p.provider === "osm")?.status).toBe("success");
    expect(out.providers.find((p) => p.provider === "scrapling")?.status).toBe("skipped");
    expect(out.total_unique).toBe(2);
    expect(out.merged_contacts).toEqual([]);

    const serperDecision = out.qualification_decisions.find((d) => d.business.source_agent === "serper");
    expect(serperDecision?.business.website_status).toBe("VERIFIED_WORKING");
    expect(serperDecision?.business.location_source).toBe("search_target");
    expect(serperDecision?.business.evidence[0]?.kind).toBe("serper");

    const osmDecision = out.qualification_decisions.find((d) => d.business.source_agent === "osm");
    // Absence only after the documented protocol completed — never from the
    // missing OSM tag itself.
    expect(osmDecision?.business.website_status).toBe("NO_OFFICIAL_WEBSITE_FOUND");
    expect(osmDecision?.business.location_source).toBe("search_target");
    expect(osmDecision?.business.evidence[0]?.kind).toBe("osm");

    // Only the URL-bearing business was probed: robots.txt + page.
    expect(audit.fetchPinned).toHaveBeenCalledTimes(2);

    // Qualification is untouched: a working website alone never qualifies.
    expect(out.qualification_decisions.every((d) => d.status === "not_qualified")).toBe(true);
    expect(out.total_qualified).toBe(0);
  });

  test("a Serper outage is an explicit provider failure and OSM results survive", async () => {
    const { transport } = fakeHttp({
      serper: () => ({ status: 500, json: {} }),
      osm: () => ({ status: 200, json: { elements: [osmElementWithWebsite] } }),
    });
    const audit = fakeAudit(200);
    const out = await runConfiguredDiscoveryJob({
      env: configuredEnv,
      target,
      httpTransport: transport,
      auditTransport: audit,
      retryDelayMs: 0,
    });

    const serper = out.providers.find((p) => p.provider === "serper");
    expect(serper?.status).toBe("failure");
    expect(serper?.error).toBe("SERPER_UNAVAILABLE");
    expect(out.providers.find((p) => p.provider === "osm")?.status).toBe("success");
    expect(out.total_unique).toBe(1);

    const decision = out.qualification_decisions[0];
    expect(decision.business.source_agent).toBe("osm");
    expect(decision.business.website_status).toBe("VERIFIED_WORKING");
    expect(out.total_qualified).toBe(0);
  });

  test("without an audit permission reference assessment stays unwired and nothing is verified", async () => {
    const { transport, calls } = fakeHttp({
      serper: () => ({ status: 200, json: serperOrganic }),
      osm: () => ({ status: 200, json: { elements: [osmElementNoWebsite] } }),
    });
    const audit = fakeAudit(200);
    const out = await runConfiguredDiscoveryJob({
      env: {
        ENABLE_DISCOVERY_RUN: "true",
        ENABLE_SERPER_DISCOVERY: "true",
        SERPER_API_KEY: "unit-test-key",
        ENABLE_OSM_DISCOVERY: "true",
        // Deliberately no AUDIT_PERMISSION_REFERENCE: assessment must stay unwired.
      },
      target,
      httpTransport: transport,
      auditTransport: audit,
      retryDelayMs: 0,
    });

    expect(out.configuration).toEqual({
      serper: "configured",
      osm: "configured",
      assessment: "not_configured",
      research: "assessment_not_wired", // research is only reachable via the assessor
      scrapling: "disabled",
      vibe_fallback: "not_configured",
    });
    expect(out.total_unique).toBe(2);
    for (const decision of out.qualification_decisions) {
      expect(decision.business.website_status).toBe(null); // unknown, never assumed
    }
    expect(audit.fetchPinned).not.toHaveBeenCalled();
    // Research is unreachable without the assessor: only the 1 discovery
    // search went out, none of the documented research queries.
    expect(calls.filter((url) => url.includes("google.serper.dev"))).toHaveLength(1);
  });

  test("ENABLE_SCRAPLING reports an explicit not-wired failure, never a fabricated report", async () => {
    const { transport } = fakeHttp({
      serper: () => ({ status: 200, json: serperOrganic }),
      osm: () => ({ status: 200, json: { elements: [osmElementWithWebsite] } }),
    });
    const audit = fakeAudit(200);
    const out = await runConfiguredDiscoveryJob({
      env: { ...configuredEnv, ENABLE_SCRAPLING: "true" },
      target,
      httpTransport: transport,
      auditTransport: audit,
      retryDelayMs: 0,
    });

    expect(out.configuration.scrapling).toBe("enabled_not_wired");
    const scrapling = out.providers.find((p) => p.provider === "scrapling");
    expect(scrapling?.status).toBe("failure");
    expect(scrapling?.error).toContain("SCRAPLING_WORKER_NOT_WIRED");
    expect(out.merged_contacts).toEqual([]); // no observations were invented
  });
});
