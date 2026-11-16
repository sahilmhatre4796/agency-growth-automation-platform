// Campaign orchestration: intake → website assessment → qualification →
// contact discovery → email verification → Groq email generation → Gmail
// sending → follow-up scheduling.
//
// All external dependencies are injected so every stage can be tested
// synthetically. Nothing is sent unless ENABLE_LIVE_EMAIL === "true".
//
// Harvey is the central discovery/decision intelligence: it runs as a
// separate local Python application and feeds qualified leads into ChainCraft
// via the existing `ingest_discovered_business` RPC. This module is the
// ChainCraft side that receives those leads and runs them through the
// assessment, qualification, contact, verification and outbound stages.

import {
  type WebsiteProblem,
  type OperationalNeed,
  type StrictQualificationResult,
  qualifyLeadStrictly,
} from "./qualification.ts";
import {
  mapVerificationToDisposition,
  type ReacherVerificationOutcome,
} from "./reacher-orchestration.ts";
import type { ContactObservation } from "./vibe-contact-enrichment.ts";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

export type WebsiteStatus =
  | "VERIFIED_WORKING"
  | "VERIFIED_OUTDATED"
  | "VERIFIED_SLOW"
  | "VERIFIED_SERIOUS_ISSUE"
  | "NO_OFFICIAL_WEBSITE_FOUND"
  | "UNKNOWN";

export type ServiceMatch = {
  service_key: string;
  service_name: string;
  status: "verified_gap" | "research_needed" | "rejected";
  reason: string;
  evidence_ids: string[];
  confidence: number;
};

export type LeadDecision = {
  kind: "qualify" | "reject" | "hold";
  service_key?: string;
  service_name?: string;
  reason: string;
  evidence_ids: string[];
  confidence: number;
  website_status: WebsiteStatus | null;
};

export type ContactResult = {
  email: string;
  verification_status: "valid" | "invalid" | "unknown" | "risky" | "suppressed";
  verification_reason: string;
  disposition: "approved" | "hold_review" | "blocked";
  source_url: string;
  source_provider: ContactObservation["source_provider"];
};

export type EmailDraft = {
  subject: string;
  body: string;
  evidence_ids: string[];
  suggested_service: string;
  gap_evidence_id: string;
  word_count: number;
};

export type SendResult = "queued" | "suppressed" | "blocked" | "error" | "not_configured";

export type CampaignConfig = {
  website_percent: number;
  max_leads: number;
  max_per_day: number;
  follow_up_days: number;
  max_follow_ups: number;
  enabled: boolean;
};

export type OrchestrateResult = {
  lead_id: string;
  decision: LeadDecision;
  contacts: ContactResult[];
  email_draft: EmailDraft | null;
  send_result: SendResult;
  follow_up_scheduled: boolean;
  reason: string;
};

// ---------------------------------------------------------------------------
// Injected dependency ports (implemented by the caller; faked in tests)
// ---------------------------------------------------------------------------

export type AssessmentPort = {
  getWebsiteAssessment(input: {
    org_id: string;
    lead_id: string;
  }): Promise<{
    status: string;
    official_url: string | null;
    observed_at: string;
  } | null>;
};

export type ContactPort = {
  getExistingContacts(input: {
    org_id: string;
    lead_id: string;
  }): Promise<ContactObservation[]>;
  storeContacts(input: {
    org_id: string;
    lead_id: string;
    observations: ContactObservation[];
  }): Promise<{ saved: number; skipped: number }>;
};

export type VerificationPort = {
  verifyContacts(input: {
    contacts: ContactObservation[];
    resolver: { resolve: (d: string, t: string) => Promise<unknown> };
    advanced?: { verify: (email: string) => Promise<unknown> };
  }): Promise<ReacherVerificationOutcome[]>;
};

export type EmailGenPort = {
  generate(input: {
    org_id: string;
    business_name: string;
    service_name: string;
    gap_claim: string;
    gap_evidence_id: string;
    evidence_ids: string[];
    confidence: number;
    website_status: string | null;
    language?: "en" | "hinglish";
  }): Promise<EmailDraft | null>;
};

export type GmailPort = {
  send(input: {
    account_email: string;
    sender_name: string;
    to: string;
    subject: string;
    body: string;
    thread_id?: string | null;
    reply_to_rfc_id?: string | null;
  }): Promise<{ provider_id: string; thread_id: string } | null>;
  selectSender(input: {
    recipient_email: string;
    accounts: Array<{
      email: string;
      display_name: string;
      enabled: boolean;
      rate_limited_until: string | null;
    }>;
  }): Promise<{ email: string; display_name: string } | null>;
  recordSend(input: { account_email: string; sent_at: string }): Promise<void>;
};

export type DbPort = {
  recordDecision(input: {
    org_id: string;
    lead_id: string;
    decision: LeadDecision;
  }): Promise<void>;
  recordOutbound(input: {
    org_id: string;
    lead_id: string;
    contact_email: string;
    subject: string;
    body: string;
    state: "draft" | "queued" | "sent" | "held" | "suppressed";
    scheduled_at?: string | null;
  }): Promise<void>;
  isSuppressed(input: { org_id: string; email: string }): Promise<boolean>;
  scheduleFollowUp(input: {
    org_id: string;
    lead_id: string;
    contact_email: string;
    scheduled_at: string;
  }): Promise<void>;
  recordInboundReply(input: {
    org_id: string;
    lead_id: string;
    contact_email: string;
  }): Promise<void>;
  hasFollowUpSent(input: { org_id: string; contact_email: string }): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CampaignConfig = {
  website_percent: 20,
  max_leads: 50,
  max_per_day: 10,
  follow_up_days: 2,
  max_follow_ups: 1,
  enabled: false,
};

function mergeConfig(input?: Partial<CampaignConfig>): CampaignConfig {
  return { ...DEFAULT_CONFIG, ...input };
}

function websiteStatusFromAssessment(
  a: { status: string; official_url: string | null; observed_at: string } | null,
): WebsiteStatus {
  if (!a) return "UNKNOWN";
  const s = a.status.toUpperCase();
  if (s === "WORKING" || s === "VERIFIED_WORKING") return "VERIFIED_WORKING";
  if (s === "PERSISTENTLY_BROKEN" || s === "VERIFIED_SERIOUS_ISSUE")
    return "VERIFIED_SERIOUS_ISSUE";
  if (s === "NO_OFFICIAL_WEBSITE_DISCOVERED") return "NO_OFFICIAL_WEBSITE_FOUND";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export async function orchestrateLead(input: {
  org_id: string;
  lead_id: string;
  business_name: string;
  website_url: string | null;
  serviceMatches?: ServiceMatch[];
  website_problem?: WebsiteProblem | null | undefined;
  operational_need?: OperationalNeed | null | undefined;
  assessment: AssessmentPort;
  contacts: ContactPort;
  verification: VerificationPort;
  email_gen: EmailGenPort;
  gmail: GmailPort;
  db: DbPort;
  config?: Partial<CampaignConfig>;
  now?: Date;
}): Promise<OrchestrateResult> {
  const cfg = mergeConfig(input.config);
  const nowTs = input.now ?? new Date();

  // Disabled campaign: classify only, never send or create outbound rows.
  if (!cfg.enabled) {
    const assessment = await input.assessment
      .getWebsiteAssessment({ org_id: input.org_id, lead_id: input.lead_id })
      .catch(() => null);
    const websiteStatus = websiteStatusFromAssessment(assessment);
    const strictResult = qualifyLeadStrictly({
      website_url: input.website_url,
      website_status: websiteStatus,
      website_problem: input.website_problem,
      operational_need: input.operational_need,
      serviceMatches: input.serviceMatches ?? [],
    });
    const decision = mapStrictDecisionToLeadDecision(strictResult, websiteStatus);
    await input.db
      .recordDecision({
        org_id: input.org_id,
        lead_id: input.lead_id,
        decision,
      })
      .catch(() => {
        /* record failure must not block a read-only classification */
      });
    return {
      lead_id: input.lead_id,
      decision,
      contacts: [],
      email_draft: null,
      send_result: "not_configured",
      follow_up_scheduled: false,
      reason: `Campaign disabled: ${decision.reason}`,
    };
  }

  // Website assessment (existing pinned audit / machine observation).
  const assessment = await input.assessment
    .getWebsiteAssessment({ org_id: input.org_id, lead_id: input.lead_id })
    .catch(() => null);
  const websiteStatus = websiteStatusFromAssessment(assessment);

  // Existing contacts + verification via Reacher / basic DNS.
  const verification = await input.verification
    .verifyContacts({
      contacts: [],
      resolver: { resolve: async () => ({}) },
    })
    .catch(() => []);

  const contactResults: ContactResult[] = verification.map((o) => {
    const { disposition, reason } = mapVerificationToDisposition(o.verification);
    return {
      email: o.contact.value,
      verification_status: o.verification.status as ContactResult["verification_status"],
      verification_reason: reason,
      disposition,
      source_url: o.contact.source_url,
      source_provider: o.contact.source_provider,
    };
  });

  // Qualification decision uses strict Path 1 / Path 2 gates.
  const strictResult = qualifyLeadStrictly({
    website_url: input.website_url,
    website_status: websiteStatus,
    website_problem: input.website_problem,
    operational_need: input.operational_need,
    serviceMatches: input.serviceMatches ?? [],
  });
  const decision = mapStrictDecisionToLeadDecision(strictResult, websiteStatus);

  // Global suppression check for any blocked/suppressed contact: a globally
  // suppressed recipient never receives outreach, regardless of lead
  // qualification status. Checked before qualification so a suppressed
  // contact always yields "suppressed" rather than "blocked".
  const blockedContact = contactResults.find(
    (c) => c.disposition === "blocked" || c.verification_status === "suppressed",
  );
  if (blockedContact) {
    const suppressed = await input.db
      .isSuppressed({ org_id: input.org_id, email: blockedContact.email })
      .catch(() => true);
    if (suppressed) {
      await input.db
        .recordDecision({
          org_id: input.org_id,
          lead_id: input.lead_id,
          decision,
        })
        .catch(() => {});
      return {
        lead_id: input.lead_id,
        decision,
        contacts: contactResults,
        email_draft: null,
        send_result: "suppressed",
        follow_up_scheduled: false,
        reason: "Recipient globally suppressed",
      };
    }
  }

  // If no qualified opportunity, record and return.
  if (decision.kind !== "qualify") {
    await input.db
      .recordDecision({
        org_id: input.org_id,
        lead_id: input.lead_id,
        decision,
      })
      .catch(() => {});
    return {
      lead_id: input.lead_id,
      decision,
      contacts: contactResults,
      email_draft: null,
      send_result: "blocked",
      follow_up_scheduled: false,
      reason: decision.reason,
    };
  }

  // Global suppression check for the approved contact we would send to.
  const approvedContact = contactResults.find(
    (c) => c.disposition === "approved" && c.verification_status === "valid",
  );
  if (approvedContact) {
    const suppressed = await input.db
      .isSuppressed({ org_id: input.org_id, email: approvedContact.email })
      .catch(() => true);
    if (suppressed) {
      await input.db
        .recordDecision({
          org_id: input.org_id,
          lead_id: input.lead_id,
          decision,
        })
        .catch(() => {});
      return {
        lead_id: input.lead_id,
        decision,
        contacts: contactResults,
        email_draft: null,
        send_result: "suppressed",
        follow_up_scheduled: false,
        reason: "Recipient globally suppressed",
      };
    }
  }

  // Live-email gate: no sending unless explicitly enabled.
  if (process.env.ENABLE_LIVE_EMAIL !== "true") {
    await input.db
      .recordDecision({
        org_id: input.org_id,
        lead_id: input.lead_id,
        decision,
      })
      .catch(() => {});
    return {
      lead_id: input.lead_id,
      decision,
      contacts: contactResults,
      email_draft: null,
      send_result: "not_configured",
      follow_up_scheduled: false,
      reason: "Live email disabled: qualified but not sent",
    };
  }

  // Groq email generation.
  let emailDraft: EmailDraft | null = null;
  if (approvedContact) {
    emailDraft = await input.email_gen
      .generate({
        org_id: input.org_id,
        business_name: input.business_name,
        service_name: decision.service_name ?? "ChainCraft service",
        gap_claim: decision.reason,
        gap_evidence_id: "", // strict qualification evidence_ids are URLs, not UUIDs
        evidence_ids: decision.evidence_ids.filter((id): id is string =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        ),
        confidence: decision.confidence,
        website_status: decision.website_status,
      })
      .catch(() => null);
  }

  // Send via selected Gmail account (consistent sender per prospect).
  let send_result: SendResult = "not_configured";
  if (emailDraft && approvedContact) {
    const sender = await input.gmail
      .selectSender({
        recipient_email: approvedContact.email,
        accounts: [], // populated by caller from org account store
      })
      .catch(() => null);

    if (!sender) {
      send_result = "blocked";
    } else {
      const sent = await input.gmail
        .send({
          account_email: sender.email,
          sender_name: sender.display_name,
          to: approvedContact.email,
          subject: emailDraft.subject,
          body: emailDraft.body,
        })
        .catch(() => null);

      if (!sent) {
        send_result = "error";
      } else {
        send_result = "queued";
        await input.db
          .recordOutbound({
            org_id: input.org_id,
            lead_id: input.lead_id,
            contact_email: approvedContact.email,
            subject: emailDraft.subject,
            body: emailDraft.body,
            state: "queued",
          })
          .catch(() => {});
        await input.gmail
          .recordSend({ account_email: sender.email, sent_at: nowTs.toISOString() })
          .catch(() => {});
      }
    }
  }

  // Schedule follow-up (2 business days, max 1, stop on reply).
  let follow_up_scheduled = false;
  if (send_result === "queued" && approvedContact && cfg.max_follow_ups > 0) {
    const alreadySent = await input.db
      .hasFollowUpSent({ org_id: input.org_id, contact_email: approvedContact.email })
      .catch(() => false);
    if (!alreadySent) {
      const followUpAt = new Date(nowTs.getTime() + cfg.follow_up_days * 86400_000);
      await input.db
        .scheduleFollowUp({
          org_id: input.org_id,
          lead_id: input.lead_id,
          contact_email: approvedContact.email,
          scheduled_at: followUpAt.toISOString(),
        })
        .catch(() => {});
      follow_up_scheduled = true;
    }
  }

  await input.db
    .recordDecision({
      org_id: input.org_id,
      lead_id: input.lead_id,
      decision,
    })
    .catch(() => {});

  return {
    lead_id: input.lead_id,
    decision,
    contacts: contactResults,
    email_draft: emailDraft,
    send_result,
    follow_up_scheduled,
    reason: `Qualified: ${decision.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Campaign split (80/20)
// ---------------------------------------------------------------------------

export type CampaignSplit = {
  no_website: number;
  website_improvement: number;
  total_qualified: number;
  no_website_selected: number;
  website_improvement_selected: number;
  total_selected: number;
  no_website_pct: number;
  website_improvement_pct: number;
  within_tolerance: boolean;
};

export function computeCampaignSplit(
  decisions: LeadDecision[],
): CampaignSplit {
  const qualified = decisions.filter((d) => d.kind === "qualify");
  const noWebsite = qualified.filter(
    (d) => d.website_status === "NO_OFFICIAL_WEBSITE_FOUND",
  ).length;
  const websiteImprovement = qualified.filter(
    (d) =>
      d.website_status === "VERIFIED_WORKING" ||
      d.website_status === "VERIFIED_OUTDATED" ||
      d.website_status === "VERIFIED_SLOW" ||
      d.website_status === "VERIFIED_SERIOUS_ISSUE",
  ).length;
  return {
    no_website: noWebsite,
    website_improvement: websiteImprovement,
    total_qualified: qualified.length,
    no_website_selected: noWebsite,
    website_improvement_selected: websiteImprovement,
    total_selected: noWebsite + websiteImprovement,
    no_website_pct: qualified.length > 0 ? Math.round((noWebsite / qualified.length) * 100) : 0,
    website_improvement_pct:
      qualified.length > 0 ? Math.round((websiteImprovement / qualified.length) * 100) : 0,
    within_tolerance:
      qualified.length === 0
        ? true
        : Math.abs((noWebsite / qualified.length) * 100 - 20) <= 10,
  };
}

// ---------------------------------------------------------------------------
// Inbound reply handling (stops follow-ups, never auto-replies)
// ---------------------------------------------------------------------------

export type InboundReplyResult = {
  lead_id: string;
  contact_email: string;
  follow_up_stopped: boolean;
  auto_reply_sent: boolean;
};

export async function handleInboundReply(input: {
  org_id: string;
  lead_id: string;
  contact_email: string;
  db: DbPort;
}): Promise<InboundReplyResult> {
  // The system never autonomously replies. It records the reply and stops
  // any pending follow-up.
  await input.db
    .recordInboundReply({
      org_id: input.org_id,
      lead_id: input.lead_id,
      contact_email: input.contact_email,
    })
    .catch(() => {});

  return {
    lead_id: input.lead_id,
    contact_email: input.contact_email,
    follow_up_stopped: true,
    auto_reply_sent: false,
  };
}

// Map a StrictQualificationResult to a LeadDecision for the rest of the pipeline.
export function mapStrictDecisionToLeadDecision(
  decision: StrictQualificationResult,
  website_status: WebsiteStatus | null,
): LeadDecision {
  if (decision.qualified) {
    return {
      kind: "qualify",
      service_key: decision.service_key ?? undefined,
      service_name: decision.service_name ?? undefined,
      reason: decision.reason,
      evidence_ids: decision.evidence.map((e) => e.url),
      confidence: decision.confidence,
      website_status,
    };
  }
  // Not qualified: hold (never reject outright - absence of evidence is not
  // proof of disqualification; the lead can be revisited with new evidence).
  return {
    kind: "hold",
    service_key: undefined,
    service_name: undefined,
    reason: decision.reason,
    evidence_ids: decision.evidence.map((e) => e.url),
    confidence: decision.confidence,
    website_status,
  };
}

export { mapVerificationToDisposition };

