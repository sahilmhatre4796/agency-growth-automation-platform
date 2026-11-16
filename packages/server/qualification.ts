// Strict 80/20 qualification engine.
// Every business in the qualified pool must pass ONE of two evidence-backed
// paths. Absence of evidence is not proof of opportunity.
// ============================================================================
// Path 1: Verified Website Problem
// The business has an official website, but research identifies at least one
// genuine, evidence-supported problem.
// ============================================================================

export type WebsiteProblem = {
  type: "slow" | "broken" | "outdated" | "serious_issue";
  url: string;
  evidence_claim: string;
  evidence_url: string;
  observed_at: string;
  confidence: number;
  method: "page_speed" | "manual_review" | "user_report" | "automated_check";
  details: string;
};

export function isVerifiedWebsiteProblem(
  problem: WebsiteProblem | null | undefined,
): problem is WebsiteProblem {
  if (!problem) return false;
  return !!(
    problem.url &&
    problem.evidence_claim &&
    problem.evidence_url &&
    problem.observed_at &&
    problem.confidence >= 0.6 &&
    ["slow", "broken", "outdated", "serious_issue"].includes(problem.type)
  );
}

// ============================================================================
// Path 2: Verified Operational Need for Additional ChainCraft Solution
// A business may have a working website and still qualify for AI receptionist,
// AI chatbot, WhatsApp automation, appointment booking, lead capture,
// CRM, custom AI agents, B2B portals, or custom integrations.
// ============================================================================

export type OperationalNeed = {
  type:
    | "ai_receptionist"
    | "ai_chatbot"
    | "whatsapp_automation"
    | "appointment_booking"
    | "lead_capture"
    | "crm"
    | "custom_ai_agent"
    | "b2b_portal"
    | "custom_integration"
    | "workflow_automation";
  evidence_claim: string;
  evidence_url: string;
  observed_at: string;
  confidence: number;
  source: "public_enquiries" | "missed_calls" | "manual_workflow" | "public_statement";
  details: string;
};

export function isVerifiedOperationalNeed(
  need: OperationalNeed | null | undefined,
): need is OperationalNeed {
  if (!need) return false;
  return !!(
    need.evidence_claim &&
    need.evidence_url &&
    need.observed_at &&
    need.confidence >= 0.6 &&
    [
      "ai_receptionist", "ai_chatbot", "whatsapp_automation",
      "appointment_booking", "lead_capture", "crm", "custom_ai_agent",
      "b2b_portal", "custom_integration", "workflow_automation",
    ].includes(need.type)
  );
}

// ============================================================================
// Strict Qualification: A business qualifies ONLY when it passes Path 1 or
// Path 2 with genuine evidence. A working website with no demonstrated need
// is REJECTED, not qualified.
// ============================================================================

export type StrictQualificationResult = {
  qualified: boolean;
  category: "website" | "automation" | null;
  path: "path_0_service_match" | "path_1_website_problem" | "path_2_operational_need" | null;
  service_key: string | null;
  service_name: string | null;
  reason: string;
  evidence: Array<{
    type: "website_problem" | "operational_need";
    claim: string;
    url: string;
    confidence: number;
  }>;
  confidence: number;
};

export function qualifyLeadStrictly(input: {
  website_url: string | null;
  website_status: string | null; // from assessment: WORKING, OUTDATED, SLOW, SERIOUS_ISSUE, NO_OFFICIAL_WEBSITE_FOUND, UNKNOWN
  website_problem: WebsiteProblem | null | undefined;
  operational_need: OperationalNeed | null | undefined;
  serviceMatches: Array<{
    service_key: string;
    service_name: string;
    status: "verified_gap" | "research_needed" | "rejected";
    reason: string;
    evidence_ids: string[];
    confidence: number;
  }>;
}): StrictQualificationResult {
  // Path 0: Classic service match qualification - a verified_gap service match
  // from classifyLeadOpportunity qualifies as a genuine opportunity.
  const verifiedGapMatch = input.serviceMatches.find(
    (m) => m.status === "verified_gap",
  );
  if (verifiedGapMatch) {
    return {
      qualified: true,
      category: verifiedGapMatch.service_key === "service_01" ? "website" : "automation",
      path: "path_0_service_match",
      service_key: verifiedGapMatch.service_key,
      service_name: verifiedGapMatch.service_name,
      reason: verifiedGapMatch.reason,
      evidence: [],
      confidence: verifiedGapMatch.confidence,
    };
  }

  // Path 1: Verified website problem - business has a website but it has a
  // genuine, evidence-supported problem.
  if (isVerifiedWebsiteProblem(input.website_problem)) {
    // Match to a website-related service (service_01 = website)
    const websiteMatch = input.serviceMatches.find(
      (m) => m.service_key === "service_01" && m.status === "verified_gap",
    );
    if (websiteMatch) {
      return {
        qualified: true,
        category: "website",
        path: "path_1_website_problem",
        service_key: websiteMatch.service_key,
        service_name: websiteMatch.service_name,
        reason: `Verified website problem: ${input.website_problem.evidence_claim}`,
        evidence: [{
          type: "website_problem",
          claim: input.website_problem.evidence_claim,
          url: input.website_problem.evidence_url,
          confidence: input.website_problem.confidence,
        }],
        confidence: Math.min(input.website_problem.confidence, websiteMatch.confidence),
      };
    }
  }

  // Path 2: Verified operational need - business has a working website but
  // demonstrates a genuine need for an additional ChainCraft solution.
  if (isVerifiedOperationalNeed(input.operational_need)) {
    // Match to an automation-related service
    const automationMatch = input.serviceMatches.find(
      (m) =>
        /^service_(09|10|11|12|13|14|15|16|17|18|19|20|23|24)$/.test(m.service_key) &&
        m.status === "verified_gap",
    );
    if (automationMatch) {
      return {
        qualified: true,
        category: "automation",
        path: "path_2_operational_need",
        service_key: automationMatch.service_key,
        service_name: automationMatch.service_name,
        reason: `Verified operational need: ${input.operational_need.evidence_claim}`,
        evidence: [{
          type: "operational_need",
          claim: input.operational_need.evidence_claim,
          url: input.operational_need.evidence_url,
          confidence: input.operational_need.confidence,
        }],
        confidence: Math.min(input.operational_need.confidence, automationMatch.confidence),
      };
    }
  }

  // No qualified path. Reject or hold.
  return {
    qualified: false,
    category: null,
    path: null,
    service_key: null,
    service_name: null,
    reason: "No qualified opportunity: no verified website problem or operational need established. "
      + "A working website alone does not qualify a business for the 20% segment.",
    evidence: [],
    confidence: 0,
  };
}

// ============================================================================
// Strict 80/20 allocation enforcer.
// Applies the 80/20 split to the QUALIFIED pool only. If one category lacks
// sufficient qualified leads, the remaining capacity stays unfilled - we do
// NOT weaken qualification to fill the ratio.
// ============================================================================

export type StrictSplitResult = {
  no_website_qualified: number;
  website_improvement_qualified: number;
  total_qualified: number;
  no_website_selected: number;
  website_improvement_selected: number;
  total_selected: number;
  no_website_pct: number;
  website_improvement_pct: number;
  within_tolerance: boolean;
};

export function enforce80_20Split(
  decisions: StrictQualificationResult[],
  targetNoWebsitePct = 80,
): StrictSplitResult {
  const noWebsite = decisions.filter(
    (d) => d.qualified && d.category === "website" && d.path === "path_1_website_problem",
  ).length;
  const websiteImprovement = decisions.filter(
    (d) => d.qualified && d.category === "automation" && d.path === "path_2_operational_need",
  ).length;
  const totalQualified = noWebsite + websiteImprovement;

  // Apply 80/20 to the qualified pool. We select up to the target ratio,
  // but never exceed the available qualified leads in either category.
  const targetNoWebsite = Math.round(totalQualified * (targetNoWebsitePct / 100));
  const targetWebsiteImprovement = totalQualified - targetNoWebsite;

  const noWebsiteSelected = Math.min(noWebsite, targetNoWebsite);
  const websiteImprovementSelected = Math.min(websiteImprovement, targetWebsiteImprovement);
  const totalSelected = noWebsiteSelected + websiteImprovementSelected;

  return {
    no_website_qualified: noWebsite,
    website_improvement_qualified: websiteImprovement,
    total_qualified: totalQualified,
    no_website_selected: noWebsiteSelected,
    website_improvement_selected: websiteImprovementSelected,
    total_selected: totalSelected,
    no_website_pct: totalQualified > 0 ? Math.round((noWebsiteSelected / totalQualified) * 100) : 0,
    website_improvement_pct: totalQualified > 0 ? Math.round((websiteImprovementSelected / totalQualified) * 100) : 0,
    within_tolerance: totalQualified === 0
      ? true
      : Math.abs((noWebsiteSelected / totalQualified) * 100 - targetNoWebsitePct) <= 10,
  };
}

// ============================================================================
// Strict reject reason for businesses that don't qualify.
// ============================================================================

export function rejectionReason(
  decision: StrictQualificationResult,
): string {
  if (decision.qualified) return "";
  return "No verified website problem or operational need established. "
    + "Rejected: insufficient evidence.";
}

// ============================================================================
// Campaign split (80/20)
// ============================================================================

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

// ============================================================================
// Build a ServiceMatch from a StrictQualificationResult for downstream use.
// ============================================================================

export function strictMatchFromQualification(
  q: StrictQualificationResult,
): {
  service_key: string;
  status: "verified_gap";
  reason: string;
  evidence_ids: string[];
  confidence: number;
} | null {
  if (!q.qualified || !q.service_key) return null;
  return {
    service_key: q.service_key,
    status: "verified_gap",
    reason: q.reason,
    evidence_ids: q.evidence.map((e: { url: string }) => e.url).filter(Boolean),
    confidence: q.confidence,
  };
}
