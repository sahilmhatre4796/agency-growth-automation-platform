import { describe, expect, test } from "vitest";
import { applyIntakeHandoff, handoffIntakePreview, planIntakeHandoff, type IntakeHandoffDb } from "../packages/server/intake-handoff.ts";
import type { AutomaticWebsiteObservation } from "../packages/server/automatic-website-observation.ts";

const now = Date.parse("2026-11-04T12:00:00.000Z");
const iso = (days: number) => new Date(now - days * 86400000).toISOString();
const lead = (over: Partial<{ is_demo: boolean; status: string; website_url: string | null }> = {}) =>
  ({ id: "11111111-1111-4111-8111-111111111111", country: "USA",
    website_url: null, is_demo: false, status: "new", ...over });
const twoPublishers = [
  { source_url: "https://chamber.example/listing", rejected_by: null },
  { source_url: "https://localnews.example/story", rejected_by: null },
];

describe("planIntakeHandoff", () => {
  test("ambiguous intake identity holds for owner review", async () => {
    const plan = await planIntakeHandoff({ identityState: "review_needed", lead: lead(),
      evidence: twoPublishers, reviewedAssessment: null, audits: [], proposals: [], matches: [] }, now);
    expect(plan.action).toBe("hold_identity_review");
    expect(plan.nextAction).toContain("Resolve the ambiguous discovery identity");
  });

  test("demo leads are skipped", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead({ is_demo: true }),
      evidence: twoPublishers, reviewedAssessment: null, audits: [], proposals: [], matches: [] }, now);
    expect(plan.action).toBe("skip_not_eligible");
  });

  test("rejected matches surface a rejection review instead of a pitch", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead(),
      evidence: twoPublishers, reviewedAssessment: null, audits: [], proposals: [],
      matches: [{ service_key: "service_01", status: "rejected", reason: "Owner declined: already served.",
        evidence_ids: ["e1"], confidence: 0.8 },
        { service_key: "service_09", status: "rejected", reason: "Owner declined: not a fit.",
        evidence_ids: [], confidence: 0.5 }] }, now);
    expect(plan.action).toBe("review_rejected_matches");
    expect(plan.reason).toContain("must not be pitched");
  });

  test("a single publisher domain cannot corroborate", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead(),
      evidence: [{ source_url: "https://chamber.example/a", rejected_by: null },
        { source_url: "https://www.chamber.example/b", rejected_by: null }],
      reviewedAssessment: null, audits: [], proposals: [], matches: [] }, now);
    expect(plan.action).toBe("hold_needs_evidence");
    expect(plan.independentPublishers).toEqual(["chamber.example"]);
    expect(plan.reason).toContain("Only 1");
  });

  test("rejected facts never count toward independent publishers", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead(),
      evidence: [...twoPublishers, { source_url: "https://third.example/x", rejected_by: "user-1" }],
      reviewedAssessment: null, audits: [], proposals: [], matches: [] }, now);
    expect(plan.independentPublishers).toEqual(["chamber.example", "localnews.example"]);
    expect(plan.action).not.toBe("hold_needs_evidence");
  });

  test("current no-site assessment plus verified gap requests the preview handoff", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead(),
      evidence: twoPublishers,
      reviewedAssessment: { status: "NO_OFFICIAL_WEBSITE_DISCOVERED", official_url: null, observed_at: iso(1) },
      audits: [], proposals: [],
      matches: [{ service_key: "service_01", status: "verified_gap",
        reason: "Reviewed assessment shows no official site.", evidence_ids: ["e1"], confidence: 0.9 }] }, now);
    expect(plan.action).toBe("request_preview_handoff");
    expect(plan.suggestedService).toBe("service_01");
    expect(plan.classificationStatus).toBe("reviewed_no_site");
    expect(plan.websiteObservation).toBeNull();
  });

  test("machine reachable check supplies the assessment when none is reviewed", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched",
      lead: lead({ website_url: "https://shop.example/" }), evidence: twoPublishers,
      reviewedAssessment: null,
      audits: [{ id: "a1", checked_url: "https://shop.example/", checked_at: iso(1),
        outcome: "ok", http_status: 200 }], proposals: [],
      matches: [{ service_key: "service_09", status: "research_needed",
        reason: "Public workflow evidence suggests room for automation.",
        evidence_ids: ["e1"], confidence: 0.7 }] }, now);
    expect(plan.websiteObservation?.state).toBe("recorded_url_reachable");
    expect(plan.action).toBe("request_preview_handoff");
    expect(plan.suggestedService).toBe("service_09");
  });

  test("unknown website status holds for assessment and never assumes no site", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead(),
      evidence: twoPublishers, reviewedAssessment: null, audits: [], proposals: [], matches: [] }, now);
    expect(plan.action).toBe("hold_needs_assessment");
    expect(plan.websiteObservation?.state).toBe("unknown");
    expect(plan.reason).toContain("absence is not assumed");
  });

  test("stale reviewed assessment cannot support a preview", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched", lead: lead(),
      evidence: twoPublishers,
      reviewedAssessment: { status: "NO_OFFICIAL_WEBSITE_DISCOVERED", official_url: null, observed_at: iso(40) },
      audits: [], proposals: [], matches: [] }, now);
    expect(plan.action).toBe("hold_needs_assessment");
  });

  test("fresh assessment without a supported angle holds for further research", async () => {
    const plan = await planIntakeHandoff({ identityState: "matched",
      lead: lead({ website_url: "https://shop.example/" }), evidence: twoPublishers,
      reviewedAssessment: { status: "PERSISTENTLY_BROKEN", official_url: "https://shop.example/", observed_at: iso(2) },
      audits: [], proposals: [], matches: [] }, now);
    expect(plan.action).toBe("hold_further_research");
    expect(plan.classificationStatus).toBe("insufficient_evidence");
  });
});

function fakeDb(overrides: Partial<IntakeHandoffDb> = {}) {
  const calls: Record<string, unknown[]> = { findObservation: [], insertObservation: [],
    updateLeadStatus: [], findOpenTask: [], insertTask: [] };
  const track = <K extends keyof IntakeHandoffDb>(name: K, result: unknown) =>
    (async (input: unknown) => { calls[name].push(input); return result; }) as IntakeHandoffDb[K];
  const db = {
    findObservation: track("findObservation", { data: null, error: null }),
    insertObservation: track("insertObservation", { data: { id: "o1" }, error: null }),
    updateLeadStatus: track("updateLeadStatus", { data: { id: "l1" }, error: null }),
    findOpenTask: track("findOpenTask", { data: null, error: null }),
    insertTask: track("insertTask", { data: { id: "t1" }, error: null }),
    ...overrides,
  } as IntakeHandoffDb;
  return { db, calls };
}

const observation: AutomaticWebsiteObservation = { state: "unknown", recorded_url: null, checked_url: null,
  audit_observation_id: null, http_status: null, proposed_website_url: null, proposal_source_url: null,
  reason: "No current check.", confidence: 0.2, observed_at: iso(0), source_fingerprint: "fp-123" };
const plan = (over: Partial<Parameters<typeof applyIntakeHandoff>[1]["plan"]> = {}) => ({
  action: "hold_needs_assessment" as const, reason: "No current assessment.",
  independentPublishers: ["a.example", "b.example"], websiteObservation: observation,
  suggestedService: null, classificationStatus: null,
  nextAction: "Complete a current website assessment.", ...over });
const crmLead = { id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222", status: "new" };

describe("applyIntakeHandoff", () => {
  test("records the machine observation, moves new to researching and opens one task", async () => {
    const { db, calls } = fakeDb();
    const applied = await applyIntakeHandoff(db, { lead: crmLead, plan: plan() });
    expect(applied.observation_recorded).toBe(true);
    expect(applied.status_updated).toBe(true);
    expect(applied.task_created).toBe(true);
    expect(calls.insertObservation[0]).toMatchObject({ org_id: crmLead.org_id, source_fingerprint: "fp-123" });
    expect(calls.updateLeadStatus[0]).toMatchObject({ status: "researching" });
    expect(calls.insertTask[0]).toMatchObject({ title: "Complete website assessment" });
  });

  test("an existing fingerprint or open task is never duplicated", async () => {
    const { db, calls } = fakeDb({
      findObservation: (async () => ({ data: { id: "old" }, error: null })) as IntakeHandoffDb["findObservation"],
      findOpenTask: (async () => ({ data: { id: "task" }, error: null })) as IntakeHandoffDb["findOpenTask"],
    });
    const applied = await applyIntakeHandoff(db, { lead: crmLead, plan: plan() });
    expect(applied.observation_recorded).toBe(false);
    expect(applied.task_created).toBe(false);
    expect(calls.insertObservation).toHaveLength(0);
    expect(calls.insertTask).toHaveLength(0);
  });

  test("a concurrent duplicate observation race is tolerated", async () => {
    const { db } = fakeDb({
      insertObservation: (async () => ({ data: null, error: { code: "23505", message: "duplicate" } })) as IntakeHandoffDb["insertObservation"],
    });
    const applied = await applyIntakeHandoff(db, { lead: crmLead, plan: plan() });
    expect(applied.observation_recorded).toBe(false);
  });

  test("database failures surface instead of being swallowed", async () => {
    const { db } = fakeDb({
      insertTask: (async () => ({ data: null, error: { code: "XX000", message: "connection lost" } })) as IntakeHandoffDb["insertTask"],
    });
    await expect(applyIntakeHandoff(db, { lead: crmLead, plan: plan() }))
      .rejects.toThrow("INTAKE_HANDOFF_DB_ERROR: connection lost");
  });

  test("terminal or ambiguous leads receive no status change or task", async () => {
    const skipped = fakeDb();
    const appliedSkip = await applyIntakeHandoff(skipped.db, { lead: crmLead,
      plan: plan({ action: "skip_not_eligible", reason: "Demo lead." }) });
    expect(appliedSkip.status_updated).toBe(false);
    expect(appliedSkip.task_created).toBe(false);
    expect(skipped.calls.updateLeadStatus).toHaveLength(0);
    expect(skipped.calls.insertTask).toHaveLength(0);

    const held = fakeDb();
    const appliedHold = await applyIntakeHandoff(held.db, { lead: crmLead,
      plan: plan({ action: "hold_identity_review", reason: "Ambiguous identity." }) });
    expect(appliedHold.status_updated).toBe(false);
    expect(appliedHold.task_created).toBe(true);
    expect(held.calls.updateLeadStatus).toHaveLength(0);
  });

  test("qualified leads are never downgraded to researching", async () => {
    const { db, calls } = fakeDb();
    await applyIntakeHandoff(db, { lead: { ...crmLead, status: "qualified" }, plan: plan() });
    expect(calls.updateLeadStatus).toHaveLength(0);
  });
});

describe("handoffIntakePreview", () => {
  const leadId = "33333333-3333-4333-8333-333333333333";
  const secret = "s".repeat(40);
  let lastSeen: { input: unknown; init?: unknown } | undefined;
  const respond = (status: number, body: unknown) => (async (input: unknown, init?: unknown) => {
    lastSeen = { input, init };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  test("without a configured internal secret nothing is sent", async () => {
    expect(await handoffIntakePreview({ supabaseUrl: "https://project.supabase.co",
      internalSecret: undefined, leadId })).toBe("not_configured");
    expect(await handoffIntakePreview({ supabaseUrl: "https://project.supabase.co",
      internalSecret: "short", leadId })).toBe("not_configured");
  });

  test("malformed lead or endpoint inputs are rejected", async () => {
    await expect(handoffIntakePreview({ supabaseUrl: "https://project.supabase.co",
      internalSecret: secret, leadId: "not-a-uuid" })).rejects.toThrow("INVALID_INTAKE_LEAD");
    await expect(handoffIntakePreview({ supabaseUrl: "http://project.supabase.co",
      internalSecret: secret, leadId })).rejects.toThrow("INVALID_SUPABASE_URL");
  });

  test("an enabled preview worker receives exactly this lead with the internal signature", async () => {
    const fetcher = respond(200, { inspected: 1, created: 0, held: 1 });
    expect(await handoffIntakePreview({ supabaseUrl: "https://project.supabase.co",
      internalSecret: secret, leadId }, fetcher)).toBe("submitted");
    const { input, init } = lastSeen!;
    expect(String(input)).toBe("https://project.supabase.co/functions/v1/research-preview-jobs");
    const request = init as RequestInit;
    expect((request.headers as Record<string, string>)["X-Cron-Signature"]).toBe(secret);
    expect(request.body).toBe(JSON.stringify({ lead_ids: [leadId] }));
  });

  test("a disabled preview worker is reported as disabled, not as failure", async () => {
    const fetcher = respond(503, { error: "RESEARCH_PREVIEW_JOBS_DISABLED" });
    expect(await handoffIntakePreview({ supabaseUrl: "https://project.supabase.co",
      internalSecret: secret, leadId }, fetcher)).toBe("disabled");
  });

  test("other worker errors fail loudly", async () => {
    const fetcher = respond(500, { error: "RESEARCH_EVIDENCE_UNAVAILABLE" });
    await expect(handoffIntakePreview({ supabaseUrl: "https://project.supabase.co",
      internalSecret: secret, leadId }, fetcher)).rejects.toThrow("INTAKE_PREVIEW_HANDOFF_FAILED");
  });
});
