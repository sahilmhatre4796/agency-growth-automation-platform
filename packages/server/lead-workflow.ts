import { canonicalDiscoveryCountry } from "./market-targeting.ts";

// Advances one owner-selected lead through existing review and job APIs. A
// queued job ends this pass; the next pass uses its persisted result.
export type LeadWorkflowSnapshot = {
  country: string;
  leadStatus: string;
  identityReviewed: boolean;
  websiteStatus: string | null;
  serviceGapReviewed: boolean;
  qualificationStatus: string | null;
  sourcedEmailCount: number;
  contactId: string | null;
  verificationStatus: string | null;
  verificationReviewed: boolean;
  reportId: string | null;
  reportReady: boolean;
  permissionRecorded: boolean;
  draftId: string | null;
};

export type LeadWorkflowPorts = {
  requestVibe: () => Promise<"queued" | "cached">;
  evaluateQualification: () => Promise<string>;
  requestVerification: (contactId: string) => Promise<"queued" | "cached">;
  requestResearch: (contactId: string) => Promise<{ state: "queued" | "cached"; reportId?: string; ready?: boolean }>;
  createDraft: (reportId: string, contactId: string) => Promise<string>;
};

export type LeadWorkflowResult = {
  state: "owner_review" | "job_pending" | "draft_review";
  reason: string;
  completed: string[];
  draftId?: string;
};

export async function advanceLeadWorkflow(
  saved: LeadWorkflowSnapshot,
  ports: LeadWorkflowPorts,
  enabled: { vibe: boolean; verification: boolean; research: boolean; ai: boolean },
): Promise<LeadWorkflowResult> {
  const completed: string[] = [];
  const hold = (reason: string): LeadWorkflowResult => ({ state: "owner_review", reason, completed });
  const pending = (reason: string): LeadWorkflowResult => ({ state: "job_pending", reason, completed });
  if (["disqualified", "lost", "won"].includes(saved.leadStatus)) return hold("LEAD_NOT_ELIGIBLE");
  if (!saved.identityReviewed) return hold("BUSINESS_IDENTITY_REVIEW_REQUIRED");
  if (!saved.websiteStatus || saved.websiteStatus === "UNKNOWN") return hold("WEBSITE_ASSESSMENT_REQUIRED");
  if (!saved.serviceGapReviewed) return hold("REVIEWED_SERVICE_GAP_REQUIRED");
  const country = canonicalDiscoveryCountry(saved.country);
  if (!country) return hold("COUNTRY_REVIEW_REQUIRED");
  if (country === "India") return hold("INDIA_AUTOMATED_EMAIL_DISABLED");
  if (!saved.sourcedEmailCount) {
    if (!enabled.vibe) return hold("SOURCED_CONTACT_REQUIRED");
    const result = await ports.requestVibe();
    completed.push("vibe_requested");
    return result === "queued" ? pending("VIBE_DISCOVERY_PENDING") : hold("REVIEW_VIBE_CONTACTS");
  }
  if (!saved.contactId) return hold("REVIEWED_EMAIL_CONTACT_REQUIRED");
  if (saved.verificationStatus === "invalid") return hold("EMAIL_VERIFICATION_BLOCKED");
  if (["unknown", "risky"].includes(saved.verificationStatus ?? "")) {
    if (!saved.verificationReviewed) return hold("EMAIL_VERIFICATION_REVIEW_REQUIRED");
  } else if (saved.verificationStatus !== "valid") {
    if (!enabled.verification) return hold("MAILBOX_VERIFICATION_REVIEW_REQUIRED");
    await ports.requestVerification(saved.contactId);
    completed.push("verification_requested");
    return pending("EMAIL_VERIFICATION_PENDING");
  }
  if (!saved.permissionRecorded) return hold("RECIPIENT_PERMISSION_REQUIRED");
  // SQL qualification needs a reviewed, verified and permitted contact.
  let qualification = saved.qualificationStatus;
  if (qualification !== "QUALIFIED") {
    qualification = await ports.evaluateQualification();
    completed.push("qualification_evaluated");
    if (qualification !== "QUALIFIED") return hold("OWNER_QUALIFICATION_REQUIRED");
  }
  let reportId = saved.reportReady ? saved.reportId : null;
  if (!reportId) {
    if (!enabled.research) return hold("RESEARCH_REPORT_REVIEW_REQUIRED");
    const result = await ports.requestResearch(saved.contactId);
    completed.push("research_requested");
    if (result.state === "cached" && !result.ready) return hold("RESEARCH_REPORT_REVIEW_REQUIRED");
    if (result.state !== "cached" || !result.reportId) return pending("BUSINESS_RESEARCH_PENDING");
    reportId = result.reportId;
  }
  if (saved.draftId) return { state: "draft_review", reason: "OWNER_DRAFT_APPROVAL_REQUIRED", completed, draftId: saved.draftId };
  if (!enabled.ai) return hold("PERSONALIZED_AI_DISABLED");
  // The existing personalized-draft endpoint validates every factual claim,
  // suppression, consent, qualification and budget again before saving.
  const draftId = await ports.createDraft(reportId, saved.contactId);
  completed.push("draft_created");
  return { state: "draft_review", reason: "OWNER_DRAFT_APPROVAL_REQUIRED", completed, draftId };
}
