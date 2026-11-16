import { z } from "zod";
import { extractPublicDecisionMakers, type PublicDecisionMaker } from "./vibe-prospecting.ts";
import { extractPublicEmailCandidates } from "./vibe-contact-enrichment.ts";
import { sourceAuthority } from "./source-authority.ts";

export type SearchHit = { title: string; url: string; content: string; score: number };
export type ExtractedPage = { url: string; raw_content: string };
export interface SearchAdapter {
  search(query: string, maxResults: number, page?: number): Promise<SearchHit[]>;
  extract(urls: string[]): Promise<ExtractedPage[]>;
}
const hitSchema = z.object({ title: z.string(), url: z.url(), content: z.string(), score: z.number().optional() });

// One report can make two searches and scrape at most four pages. Reserve the
// conservative upper bound before the worker creates this adapter.
export const SERPER_MAX_CREDITS_PER_REPORT = 42;
export class SerperSearchAdapter implements SearchAdapter {
  private remainingCredits: number;
  constructor(private apiKey: string, private transport: typeof fetch = fetch,
    creditLimit = SERPER_MAX_CREDITS_PER_REPORT, private extractCharLimit = 12000) {
    if (!apiKey || apiKey === "your_key_here") throw new Error("SERPER_NOT_CONFIGURED");
    if (!Number.isInteger(creditLimit) || creditLimit < 1 || creditLimit > SERPER_MAX_CREDITS_PER_REPORT)
      throw new Error("INVALID_SERPER_CREDIT_LIMIT");
    if (!Number.isInteger(extractCharLimit) || extractCharLimit < 1000 || extractCharLimit > 100000)
      throw new Error("INVALID_EXTRACT_CHAR_LIMIT");
    this.remainingCredits = creditLimit;
  }
  private async request(endpoint: "search" | "scrape", body: unknown, maximumCredits: number) {
    if (this.remainingCredits < maximumCredits) throw new Error("SERPER_LOCAL_CREDIT_CAP");
    // Count the maximum before requesting. A timeout must not allow a retry to
    // spend the same local allowance twice when provider acceptance is unknown.
    this.remainingCredits -= maximumCredits;
    const response = await this.transport(endpoint === "search" ? "https://google.serper.dev/search" : "https://scrape.serper.dev", {
      method: "POST", headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if ([402, 429].includes(response.status)) throw new Error("SERPER_CREDITS_OR_RATE_EXHAUSTED");
    if (!response.ok) throw new Error("SERPER_UNAVAILABLE");
    const content = await response.text();
    if (content.length > 250000) throw new Error("SERPER_RESPONSE_TOO_LARGE");
    const payload = JSON.parse(content) as unknown;
    const envelope = z.object({ credits: z.number().int().nonnegative().optional(), error: z.unknown().optional() }).passthrough().parse(payload);
    if (envelope.error) throw new Error("SERPER_UNAVAILABLE");
    if (envelope.credits !== undefined && envelope.credits > maximumCredits) throw new Error("SERPER_CREDIT_COST_UNEXPECTED");
    return payload;
  }
  async search(query: string, maxResults = 5, page = 1): Promise<SearchHit[]> {
    if (query.length > 300 || maxResults < 1 || maxResults > 10 || !Number.isInteger(page) || page < 1 || page > 15) throw new Error("INVALID_RESEARCH_QUERY");
    const result = z.object({ organic: z.array(z.object({ title: z.string(), link: z.url(), snippet: z.string().optional(), position: z.number().optional() })).max(100).optional() })
      .parse(await this.request("search", { q: query, num: 10, page }, 1));
    return (result.organic ?? []).slice(0, maxResults).map((hit) => ({
      title: hit.title.slice(0, 200), url: hit.link, content: (hit.snippet ?? "").slice(0, 2000), score: hit.position ? 1 / hit.position : 0,
    }));
  }
  async extract(urls: string[]): Promise<ExtractedPage[]> {
    if (!urls.length || urls.length > 3) throw new Error("INVALID_EXTRACT_BATCH");
    const pages: ExtractedPage[] = [];
    for (const input of urls) {
      const url = safeResearchUrl(input);
      const result = z.object({ text: z.string().optional() }).parse(await this.request("scrape", { url, includeMarkdown: false }, 10));
      if (result.text) pages.push({ url, raw_content: result.text.slice(0, this.extractCharLimit) });
    }
    return pages;
  }
}

export class TavilySearchAdapter implements SearchAdapter {
  constructor(private apiKey: string, private transport: typeof fetch = fetch) {
    if (!apiKey || apiKey === "your_key_here") throw new Error("TAVILY_NOT_CONFIGURED");
  }
  private async request(path: "search" | "extract", body: unknown) {
    const response = await this.transport(`https://api.tavily.com/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429 || response.status === 432 || response.status === 433)
      throw new Error("TAVILY_CREDITS_OR_RATE_EXHAUSTED");
    if (!response.ok) throw new Error("TAVILY_UNAVAILABLE");
    const text = await response.text();
    if (text.length > 250000) throw new Error("TAVILY_RESPONSE_TOO_LARGE");
    return JSON.parse(text) as unknown;
  }
  async search(query: string, maxResults = 5): Promise<SearchHit[]> {
    if (query.length > 300 || maxResults < 1 || maxResults > 8) throw new Error("INVALID_RESEARCH_QUERY");
    const result = z.object({ results: z.array(hitSchema).max(20) }).parse(await this.request("search", {
      query, search_depth: "basic", max_results: maxResults, include_answer: false,
      include_raw_content: false, include_images: false, include_usage: true,
    }));
    return result.results.map((hit) => ({ title: hit.title.slice(0, 200), url: hit.url, content: hit.content.slice(0, 2000), score: hit.score ?? 0 }));
  }
  async extract(urls: string[]): Promise<ExtractedPage[]> {
    if (!urls.length || urls.length > 4) throw new Error("INVALID_EXTRACT_BATCH");
    const safe = urls.map(safeResearchUrl);
    const result = z.object({ results: z.array(z.object({ url: z.url(), raw_content: z.string() })).max(20), failed_results: z.array(z.unknown()).optional() })
      .parse(await this.request("extract", { urls: safe, extract_depth: "basic", format: "text", include_images: false, include_usage: true }));
    return result.results.filter((page) => safe.some((url) => new URL(url).hostname === new URL(page.url).hostname))
      .map((page) => ({ url: page.url, raw_content: page.raw_content.slice(0, 12000) }));
  }
}

export function safeResearchUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname === "localhost" ||
    /\.(local|internal|localhost)$/i.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
    url.hostname.includes(":") || !url.hostname.includes(".")) throw new Error("RESEARCH_URL_NOT_PERMITTED");
  url.hash = "";
  return url.toString();
}

export type ResearchEvidence = { id: string; kind: "business_fact" | "competitor" | "website"; claim: string; url: string; observed_at: string; confidence: number };
export type ResearchReport = {
  state: "ready" | "manual_review";
  website: { status: "verified" | "not_verified"; url: string | null };
  evidence: ResearchEvidence[];
  competitors: Array<{ name: string; url: string; capability: string; evidence_id: string }>;
  contact_candidates?: Array<{ email: string; source_url: string; observed_at: string; confidence: number }>;
  decision_maker_candidates?: PublicDecisionMaker[];
  contact_observations?: ReturnType<typeof extractPublicEmailCandidates>;
  opportunity: "website_presence_review" | "website_improvement_review" | "business_research_only" | "appointment_workflow_review" |
    "whatsapp_enquiry_workflow_review" | "dealer_ordering_workflow_review" | "customer_support_workflow_review";
  confidence: number;
  reason: string;
};

function meaningfulSentence(content: string, name: string) {
  const clean = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 6000);
  const sentences = clean.split(/(?<=[.!?])\s+/).map((part) => part.trim());
  return sentences.filter((sentence) => sentence.length >= 25 && sentence.length <= 180 &&
    /\b(design|build|create|offer|provide|speciali[sz]|craft|make|produce|develop|serve|launch|deliver)\w*\b/i.test(sentence) &&
    !/\b(ignore|instruction|prompt|system|assistant)\b/i.test(sentence) &&
    (sentence.toLowerCase().includes(name.toLowerCase().split(" ")[0]) || /\b(we|our)\b/i.test(sentence))).slice(0, 2);
}

export function publicWorkflowSignal(content: string) {
  const lines = content.slice(0, 12000).replace(/<(?:br|\/p|\/div)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ").split(/[\r\n]+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 20 && line.length <= 200 && !/\b(ignore previous|system prompt|assistant instruction)\b/i.test(line));
  const patterns = [
    { opportunity: "appointment_workflow_review" as const, pattern: /\b(?:book|schedule|request|confirm)\b.{0,65}\b(?:appointments?|consultations?|reservations?|visits?)\b|\b(?:appointments?|consultations?|reservations?)\b.{0,65}\b(?:book|schedule|request|confirm)\b/i },
    { opportunity: "whatsapp_enquiry_workflow_review" as const, pattern: /\bwhatsapp\b.{0,65}\b(?:enquir(?:y|ies)|booking|reservation|order|support|contact)\b|\b(?:enquir(?:y|ies)|booking|reservation|order|support)\b.{0,65}\bwhatsapp\b/i },
    { opportunity: "dealer_ordering_workflow_review" as const, pattern: /\b(?:dealer|wholesale|distributor)\b.{0,65}\b(?:orders?|quotations?|enquir(?:y|ies))\b|\b(?:orders?|quotations?)\b.{0,65}\b(?:dealer|wholesale|distributor)\b/i },
    { opportunity: "customer_support_workflow_review" as const, pattern: /\b(?:track|check)\b.{0,40}\b(?:order|shipment|delivery)\b|\b(?:customer support|help desk)\b.{0,65}\b(?:enquir(?:y|ies)|orders?|questions?)\b/i },
  ];
  for (const { opportunity, pattern } of patterns) {
    const claim = lines.find((line) => pattern.test(line) && !/\b(?:book online|online booking|instant booking|self.service booking|automated whatsapp|whatsapp chatbot|ai chatbot|ai receptionist|automatic order tracking)\b/i.test(line));
    if (claim) return { opportunity, claim };
  }
  return null;
}

export async function researchBusiness(input: {
  name: string; websiteUrl?: string | null; industry?: string | null; market?: string | null;
}, adapter: SearchAdapter, observedAt = new Date().toISOString()): Promise<ResearchReport> {
  if (input.name.trim().length < 2 || input.name.length > 120) throw new Error("INVALID_BUSINESS_NAME");
  const hits = await adapter.search(`${input.name} ${input.market ?? ""} official website`, 5);
  const supplied = input.websiteUrl ? safeResearchUrl(input.websiteUrl) : null;
  // Search hits are suggestions. A page mentioning a business, including a
  // directory page, does not establish that it is the official website.
  const officialCandidate = supplied;
  const evidence: ResearchEvidence[] = [];
  let verified: ExtractedPage | undefined;
  if (officialCandidate) {
    const extracted = await adapter.extract([officialCandidate]);
    verified = extracted.find((page) => {
      try { return new URL(safeResearchUrl(page.url)).hostname === new URL(officialCandidate).hostname &&
        page.raw_content.toLowerCase().includes(input.name.toLowerCase()); }
      catch { return false; }
    });
    if (verified) evidence.push({ id: crypto.randomUUID(), kind: "website", claim: "The business website returned readable content during research", url: verified.url, observed_at: observedAt, confidence: 0.85 });
  }
  for (const claim of verified ? meaningfulSentence(verified.raw_content, input.name) : []) {
    evidence.push({ id: crypto.randomUUID(), kind: "business_fact", claim, url: verified!.url, observed_at: observedAt, confidence: 0.8 });
  }
  // A business with no confirmed site can still have two independent public
  // pages describing its work. These facts remain owner-reviewable; they do
  // not prove that an official website is absent.
  if (!supplied && !verified) {
    const candidates = hits.flatMap((hit) => {
      try { return [{ url: safeResearchUrl(hit.url), host: new URL(hit.url).hostname.replace(/^www\./, ""),
        authority: sourceAuthority(hit.url) }]; }
      catch { return []; }
    }).filter((item, index, all) => all.findIndex((other) => other.authority === item.authority) === index).slice(0, 3);
    if (candidates.length >= 2) {
      const pages = await adapter.extract(candidates.map((item) => item.url));
      const facts = candidates.flatMap((candidate) => {
        const page = pages.find((item) => new URL(item.url).hostname.replace(/^www\./, "") === candidate.host);
        if (!page || !page.raw_content.toLowerCase().includes(input.name.toLowerCase()) ||
          (input.market && !page.raw_content.toLowerCase().includes(input.market.toLowerCase()))) return [];
        const claim = meaningfulSentence(page.raw_content, input.name)
          .find((sentence) => sentence.toLowerCase().includes(input.name.toLowerCase().split(" ")[0]));
        return claim ? [{ id: crypto.randomUUID(), kind: "business_fact" as const, claim,
          url: page.url, observed_at: observedAt, confidence: 0.7 }] : [];
      });
      if (new Set(facts.map((fact) => sourceAuthority(fact.url))).size >= 2) evidence.push(...facts);
    }
  }
  const workflow = verified ? publicWorkflowSignal(verified.raw_content) : null;
  if (workflow && !evidence.some((item) => item.claim === workflow.claim))
    evidence.push({ id: crypto.randomUUID(), kind: "business_fact", claim: workflow.claim, url: verified!.url,
      observed_at: observedAt, confidence: 0.7 });
  const contactCandidates: NonNullable<ResearchReport["contact_candidates"]> = [];
  const decisionMakerCandidates = verified ? extractPublicDecisionMakers({
    business_name: input.name, official_page_url: verified.url,
    public_page_text: verified.raw_content, observed_at: observedAt,
  }) : [];
  const contactObservations = verified ? extractPublicEmailCandidates({
    source_url: verified.url, page_text: verified.raw_content,
    observed_at: observedAt, business_name: input.name,
  }) : [];
  if (verified) {
    const domain = new URL(verified.url).hostname.toLowerCase().replace(/^www\./, "");
    const found = verified.raw_content.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
    for (const raw of found) {
      const email = raw.toLowerCase().replace(/[),.;]+$/, "");
      if (email.split("@")[1] !== domain || contactCandidates.some((item) => item.email === email)) continue;
      contactCandidates.push({ email, source_url: verified.url, observed_at: observedAt, confidence: 0.65 });
      if (contactCandidates.length === 3) break;
    }
  }
  const competitors: ResearchReport["competitors"] = [];
  if (input.industry && input.market && verified) {
    const candidates = await adapter.search(`${input.industry} ${input.market} businesses websites`, 6);
    const possible = candidates.flatMap((hit) => {
      const name = hit.title.split(/\s+[|–—-]\s+/)[0]?.trim() ?? "";
      if (name.length < 3 || name.length > 100 || /\b(best|top|list|directory|near me|results)\b/i.test(name)) return [];
      try { return new URL(safeResearchUrl(hit.url)).hostname !== new URL(verified!.url).hostname ? [{ hit, name }] : []; }
      catch { return []; }
    });
    const unique = possible.filter((item, index) => possible.findIndex((other) =>
      new URL(other.hit.url).hostname === new URL(item.hit.url).hostname) === index).slice(0, 3);
    if (unique.length) {
      const pages = await adapter.extract(unique.map(({ hit }) => hit.url));
      for (const { hit, name } of unique) {
        const page = pages.find((item) => new URL(item.url).hostname === new URL(hit.url).hostname);
        if (!page || !page.raw_content.toLowerCase().includes(input.industry.toLowerCase()) ||
          !page.raw_content.toLowerCase().includes(input.market.toLowerCase()) ||
          !page.raw_content.toLowerCase().includes(name.toLowerCase())) continue;
        const capability = meaningfulSentence(page.raw_content, name).find((sentence) =>
          sentence.toLowerCase().includes(input.industry!.toLowerCase()));
        if (!capability) continue;
        const id = crypto.randomUUID();
        evidence.push({ id, kind: "competitor", claim: capability, url: page.url, observed_at: observedAt, confidence: 0.65 });
        competitors.push({ name, url: page.url, capability, evidence_id: id });
      }
    }
  }
  const facts = evidence.filter((item) => item.kind === "business_fact");
  const corroboratedPublicFacts = !supplied && new Set(facts.map((fact) => sourceAuthority(fact.url))).size >= 2;
  const state = (verified && facts.length) || corroboratedPublicFacts ? "ready" : "manual_review";
  return {
    state,
    website: { status: verified ? "verified" : "not_verified", url: verified?.url ?? null },
    evidence, competitors: competitors.slice(0, 3), contact_candidates: contactCandidates,
    decision_maker_candidates: decisionMakerCandidates,
    contact_observations: contactObservations,
    opportunity: verified ? workflow?.opportunity ?? "business_research_only" : "website_presence_review",
    confidence: state === "ready" ? verified ? 0.8 : 0.7 : 0.25,
    reason: corroboratedPublicFacts ?
      "Two independent public pages describe this business. Official website status is unconfirmed here and requires a separate reviewed assessment" :
      state === "ready" ? workflow
      ? "The supplied website describes a customer workflow that may suit automation. Whether an adequate system already exists is unknown; owner review and a discovery conversation are required"
      : "Supplied website content supports at least one concrete business fact. No website defect or automation gap was established; owner review is required" :
      hits.length && !supplied ? "Search suggested possible websites, but none is confirmed as official; manual identity review required" :
        "Insufficient verified public information; manual research required",
  };
}
