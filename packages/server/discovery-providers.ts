// Production adapters connecting the discovery-coordinator ports to the
// project's existing research providers:
//
// - Serper: discoverSerperSearchCandidates() over the existing
//   SerperSearchAdapter/SearchAdapter contract (packages/server/discovery.ts).
// - OpenStreetMap: OsmCollector (packages/server/harvey-osm.ts, legacy file
//   name) — the bounded OSM listing collector. Results are reported as
//   provider "osm", never "harvey". The external Harvey Python application has
//   NO callable research contract in this repository; it feeds ChainCraft via
//   the intake RPC (harvey-integration.ts / ingest_discovered_business), which
//   is downstream of discovery and is not used here as a research provider.
//
// Construction never performs a network call. Real traffic happens only when a
// caller supplies a live adapter/collector — the env factories below stay
// fail-closed (flags off, missing keys) and unit tests inject fakes.
//
// These providers map listing observations into DiscoveredBusiness with
// website_status: null (UNKNOWN) — a search snippet or OSM tag never verifies
// a website — and location_source: "search_target", because neither provider
// carries a verified business address. Qualification still runs exclusively
// through qualifyLeadStrictly() inside the coordinator.
import { discoverSerperSearchCandidates, type DiscoveryCandidate } from "./discovery.ts";
import { OsmCollector, type OsmCategory, type OsmObservation } from "./harvey-osm.ts";
import { SerperSearchAdapter, type SearchAdapter } from "./research.ts";
import { normalizeContactValue, type ContactObservation } from "./vibe-contact-enrichment.ts";
import type { DiscoveredBusiness, DiscoveryJobInput, DiscoveryTarget } from "./discovery-coordinator.ts";

// Listing snippets/tags are provenance, not verified qualification evidence.
// qualifyLeadStrictly never reads this field (it scores website_problem,
// operational_need and serviceMatches only), so a fixed conservative value is
// safe here.
const LISTING_CONFIDENCE = 0.5;

export function mapDiscoveryCandidateToBusiness(
  candidate: DiscoveryCandidate,
  country: string,
): DiscoveredBusiness {
  return {
    // Search results carry no stable id; cross-run identity is handled by the
    // coordinator's domain/name+city+country dedup.
    provider_record_id: crypto.randomUUID(),
    business_name: candidate.name,
    website_url: candidate.proposed_website_url,
    website_status: null, // UNKNOWN until a real website assessment runs
    website_problem: null,
    operational_need: null,
    serviceMatches: [],
    city: candidate.city,
    state_region: null,
    country,
    // candidate.city comes from the search target, not a verified address.
    location_source: "search_target",
    source_url: candidate.source_url,
    observed_at: candidate.observed_at,
    evidence: [
      { kind: "serper", claim: candidate.evidence_quote, url: candidate.source_url, confidence: LISTING_CONFIDENCE },
    ],
    source_agent: "serper",
  };
}

// Serper snippet contacts come from extracted public evidence on result pages.
// A snippet alone never proves contact ownership: each observation keeps its
// source URL and excerpt so the coordinator can attribute, reconcile and
// preserve conflicts without treating any value as verified.
function mapSerperContacts(candidate: DiscoveryCandidate, lead_id: string): ContactObservation[] {
  const contacts: ContactObservation[] = [];
  const observedAt = candidate.observed_at;
  for (const c of candidate.contacts ?? []) {
    try {
      const normalized = normalizeContactValue(c.kind, c.value);
      contacts.push({
        lead_id,
        kind: c.kind,
        value: normalized,
        source_provider: "serper",
        source_url: candidate.source_url,
        observed_at: observedAt,
        evidence_excerpt: c.evidence_excerpt.trim().slice(0, 320),
        confidence: 0.55,
      });
    } catch { /* malformed snippet contact: never becomes evidence */ }
  }
  return contacts;
}

// OSM tags are candidate evidence, not verification. Each contact tag keeps
// its own source excerpt (the OSM tag) and provenance "osm" — never "harvey".
export function mapOsmContacts(observation: OsmObservation, lead_id: string): ContactObservation[] {
  const contacts: ContactObservation[] = [];
  const observedAt = observation.observed_at;
  for (const c of observation.contacts ?? []) {
    try {
      const normalized = normalizeContactValue(c.kind, c.value);
      contacts.push({
        lead_id,
        kind: c.kind,
        value: normalized,
        source_provider: "osm",
        source_url: observation.source_url,
        observed_at: observedAt,
        evidence_excerpt: c.evidence_excerpt.trim().slice(0, 320),
        confidence: 0.5,
      });
    } catch { /* malformed OSM contact tag: never becomes evidence */ }
  }
  return contacts;
}

export function mapOsmObservationToBusiness(
  observation: OsmObservation,
  target: { city: string | null; region: string | null; country: string },
): { business: DiscoveredBusiness; contacts: ContactObservation[] } {
  const coordinates =
    observation.latitude !== null && observation.longitude !== null
      ? ` at ${observation.latitude},${observation.longitude}`
      : "";
  return {
    business: {
      // OSM node identity (osm:node/123) preserved as the record's dedup key.
      provider_record_id: observation.provider_record_id,
      business_name: observation.name,
      // A present tag is an unverified claim; an absent tag proves nothing.
      website_url: observation.proposed_website_url,
      website_status: null, // UNKNOWN until a real website assessment runs
      website_problem: null,
      operational_need: null,
      serviceMatches: [],
      // OSM records carry no address; city/region come from the bounded radius
      // search target and stay search-area metadata, never a verified address.
      city: target.city,
      state_region: target.region,
      country: target.country,
      location_source: "search_target",
      source_url: observation.source_url,
      observed_at: observation.observed_at,
      evidence: [
        {
          kind: "osm",
          claim: `OpenStreetMap ${observation.category} listing${coordinates}`,
          url: observation.source_url,
          confidence: LISTING_CONFIDENCE,
        },
      ],
      source_agent: "osm",
    },
    contacts: mapOsmContacts(observation, observation.provider_record_id),
  };
}

export function createSerperProvider(deps: {
  adapter: SearchAdapter | null;
  lane?: "website" | "automation";
  page?: number;
  observedAt?: string;
}): DiscoveryJobInput["serper"] {
  return {
    search: async (target: DiscoveryTarget) => {
      if (!deps.adapter) return { businesses: [], error: "SERPER_NOT_CONFIGURED" };
      if (!target.industry || !target.city) return { businesses: [], error: "INVALID_DISCOVERY_TARGET" };
      try {
        const candidates = await discoverSerperSearchCandidates(
          {
            industry: target.industry,
            city: target.city,
            country: target.country,
            page: deps.page ?? 1,
            lane: deps.lane,
          },
          deps.adapter,
          deps.observedAt,
        );
        const limit = Number.isInteger(target.requested_count) && target.requested_count >= 0
          ? target.requested_count
          : candidates.length;
        // Business and its contacts must share one lead id, so they are mapped
        // together: contact candidates are provenance-preserving observations
        // (source "serper"), never qualification or verification evidence.
        const mapped = candidates.slice(0, limit).map((candidate) => {
          const business = mapDiscoveryCandidateToBusiness(candidate, target.country);
          return { business, contacts: mapSerperContacts(candidate, business.provider_record_id) };
        });
        return {
          businesses: mapped.map(({ business }) => business),
          contacts: mapped.flatMap(({ contacts }) => contacts),
        };
      } catch (err) {
        // Missing credentials, quota/rate exhaustion, timeouts, malformed
        // payloads and transport failures all surface as an explicit error;
        // the coordinator records failure/partial status from this.
        return { businesses: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// Fail-closed production wiring: no adapter without the discovery flag AND a
// real key. Construction itself never touches the network.
export function createSerperAdapterFromEnv(
  env: Record<string, string | undefined>,
  transport: typeof fetch = fetch,
): SearchAdapter | null {
  const key = env.SERPER_API_KEY;
  if (env.ENABLE_SERPER_DISCOVERY !== "true" || !key) return null;
  try {
    return new SerperSearchAdapter(key, transport);
  } catch {
    return null; // placeholder/invalid key: report not-configured, never throw at wiring time
  }
}

// The collector validates category/geo in buildOsmQuery() before any
// transport call, so unsupported targets fail without network traffic.
export function createOsmProvider(deps: {
  collector: Pick<OsmCollector, "collect"> | null;
  geo: { latitude: number; longitude: number; radiusKm?: number };
  observedAt?: string;
}): DiscoveryJobInput["osm"] {
  return {
    discover: async (target: DiscoveryTarget) => {
      if (!deps.collector) return { businesses: [], error: "OSM_DISCOVERY_DISABLED" };
      // Category derives from the industry target; invalid values throw
      // INVALID_OSM_TARGET from the collector before any request is made.
      const category = (target.industry ?? "").toLowerCase() as OsmCategory;
      try {
        // Collector bound: at most 3 listings per query.
        const limit = Math.min(Math.max(Math.trunc(target.requested_count) || 1, 1), 3);
        const observations = await deps.collector.collect(
          {
            category,
            latitude: deps.geo.latitude,
            longitude: deps.geo.longitude,
            radiusKm: deps.geo.radiusKm ?? 5,
            limit,
          },
          deps.observedAt,
        );
        const mapped = observations.map((o) => mapOsmObservationToBusiness(o, target));
        return { businesses: mapped.map(({ business }) => business), contacts: mapped.flatMap(({ contacts }) => contacts) };
      } catch (err) {
        return { businesses: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// Fail-closed production wiring: no collector without ENABLE_OSM_DISCOVERY.
// ENABLE_HARVEY_OSM_DISCOVERY stays as a compatibility alias because existing
// configuration (config/.env.example, the harvey-osm-discovery-* edge
// functions, staging docs) still uses it; do not remove until those migrate.
export function createOsmCollectorFromEnv(
  env: Record<string, string | undefined>,
  transport: typeof fetch = fetch,
): Pick<OsmCollector, "collect"> | null {
  const enabled = env.ENABLE_OSM_DISCOVERY === "true" || env.ENABLE_HARVEY_OSM_DISCOVERY === "true";
  return enabled ? new OsmCollector(transport) : null;
}
