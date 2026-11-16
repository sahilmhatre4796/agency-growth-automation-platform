// A read-only view of the existing CRM gates. It never grants qualification,
// recipient permission, draft approval, or dispatch eligibility.
export type LeadReviewInput = {
  identityEvidenceCount: number;
  identityReviewed: boolean;
  websiteStatus: string | null;
  serviceGapReviewed: boolean;
  qualificationStatus: string | null;
  sourcedEmails: number;
  reviewedEmailContacts: number;
  verificationStatus: string | null;
  verificationReviewed: boolean;
  researchReady: boolean;
  recipientPermission: boolean;
  draftCount: number;
};

export function leadReviewReadiness(input: LeadReviewInput) {
  const holds: string[] = [];
  if (input.identityEvidenceCount < 1 || !input.identityReviewed) holds.push("Business identity evidence needs review");
  if (!input.websiteStatus || input.websiteStatus === "UNKNOWN") holds.push("Website status needs assessment");
  if (!input.serviceGapReviewed) holds.push("A service gap has not been reviewed");
  if (input.qualificationStatus !== "QUALIFIED") holds.push("Owner qualification is required");
  if (input.sourcedEmails < 1) holds.push("No sourced business email");
  else if (input.reviewedEmailContacts < 1) holds.push("Sourced email awaits contact review");
  if (input.verificationStatus === "invalid" ||
    (input.verificationStatus !== "valid" && !input.verificationReviewed))
    holds.push("Mailbox verification needs review");
  if (!input.researchReady) holds.push("Business research is not draft-ready");
  if (!input.recipientPermission) holds.push("Recipient permission is unrecorded");
  if (input.draftCount < 1) holds.push("No personalized draft exists");
  return { holds, ownerReviewRequired: holds.length > 0, draftPreviewAvailable: input.draftCount > 0 };
}
