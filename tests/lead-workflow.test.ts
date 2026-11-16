import { expect, test } from "vitest";
import { advanceLeadWorkflow, type LeadWorkflowPorts, type LeadWorkflowSnapshot } from "../packages/server/lead-workflow.ts";

const ready: LeadWorkflowSnapshot = {
  country: "United States", leadStatus: "qualified", identityReviewed: true, websiteStatus: "WORKING", serviceGapReviewed: true,
  qualificationStatus: "QUALIFIED", sourcedEmailCount: 1, contactId: "contact-1", verificationStatus: "valid",
  verificationReviewed: false,
  reportId: "report-1", reportReady: true, permissionRecorded: true, draftId: null,
};
const flags = { vibe: true, verification: true, research: true, ai: true };
function ports(calls: string[]): LeadWorkflowPorts {
  return {
    requestVibe: async () => { calls.push("vibe"); return "queued"; },
    evaluateQualification: async () => { calls.push("qualification"); return "QUALIFIED"; },
    requestVerification: async () => { calls.push("verification"); return "queued"; },
    requestResearch: async () => { calls.push("research"); return { state: "cached", reportId: "report-1", ready: true }; },
    createDraft: async () => { calls.push("draft"); return "draft-1"; },
  };
}

test("owner-selected workflow advances only through reviewed stages and reuses cached research", async () => {
  const calls: string[] = [];
  const result = await advanceLeadWorkflow({ ...ready, qualificationStatus: "RESEARCH_NEEDED", reportReady: false }, ports(calls), flags);
  expect(result).toEqual({ state: "draft_review", reason: "OWNER_DRAFT_APPROVAL_REQUIRED",
    completed: ["qualification_evaluated", "research_requested", "draft_created"], draftId: "draft-1" });
  expect(calls).toEqual(["qualification", "research", "draft"]);
  expect((await advanceLeadWorkflow({ ...ready, draftId: "draft-1" }, ports(calls), flags)).draftId).toBe("draft-1");
  expect(calls).toEqual(["qualification", "research", "draft"]); // duplicate draft prevented
  expect((await advanceLeadWorkflow({ ...ready, verificationStatus: "unknown", verificationReviewed: true }, ports(calls), flags)).state)
    .toBe("draft_review");
});

test("unreviewed evidence, missing contact, unknown mailbox, India and disabled providers never draft", async () => {
  const scenarios: Array<[Partial<LeadWorkflowSnapshot>, string, Partial<typeof flags>?]> = [
    [{ identityReviewed: false }, "BUSINESS_IDENTITY_REVIEW_REQUIRED"],
    [{ leadStatus: "disqualified" }, "LEAD_NOT_ELIGIBLE"],
    [{ websiteStatus: "UNKNOWN" }, "WEBSITE_ASSESSMENT_REQUIRED"],
    [{ serviceGapReviewed: false }, "REVIEWED_SERVICE_GAP_REQUIRED"],
    [{ sourcedEmailCount: 0 }, "VIBE_DISCOVERY_PENDING"],
    [{ sourcedEmailCount: 0 }, "SOURCED_CONTACT_REQUIRED", { vibe: false }],
    [{ contactId: null }, "REVIEWED_EMAIL_CONTACT_REQUIRED"],
    [{ verificationStatus: null }, "EMAIL_VERIFICATION_PENDING"],
    [{ verificationStatus: null }, "MAILBOX_VERIFICATION_REVIEW_REQUIRED", { verification: false }],
    [{ verificationStatus: "unknown" }, "EMAIL_VERIFICATION_REVIEW_REQUIRED"],
    [{ verificationStatus: "invalid" }, "EMAIL_VERIFICATION_BLOCKED"],
    [{ reportReady: false }, "BUSINESS_RESEARCH_PENDING", { research: false }],
    [{ permissionRecorded: false }, "RECIPIENT_PERMISSION_REQUIRED"],
    [{ country: "India" }, "INDIA_AUTOMATED_EMAIL_DISABLED"],
    [{ country: "" }, "COUNTRY_REVIEW_REQUIRED"],
    [{}, "PERSONALIZED_AI_DISABLED", { ai: false }],
  ];
  for (const [change, reason, flagChange] of scenarios) {
    const calls: string[] = [];
    const result = await advanceLeadWorkflow({ ...ready, ...change }, ports(calls), { ...flags, ...flagChange });
    // A disabled research provider holds for owner review, not a pending job.
    expect(result.reason).toBe(reason === "BUSINESS_RESEARCH_PENDING" ? "RESEARCH_REPORT_REVIEW_REQUIRED" : reason);
    expect(calls).not.toContain("draft");
  }
});

test("provider request failures propagate without claiming a completed stage", async () => {
  const calls: string[] = [];
  const failed = ports(calls);
  failed.requestVerification = async () => { throw new Error("VERIFICATION_DISABLED"); };
  await expect(advanceLeadWorkflow({ ...ready, verificationStatus: null }, failed, flags))
    .rejects.toThrow("VERIFICATION_DISABLED");
  expect(calls).toEqual([]);
});

test("qualification waits for sourced contact, verification and recipient permission", async () => {
  const calls: string[] = [];
  const waiting = { ...ready, qualificationStatus: "CONTACT_UNVERIFIED" };
  expect((await advanceLeadWorkflow({ ...waiting, sourcedEmailCount: 0 }, ports(calls), flags)).reason)
    .toBe("VIBE_DISCOVERY_PENDING");
  expect((await advanceLeadWorkflow({ ...waiting, verificationStatus: null }, ports(calls), flags)).reason)
    .toBe("EMAIL_VERIFICATION_PENDING");
  expect((await advanceLeadWorkflow({ ...waiting, permissionRecorded: false }, ports(calls), flags)).reason)
    .toBe("RECIPIENT_PERMISSION_REQUIRED");
  expect(calls).toEqual(["vibe", "verification"]);
  expect((await advanceLeadWorkflow(waiting, ports(calls), flags)).state).toBe("draft_review");
  expect(calls).toEqual(["vibe", "verification", "qualification", "draft"]);
});

test("reviewed no-site leads use corroborated public research, while manual reports hold", async () => {
  const calls: string[] = [];
  expect((await advanceLeadWorkflow({ ...ready, websiteStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED" }, ports(calls), flags)).state)
    .toBe("draft_review");
  const unavailable = ports(calls);
  unavailable.requestResearch = async () => ({ state: "cached", reportId: "manual-report", ready: false });
  const result = await advanceLeadWorkflow({ ...ready, websiteStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED", reportReady: false }, unavailable, flags);
  expect(result).toMatchObject({ state: "owner_review", reason: "RESEARCH_REPORT_REVIEW_REQUIRED" });
  expect(calls).toEqual(["draft"]);
});
