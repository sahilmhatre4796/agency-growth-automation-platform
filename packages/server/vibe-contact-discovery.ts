import { safeResearchUrl, type SearchAdapter } from "./research.ts";
import { extractPublicEmailCandidates, extractPublicPhoneCandidates, type ContactObservation } from "./vibe-contact-enrichment.ts";
import { extractPublicDecisionMakers } from "./vibe-prospecting.ts";

export const VIBE_CONTACT_MAX_SERPER_CREDITS = 21; // one search + at most two scrapes

// Reuse a page already fetched by the pinned, robots-aware website audit.
// No search API, second HTTP request, mailbox probe or inferred address.
export function discoverAuditedOfficialContacts(input: {
  lead_id: string; business_name: string; official_url: string;
  audited_url: string; page_text: string; observed_at: string; country?: string | null;
}): ContactObservation[] {
  const official = safeResearchUrl(input.official_url);
  const audited = safeResearchUrl(input.audited_url);
  if (host(official) !== host(audited) || !input.business_name.trim() ||
    !input.page_text.toLowerCase().includes(input.business_name.trim().toLowerCase())) return [];
  const domain = host(official);
  const emails = extractPublicEmailCandidates({ source_url: audited,
    page_text: input.page_text, observed_at: input.observed_at,
    business_name: input.business_name, maximum: 10 }).filter((item) => {
    const emailDomain = item.value.toLowerCase().split("@")[1];
    return emailDomain === domain || (emailDomain === "gmail.com" &&
      item.evidence_excerpt.toLowerCase().includes(input.business_name.toLowerCase()));
  }).map((item) => ({ ...item, lead_id: input.lead_id,
    source_provider: "official_website" as const }));
  const phones = extractPublicPhoneCandidates({ source_url: audited,
    page_text: input.page_text, observed_at: input.observed_at,
    business_name: input.business_name, country: input.country, maximum: 5 })
    .map((item) => ({ ...item, lead_id: input.lead_id,
      source_provider: "official_website" as const }));
  return [...emails, ...phones].slice(0, 15);
}

function host(value: string) {
  return new URL(safeResearchUrl(value)).hostname.toLowerCase().replace(/^www\./, "");
}

// The caller must have a reviewed official website for this exact lead. Search
// snippets are only a page locator; evidence is extracted from fetched pages.
export async function discoverVibePublicContacts(input: {
  lead_id: string; business_name: string; official_website_url: string; country?: string | null;
}, adapter: SearchAdapter, observedAt = new Date().toISOString()): Promise<ContactObservation[]> {
  const site = safeResearchUrl(input.official_website_url);
  const domain = host(site);
  if (!input.business_name.trim() || !domain) throw new Error("OFFICIAL_IDENTITY_REQUIRED");
  const hits = await adapter.search(`site:${domain} contact email ${input.business_name.trim()}`.slice(0, 300), 8);
  const candidates = [
    ...hits.filter((hit) => /contact|about|team|reach|connect/i.test(hit.url + " " + hit.title))
      .sort((a, b) => Number(/contact/i.test(b.url)) - Number(/contact/i.test(a.url)))
      .map((hit) => hit.url),
    site,
  ];
  const urls: string[] = [];
  for (const candidate of candidates) {
    try {
      const safe = safeResearchUrl(candidate);
      if (host(safe) === domain && !urls.includes(safe)) urls.push(safe);
    } catch { /* An unsafe or off-domain hit never reaches extraction. */ }
    if (urls.length === 2) break;
  }
  if (!urls.length) return [];
  const pages = await adapter.extract(urls);
  const emails: ContactObservation[] = [];
  const phones: ContactObservation[] = [];
  for (const page of pages) {
    try {
      if (host(page.url) !== domain || !urls.includes(safeResearchUrl(page.url))) continue;
      const names = extractPublicDecisionMakers({ business_name: input.business_name,
        official_page_url: page.url, public_page_text: page.raw_content, observed_at: observedAt });
      for (const person of names.filter((item) => item.email &&
        item.evidence_excerpt.toLowerCase().includes(item.email.toLowerCase()))) {
        emails.push({ lead_id: input.lead_id, kind: "email", value: person.email!, source_provider: "vibe",
          source_url: page.url, observed_at: observedAt, evidence_excerpt: person.evidence_excerpt,
          confidence: person.confidence, contact_name: person.full_name, role: person.role });
      }
      for (const candidate of extractPublicEmailCandidates({
        source_url: page.url, page_text: page.raw_content, observed_at: observedAt,
        business_name: input.business_name, official_domain_confirmed: true, maximum: 10,
      })) emails.push({ ...candidate, lead_id: input.lead_id, source_provider: "vibe",
        confidence: 0.65 });
      for (const candidate of extractPublicPhoneCandidates({
        source_url: page.url, page_text: page.raw_content, observed_at: observedAt,
        business_name: input.business_name, official_domain_confirmed: true, country: input.country, maximum: 5,
      })) phones.push({ ...candidate, lead_id: input.lead_id, source_provider: "vibe" });
    } catch { /* An invalid provider page does not become contact evidence. */ }
  }
  // Email evidence remains first even when a page also lists many phone lines.
  return [...emails, ...phones].slice(0, 20);
}

// For businesses with no confirmed website, only an owner-reviewed listing
// URL already tied to this CRM lead may be scanned. The business name and
// address must share one short listing passage; a whole directory page is
// never treated as one business's contact card.
export async function discoverVibeListingContacts(input: {
  lead_id: string; business_name: string; city: string; country?: string | null; reviewed_listing_url: string;
}, adapter: SearchAdapter, observedAt = new Date().toISOString()): Promise<ContactObservation[]> {
  const listing = safeResearchUrl(input.reviewed_listing_url);
  if (!input.business_name.trim() || !input.city.trim()) throw new Error("REVIEWED_LISTING_IDENTITY_REQUIRED");
  const pages = await adapter.extract([listing]);
  const page = pages.find((item) => {
    try { return safeResearchUrl(item.url) === listing; } catch { return false; }
  });
  if (!page) return [];
  const passages = page.raw_content.slice(0, 100000).split(/\r?\n|<\/(?:li|p|article|div)>/i)
    .map((part) => part.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 10 && part.length <= 320 &&
      part.toLowerCase().includes(input.business_name.toLowerCase()) &&
      part.toLowerCase().includes(input.city.toLowerCase()));
  const emails: ContactObservation[] = [], phones: ContactObservation[] = [];
  for (const passage of passages) {
    for (const candidate of extractPublicEmailCandidates({ source_url: listing, page_text: passage,
      observed_at: observedAt, business_name: input.business_name, maximum: 10 })) {
      emails.push({ ...candidate, lead_id: input.lead_id, source_provider: "vibe", confidence: 0.5 });
    }
    for (const candidate of extractPublicPhoneCandidates({ source_url: listing, page_text: passage,
      observed_at: observedAt, business_name: input.business_name, country: input.country, maximum: 5 })) {
      phones.push({ ...candidate, lead_id: input.lead_id, source_provider: "vibe", confidence: 0.5 });
    }
  }
  return [...emails, ...phones].slice(0, 20);
}
