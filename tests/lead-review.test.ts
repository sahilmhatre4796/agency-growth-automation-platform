import { describe, expect, test } from "vitest";
import { leadReviewReadiness, type LeadReviewInput } from "../packages/server/lead-review.ts";
import { reconcileContactObservations, type ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";
import { verifyEmailAddress } from "../packages/server/email-verification.ts";
import { renderPersonalizedEmail } from "../packages/shared/personalization.ts";
import { scheduleApprovedDraft } from "../packages/server/gmail-backlog.ts";

const observed = "2026-10-23T06:00:00Z";
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
const source = {
  gannon: "https://www.livermoreca.gov/Home/Components/BusinessDirectory/BusinessDirectory/162/4646",
  graf: "https://www.livermoreca.gov/Home/Components/BusinessDirectory/BusinessDirectory/194/4646",
  grafPdf: "https://www.livermoreca.gov/home/showpublisheddocument/13667/639081493479670000",
  arch: "https://archplumbinginc.com/",
};
function observation(lead_id: string, kind: "email" | "phone", value: string, source_url: string): ContactObservation {
  return { lead_id, kind, value, source_provider: "vibe", source_url, observed_at: observed,
    evidence_excerpt: `Public business contact: ${value}`, confidence: 0.8 };
}

describe("saved USA lead evidence, read-only", () => {
  test("keeps the three business identities and Graf's two distinct emails separate", () => {
    // These are the seven already-saved public contact observations, with their
    // recorded source URLs. This test performs no fresh research or CRM write.
    const points = reconcileContactObservations([
      observation(ids[0], "email", "gannonbackflow@example.com", source.gannon),
      observation(ids[0], "phone", "+1555010015", source.gannon),
      observation(ids[1], "email", "graflance0803@example.com", source.graf),
      observation(ids[1], "email", "graflance0806@example.com", source.grafPdf),
      observation(ids[1], "phone", "+1555010014", source.graf),
      observation(ids[2], "email", "service@archplumbinginc.com", source.arch),
      observation(ids[2], "phone", "+1555010011", source.arch),
    ]);
    expect(points).toHaveLength(7);
    expect(points.filter((point) => point.kind === "email")).toHaveLength(4);
    expect(points.filter((point) => point.lead_id === ids[1] && point.kind === "email").map((point) => point.normalized_value))
      .toEqual(["graflance0803@example.com", "graflance0806@example.com"]);
    expect(points.every((point) => !point.corroborated)).toBe(true);
  });
});

const eligible: LeadReviewInput = {
  identityEvidenceCount: 2, identityReviewed: true, websiteStatus: "WORKING", serviceGapReviewed: true,
  qualificationStatus: "QUALIFIED", sourcedEmails: 1, reviewedEmailContacts: 1, verificationStatus: "valid", verificationReviewed: false,
  researchReady: true, recipientPermission: true, draftCount: 1,
};

test("ten synthetic leads stop at the first real review gate and only one reaches draft review", async () => {
  const cases: Array<[Partial<LeadReviewInput>, string]> = [
    [{}, ""],
    [{ identityReviewed: false }, "Business identity evidence needs review"],
    [{ websiteStatus: null }, "Website status needs assessment"],
    [{ serviceGapReviewed: false }, "A service gap has not been reviewed"],
    [{ qualificationStatus: "RESEARCH_NEEDED" }, "Owner qualification is required"],
    [{ sourcedEmails: 0, reviewedEmailContacts: 0 }, "No sourced business email"],
    [{ reviewedEmailContacts: 0 }, "Sourced email awaits contact review"],
    [{ verificationStatus: "unknown" }, "Mailbox verification needs review"],
    [{ recipientPermission: false }, "Recipient permission is unrecorded"],
    [{ draftCount: 0 }, "No personalized draft exists"],
  ];
  expect(cases).toHaveLength(10);
  let progressedToDraftReview = 0;
  for (const [index, [variation, expectedHold]] of cases.entries()) {
    const email = `lead${index}@example.test`;
    const points = reconcileContactObservations(index === 5 ? [] : [observation(
      `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`, "email", email,
      "https://example.test/contact",
    )]);
    const verification = index === 5 ? null : await verifyEmailAddress({ email, resolver: {
      resolve: async () => ({ Status: 0, Answer: [{ type: 15, data: "10 mail.example.test." }] }),
    }, advanced: { verify: async () => ({ is_reachable: index === 7 ? "unknown" : "safe" }) } });
    const result = leadReviewReadiness({ ...eligible, sourcedEmails: points.length,
      verificationStatus: verification?.status ?? null, ...variation });
    if (expectedHold) expect(result.holds).toContain(expectedHold);
    else { expect(result.holds).toEqual([]); progressedToDraftReview++; }
  }
  expect(progressedToDraftReview).toBe(1);
  const verification = await verifyEmailAddress({ email: "owner@example.test", resolver: {
    resolve: async () => ({ Status: 0, Answer: [{ type: 15, data: "10 mail.example.test." }] }),
  } });
  expect(verification.status).toBe("unknown"); // MX cannot establish the mailbox.
  const factId = "00000000-0000-4000-8000-000000000011";
  const gapId = "00000000-0000-4000-8000-000000000012";
  const draft = renderPersonalizedEmail("Example Plumbing", {
    state: "ready", website: { status: "verified", url: "https://example.test/" },
    evidence: [{ id: factId, kind: "business_fact", claim: "We provide emergency plumbing service around the clock.",
      url: "https://example.test/", observed_at: observed, confidence: 0.9 }],
    competitors: [], opportunity: "appointment_workflow_review", confidence: 0.9, reason: "Fixture only",
  }, { fact_id: factId, competitor_id: null, language: "en" }, {
    service_name: "Booking automation", gap_claim: "Customers currently request appointments through a contact form.",
    gap_evidence_id: gapId, benefit: "organizing appointment requests", confidence: 0.9,
  });
  expect(draft.review_required).toBe(true);
  expect(draft.evidence_ids).toEqual([factId]);
  expect(draft.word_count).toBeLessThanOrEqual(90);
  let queueCalls = 0;
  const queued = await scheduleApprovedDraft({ now: new Date("2026-10-23T18:00:00Z"), timeZone: "America/Los_Angeles",
    enqueue: async () => { queueCalls++; return { error: "EMAIL_NOT_ENABLED" }; } });
  expect(queued).toBe("review");
  expect(queueCalls).toBe(1);
});
