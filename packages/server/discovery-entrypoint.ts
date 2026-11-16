// Runnable entrypoint wiring runDiscoveryJob() to the PRODUCTION factories:
// - Serper: createSerperAdapterFromEnv() → createSerperProvider()
//   (wraps discoverSerperSearchCandidates + SerperSearchAdapter).
// - OpenStreetMap: createOsmCollectorFromEnv() → createOsmProvider()
//   (wraps the bounded OsmCollector; reported as provider "osm", never
//   "harvey" — the external Harvey application has no callable contract).
// - Website assessment: createWebsiteAssessor() over the existing
//   auditWebsite() with NodePinnedAuditTransport, plus documented
//   official-website research (createOfficialWebsiteResearch) over the same
//   Serper adapter.
// - Qualification: strictly delegated to qualifyLeadStrictly inside the
//   coordinator; nothing here qualifies or sends outreach
//   (ENABLE_LIVE_EMAIL is untouched and stays authoritative).
//
// This entrypoint performs NO database access and NO outreach: it returns the
// run result to its caller (the CLI worker prints it as JSON). Queue leasing
// and CRM persistence remain blocked — Supabase <your-project-ref> has been
// unreachable (NXDOMAIN) and no migration may be applied in this phase.
//
// All provider flags/credentials are checked BEFORE any provider executes.
// Disabled or unconfigured providers surface as explicit provider failure
// statuses from the coordinator (SERPER_NOT_CONFIGURED,
// OSM_DISCOVERY_DISABLED) — never as silent fakes.
import { runDiscoveryJob, type DiscoveryJobOutput } from "./discovery-coordinator.ts";
import {
  createOsmCollectorFromEnv,
  createOsmProvider,
  createSerperAdapterFromEnv,
  createSerperProvider,
} from "./discovery-providers.ts";
import { createOfficialWebsiteResearch } from "./website-research.ts";
import { createWebsiteAssessor } from "./website-assessment.ts";
import { NodePinnedAuditTransport } from "./node-audit-transport.ts";
import { scraplingEnabled } from "./scrapling-adapter.ts";
import { createVibeFallbackProvider } from "./vibe-prospecting-api.ts";
import type { PinnedAuditTransport } from "./audit.ts";

export type DiscoveryRunTarget = {
  org_id?: string;
  industry: string;
  city?: string | null;
  region?: string | null;
  country: string;
  requested_count: number;
  // Owner-approved OSM search area; required only when the OSM provider is
  // enabled. Never a verified business address.
  latitude?: number;
  longitude?: number;
  radius_km?: number;
};

export type DiscoveryRunConfiguration = {
  serper: "configured" | "not_configured";
  osm: "configured" | "disabled";
  assessment: "configured" | "not_configured";
  // Research is only reachable through the assessor, so it reports whether it
  // will actually run — not just whether a search adapter exists.
  research: "configured" | "search_adapter_unavailable" | "assessment_not_wired";
  scrapling: "enabled_not_wired" | "disabled";
  // Vibe Prospecting external fallback. "configured" when the API key is
  // present and the provider can be invoked; "not_configured" when the key is
  // missing (the coordinator then reports provider_contract_missing).
  vibe_fallback: "configured" | "not_configured";
};

export type DiscoveryRunOutput = DiscoveryJobOutput & { configuration: DiscoveryRunConfiguration };

export async function runConfiguredDiscoveryJob(input: {
  env: Record<string, string | undefined>;
  target: DiscoveryRunTarget;
  run_id?: string;
  // Injected transports keep tests offline. Production defaults are the REAL
  // fetch and the REAL pinned audit transport — never a fake.
  httpTransport?: typeof fetch;
  auditTransport?: PinnedAuditTransport;
  timeout_ms?: number;
  retryDelayMs?: number;
  now?: () => Date;
}): Promise<DiscoveryRunOutput> {
  const env = input.env;
  // Owner-invocation gate, checked before any provider construction.
  if (env.ENABLE_DISCOVERY_RUN !== "true") throw new Error("DISCOVERY_RUN_DISABLED");

  const target = input.target;
  const country = target.country?.trim();
  const industry = target.industry?.trim();
  const city = target.city?.trim() || null;
  if (!country || country.length < 2 || country.length > 80
    || !industry || industry.length < 3 || industry.length > 80
    || (city !== null && (city.length < 2 || city.length > 80))
    || !Number.isInteger(target.requested_count) || target.requested_count < 1 || target.requested_count > 50)
    throw new Error("INVALID_DISCOVERY_TARGET");

  const http = input.httpTransport ?? fetch;
  // Fail-closed factories: flag + credential checks happen inside, before any
  // network traffic; disabled providers come back as null and the coordinator
  // reports their explicit status.
  const serperAdapter = createSerperAdapterFromEnv(env, http);
  const osmCollector = createOsmCollectorFromEnv(env, http);
  if (osmCollector) {
    const { latitude, longitude, radius_km } = target;
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || (radius_km !== undefined && (!Number.isFinite(radius_km) || radius_km < 1 || radius_km > 10)))
      throw new Error("OSM_GEO_REQUIRED");
  }

  // Vibe Prospecting fallback: wired only when the API key is present.
  // The coordinator invokes it only when primary contact discovery is
  // incomplete, and never overwrites stronger primary evidence.
  const vibeFallback = createVibeFallbackProvider(env);

  // The assessor documents the owner's public-access permission basis; without
  // it no audit may run, so assessment stays unwired (website_status null,
  // every strict-qualified business held as hold_unassessed — never qualified
  // on unassessed website evidence).
  const permissionReference = (env.AUDIT_PERMISSION_REFERENCE ?? "").trim();
  const assessor = permissionReference
    ? createWebsiteAssessor({
        transport: input.auditTransport ?? new NodePinnedAuditTransport(),
        permissionReference,
        researchOfficialWebsite: createOfficialWebsiteResearch({ adapter: serperAdapter, now: input.now }),
        // Production gap between bounded repeat observations so a transient
        // 5xx has time to recover before a persistent verdict; tests pass 0.
        retryDelayMs: input.retryDelayMs ?? 2000,
        now: input.now,
      })
    : null;

  const output = await runDiscoveryJob({
    // Contract echo only: this entrypoint persists nothing (no CRM writes).
    org_id: target.org_id ?? "00000000-0000-4000-8000-000000000000",
    run_id: input.run_id ?? crypto.randomUUID(),
    industry,
    city,
    region: target.region?.trim() || null,
    country,
    requested_count: target.requested_count,
    osm: createOsmProvider({
      collector: osmCollector,
      geo: { latitude: target.latitude ?? 0, longitude: target.longitude ?? 0, radiusKm: target.radius_km ?? 5 },
    }),
    serper: createSerperProvider({ adapter: serperAdapter }),
    // The local Scrapling Python worker has no callable TypeScript contract
    // yet; when ENABLE_SCRAPLING is on, the coordinator records this explicit
    // failure instead of fabricating a report.
    scrapling: { fetch: async () => ({ report: null, error: "SCRAPLING_WORKER_NOT_WIRED" }) },
    assessment: assessor ? { assess: assessor.assess } : undefined,
    vibe_fallback: vibeFallback ? { lookup: vibeFallback.lookup } : undefined,
    env,
    timeout_ms: input.timeout_ms,
  });

  return {
    ...output,
    configuration: {
      serper: serperAdapter ? "configured" : "not_configured",
      osm: osmCollector ? "configured" : "disabled",
      assessment: assessor ? "configured" : "not_configured",
      research: !assessor ? "assessment_not_wired" : serperAdapter ? "configured" : "search_adapter_unavailable",
      scrapling: scraplingEnabled(env) ? "enabled_not_wired" : "disabled",
      vibe_fallback: vibeFallback ? "configured" : "not_configured",
    },
  };
}

