// Intake → assessment → preview handoff: after a business enters through the
// existing intake, this decides the next CRM step from stored facts only.
// It never assumes a business lacks a website, never pitches what matches
// were already rejected, and treats page evidence as untrusted data.
import { planAutomaticWebsiteObservation, type AutomaticWebsiteObservation } from "./automatic-website-observation.ts";
import { classifyLeadOpportunity } from "./vibe-prospecting.ts";
import { potentialPreviewService } from "./research-preview.ts";
import { sourceAuthority } from "./source-authority.ts";

type Audit = { id: string; checked_url: string; checked_at: string; outcome: string; http_status: number | null };
type Proposal = { id: string; source_url: string; proposed_website_url: string; observed_at: string };
type Assessment = { status: string; official_url: string | null; observed_at: string };
type Match = { service_key: string; status: string; reason: string; evidence_ids: string[]; confidence: number };

export type IntakeHandoffAction =
  | "hold_identity_review"
  | "skip_not_eligible"
  | "review_rejected_matches"
  | "hold_needs_evidence"
  | "request_preview_handoff"
  | "hold_needs_assessment"
  | "hold_further_research";

export type IntakeHandoffPlan = {
  action: IntakeHandoffAction;
  reason: string;
  independentPublishers: string[];
  websiteObservation: AutomaticWebsiteObservation | null;
  suggestedService: "service_01" | "service_09" | null;
  classificationStatus: string | null;
  nextAction: string;
};

export async function planIntakeHandoff(input: {
  identityState: "created" | "matched" | "review_needed";
  lead: { id: string; country: string | null; website_url: string | null; is_demo: boolean; status: string };
  evidence: { source_url: string; rejected_by: string | null }[];
  reviewedAssessment: Assessment | null;
  audits: Audit[];
  proposals: Proposal[];
  matches: Match[];
}, now = Date.now()): Promise<IntakeHandoffPlan> {
  const { lead } = input;
  const websiteObservation = await planAutomaticWebsiteObservation({
    lead, reviewedAssessmentObservedAt: input.reviewedAssessment?.observed_at ?? null,
    audits: input.audits, proposals: input.proposals,
  }, now);
  const base = { websiteObservation, suggestedService: null as IntakeHandoffPlan["suggestedService"],
    classificationStatus: null as string | null };
  if (input.identityState === "review_needed") return { ...base, action: "hold_identity_review",
    reason: "The intake identity is ambiguous and still awaits owner review.",
    independentPublishers: [], nextAction: "Resolve the ambiguous discovery identity before research or outreach." };
  if (lead.is_demo || ["disqualified", "lost", "won"].includes(lead.status)) return { ...base,
    action: "skip_not_eligible", reason: "Demo or terminal leads receive no handoff action.",
    independentPublishers: [], nextAction: "No intake handoff action." };

  // Two independent public facts means two distinct publisher domains,
  // counting only facts that were not rejected in review.
  const independentPublishers = [...new Set(input.evidence.filter((item) => !item.rejected_by)
    .map((item) => { try { return sourceAuthority(item.source_url); } catch { return null; } })
    .filter((value): value is string => value !== null))];

  if (input.matches.length > 0 && input.matches.every((match) => match.status === "rejected"))
    return { ...base, action: "review_rejected_matches", independentPublishers,
      reason: "Every stored service match was rejected in owner review; the lead must not be pitched.",
      nextAction: "Confirm disqualification or reopen research: all stored service matches are rejected." };
  if (independentPublishers.length < 2)
    return { ...base, action: "hold_needs_evidence", independentPublishers,
      reason: `Only ${independentPublishers.length} independent publisher domain(s) support this lead; two are required.`,
      nextAction: "Gather a second independent public business fact from a distinct publisher domain." };

  const fresh = input.reviewedAssessment && Number.isFinite(Date.parse(input.reviewedAssessment.observed_at)) &&
    Date.parse(input.reviewedAssessment.observed_at) <= now &&
    Date.parse(input.reviewedAssessment.observed_at) > now - 30 * 86400000
    ? input.reviewedAssessment : null;
  const machine = websiteObservation?.state === "recorded_url_reachable" &&
    websiteObservation.recorded_url === lead.website_url
    ? { status: "WORKING", official_url: websiteObservation.recorded_url, observed_at: websiteObservation.observed_at }
    : null;
  const assessment = fresh ?? machine;
  const classification = classifyLeadOpportunity({ website_url: lead.website_url,
    assessment_status: assessment?.status ?? null, matches: input.matches });
  const suggestedService = assessment
    ? potentialPreviewService({ websiteUrl: lead.website_url, assessment }, now) : null;
  if (suggestedService) return { ...base, action: "request_preview_handoff", independentPublishers,
    suggestedService, classificationStatus: classification.qualification_status,
    reason: `A current website assessment suggests ${suggestedService} with ${independentPublishers.length} independent publishers.`,
    nextAction: "Submit this exact lead to the existing research-preview worker for an internal draft." };
  if (!assessment) return { ...base, action: "hold_needs_assessment", independentPublishers,
    classificationStatus: classification.qualification_status,
    reason: "No current reviewed assessment or successful pinned check establishes website status; absence is not assumed.",
    nextAction: "Complete a current website assessment before any website-related decision." };
  return { ...base, action: "hold_further_research", independentPublishers,
    classificationStatus: classification.qualification_status,
    reason: `Current assessment ${assessment.status} supports no preview angle; opportunity status: ${classification.qualification_status}.`,
    nextAction: "Continue evidence-backed research; no preview is eligible yet." };
}

const taskTitles: Record<IntakeHandoffAction, string> = {
  hold_identity_review: "Resolve discovery identity review",
  skip_not_eligible: "No intake handoff action",
  review_rejected_matches: "Review rejected service matches",
  hold_needs_evidence: "Gather second independent business fact",
  request_preview_handoff: "Eligible for research preview handoff",
  hold_needs_assessment: "Complete website assessment",
  hold_further_research: "Continue opportunity research",
};

type HandoffResult<T> = { data: T | null; error: { code?: string; message: string } | null };

// Flat write interface so the worker maps its existing Supabase client in one
// place and tests can fake every outcome, including duplicate races.
export type IntakeHandoffDb = {
  findOpenTask(input: { org_id: string; lead_id: string; title: string }): Promise<HandoffResult<{ id: string }>>;
  insertTask(input: { org_id: string; lead_id: string; title: string; description: string }): Promise<HandoffResult<{ id: string }>>;
  findObservation(input: { org_id: string; lead_id: string; source_fingerprint: string }): Promise<HandoffResult<{ id: string }>>;
  insertObservation(input: { org_id: string; lead_id: string } & AutomaticWebsiteObservation): Promise<HandoffResult<{ id: string }>>;
  updateLeadStatus(input: { org_id: string; lead_id: string; status: string }): Promise<HandoffResult<{ id: string }>>;
};

export type IntakeHandoffApplied = {
  action: IntakeHandoffAction;
  reason: string;
  observation_recorded: boolean;
  status_updated: boolean;
  task_created: boolean;
  task_title: string;
  independent_publishers: string[];
  suggested_service: "service_01" | "service_09" | null;
  classification_status: string | null;
};

export async function applyIntakeHandoff(db: IntakeHandoffDb, input: {
  lead: { id: string; org_id: string; status: string };
  plan: IntakeHandoffPlan;
}): Promise<IntakeHandoffApplied> {
  const { lead, plan } = input;
  const applied: IntakeHandoffApplied = { action: plan.action, reason: plan.reason,
    observation_recorded: false, status_updated: false, task_created: false,
    task_title: taskTitles[plan.action], independent_publishers: plan.independentPublishers,
    suggested_service: plan.suggestedService, classification_status: plan.classificationStatus };
  const fail = (message: string): never => { throw new Error(`INTAKE_HANDOFF_DB_ERROR: ${message}`); };

  if (plan.websiteObservation) {
    const existing = await db.findObservation({ org_id: lead.org_id, lead_id: lead.id,
      source_fingerprint: plan.websiteObservation.source_fingerprint });
    if (existing.error) fail(existing.error.message);
    if (!existing.data) {
      const saved = await db.insertObservation({ org_id: lead.org_id, lead_id: lead.id, ...plan.websiteObservation });
      if (saved.error && saved.error.code !== "23505") fail(saved.error.message);
      applied.observation_recorded = !saved.error;
    }
  }
  // A first inspection moves "new" to "researching"; qualified or terminal
  // states are never downgraded, and ambiguous identities are not touched.
  if (plan.action !== "skip_not_eligible" && plan.action !== "hold_identity_review" && lead.status === "new") {
    const updated = await db.updateLeadStatus({ org_id: lead.org_id, lead_id: lead.id, status: "researching" });
    if (updated.error) fail(updated.error.message);
    applied.status_updated = true;
  }
  if (plan.action !== "skip_not_eligible") {
    const open = await db.findOpenTask({ org_id: lead.org_id, lead_id: lead.id, title: applied.task_title });
    if (open.error) fail(open.error.message);
    if (!open.data) {
      const saved = await db.insertTask({ org_id: lead.org_id, lead_id: lead.id, title: applied.task_title,
        description: `${plan.reason} Next action: ${plan.nextAction}`.slice(0, 2000) });
      if (saved.error && saved.error.code !== "23505") fail(saved.error.message);
      applied.task_created = !saved.error;
    }
  }
  return applied;
}

// One exact lead may be handed to the existing preview worker. The worker
// keeps its own ENABLE_RESEARCH_PREVIEW_JOBS gate, so a disabled deployment
// reports "disabled" instead of failing the intake record.
export async function handoffIntakePreview(input: {
  supabaseUrl: string;
  internalSecret: string | undefined;
  leadId: string;
  org_id?: string;
}, fetcher: typeof fetch = fetch): Promise<"submitted" | "not_configured" | "disabled"> {
  if (!input.internalSecret || input.internalSecret.length < 32) return "not_configured";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.leadId))
    throw new Error("INVALID_INTAKE_LEAD");
  const base = new URL(input.supabaseUrl);
  if (base.protocol !== "https:") throw new Error("INVALID_SUPABASE_URL");
  const response = await fetcher(new URL("/functions/v1/research-preview-jobs", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cron-Signature": input.internalSecret },
    body: JSON.stringify({ lead_ids: [input.leadId], org_id: input.org_id }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.ok) return "submitted";
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (body?.error === "RESEARCH_PREVIEW_JOBS_DISABLED") return "disabled";
  throw new Error("INTAKE_PREVIEW_HANDOFF_FAILED");
}
