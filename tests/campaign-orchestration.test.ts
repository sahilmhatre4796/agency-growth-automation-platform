import { describe, expect, test } from "vitest";
import { type VerificationResult } from "../packages/server/reacher-orchestration.ts";
import { orchestrateLead, computeCampaignSplit, handleInboundReply } from "../packages/server/campaign-orchestration.ts";
import type { LeadDecision } from "../packages/server/campaign-orchestration.ts";

const now = new Date("2026-11-04T12:00:00.000Z");

const orgId = "00000000-0000-4000-8000-000000000001";
const leadId = "00000000-0000-4000-8000-000000000051";

function assessmentPort(over: Partial<{ status: string | null; official_url: string | null }> | null = {}) {
  return {
    getWebsiteAssessment: async () => (over && over.status)
      ? { status: over.status, official_url: over.official_url ?? null, observed_at: now.toISOString() }
      : null,
  };
}

function contactsPort() {
  return {
    getExistingContacts: async () => [],
    storeContacts: async () => ({ saved: 0, skipped: 0 }),
  };
}

function verificationPort(results: Array<{
  email: string; status: "valid" | "invalid" | "unknown" | "risky" | "suppressed";
  disposition: "approved" | "hold_review" | "blocked"; reason: string;
}> = []) {
  return {
    verifyContacts: async () => results.map((r) => ({
      contact: {
        lead_id: leadId,
        kind: "email" as const,
        normalized_value: r.email.toLowerCase(),
        value: r.email,
        source_url: "https://example.com/contact",
        observed_at: now.toISOString(),
        evidence_excerpt: `Contact: ${r.email}`,
        confidence: 0.7,
        source_provider: "scrapling" as const,
      },
      verification: {
        provider: "basic_dns",
        status: r.status,
        evidence: {
          syntax: "pass",
          domain: "exists",
          mx: "present",
          fallback_address: null,
          disposable: false,
          reason: r.reason,
        } as VerificationResult["evidence"],
      },
      disposition: r.disposition,
    })),
  };
}

function emailGenPort(draft: { subject: string; body: string; evidence_ids: string[]; suggested_service: string; gap_evidence_id: string; word_count: number } | null = null) {
  return {
    generate: async () => draft,
  };
}

function gmailPort(sendResult: { provider_id: string; thread_id: string } | null = null) {
  return {
    send: async () => sendResult,
    selectSender: async () => ({ email: "owner@example.com", display_name: "Owner" }),
    recordSend: async () => {},
  };
}

function dbPort(over: Partial<{
  suppressed: boolean;
  recordDecision_calls: LeadDecision[];
  recordOutbound_calls: Array<{ state: string }>;
  scheduleFollowUp_calls: Array<{ scheduled_at: string }>;
  recordInboundReply_calls: Array<{ contact_email: string }>;
  hasFollowUpSent: boolean;
}> = {}) {
  const recordDecision_calls: LeadDecision[] = over.recordDecision_calls ?? [];
  const recordOutbound_calls: Array<{ state: string }> = over.recordOutbound_calls ?? [];
  const scheduleFollowUp_calls: Array<{ scheduled_at: string }> = over.scheduleFollowUp_calls ?? [];
  const recordInboundReply_calls: Array<{ contact_email: string }> = over.recordInboundReply_calls ?? [];
  return {
    recordDecision: async (input: { org_id: string; lead_id: string; decision: LeadDecision }) => {
      recordDecision_calls.push(input.decision);
    },
    recordOutbound: async (input: { org_id: string; lead_id: string; contact_email: string; subject: string; body: string; state: string }) => {
      recordOutbound_calls.push({ state: input.state });
    },
    isSuppressed: async () => over.suppressed ?? false,
    scheduleFollowUp: async (input: { scheduled_at: string }) => {
      scheduleFollowUp_calls.push(input);
    },
    recordInboundReply: async (input: { contact_email: string }) => {
      recordInboundReply_calls.push(input);
    },
    hasFollowUpSent: async () => over.hasFollowUpSent ?? false,
    get calls() {
      return { recordDecision_calls, recordOutbound_calls, scheduleFollowUp_calls, recordInboundReply_calls };
    },
  };
}

describe("orchestrateLead", () => {
  test("disabled campaign classifies only, never sends", async () => {
    const db = dbPort({ recordDecision_calls: [] });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Synthetic Plumbing",
      website_url: null,
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([]),
      email_gen: emailGenPort(),
      gmail: gmailPort(),
      db,
      config: { enabled: false },
      now,
    });

    expect(result.send_result).toBe("not_configured");
    expect(result.email_draft).toBeNull();
    expect(result.follow_up_scheduled).toBe(false);
    expect(db.calls.recordDecision_calls).toHaveLength(1);
    expect(result.reason).toContain("Campaign disabled");
  });

  test("qualified no-website lead generates draft, queues send, schedules follow-up", async () => {
    const db = dbPort({ recordDecision_calls: [] });

    const prevLiveEmail = process.env.ENABLE_LIVE_EMAIL;
    process.env.ENABLE_LIVE_EMAIL = "true";
    try {
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Synthetic Plumbing",
      website_url: null,
      serviceMatches: [{
        service_key: "service_01",
        service_name: "Business website",
        status: "verified_gap",
        reason: "No official website found; verified gap",
        evidence_ids: ["ev-1"],
        confidence: 0.9,
      }],
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([
        { email: "owner@synthetic-plumbing.example", status: "valid", disposition: "approved", reason: "Reacher verified" },
      ]),
      email_gen: emailGenPort({
        subject: "An idea for Synthetic Plumbing",
        body: "Hi,\n\nI noticed this on Synthetic Plumbing's site: “we serve emergencies”\n\nA business website could help with clearer enquiries.\n\nWould a practical idea be useful?\n\nBest,\nChainCraft Studio",
        evidence_ids: ["e1"],
        suggested_service: "Business website",
        gap_evidence_id: "e1",
        word_count: 45,
      }),
      gmail: gmailPort({ provider_id: "msg-1", thread_id: "thread-1" }),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.decision.kind).toBe("qualify");
    expect(result.send_result).toBe("queued");
    expect(result.email_draft?.subject).toBe("An idea for Synthetic Plumbing");
    expect(result.follow_up_scheduled).toBe(true);
    expect(db.calls.recordOutbound_calls).toHaveLength(1);
    expect(db.calls.recordOutbound_calls[0].state).toBe("queued");
    expect(db.calls.scheduleFollowUp_calls).toHaveLength(1);
    } finally {
      process.env.ENABLE_LIVE_EMAIL = prevLiveEmail;
    }
  });

  test("blocked contact never enters CRM", async () => {
    const storeCalls: Array<{ observations: Array<{ value: string }> }> = [];
    const contacts = {
      getExistingContacts: async () => [],
      storeContacts: async (input: { observations: Array<{ value: string }> }) => {
        storeCalls.push(input);
        return { saved: 0, skipped: 0 };
      },
    };

    await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Synthetic Plumbing",
      website_url: null,
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts,
      verification: verificationPort([
        { email: "blocked@nomail.example", status: "invalid", disposition: "blocked", reason: "null MX" },
      ]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db: dbPort({ recordDecision_calls: [] }),
      config: { enabled: true },
      now,
    });

    expect(storeCalls).toHaveLength(0);
  });

  test("suppressed contact is blocked, not sent", async () => {
    const db = dbPort({ recordDecision_calls: [], suppressed: true });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Synthetic Plumbing",
      website_url: null,
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([
        { email: "suppressed@example.com", status: "suppressed", disposition: "blocked", reason: "Globally suppressed" },
      ]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.send_result).toBe("suppressed");
    expect(result.email_draft).toBeNull();
  });

  test("live email disabled returns not_configured even when qualified", async () => {
    const prevLiveEmail = process.env.ENABLE_LIVE_EMAIL;
    delete process.env.ENABLE_LIVE_EMAIL;
    const db = dbPort({ recordDecision_calls: [] });
    try {
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Synthetic Plumbing",
      website_url: null,
      serviceMatches: [{
        service_key: "service_01",
        service_name: "Business website",
        status: "verified_gap",
        reason: "No official website found; verified gap",
        evidence_ids: ["ev-1"],
        confidence: 0.9,
      }],
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([
        { email: "owner@synthetic-plumbing.example", status: "valid", disposition: "approved", reason: "verified" },
      ]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.send_result).toBe("not_configured");
    expect(result.reason).toContain("Live email disabled");
    } finally {
      process.env.ENABLE_LIVE_EMAIL = prevLiveEmail;
    }
  });

  test("working adequate website is not qualified (hold)", async () => {
    const db = dbPort({ recordDecision_calls: [] });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Adequate Plumbing",
      website_url: "https://adequate-plumbing.example/",
      assessment: assessmentPort({ status: "WORKING" }),
      contacts: contactsPort(),
      verification: verificationPort([]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.decision.kind).toBe("hold");
    expect(result.send_result).toBe("blocked");
    expect(result.reason).toContain("No qualified opportunity");
  });

  test("unknown website status holds, never assumes absence", async () => {
    const db = dbPort({ recordDecision_calls: [] });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Mystery Business",
      website_url: null,
      assessment: assessmentPort(null),
      contacts: contactsPort(),
      verification: verificationPort([]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.decision.kind).toBe("hold");
    expect(result.decision.website_status).toBe("UNKNOWN");
    expect(result.send_result).toBe("blocked");
  });

  test("Path 0: verified service gap qualifies (no website)", async () => {
    const db = dbPort({ recordDecision_calls: [] });

    const prevLiveEmail = process.env.ENABLE_LIVE_EMAIL;
    process.env.ENABLE_LIVE_EMAIL = "true";
    let result: Awaited<ReturnType<typeof orchestrateLead>> | null = null;
    try {
      result = await orchestrateLead({
        org_id: orgId,
        lead_id: leadId,
        business_name: "No Site Business",
        website_url: null,
        serviceMatches: [{
          service_key: "service_09",
          service_name: "AI receptionist",
          status: "verified_gap",
          reason: "No website; AI receptionist gap verified",
          evidence_ids: ["ev-1"],
          confidence: 0.85,
        }],
        assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
        contacts: contactsPort(),
        verification: verificationPort([
          { email: "owner@nosite.example", status: "valid", disposition: "approved", reason: "Reacher verified" },
        ]),
        email_gen: emailGenPort({
          subject: "AI receptionist for No Site Business",
          body: "Hi,\n\nNo website detected; an AI receptionist could capture enquiries.\n\nBest,\nChainCraft Studio",
          evidence_ids: ["e1"],
          suggested_service: "AI receptionist",
          gap_evidence_id: "e1",
          word_count: 20,
        }),
        gmail: gmailPort({ provider_id: "msg-2", thread_id: "thread-2" }),
        db,
        config: { enabled: true },
        now,
      });
    } finally {
      if (prevLiveEmail === undefined) delete process.env.ENABLE_LIVE_EMAIL;
      else process.env.ENABLE_LIVE_EMAIL = prevLiveEmail;
    }
    if (!result) throw new Error("orchestrateLead did not return a result");
    expect(result.decision.kind).toBe("qualify");
    expect(result.decision.service_key).toBe("service_09");
    expect(result.send_result).toBe("queued");
    expect(result.email_draft?.subject).toBe("AI receptionist for No Site Business");
  });

  test("Path 0 negative: research_needed service match does NOT qualify", async () => {
    const db = dbPort({ recordDecision_calls: [] });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Speculative Business",
      website_url: null,
      serviceMatches: [{
        service_key: "service_09",
        service_name: "AI receptionist",
        status: "research_needed",
        reason: "Possible gap; needs manual review",
        evidence_ids: ["ev-1"],
        confidence: 0.5,
      }],
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.decision.kind).toBe("hold");
    expect(result.send_result).toBe("blocked");
    expect(result.reason).toContain("No qualified opportunity");
  });

  test("Path 0 negative: rejected service match does NOT qualify", async () => {
    const db = dbPort({ recordDecision_calls: [] });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Rejected Match Business",
      website_url: null,
      serviceMatches: [{
        service_key: "service_01",
        service_name: "Business website",
        status: "rejected",
        reason: "Owner rejected website pitch",
        evidence_ids: [],
        confidence: 0,
      }],
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.decision.kind).toBe("hold");
    expect(result.send_result).toBe("blocked");
    expect(result.reason).toContain("No qualified opportunity");
  });

  test("Suppression lookup failure fails closed (blocked contact)", async () => {
    const db = dbPort({
      recordDecision_calls: [],
      suppressed: true,
    });
    // Override isSuppressed to throw, simulating lookup failure
    db.isSuppressed = async () => { throw new Error("DB connection lost"); };
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Suppressed Business",
      website_url: null,
      serviceMatches: [{
        service_key: "service_01",
        service_name: "Business website",
        status: "verified_gap",
        reason: "No official website found; verified gap",
        evidence_ids: ["ev-1"],
        confidence: 0.9,
      }],
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([
        { email: "suppressed@example.com", status: "suppressed", disposition: "blocked", reason: "Globally suppressed" },
      ]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    expect(result.send_result).toBe("suppressed");
    expect(result.email_draft).toBeNull();
  });

  test("Blocked contact (non-suppressed status) is blocked before qualification", async () => {
    const db = dbPort({ recordDecision_calls: [], suppressed: false });
    const result = await orchestrateLead({
      org_id: orgId,
      lead_id: leadId,
      business_name: "Blocked MX Business",
      website_url: null,
      serviceMatches: [{
        service_key: "service_01",
        service_name: "Business website",
        status: "verified_gap",
        reason: "No official website found; verified gap",
        evidence_ids: ["ev-1"],
        confidence: 0.9,
      }],
      assessment: assessmentPort({ status: "NO_OFFICIAL_WEBSITE_DISCOVERED" }),
      contacts: contactsPort(),
      verification: verificationPort([
        { email: "invalid@nomail.example", status: "invalid", disposition: "blocked", reason: "null MX" },
      ]),
      email_gen: emailGenPort(null),
      gmail: gmailPort(null),
      db,
      config: { enabled: true },
      now,
    });

    // Contact is blocked but not globally suppressed → no send path reached
    expect(result.send_result).toBe("not_configured");
    expect(result.email_draft).toBeNull();
  });

  test("80/20: 80% no-website qualified pool reports correct counts", () => {
    const decisions: LeadDecision[] = [
      { kind: "qualify", website_status: "NO_OFFICIAL_WEBSITE_FOUND", reason: "no site", evidence_ids: [], confidence: 0.8 },
      { kind: "qualify", website_status: "NO_OFFICIAL_WEBSITE_FOUND", reason: "no site", evidence_ids: [], confidence: 0.8 },
      { kind: "qualify", website_status: "NO_OFFICIAL_WEBSITE_FOUND", reason: "no site", evidence_ids: [], confidence: 0.8 },
      { kind: "qualify", website_status: "NO_OFFICIAL_WEBSITE_FOUND", reason: "no site", evidence_ids: [], confidence: 0.8 },
      { kind: "qualify", website_status: "VERIFIED_WORKING", reason: "working site + verified problem", evidence_ids: [], confidence: 0.7 },
    ];

    const split = computeCampaignSplit(decisions);
    expect(split.no_website).toBe(4);
    expect(split.website_improvement).toBe(1);
    expect(split.total_qualified).toBe(5);
    expect(split.no_website_pct).toBe(80);
    expect(split.website_improvement_pct).toBe(20);
  });
});

describe("computeCampaignSplit", () => {
  test("80/20 split on qualified decisions", () => {
    const decisions: LeadDecision[] = [
      { kind: "qualify", website_status: "NO_OFFICIAL_WEBSITE_FOUND", reason: "no site", evidence_ids: [], confidence: 0.8 },
      { kind: "qualify", website_status: "NO_OFFICIAL_WEBSITE_FOUND", reason: "no site", evidence_ids: [], confidence: 0.8 },
      { kind: "qualify", website_status: "VERIFIED_WORKING", reason: "working site", evidence_ids: [], confidence: 0.7 },
      { kind: "hold", website_status: null, reason: "not qualified", evidence_ids: [], confidence: 0 },
    ];

    const split = computeCampaignSplit(decisions);
    expect(split.no_website).toBe(2);
    expect(split.website_improvement).toBe(1);
    expect(split.total_qualified).toBe(3);
  });
});

describe("handleInboundReply", () => {
  test("records reply and stops follow-up, never auto-replies", async () => {
    const recordInboundReply_calls: Array<{ contact_email: string }> = [];
    const db = dbPort({ recordInboundReply_calls });

    const result = await handleInboundReply({
      org_id: orgId,
      lead_id: leadId,
      contact_email: "owner@example.com",
      db,
    });

    expect(result.auto_reply_sent).toBe(false);
    expect(result.follow_up_stopped).toBe(true);
    expect(recordInboundReply_calls).toHaveLength(1);
    expect(recordInboundReply_calls[0].contact_email).toBe("owner@example.com");
  });
});
