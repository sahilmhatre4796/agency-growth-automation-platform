import { z } from "zod";
import type { ResearchReport } from "../server/research.ts";

export const personalizedSelectionSchema = z.object({
  fact_id: z.uuid(), competitor_id: z.uuid().nullable(),
  language: z.enum(["en", "hinglish"]),
}).strict();
export type PersonalizedSelection = z.infer<typeof personalizedSelectionSchema>;

export const approvedOpportunitySchema = z.object({
  service_name: z.string().trim().min(3).max(100),
  gap_claim: z.string().trim().min(20).max(150),
  gap_evidence_id: z.uuid(),
  benefit: z.string().trim().min(8).max(80),
  confidence: z.number().min(0.7).max(1),
}).strict();
export type ApprovedOpportunity = z.infer<typeof approvedOpportunitySchema>;

export function reviewedNoSiteDraftEligible(input: {
  reportWebsite: ResearchReport["website"];
  leadWebsiteUrl: string | null;
  assessmentStatus: string | null;
  assessmentObservedAt: string | null;
  serviceKey: string | null;
}, now = Date.now()) {
  const observed = Date.parse(input.assessmentObservedAt ?? "");
  return input.reportWebsite.status === "not_verified" && !input.reportWebsite.url &&
    !input.leadWebsiteUrl && input.assessmentStatus === "NO_OFFICIAL_WEBSITE_DISCOVERED" &&
    input.serviceKey === "service_01" && Number.isFinite(observed) &&
    observed > now - 30 * 86400000 && observed <= now;
}

export function renderPersonalizedEmail(name: string, report: ResearchReport, proposed: PersonalizedSelection, proposedOpportunity: ApprovedOpportunity) {
  const selection = personalizedSelectionSchema.parse(proposed);
  const opportunity = approvedOpportunitySchema.parse(proposedOpportunity);
  const publicPageCase = report.website.status === "not_verified" && !report.website.url &&
    report.opportunity === "website_presence_review" &&
    new Set(report.evidence.filter((item) => item.kind === "business_fact" && item.confidence >= 0.7)
      .map((item) => new URL(item.url).hostname.replace(/^www\./, ""))).size >= 2;
  if (report.state !== "ready" || (report.website.status !== "verified" && !publicPageCase))
    throw new Error("RESEARCH_REVIEW_REQUIRED");
  const fact = report.evidence.find((item) => item.id === selection.fact_id && item.kind === "business_fact" && item.confidence >= 0.7);
  if (!fact || (!publicPageCase && (!report.website.url || new URL(fact.url).hostname !== new URL(report.website.url).hostname)))
    throw new Error("FACT_NOT_EVIDENCED");
  const competitor = selection.competitor_id
    ? report.competitors.find((item) => item.evidence_id === selection.competitor_id &&
        report.evidence.some((evidence) => evidence.id === item.evidence_id && evidence.kind === "competitor" &&
          evidence.confidence >= 0.6 && evidence.claim === item.capability && evidence.url === item.url))
    : undefined;
  if (selection.competitor_id && !competitor) throw new Error("COMPETITOR_NOT_VERIFIED");
  const quote = fact.claim.replace(/[\r\n"“”]/g, " ").replace(/\s+/g, " ").trim();
  if (quote.length < 25 || quote.length > 180) throw new Error("FACT_TOO_WEAK");
  const gap = opportunity.gap_claim.replace(/[\r\n"“”]/g, " ").replace(/\s+/g, " ").trim();
  const competitorFact = competitor?.capability.replace(/[\r\n"“”]/g, " ").replace(/\s+/g, " ").trim();
  if (competitorFact && (competitorFact.length < 25 || competitorFact.length > 180)) throw new Error("COMPETITOR_FACT_TOO_WEAK");
  if (/\b(ignore|instruction|prompt|system|assistant)\b/i.test(gap)) throw new Error("GAP_CLAIM_UNSAFE");
  const safeName = name.trim().replace(/[\r\n]/g, " ");
  const shortName = safeName.split(/\s+/).slice(0, 2).join(" ").replace(/[^\p{L}\p{N} &'’-]/gu, "").trim();
  const serviceTopic = opportunity.service_name.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter((word) => word && !/^(a|an|and|the|for|with|of|to)$/i.test(word)).slice(0, 2).join(" ").toLowerCase() || "service";
  const subjects = selection.language === "en"
    ? [`An idea for ${shortName}`, `${shortName}: ${serviceTopic} idea`]
    : [`${shortName} ke liye ek idea`, `${shortName}: ${serviceTopic} par idea`];
  const compose = (comparison: string | undefined) => selection.language === "en"
    ? `Hi,\n\n${publicPageCase ? `A public page about ${safeName} says` : `I noticed this on ${safeName}'s site`}: “${quote}”\n\n${comparison ? `For context, ${competitor!.name}'s site says: “${comparison}”\n\n` : ""}I also saw: “${gap}” A ${opportunity.service_name.toLowerCase()} could help with ${opportunity.benefit.toLowerCase()}.\n\nWould a practical idea be useful?\n\nBest,\nChainCraft Studio`
    : `Hi,\n\n${publicPageCase ? `${safeName} ke baare mein ek public page par yeh dekha` : `${safeName} ki site par yeh dekha`}: “${quote}”\n\n${comparison ? `${competitor!.name} ki site par likha hai: “${comparison}”\n\n` : ""}Maine yeh bhi dekha: “${gap}” ${opportunity.service_name} se ${opportunity.benefit.toLowerCase()} mein help ho sakti hai.\n\nEk practical idea share karun?\n\nBest,\nChainCraft Studio`;
  let citedCompetitor = competitorFact;
  let body = compose(citedCompetitor);
  if (body.trim().split(/\s+/).length > 90 && citedCompetitor) {
    citedCompetitor = undefined;
    body = compose(undefined);
  }
  const wordCount = body.trim().split(/\s+/).length;
  if (wordCount > 90 || subjects.some((subject) => subject.split(/\s+/).length < 4 || subject.split(/\s+/).length > 7))
    throw new Error("DRAFT_QUALITY_REVIEW_REQUIRED");
  return {
    subjects, body, word_count: wordCount, confidence: Math.min(report.confidence, fact.confidence, opportunity.confidence),
    evidence_ids: [fact.id, ...(citedCompetitor ? [competitor!.evidence_id] : [])],
    gap_evidence_id: opportunity.gap_evidence_id,
    suggested_service: opportunity.service_name, review_required: true,
  };
}
