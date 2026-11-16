import { z } from "zod";
import { buildEvidenceOnlyPreview, type ReviewedPreviewEvidence } from "./research-preview.ts";

// The model chooses only a stored fact ID. All factual copy and the service
// offer are rendered by the existing validated, non-sendable preview builder.
export const aiPreviewSelectionSchema = z.object({
  fact_id: z.uuid(), cta_variant: z.enum(["brief_example", "short_example"]),
  subject_variant: z.enum(["first", "second"]),
}).strict();

export function buildAISelectedResearchPreview(input: {
  leadId: string;
  businessName: string;
  evidence: Array<ReviewedPreviewEvidence & { lead_id: string }>;
  selection: unknown;
  serviceKey: "service_01" | "service_09";
  serviceName: string;
  matchConfidence: number;
  websiteStatus: string;
  requiredLocation?: string | null;
}, now = Date.now()) {
  const { fact_id: factId, cta_variant: ctaVariant, subject_variant: subjectVariant } =
    aiPreviewSelectionSchema.parse(input.selection);
  const sameLeadEvidence = input.evidence.filter((item) => item.lead_id === input.leadId);
  const fact = sameLeadEvidence.find((item) => item.id === factId);
  if (!fact) throw new Error("AI_EVIDENCE_NOT_FOR_LEAD");
  const preview = buildEvidenceOnlyPreview({
    businessName: input.businessName,
    fact,
    corroboration: sameLeadEvidence,
    serviceKey: input.serviceKey,
    serviceName: input.serviceName,
    matchConfidence: input.matchConfidence,
    websiteStatus: input.websiteStatus,
    requiredLocation: input.requiredLocation,
  }, now);
  const body = ctaVariant === "short_example"
    ? preview.body.replace("Would a brief example be useful?", "Would a short example help?")
    : preview.body;
  if (ctaVariant === "short_example" && body === preview.body)
    throw new Error("PREVIEW_CTA_UNAVAILABLE");
  if (preview.subjects.length !== 2) throw new Error("PREVIEW_SUBJECTS_UNAVAILABLE");
  const subjects = subjectVariant === "second"
    ? [preview.subjects[1], preview.subjects[0]] : preview.subjects;
  return { ...preview, subjects, body, generator: "groq_selected_template" as const };
}
