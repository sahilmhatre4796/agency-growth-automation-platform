import { renderPersonalizedEmail } from "../shared/personalization.ts";
import type { ResearchReport } from "./research.ts";
import { sourceAuthority } from "./source-authority.ts";

export type ReviewedPreviewEvidence = {
  id: string;
  source_url: string;
  claim: string;
  confidence: number;
  observed_at: string;
  reviewed_by: string | null;
  rejected_by: string | null;
};

export function previewProviderCallCap(raw: string | undefined): number {
  const cap = Number(raw);
  return Number.isSafeInteger(cap) && cap >= 1 && cap <= 10 ? cap : 0;
}

export function parsePreviewJobRequest(value: unknown): { dry_run: boolean; lead_ids: string[] | null; org_id?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["dry_run", "lead_ids", "org_id"].includes(key)) ||
    (body.dry_run !== undefined && typeof body.dry_run !== "boolean")) throw new Error("INVALID_REQUEST");
  // Optional org_id: intake-handoff batch sends it for preview idempotency scoping.
  if (body.org_id !== undefined && (typeof body.org_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.org_id)))
    throw new Error("INVALID_REQUEST");
  const orgId = body.org_id as string | undefined;
  if (body.lead_ids === undefined) return { dry_run: body.dry_run === true, lead_ids: null, org_id: orgId };
  if (!Array.isArray(body.lead_ids) || body.lead_ids.length < 1 || body.lead_ids.length > 10 ||
    body.lead_ids.some((id) => typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
    new Set(body.lead_ids.map((id: string) => id.toLowerCase())).size !== body.lead_ids.length)
    throw new Error("INVALID_LEAD_SCOPE");
  return { dry_run: body.dry_run === true, lead_ids: body.lead_ids, org_id: orgId };
}

export function ownerPreviewOrg(leadIds: string[] | null, rows: Array<{ id: string; org_id: string }>): string | null {
  if (!leadIds || rows.length !== leadIds.length ||
    new Set(rows.map((row) => row.org_id)).size !== 1 ||
    rows.some((row) => !leadIds.includes(row.id))) return null;
  return rows[0].org_id;
}

export function isBoundedAuditHandoff(internal: boolean, header: string | null, leadIds: string[] | null): boolean {
  return internal && header === "1" && leadIds?.length === 1;
}

export function hasCurrentAuditHandoff(observedAt: string | null | undefined, now = Date.now()): boolean {
  const at = Date.parse(observedAt ?? "");
  return Number.isFinite(at) && at <= now && at > now - 10 * 60000;
}

// A discovery observation alone cannot establish an official website or an
// unmet service need. This only selects a conditional internal research angle.
export function potentialPreviewService(input: {
  websiteUrl: string | null;
  assessment: { status: string; official_url: string | null; observed_at: string } | null;
}, now = Date.now()): "service_01" | "service_09" | null {
  const assessment = input.assessment;
  if (!assessment || !Number.isFinite(Date.parse(assessment.observed_at)) ||
    Date.parse(assessment.observed_at) <= now - 30 * 86400000 ||
    Date.parse(assessment.observed_at) > now) return null;
  if (!input.websiteUrl && assessment.status === "NO_OFFICIAL_WEBSITE_DISCOVERED" &&
    !assessment.official_url) return "service_01";
  if (input.websiteUrl && assessment.status === "WORKING" &&
    assessment.official_url === input.websiteUrl) return "service_09";
  return null;
}

// Research copy stays outside outbound_drafts. No contact, consent or Gmail
// account is needed, and this result has no transition to the send queue.
export function buildResearchPreview(input: {
  businessName: string;
  report: ResearchReport;
  evidence: ReviewedPreviewEvidence[];
  serviceName: string;
  gapEvidenceId: string;
  benefit: string;
  language?: "en" | "hinglish";
}, now = Date.now()) {
  const approved = new Map(input.evidence.filter((item) => item.reviewed_by && !item.rejected_by &&
    Number(item.confidence) >= 0.7 && Date.parse(item.observed_at) > now - 30 * 86400000 &&
    Date.parse(item.observed_at) <= now).map((item) => [item.id, item]));
  const gap = approved.get(input.gapEvidenceId);
  const fact = input.report.evidence.find((item) => item.kind === "business_fact" && item.confidence >= 0.7 &&
    approved.get(item.id)?.source_url === item.url && approved.get(item.id)?.claim === item.claim);
  if (!gap || !fact) throw new Error("REVIEWED_RESEARCH_EVIDENCE_REQUIRED");
  const draft = renderPersonalizedEmail(input.businessName, input.report,
    { fact_id: fact.id, competitor_id: null, language: input.language ?? "en" },
    { service_name: input.serviceName, gap_claim: gap.claim, gap_evidence_id: gap.id,
      benefit: input.benefit, confidence: Number(gap.confidence) });
  return { ...draft, evidence_ids: [...draft.evidence_ids, gap.id],
    state: "research_review" as const, generator: "grounded_template" as const };
}

// A conditional internal idea, never a claim that a business lacks a service.
// It cannot be approved or queued because it lives outside outbound_drafts.
export function buildEvidenceOnlyPreview(input: {
  businessName: string;
  fact: ReviewedPreviewEvidence;
  corroboration: ReviewedPreviewEvidence[];
  serviceKey: "service_01" | "service_09";
  serviceName: string;
  matchConfidence: number;
  websiteStatus: string;
  requiredLocation?: string | null;
}, now = Date.now()) {
  const name = input.businessName.trim().replace(/\s+/g, " ");
  const fact = input.fact;
  const current = (item: ReviewedPreviewEvidence) => !item.rejected_by &&
    Number(item.confidence) >= 0.8 && Date.parse(item.observed_at) > now - 30 * 86400000 &&
    Date.parse(item.observed_at) <= now && item.source_url?.startsWith("https://") &&
    item.claim.toLowerCase().includes(name.toLowerCase()) &&
    (!input.requiredLocation || item.claim.toLowerCase().includes(input.requiredLocation.toLowerCase()));
  if (!current(fact) || name.length < 3 || name.length > 120 || input.matchConfidence < 0.5 ||
    !Number.isFinite(input.matchConfidence)) throw new Error("PUBLIC_FACT_REVIEW_REQUIRED");
  let claim = fact.claim.replace(/[\r\n“”"]/g, " ").replace(/\s+/g, " ").trim();
  // A public directory often puts the address, phone and email after the
  // business name. Quote only its supported identity clause in the preview.
  if (input.serviceKey === "service_01" && /\bdirectory lists\b/i.test(claim)) {
    const nameEnd = claim.toLowerCase().indexOf(name.toLowerCase()) + name.length;
    if (nameEnd >= name.length && /^\s+at\s+\d/.test(claim.slice(nameEnd)))
      claim = `${claim.slice(0, nameEnd).replace(/[.,;:\s]+$/, "")}.`;
  }
  if (claim.length < 25 || claim.length > 180 || /@|\b(ignore|prompt|instruction|assistant|system|phone|gmail|email)\b/i.test(claim) ||
    /\b(unknown|unverified|requires owner review|does not establish)\b/i.test(claim))
    throw new Error("PUBLIC_FACT_REVIEW_REQUIRED");
  const host = sourceAuthority(fact.source_url);
  const corroborating = input.corroboration.find((item) => current(item) &&
    sourceAuthority(item.source_url) !== host);
  if (!corroborating)
    throw new Error("INDEPENDENT_IDENTITY_EVIDENCE_REQUIRED");
  if ((input.serviceKey === "service_01" && input.websiteStatus !== "NO_OFFICIAL_WEBSITE_DISCOVERED") ||
    (input.serviceKey === "service_09" && input.websiteStatus !== "WORKING"))
    throw new Error("SERVICE_CONTEXT_REVIEW_REQUIRED");
  if (input.serviceKey === "service_09" &&
    !/\b(24\s*\/\s*7|around.the.clock|emergency|booking|appointment|enquir(?:y|ies)|service requests?|calls?)\b/i.test(claim))
    throw new Error("CUSTOMER_WORKFLOW_EVIDENCE_REQUIRED");
  const shortName = name.split(" ").slice(0, 2).join(" ").replace(/[^\p{L}\p{N} &'’-]/gu, "");
  const offer = input.serviceKey === "service_01"
    ? "If a dedicated website is in your plans, we could explore a clear place for service details and enquiries."
    : "If improving your enquiry workflow is a priority, an AI receptionist could help route requests to your team.";
  const body = `Hi,\n\nI noticed this public detail about ${name}: “${claim}”\n\n${offer} Would a brief example be useful?\n\nBest,\nChainCraft Studio`;
  const subjects = input.serviceKey === "service_01"
    ? [`A website idea for ${shortName}`, `${shortName}: a clearer online home`]
    : [`A practical idea for ${shortName}`, `${shortName}: an enquiry idea`];
  if (body.trim().split(/\s+/).length > 90 ||
    subjects.some((subject) => subject.split(/\s+/).length < 4 || subject.split(/\s+/).length > 7))
    throw new Error("DRAFT_QUALITY_REVIEW_REQUIRED");
  return { subjects, body, evidence_ids: [fact.id, corroborating.id], fact_claim: claim,
    confidence: Math.min(Number(fact.confidence), input.matchConfidence),
    state: "research_review" as const, generator: "grounded_template" as const,
    basis: "potential_use_case" as const, service_name: input.serviceName };
}
