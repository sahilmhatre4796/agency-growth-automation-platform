import { normalizeContactValue } from "./vibe-contact-enrichment.ts";
import { safeResearchUrl } from "./research.ts";

const VIEWER = "https://explore.overturemaps.org/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASE = /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\.\d+$/;
const compact = (value: string) => value.trim().replace(/\s+/g, " ");
const key = (value: string | null | undefined) => compact(value ?? "").toLocaleLowerCase("en");
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown, max: number): string | null =>
  typeof value === "string" && compact(value).length <= max ? compact(value) || null : null;
const list = (value: unknown, max: number): unknown[] => Array.isArray(value) ? value.slice(0, max) : [];
const domain = (value: string | null | undefined) => {
  try { return value ? new URL(safeResearchUrl(value)).hostname.replace(/^www\./, "").toLowerCase() : null; }
  catch { return null; }
};

function locationKey(value: string | null | undefined, kind: "state" | "country") {
  const normalized = key(value);
  if (kind === "country" && ["us", "usa", "united states", "united states of america"].includes(normalized)) return "usa";
  if (kind === "state" && ["ca", "california"].includes(normalized)) return "california";
  return normalized;
}

export type OvertureKnownLead = {
  id: string; business_name: string; city: string | null; state_region: string | null;
  country: string | null; website_url?: string | null; emails?: string[]; phones?: string[];
};
export type OvertureCandidate = {
  id: string; release: string; businessName: string; category: string;
  city: string; stateRegion: string; country: string; address: null;
  sourceUrl: string; sources: Array<{ dataset: string; recordId: string; property: string | null;
    license: string | null; updatedAt: string | null }>;
  observedAt: string; websiteUrl: string | null; websiteStatus: "UNKNOWN";
  contacts: Array<{ kind: "email" | "phone"; value: string; sourceUrl: string;
    verificationStatus: "unknown"; reviewStatus: "pending" }>;
  recommendation: "Conditional professional website opportunity" | null;
  opportunityStatus: "conditional" | "not_established";
  duplicateLeadIds: string[]; reviewStatus: "pending"; identityStatus: "source_observation";
  attribution: string;
};

// Owner-provided official GeoJSON exports are reviewed locally. No Overture
// records, websites, or contacts are fetched or promoted by this parser.
export function parseOverturePlacesGeoJSON(
  payload: unknown,
  target: { city: string; state: string; country: string; limit: number; release: string },
  knownLeads: OvertureKnownLead[] = [],
  observedAt = new Date().toISOString(),
): OvertureCandidate[] {
  const root = record(payload);
  const city = string(target.city, 100), state = string(target.state, 120), country = string(target.country, 120);
  if (!city || !state || !country || !RELEASE.test(target.release) || !Number.isInteger(target.limit)
    || target.limit < 1 || target.limit > 15 || !Number.isFinite(Date.parse(observedAt))) throw new Error("INVALID_OVERTURE_TARGET");
  if (root?.type !== "FeatureCollection" || !Array.isArray(root.features) || root.features.length > 500)
    throw new Error("INVALID_OVERTURE_EXPORT");
  const results: OvertureCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of root.features) {
    const feature = record(raw), props = record(feature?.properties);
    const geometry = record(feature?.geometry);
    const coordinates = geometry?.coordinates;
    const id = string(feature?.id ?? props?.id, 80);
    const name = string(record(props?.names)?.primary, 160);
    const taxonomy = record(props?.taxonomy);
    const category = string(taxonomy?.primary ?? props?.basic_category, 100);
    const operating = key(string(props?.operating_status, 40));
    if (feature?.type !== "Feature" || geometry?.type !== "Point" || !Array.isArray(coordinates)
      || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number"
      || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90
      || !id || !UUID.test(id) || !name || !category
      || operating === "permanently_closed" || /(?:residential|private_residence|individual|person|household|apartment)/i.test(category)
      || (Array.isArray(props?.sources) && props.sources.length > 20)
      || (Array.isArray(props?.emails) && props.emails.length > 10)
      || (Array.isArray(props?.phones) && props.phones.length > 10)) continue;
    const address = list(props?.addresses, 5).map(record).find((item) => item
      && key(string(item.locality, 100)) === key(city)
      && locationKey(string(item.region, 120), "state") === locationKey(state, "state")
      && locationKey(string(item.country, 120), "country") === locationKey(country, "country"));
    if (!address) continue;
    const sources = list(props?.sources, 20).flatMap((value) => {
      const source = record(value);
      const dataset = string(source?.dataset, 80), recordId = string(source?.record_id, 300);
      const updated = string(source?.update_time, 80);
      return dataset && recordId ? [{ dataset, recordId, property: string(source?.property, 120),
        license: string(source?.license, 120),
        updatedAt: updated && Number.isFinite(Date.parse(updated)) ? updated : null }] : [];
    });
    if (!sources.length) continue;
    const identity = `${key(name)}|${key(city)}|${locationKey(state, "state")}|${locationKey(country, "country")}`;
    if (seen.has(id) || seen.has(identity)) continue;
    seen.add(id); seen.add(identity);
    const contacts: OvertureCandidate["contacts"] = [];
    for (const [kind, values] of [["email", props?.emails], ["phone", props?.phones]] as const) {
      for (const rawValue of list(values, 10)) {
        if (typeof rawValue !== "string") continue;
        try {
          const value = normalizeContactValue(kind, rawValue);
          if (!contacts.some((contact) => contact.kind === kind && contact.value === value))
            contacts.push({ kind, value, sourceUrl: VIEWER, verificationStatus: "unknown", reviewStatus: "pending" });
        } catch { /* Invalid source contact remains out of the review/promote path. */ }
      }
    }
    const websiteUrl = list(props?.websites, 5).flatMap((value) => {
      if (typeof value !== "string") return [];
      try { return [safeResearchUrl(value)]; } catch { return []; }
    })[0] ?? null;
    const duplicateLeadIds = knownLeads.filter((lead) => {
      const sameNameAndLocation = key(lead.business_name) === key(name) && key(lead.city) === key(city)
        && locationKey(lead.state_region, "state") === locationKey(state, "state")
        && (!lead.country || locationKey(lead.country, "country") === locationKey(country, "country"));
      const sameEmail = contacts.some((contact) => contact.kind === "email" &&
        lead.emails?.some((email) => key(email) === contact.value));
      const samePhone = contacts.some((contact) => contact.kind === "phone" &&
        lead.phones?.some((phone) => {
          try { return normalizeContactValue("phone", phone) === contact.value; } catch { return false; }
        }));
      const sameWebsite = !!websiteUrl && domain(lead.website_url) === domain(websiteUrl);
      return sameNameAndLocation || sameEmail || samePhone || sameWebsite;
    }).map((lead) => lead.id);
    const attribution = `Overture Maps Foundation · ${[...new Set(sources.map((source) => source.dataset))].join(", ")}`;
    results.push({ id, release: target.release, businessName: name, category, city, stateRegion: state,
      country, address: null, sourceUrl: VIEWER, sources, observedAt, websiteUrl,
      websiteStatus: "UNKNOWN", contacts,
      recommendation: websiteUrl ? null : "Conditional professional website opportunity",
      opportunityStatus: websiteUrl ? "not_established" : "conditional",
      duplicateLeadIds, reviewStatus: "pending", identityStatus: "source_observation", attribution });
  }
  return results.sort((a, b) => Number(!!a.websiteUrl) - Number(!!b.websiteUrl)
    || b.contacts.length - a.contacts.length || a.businessName.localeCompare(b.businessName)).slice(0, target.limit);
}
