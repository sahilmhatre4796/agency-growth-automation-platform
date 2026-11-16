import { z } from "zod";
import { safeResearchUrl } from "./research.ts";

// Adapted from Harvey's bounded OpenStreetMap discovery strategy (MIT):
// https://github.com/ethanplusai/harvey/blob/addfb82c79ca8d95cf2382468d899145ec066453/harvey/collectors/discover.py
// PROVENANCE: this module is an OpenStreetMap listing collector. It is NOT the
// external Harvey application and no callable Harvey integration contract
// exists in this repository; results are reported as provider "osm".
// It never treats an absent OSM website tag as proof that a business lacks a
// site or service.
const categories = {
  dentist: [["amenity", "dentist"]],
  plumber: [["craft", "plumber"]],
  electrician: [["craft", "electrician"]],
  roofer: [["craft", "roofer"]],
  gardener: [["craft", "gardener"]],
} as const;
export type OsmCategory = keyof typeof categories;
export type OsmObservation = {
  name: string; proposed_website_url: string | null; provider_record_id: string;
  source_url: string; observed_at: string; category: OsmCategory;
  // Node/way coordinates preserved as source evidence (null when the element
  // carries no position).
  latitude: number | null; longitude: number | null;
  contacts: Array<{ kind: "email" | "phone" | "whatsapp"; value: string; evidence_excerpt: string }>;
};

// Legacy aliases: existing configuration (edge function
// harvey-osm-discovery-jobs and existing tests) still imports the Harvey-prefixed
// names. Kept until those callers migrate; new code must use the OSM names.
export type { OsmCategory as HarveyOsmCategory };
export type { OsmObservation as HarveyOsmObservation };

export function buildOsmQuery(input: { category: OsmCategory; latitude: number; longitude: number; radiusKm: number; limit: number }) {
  const tags = categories[input.category];
  if (!tags || !Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
    !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180 ||
    !Number.isFinite(input.radiusKm) || input.radiusKm < 1 || input.radiusKm > 10 ||
    !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 3)
    throw new Error("INVALID_OSM_TARGET");
  const radius = Math.round(input.radiusKm * 1000);
  const clauses = tags.flatMap(([key, value]) => ["node", "way"].map((type) =>
    `${type}[${key}=${value}](around:${radius},${input.latitude},${input.longitude});`)).join("");
  return `[out:json][timeout:15];(${clauses});out center ${input.limit};`;
}
export { buildOsmQuery as buildHarveyOsmQuery };

const osmResponse = z.object({ elements: z.array(z.object({
  type: z.enum(["node", "way", "relation"]), id: z.number().int().positive(),
  lat: z.number().optional(), lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
})).max(100).optional() });

export class OsmCollector {
  constructor(private transport: typeof fetch = fetch) {}
  async collect(input: { category: OsmCategory; latitude: number; longitude: number; radiusKm: number; limit: number },
    observedAt = new Date().toISOString()): Promise<OsmObservation[]> {
    const query = buildOsmQuery(input);
    const request = (endpoint: string) => this.transport(endpoint, {
      method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "ChainCraftSalesCommandCenter/0.1 (bounded owner-requested OSM research)" },
      body: query, signal: AbortSignal.timeout(20000),
    });
    // This public instance permits small projects; do not retry on another host.
    const response = await request("https://overpass.private.coffee/api/interpreter");
    if ([429, 504].includes(response.status)) throw new Error("OSM_RATE_LIMITED");
    if (!response.ok) throw new Error("OSM_UNAVAILABLE");
    const body = await response.text();
    if (body.length > 250000) throw new Error("OSM_RESPONSE_TOO_LARGE");
    const parsed = osmResponse.parse(JSON.parse(body));
    const seen = new Set<string>();
    const observations: OsmObservation[] = [];
    for (const element of parsed.elements ?? []) {
      const name = element.tags?.name?.trim() ?? "";
      if (name.length < 2 || name.length > 160) continue;
      const identifier = `osm:${element.type}/${element.id}`;
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      const proposed = element.tags?.website ?? element.tags?.["contact:website"] ?? null;
      let proposedWebsite: string | null = null;
      try { if (proposed) proposedWebsite = safeResearchUrl(proposed); } catch { /* An unsafe or malformed tag stays unconfirmed. */ }
      const contacts: OsmObservation["contacts"] = [];
      for (const tag of ["email", "contact:email"] as const) {
        const value = element.tags?.[tag]?.trim();
        if (value && value.length <= 254) contacts.push({ kind: "email", value, evidence_excerpt: `${tag}=${value}` });
      }
      for (const tag of ["phone", "contact:phone", "mobile", "contact:mobile", "contact:whatsapp"] as const) {
        const value = element.tags?.[tag]?.trim();
        if (value && value.length <= 40) contacts.push({ kind: tag === "contact:whatsapp" ? "whatsapp" : "phone", value, evidence_excerpt: `${tag}=${value}` });
      }
      observations.push({ name, proposed_website_url: proposedWebsite, provider_record_id: identifier,
        source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
        observed_at: observedAt, category: input.category,
        latitude: element.lat ?? element.center?.lat ?? null,
        longitude: element.lon ?? element.center?.lon ?? null,
        contacts });
      if (observations.length >= input.limit) break;
    }
    return observations;
  }
}
// Legacy alias — see note above. New code must use OsmCollector.
export { OsmCollector as HarveyOsmCollector };
