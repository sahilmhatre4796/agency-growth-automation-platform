import { safeResearchUrl } from "./research.ts";
import { canonicalDiscoveryCountry, DEFAULT_DISCOVERY_COUNTRIES, mentionedDiscoveryCountries, SELECTABLE_DISCOVERY_COUNTRIES } from "./market-targeting.ts";
import { z } from "zod";

export type VibeFilters = {
  mode: "enrich_existing" | "discover_new";
  industry: string | null;
  city: string | null;
  region: string | null;
  country: string;
  countries: string[];
  requested_count: number;
  decision_maker_role: string | null;
  website_criterion: "missing_or_broken" | "ecommerce_opportunity" | "improvement" | "any";
  require_public_email: boolean;
  needs_review: string[];
  lead_category: "mixed" | "website" | "automation";
  website_percent: number;
  website_industries: string[];
  automation_industries: string[];
};

export function industryMatches(category: string | null, targets: string[]) {
  if (!targets.length) return true;
  const normalize = (value: string) => value.toLocaleLowerCase("en").trim().replace(/(?:ies|s)$/, (suffix) => suffix === "ies" ? "y" : "");
  const value = normalize(category ?? "");
  return targets.some((target) => value.includes(normalize(target)) || normalize(target).includes(value) && value.length >= 3);
}

export function leadTargets(total: number, websitePercent = 70, category: VibeFilters["lead_category"] = "mixed") {
  if (!Number.isInteger(total) || total < 1 || total > 500 || !Number.isInteger(websitePercent) || websitePercent < 0 || websitePercent > 100)
    throw new Error("INVALID_LEAD_TARGET");
  const website = category === "website" ? total : category === "automation" ? 0 : Math.round(total * websitePercent / 100);
  return { website, automation: total - website };
}

// Qualification is based on reviewed evidence, never merely on an absent URL
// or the general industry. A research_needed match is shown for owner review.
export function classifyLeadOpportunity(input: {
  website_url: string | null;
  assessment_status: string | null;
  matches: { service_key: string; status: string; reason: string; evidence_ids: string[]; confidence: number }[];
}) {
  const website = !input.website_url && input.assessment_status === "NO_OFFICIAL_WEBSITE_DISCOVERED"
    ? input.matches.find((match) => match.service_key === "service_01" && match.status === "verified_gap" && match.evidence_ids.length > 0) : undefined;
  if (website) return { category: "website" as const, match: website, qualified: true, qualification_status: "reviewed_no_site" as const };
  const automation = input.matches.find((match) => /^service_(09|10|11|12|13|14|15|16|17|18|19|20|23|24)$/.test(match.service_key)
    && match.status === "verified_gap" && match.evidence_ids.length > 0);
  if (automation) return { category: "automation" as const, match: automation, qualified: true, qualification_status: "evidence_supported_opportunity" as const };
  const hypothesis = input.matches.find((match) => /^service_(09|10|11|12|13|14|15|16|17|18|19|20|23|24)$/.test(match.service_key)
    && match.status === "research_needed" && match.evidence_ids.length > 0);
  if (hypothesis) return { category: "automation" as const, match: hypothesis,
    // Public workflow evidence can justify a discovery call, but cannot
    // certify that a prospect's private automation is missing or inadequate.
    qualified: false,
    qualification_status: hypothesis.confidence >= 0.6 && hypothesis.reason.trim().length >= 20
      ? "potential_needs_discovery_call" as const : "hypothesis_needs_research" as const };
  return { category: "unclassified" as const, match: null, qualified: false, qualification_status: "insufficient_evidence" as const };
}

export function opportunityPriority(input: {
  category: "website" | "automation";
  match_confidence: number;
  reviewed_evidence_count: number;
  has_sourced_email: boolean;
  has_sourced_phone: boolean;
}) {
  if (!Number.isFinite(input.match_confidence) || input.match_confidence < 0 || input.match_confidence > 1
    || !Number.isInteger(input.reviewed_evidence_count) || input.reviewed_evidence_count < 1)
    throw new Error("INVALID_OPPORTUNITY_EVIDENCE");
  const evidence = Math.min(input.reviewed_evidence_count, 3);
  // Independent rankings: automation has no website-presence term.
  const score = input.category === "website"
    ? 40 + Math.round(input.match_confidence * 25) + evidence * 6 + (input.has_sourced_email ? 12 : 0) + (input.has_sourced_phone ? 5 : 0)
    : 25 + Math.round(input.match_confidence * 35) + evidence * 8 + (input.has_sourced_email ? 12 : 0) + (input.has_sourced_phone ? 4 : 0);
  return Math.min(100, score);
}

export function websiteServiceLabel(category: string | null) {
  const value = (category ?? "").toLocaleLowerCase("en");
  if (/restaurant|cafe|hotel|hospitality/.test(value)) return "Restaurant & hospitality website";
  if (/jewell?ery|diamond/.test(value)) return "Premium jewellery business website";
  if (/construction|contractor|builder|architect/.test(value)) return "Company portfolio website";
  if (/retail|shop|store/.test(value)) return "Product catalogue website";
  return "Professional business website";
}

export const vibeModelSchema = z.object({
  mode: z.enum(["enrich_existing", "discover_new"]),
  industry: z.string().min(2).max(80).nullable(),
  city: z.string().min(2).max(80).nullable(),
  country: z.string().min(2).max(80),
  requested_count: z.number().int().min(1).max(500),
  decision_maker_role: z.string().max(100).nullable(),
  website_criterion: z.enum(["missing_or_broken", "ecommerce_opportunity", "improvement", "any"]),
  require_public_email: z.boolean(),
}).strict();

export function groundedVibeModelFilters(request: string, modelOutput: unknown): VibeFilters {
  const parsed = vibeModelSchema.parse(modelOutput);
  const lower = request.toLocaleLowerCase("en");
  const explicitCount = /\b(?:find|show|discover|search for|these)\s+(\d{1,3})\b/i.exec(request);
  const countAppears = explicitCount !== null;
  const localCriterion = parseVibeRequest(request).website_criterion;
  const localMode = parseVibeRequest(request).mode;
  const local = parseVibeRequest(request);
  const proposedCountry = canonicalDiscoveryCountry(parsed.country);
  if ((parsed.industry && !lower.includes(parsed.industry.toLocaleLowerCase("en"))) ||
    (parsed.city && !lower.includes(parsed.city.toLocaleLowerCase("en"))) ||
    (!proposedCountry || proposedCountry !== local.country) ||
    (parsed.decision_maker_role && !lower.includes(parsed.decision_maker_role.toLocaleLowerCase("en"))) ||
    (countAppears ? parsed.requested_count !== Number(explicitCount[1]) : parsed.requested_count !== 10) ||
    (localCriterion === "any" && parsed.website_criterion !== "any") ||
    (parsed.mode !== localMode) ||
    (parsed.require_public_email && !parseVibeRequest(request).require_public_email)) throw new Error("UNGROUNDED_PROSPECT_FILTER");
  const warnings: string[] = [];
  if (parsed.mode === "discover_new" && !parsed.industry) warnings.push("Specify the business type or industry.");
  if (parsed.mode === "discover_new" && !parsed.city) warnings.push("Specify the city or geographic market.");
  if (!countAppears) warnings.push("Prospect count defaulted to 10; confirm it before searching.");
  return { ...parsed, country: proposedCountry, countries: local.countries, region: local.region,
    needs_review: warnings, lead_category: local.lead_category, website_percent: local.website_percent,
    website_industries: local.website_industries, automation_industries: local.automation_industries };
}

// This free, local interpretation is deliberately conservative. An ambiguous
// request stays editable rather than being silently sent to a paid model.
export function parseVibeRequest(request: string): VibeFilters {
  const text = request.trim().replace(/\s+/g, " ");
  if (text.length < 15 || text.length > 1000) throw new Error("INVALID_PROSPECT_REQUEST");
  const count = /\b(?:find|show|discover|search for|these)\s+(\d{1,3})\b/i.exec(text);
  const requestedCount = count ? Number(count[1]) : 10;
  if (requestedCount < 1 || requestedCount > 500) throw new Error("PROSPECT_COUNT_OUT_OF_RANGE");
  const explicitlyMixed = /\b70\s*\/\s*30\b|\bwebsite\s+(?:development\s+)?leads\b.*\bautomation\s+leads\b|\b70\b.{0,80}\b30\b/i.test(text);
  const singleAutomation = /\b(?:automation|ai receptionist|whatsapp (?:automation|chatbot)) leads\b/i.test(text) && !explicitlyMixed;
  const singleWebsite = /\b(?:website development|no official website|without (?:official )?websites?) leads\b/i.test(text) && !explicitlyMixed && !singleAutomation;
  const leadCategory = singleAutomation ? "automation" : singleWebsite ? "website" : "mixed";
  const ratio = /\b(\d{1,3})\s*%?\s*\/\s*(\d{1,3})\s*%?\b/.exec(text);
  const websitePercent = ratio && Number(ratio[1]) + Number(ratio[2]) === 100 ? Number(ratio[1]) : 70;
  const categoryFocus = /\bprioritiz\w*\s+(.{3,60}?)\s+for\s+website\s+development\s+and\s+(.{3,60}?)\s+for\s+automation\b/i.exec(text);
  const focusIndustries = (value: string | undefined) => value ? [...new Set(value.split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i)
    .map((part) => part.replace(/\b(?:businesses|companies|firms|shops|stores)\b/gi, "").trim().toLocaleLowerCase("en"))
    .filter((part) => part.length >= 3 && part.length <= 40))] : [];
  const industryMatch = /\b(?:find|show|discover|search for)\s+(?:\d{1,3}\s+)?(.{3,80}?)\s+(?:businesses|companies|shops|firms|clinics|stores)\s+in\s+/i.exec(text);
  const directMarketMatch = /\b(?:find|show|discover|search for)\s+(?:\d{1,3}\s+)?(?:some\s+|local\s+|the\s+)?([\p{L}][\p{L}\s&-]{2,60}?)\s+in\s+([\p{L}][\p{L}\s.-]{1,60}?)(?=\s+(?:that|with|which|who|needing|for)\b|\s+and\s+(?:find|locate|verify|cross-check|collect)\b|[.,;]|$)/iu.exec(text);
  const rawIndustry = industryMatch?.[1]?.replace(/^(?:some|local|the)\s+/i, "").trim() || directMarketMatch?.[1]?.trim() || null;
  const industry = rawIndustry && !/^(?:business(?:es)?(?: leads)?|prospects|leads|automation leads)$/i.test(rawIndustry) ? rawIndustry : null;
  const cityMatch = /\b(?:businesses|companies|shops|firms|clinics|stores)\s+in\s+([\p{L}][\p{L}\s.-]{1,60}?)(?=\s+(?:that|with|which|who|needing|for)\b|\s+and\s+(?:find|locate|verify|cross-check|collect)\b|[.,;]|$)/iu.exec(text);
  const broadCity = /\b(?:business(?:es)?(?:\s+leads)?|companies|prospects|automation\s+leads|leads)\s+in\s+([\p{L}][\p{L}\s.-]{1,60}?)(?=\s+(?:using|with|and|for|that|who|prioritiz\w*)\b|\s*[.,;:—–]|$)/iu.exec(text);
  const mode = /\b(?:these\s+(?:\d{1,3}\s+)?(?:businesses|leads)|existing\s+(?:crm\s+)?leads|already discovered|my crm|in my crm|all existing leads|missing email)\b/i.test(text)
    ? "enrich_existing" : "discover_new";
  const namedCountries = mentionedDiscoveryCountries(text);
  const countries = namedCountries.length ? namedCountries
    : [...(mode === "enrich_existing" ? SELECTABLE_DISCOVERY_COUNTRIES : DEFAULT_DISCOVERY_COUNTRIES)];
  const country = countries[0];
  const rawCity = cityMatch?.[1]?.trim() || directMarketMatch?.[2]?.trim() || broadCity?.[1]?.trim() || null;
  const cityWithoutCountry = rawCity?.replace(/\s+(?:United States(?: of America)?|USA|U\.S\.A\.?|Australia|New Zealand|NZ|United Arab Emirates|UAE|United Kingdom|UK|Great Britain|Britain|India|Bharat|IN)$/i, "").trim() || null;
  const city = cityWithoutCountry && !canonicalDiscoveryCountry(cityWithoutCountry) ? cityWithoutCountry : null;
  const regionMatch = /\b(?:state|province|emirate|region)\s*(?:of|:)?\s+([\p{L}][\p{L}\s.-]{1,60}?)(?=\s+(?:and|with|for|in)\b|[.,;]|$)/iu.exec(text);
  const region = regionMatch?.[1]?.trim() || null;
  const websiteCriterion = /\b(?:(?:missing|no|broken|offline|nonfunctional)\s+(?:or\s+broken\s+)?|without\s+(?:an?\s+)?(?:official\s+)?)website/i.test(text)
    ? "missing_or_broken" : /\b(?:e-?commerce|online\s+(?:shop|store|checkout))\b/i.test(text)
      ? "ecommerce_opportunity" : /\b(?:outdated|redesign|improv\w*|slow|poor\s+mobile)\b/i.test(text)
        ? "improvement" : "any";
  const role = /\b(owner|founder|co-founder|director|managing director|ceo|chief executive|decision.?maker)s?\b/i.exec(text)?.[1] ?? null;
  const needsReview: string[] = [];
  if (mode === "discover_new" && !industry && !broadCity) needsReview.push("Specify the business type or industry.");
  if (mode === "discover_new" && !city && !namedCountries.length) needsReview.push("Specify the city or geographic market.");
  if (mode === "discover_new" && !city && !region) needsReview.push("Choose a city or region before a live discovery campaign.");
  if (!namedCountries.length && city && /^(?:surat|mumbai|pune|delhi)$/i.test(city))
    needsReview.push("Country is unconfirmed for this city; select India manually if intended.");
  if (!count) needsReview.push("Prospect count defaulted to 10; confirm it before searching.");
  return {
    mode, industry: mode === "enrich_existing" ? null : industry,
    city: mode === "enrich_existing" ? null : city,
    region: mode === "enrich_existing" ? null : region,
    country, countries, requested_count: requestedCount,
    decision_maker_role: role?.toLowerCase() ?? null,
    website_criterion: websiteCriterion,
    require_public_email: /\b(?:only|with)\s+(?:a\s+)?(?:sourced\s+|public\s+)?(?:emails?|e-mails?|gmail)\b/i.test(text),
    needs_review: needsReview,
    lead_category: leadCategory, website_percent: websitePercent,
    website_industries: focusIndustries(categoryFocus?.[1]), automation_industries: focusIndustries(categoryFocus?.[2]),
  };
}

export type PublicDecisionMaker = {
  full_name: string;
  role: string;
  email: string | null;
  email_status: "publicly_sourced" | "unknown";
  source_url: string;
  observed_at: string;
  evidence_excerpt: string;
  confidence: number;
};

export interface ContactEnrichmentProvider {
  readonly id: string;
  // Optional licensed providers must return their own provenance and costs.
  lookup(input: { business_name: string; domain: string; maximum_cost: number }): Promise<PublicDecisionMaker[]>;
}

const rolePattern = "(?:co-founder|founder|owner|managing director|director|chief executive officer|chief executive|ceo|proprietor)";
const namePattern = "[\\p{Lu}][\\p{L}.'-]+(?:\\s+[\\p{Lu}][\\p{L}.'-]+){1,3}";
const nameThenRole = new RegExp(`\\b(?<name>${namePattern})\\s*(?:[-–—,|:]\\s*)?(?<role>${rolePattern})\\b`, "iu");
const roleThenName = new RegExp(`\\b(?<role>${rolePattern})\\s*(?:[-–—,|:]\\s*)?(?<name>${namePattern})\\b`, "iu");
const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function extractPublicDecisionMakers(input: {
  business_name: string;
  official_page_url: string;
  public_page_text: string;
  observed_at: string;
}): PublicDecisionMaker[] {
  const sourceUrl = safeResearchUrl(input.official_page_url);
  if (!Number.isFinite(Date.parse(input.observed_at))) throw new Error("INVALID_OBSERVATION_TIME");
  const lines = input.public_page_text.slice(0, 12000).split(/[\r\n]+/)
    .map((line) => line.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 12 && line.length <= 320);
  const results: PublicDecisionMaker[] = [];
  for (const line of lines) {
    if (/\b(?:ignore previous|system prompt|assistant instruction)\b/i.test(line)) continue;
    const match = nameThenRole.exec(line) ?? roleThenName.exec(line);
    if (!match?.groups) continue;
    const name = match.groups.name.trim();
    const role = match.groups.role.trim();
    if (!name.split(/\s+/).every((part) => /^\p{Lu}/u.test(part))) continue;
    if (name.toLocaleLowerCase("en") === input.business_name.trim().toLocaleLowerCase("en")) continue;
    const emails = [...new Set((line.match(emailPattern) ?? []).map((email) => email.toLowerCase().replace(/[),.;]+$/, "")))];
    const email = emails.length === 1 && emails[0].length <= 254 ? emails[0] : null;
    if (results.some((result) => result.full_name.toLocaleLowerCase("en") === name.toLocaleLowerCase("en") && result.email === email)) continue;
    results.push({
      full_name: name, role, email,
      email_status: email ? "publicly_sourced" : "unknown",
      source_url: sourceUrl, observed_at: input.observed_at,
      evidence_excerpt: line, confidence: email ? 0.7 : 0.5,
    });
    if (results.length === 3) break;
  }
  return results;
}
