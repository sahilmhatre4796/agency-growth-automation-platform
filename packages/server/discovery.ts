import type { SearchAdapter, SearchHit } from "./research.ts";
import { safeResearchUrl } from "./research.ts";
import { extractPublicEmailCandidates, extractPublicPhoneCandidates } from "./vibe-contact-enrichment.ts";
import { canonicalDiscoveryCountry, hasUnambiguousCountryEvidence, mentionedDiscoveryCountries } from "./market-targeting.ts";

export type DiscoveryCandidate = {
  name: string;
  category: string;
  city: string;
  proposed_website_url: string | null;
  source_url: string;
  actual_provider: "serper";
  state: "review_needed";
  observed_at: string;
  evidence_quote: string;
  contacts: Array<{ kind: "email" | "phone" | "whatsapp"; value: string; evidence_excerpt: string }>;
};

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function possibleBusinessName(hit: SearchHit) {
  const beforeSeparator = hit.title.split(/\s+[|–—-]\s+/)[0]?.trim() ?? "";
  if (beforeSeparator.length < 3 || beforeSeparator.length > 80 || /\.\.\.|…|[\p{Extended_Pictographic}]/u.test(beforeSeparator)
    || /\b(best|top|list|directory|near me|results|largest|most famous|website link|instant buy)\b/i.test(beforeSeparator)
    || /^(contact|address|authenticity|shop no\b)/i.test(beforeSeparator)
    || /^(jewell?ery|jewelry) manufacturing services$/i.test(beforeSeparator)
    || /\b(company secretary|email\s*(?:&|and)\s*phone number|updated prices)\b|\.pdf\b/i.test(beforeSeparator)) return null;
  return beforeSeparator;
}

// Clear-cut off-ICP hits (jems/jewellery education with no trade markers) are
// dropped before identity verification; mixed markers fall through to the
// normal gates so ambiguous cases remain in human review.
const EDUCATION_MARKERS = /\b(institute|institutes|academy|college|university|polytechnic|school|training|vocational|gemology|gemological|diploma)\b/i;
const BUSINESS_TRADE_MARKERS = /\b(manufacturer|manufacturers|manufacturing|wholesale|wholesaler|trader|trading|distributor|supplier|exporter|exporters|retail|retailer|store|shop|showroom|boutique|dealer)\b/i;
function isEducationNotJewelleryBusiness(name: string, snippet: string): boolean {
  const text = `${normalized(name)} ${normalized(snippet)}`;
  return EDUCATION_MARKERS.test(text) && !BUSINESS_TRADE_MARKERS.test(text);
}

function credibleSearchIdentity(name: string, url: URL, snippet: string, city: string, country: string) {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (/(^|\.)(instagram|facebook|youtube|tiktok|pinterest|threads|booking|aeroleads)\.com$/.test(host)
    || /\.pdf$/i.test(url.pathname)) return false;
  const content = normalized(snippet);
  const location = normalized(city);
  // A city inside a brand name or SEO URL is not evidence that the business
  // operates there. Require a separate location mention in the excerpt.
  const locationContext = content.replaceAll(normalized(name), "");
  if (!new RegExp(`\\b${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(locationContext)) return false;
  const targetCountry = canonicalDiscoveryCountry(country);
  const countryMentions = mentionedDiscoveryCountries(locationContext);
  // The search target does not prove the business's market. International
  // candidates need an explicit, unambiguous country in public evidence.
  if (targetCountry && targetCountry !== "India" && !hasUnambiguousCountryEvidence(locationContext, country)) return false;
  if (targetCountry === "India" && countryMentions.some((item) => item !== "India")) return false;
  const tokens = normalized(name).replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((token) => token.length >= 4 && token !== location
      && !["business", "jewellery", "jewelry", "textiles", "manufacturing", "services", "store", "shop"].includes(token));
  if (!tokens.length) return false;
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const slug = url.pathname.toLowerCase().match(/^\/(?:company|showcase)\/([^/]+)/)?.[1] ?? "";
    return !!slug && content.includes(normalized(name)) && tokens.some((token) => slug.includes(token));
  }
  if (tokens.some((token) => host.includes(token))) return true;
  const directory = /(^|\.)(indiamart|justdial|sulekha|yelp|yellowpages|yell|tradeindia)\.com$/.test(host)
    || /(^|\.)truelocal\.com\.au$|(^|\.)yellow\.co\.nz$/.test(host)
    || host === "directory.example.org";
  const path = url.pathname.toLowerCase();
  return directory && content.includes(normalized(name)) && tokens.some((token) => path.includes(token));
}

// A search result is only a candidate observation. Its snippet is not an
// official-site check, a missing-website finding, or a contact verification.
// One paged search costs at most one reserved Serper credit; richer research
// stays in the separate review and contact workflows.
// Privacy-safe aggregate diagnostics for the paged_search filtering pipeline.
// Counters only — never per-result text, names, URLs, snippets or contacts.
export type DiscoveryFilterDiagnostics = {
  raw_results: number;
  name_rejected: number;
  education_rejected: number;
  unsafe_url_rejected: number;
  snippet_rejected: number;
  identity_rejected: number;
  duplicate_rejected: number;
  accepted: number;
};

export const newDiscoveryFilterDiagnostics = (): DiscoveryFilterDiagnostics => ({
  raw_results: 0, name_rejected: 0, education_rejected: 0, unsafe_url_rejected: 0,
  snippet_rejected: 0, identity_rejected: 0, duplicate_rejected: 0, accepted: 0,
});

export async function discoverSerperSearchCandidates(
  input: { industry: string; city: string; country: string; page: number; lane?: "website" | "automation" },
  adapter: SearchAdapter,
  observedAt = new Date().toISOString(),
  diagnostics?: DiscoveryFilterDiagnostics,
): Promise<DiscoveryCandidate[]> {
  const industry = input.industry.trim(), city = input.city.trim(), country = input.country.trim();
  if (industry.length < 3 || industry.length > 80 || city.length < 2 || city.length > 80 || country.length < 2 || country.length > 80
    || !Number.isInteger(input.page) || input.page < 1 || input.page > 15) throw new Error("INVALID_DISCOVERY_TARGET");
  // Do not require an official website in the search query: that would bias
  // the candidate pool against the very businesses the website lane seeks.
  // Results still require separate identity and website-status review.
  const preferredQuery = input.lane === "automation"
    ? `${industry} businesses ${city} ${country} customer enquiries ${country === "India" ? "WhatsApp" : "appointment booking"} -site:instagram.com -site:facebook.com -site:booking.com -site:aeroleads.com -filetype:pdf`
    : `${industry} ${city} ${country} -site:instagram.com -site:facebook.com -site:booking.com -site:aeroleads.com -site:yelp.com -site:indiamart.com -site:justdial.com -filetype:pdf`;
  const query = preferredQuery.length <= 300 ? preferredQuery
    : `${industry} ${city} ${country} ${input.lane === "automation" ? "online enquiries" : "email contact"}`;
  const hits = await adapter.search(query, 10, input.page);
  const counts = diagnostics ?? newDiscoveryFilterDiagnostics();
  counts.raw_results = hits.length;
  const seen = new Set<string>();
  const kept = hits.flatMap((hit) => {
    try {
      const name = possibleBusinessName(hit);
      if (!name) { counts.name_rejected += 1; return []; }
      if (isEducationNotJewelleryBusiness(name, hit.content ?? "")) { counts.education_rejected += 1; return []; }
      let url: string;
      try { url = safeResearchUrl(hit.url); } catch { counts.unsafe_url_rejected += 1; return []; }
      const snippet = hit.content.replace(/\s+/g, " ").trim();
      if (snippet.length < 15) { counts.snippet_rejected += 1; return []; }
      if (!credibleSearchIdentity(name, new URL(url), snippet, city, country)) { counts.identity_rejected += 1; return []; }
      // Directory results can contain separate business profile pages on one
      // host. Deduplicate the business identity, not the directory host.
      const key = normalized(`${name}|${city}|${country}`);
      if (seen.has(key)) { counts.duplicate_rejected += 1; return []; }
      seen.add(key);
      const contacts = [
        ...extractPublicEmailCandidates({ source_url: url, page_text: snippet,
          business_name: name, observed_at: observedAt, maximum: 3 }),
        ...extractPublicPhoneCandidates({ source_url: url, page_text: snippet,
          business_name: name, observed_at: observedAt, country, maximum: 3 }),
      ].map(({ kind, value, evidence_excerpt }) => ({ kind, value, evidence_excerpt }));
      const sourceHost = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      const isThirdPartyProfile = /(^|\.)(linkedin|indiamart|justdial|sulekha|yelp|yellowpages|yell|tradeindia)\.com$/.test(sourceHost)
        || /(^|\.)truelocal\.com\.au$|(^|\.)yellow\.co\.nz$/.test(sourceHost)
        || sourceHost === "directory.example.org";
      return [{ name, category: industry, city, proposed_website_url: isThirdPartyProfile ? null : url,
        source_url: url, actual_provider: "serper" as const, state: "review_needed" as const,
        observed_at: observedAt, evidence_quote: snippet.slice(0, 500), contacts }];
    } catch { counts.unsafe_url_rejected += 1; return []; }
  });
  const capped = kept.slice(0, 10);
  counts.accepted = capped.length;
  return capped;
}

// Weighted cumulative rounding spreads the two candidate-search lanes over
// successive pages. The ratio is a search allocation, never a qualification
// count; website presence and workflow gaps still require separate evidence.
export function discoverySearchLane(page: number, websitePercent: number): "website" | "automation" {
  if (!Number.isInteger(page) || page < 1 || page > 15 || !Number.isInteger(websitePercent)
    || websitePercent < 0 || websitePercent > 100) throw new Error("INVALID_DISCOVERY_ALLOCATION");
  return Math.round(page * websitePercent / 100) > Math.round((page - 1) * websitePercent / 100)
    ? "website" : "automation";
}

// Search results are suggestions only. A page can mention a business without being
// its official site, so every result remains in manual identity review.
export async function discoverSerperCandidates(
  input: { industry: string; city: string; country: string },
  adapter: SearchAdapter,
  observedAt = new Date().toISOString(),
): Promise<DiscoveryCandidate[]> {
  const industry = input.industry.trim();
  const city = input.city.trim();
  const country = input.country.trim();
  if (industry.length < 3 || industry.length > 80 || city.length < 2 || city.length > 80 || country.length < 2 || country.length > 80)
    throw new Error("INVALID_DISCOVERY_TARGET");
  const hits = await adapter.search(`${industry} businesses ${city} ${country} official website`, 8);
  const possible = hits.flatMap((hit) => {
    try {
      const name = possibleBusinessName(hit);
      return name ? [{ hit, name, url: safeResearchUrl(hit.url) }] : [];
    } catch { return []; }
  });
  const unique = possible.filter((item, index) => possible.findIndex((other) => new URL(other.url).hostname === new URL(item.url).hostname) === index).slice(0, 3);
  if (!unique.length) return [];
  const pages = await adapter.extract(unique.map((item) => item.url));
  return unique.flatMap((item) => {
    const page = pages.find((result) => {
      try { return new URL(result.url).hostname === new URL(item.url).hostname; } catch { return false; }
    });
    if (!page) return [];
    const content = page.raw_content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 12000);
    const lower = normalized(content);
    if (!lower.includes(normalized(item.name)) || !lower.includes(normalized(city)) || !lower.includes(normalized(industry))
      || (canonicalDiscoveryCountry(country) !== "India"
        && !hasUnambiguousCountryEvidence(lower.replaceAll(normalized(item.name), ""), country))) return [];
    const position = lower.indexOf(normalized(item.name));
    const quote = content.slice(Math.max(0, position - 50), Math.min(content.length, position + item.name.length + 140)).trim();
    const contacts: DiscoveryCandidate["contacts"] = extractPublicEmailCandidates({
      source_url: page.url, page_text: page.raw_content, business_name: item.name,
      observed_at: observedAt,
    }).map(({ kind, value, evidence_excerpt }) => ({ kind, value, evidence_excerpt }));
    return [{
      name: item.name, category: industry, city, proposed_website_url: page.url,
      source_url: page.url, actual_provider: "serper" as const,
      state: "review_needed" as const, observed_at: observedAt, evidence_quote: quote, contacts,
    }];
  });
}
