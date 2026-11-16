// Evidence-based website assessment for discovered businesses.
//
// Reuses the project's existing permitted-audit capability — auditWebsite()
// with an injected pinned transport (robots-aware, SSRF-safe) and the
// website-audit-result outcome classifier. This module is an assessment layer
// ONLY: qualifyLeadStrictly() in qualification.ts remains the single
// qualification authority, and nothing here qualifies a lead or triggers
// outreach.
//
// The six supported outcomes:
// - VERIFIED_WORKING: identity-correlated official domain, permitted audit
//   observed HTTP 2xx.
// - VERIFIED_SERIOUS_ISSUE: identity-correlated official DOMAIN ROOT whose
//   permitted audit reproducibly observed the same failure (404/410 or 5xx)
//   across a bounded number of repeat observations. A single HTTP 5xx is
//   treated as transient, and a sub-page failure never becomes a site verdict.
// - CANDIDATE_DOMAIN_UNVERIFIED: a candidate URL exists, but hostname-token
//   identity correlation failed; no probe is made.
// - NO_OFFICIAL_WEBSITE_FOUND: only after documented negative research via an
//   injected research function. A missing URL or absent OSM tag alone never
//   produces this status.
// - ASSESSMENT_FAILED: timeout, robots/policy block, transport ambiguity or
//   injected-port failure. Never becomes evidence of anything about the site.
// - UNKNOWN: insufficient evidence to determine website status.
//
// Deliberately absent: "outdated" labeling (needs concrete design/timestamp
// evidence this layer does not collect) and any operational-need inference
// (a phone number or missing AI mention proves nothing).
import { auditWebsite, type PinnedAuditTransport } from "./audit.ts";
import { failedWebsiteAudit, storedWebsiteAudit } from "./website-audit-result.ts";
import { safeResearchUrl } from "./research.ts";
import type { WebsiteProblem } from "./qualification.ts";
import type { DiscoveredBusiness } from "./discovery-coordinator.ts";
import type { OfficialWebsiteResearch } from "./website-research.ts";

export type { OfficialWebsiteResearch } from "./website-research.ts";

export type WebsiteAssessmentStatus =
  | "VERIFIED_WORKING"
  | "VERIFIED_SERIOUS_ISSUE"
  | "CANDIDATE_DOMAIN_UNVERIFIED"
  | "NO_OFFICIAL_WEBSITE_FOUND"
  | "ASSESSMENT_FAILED"
  | "UNKNOWN";

// Narrow contract fed into qualifyLeadStrictly: website_status carries the
// established status (the three strings websiteStatusFromAssessment already
// understands) or null = unknown; website_problem carries only observed,
// reproducible technical problems.
export type BusinessWebsiteAssessment = {
  status: WebsiteAssessmentStatus;
  website_status: string | null;
  website_problem: WebsiteProblem | null;
  official_url: string | null;
  observed_at: string;
  method: string;
  reason: string;
  evidence_url: string | null;
  // In-process only (never persisted, never part of the coordinator output):
  // the permitted 2xx audit body so contact discovery can extract public
  // business contacts from the page that was ALREADY fetched under the
  // robots-aware pinned-audit protections — no second request is made.
  audited_page?: { url: string; public_page_text: string; observed_at: string };
};

// Host-side identity correlation: at least one significant business-name token
// must appear in the hostname (the same correlation principle discovery.ts
// applies to search hits). This corroborates identity only — it is not legal
// ownership proof, and no probe runs without it, so snippets and OSM tags can
// never verify a domain on their own.
export function domainIdentityMatches(businessName: string, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const tokens = businessName.toLocaleLowerCase("en")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((token) => token.length >= 4);
  if (!tokens.length) return false;
  return tokens.some((token) => host.includes(token));
}

function unassessed(
  status: WebsiteAssessmentStatus,
  reason: string,
  observedAt: string,
  officialUrl: string | null,
  method: string,
): BusinessWebsiteAssessment {
  return {
    status,
    website_status: null, // nothing was established: stays unknown
    website_problem: null,
    official_url: officialUrl,
    observed_at: observedAt,
    method,
    reason,
    evidence_url: officialUrl,
  };
}

export function createWebsiteAssessor(deps: {
  transport: PinnedAuditTransport;
  permissionReference: string;
  // Optional: production wiring for documented negative research. Without it a
  // missing URL can only be UNKNOWN — absence is never assumed.
  researchOfficialWebsite?: (business: DiscoveredBusiness) => Promise<OfficialWebsiteResearch>;
  // Bounded repeat observations before a persistent failure verdict: a single
  // HTTP 5xx is transient until it reproduces on every attempt. The production
  // entrypoint passes a real delay between attempts; tests pass 0.
  maxFailureObservations?: number;
  retryDelayMs?: number;
  now?: () => Date;
}): { assess(input: { business: DiscoveredBusiness }): Promise<BusinessWebsiteAssessment> } {
  const now = deps.now ?? (() => new Date());
  const maxObservations = Math.max(2, Math.min(deps.maxFailureObservations ?? 3, 5));
  const retryDelayMs = Math.max(0, deps.retryDelayMs ?? 0);

  type Observation = {
    outcome: "ok" | "http_5xx" | "not_found" | "review_required";
    httpStatus: number | null;
    url: string;
    observed_at: string;
  };

  // Persistent verdict only when EVERY bounded observation failed the same
  // way; the evidence preserves each actual HTTP status, URL and timestamp.
  const persistentProblem = (
    observations: Observation[],
    type: "broken" | "serious_issue",
    reason: string,
  ): BusinessWebsiteAssessment => {
    const last = observations[observations.length - 1];
    const statuses = observations.map((observation) => observation.httpStatus ?? "unknown").join(", ");
    const times = observations.map((observation) => observation.observed_at).join(", ");
    return {
      status: "VERIFIED_SERIOUS_ISSUE",
      website_status: "VERIFIED_SERIOUS_ISSUE",
      website_problem: {
        type,
        url: last.url,
        evidence_claim: `Permitted pinned audit observed HTTP ${statuses} across ${observations.length} observation(s) for ${last.url}.`,
        evidence_url: last.url,
        observed_at: last.observed_at,
        confidence: 0.7, // observed directly by a permitted audit; clears the 0.6 verified bar
        method: "automated_check",
        details: `HTTP ${statuses} observed at ${times}. The failure reproduced on every bounded observation `
          + "and is reproducible by re-running the same permitted audit.",
      },
      official_url: last.url,
      observed_at: last.observed_at,
      method: "pinned_audit",
      reason,
      evidence_url: last.url,
    };
  };

  return {
    assess: async ({ business }): Promise<BusinessWebsiteAssessment> => {
      const observedAt = now().toISOString();
      let url = business.website_url;

      if (!url) {
        if (!deps.researchOfficialWebsite) {
          return unassessed(
            "UNKNOWN",
            "No official website URL is recorded and no documented website research is wired. "
              + "A missing URL or absent OSM tag never establishes that a business has no website.",
            observedAt,
            null,
            "none",
          );
        }
        let research: OfficialWebsiteResearch;
        try {
          research = await deps.researchOfficialWebsite(business);
        } catch (err) {
          return unassessed(
            "ASSESSMENT_FAILED",
            `Documented website research failed (${err instanceof Error ? err.message : String(err)}); no website conclusion was recorded.`,
            observedAt,
            null,
            "documented_research",
          );
        }
        const researchObservedAt =
          research.queries[research.queries.length - 1]?.observed_at ?? observedAt;
        if (research.outcome !== "verified_candidate") {
          // Three non-verified outcomes: ambiguous candidates are preserved
          // for review, an incomplete protocol is a failure (never absence),
          // and only a fully completed protocol may conclude no website found.
          if (research.outcome === "unverified_candidates") {
            return unassessed(
              "CANDIDATE_DOMAIN_UNVERIFIED",
              `${research.reason} Ownership is unverified and no probe was made.`,
              researchObservedAt,
              research.candidates[0] ?? null,
              "documented_research",
            );
          }
          if (research.outcome === "incomplete") {
            return unassessed(
              "ASSESSMENT_FAILED",
              research.reason,
              researchObservedAt,
              null,
              "documented_research",
            );
          }
          return {
            status: "NO_OFFICIAL_WEBSITE_FOUND",
            website_status: "NO_OFFICIAL_WEBSITE_FOUND",
            website_problem: null,
            official_url: null,
            observed_at: researchObservedAt,
            method: "documented_research",
            reason: research.reason,
            evidence_url: research.sources[0] ?? null,
          };
        }
        url = research.official_url;
      }

      let parsed: URL;
      try {
        parsed = new URL(safeResearchUrl(url));
      } catch {
        return unassessed(
          "UNKNOWN",
          "The recorded URL is not a permitted public URL; website status cannot be determined.",
          observedAt,
          url,
          "none",
        );
      }

      // Identity gate: no probe of a domain that does not correlate with the
      // business identity — a candidate domain stays unverified.
      if (!domainIdentityMatches(business.business_name, parsed)) {
        return unassessed(
          "CANDIDATE_DOMAIN_UNVERIFIED",
          "A candidate domain exists, but its hostname does not correlate with the business identity. "
            + "Ownership is unverified and no probe was made.",
          observedAt,
          parsed.toString(),
          "identity_correlation",
        );
      }

      const host = parsed.hostname;
      const approvedHosts = host.startsWith("www.") ? [host, host.slice(4)] : [host, `www.${host}`];
      // A failure on a sub-page URL never becomes a whole-site verdict: only
      // the domain root can establish site-level status.
      const rootPath = parsed.pathname === "/" || parsed.pathname === "";
      try {
        const observations: Observation[] = [];
        for (let attempt = 1; attempt <= maxObservations; attempt++) {
          if (attempt > 1 && retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
          const audit = await auditWebsite(
            { url: parsed.toString(), permissionReference: deps.permissionReference, approvedHosts },
            deps.transport,
          );
          const stored = storedWebsiteAudit(audit, parsed.toString());
          observations.push({
            outcome: stored.outcome,
            httpStatus: stored.httpStatus,
            url: audit.url,
            observed_at: audit.observed_at,
          });
          if (stored.outcome === "ok") {
            const transient = observations.length > 1
              ? ` An earlier observation (${observations
                  .slice(0, -1)
                  .map((observation) => `HTTP ${observation.httpStatus}`)
                  .join(", ")}) did not reproduce.`
              : "";
            return {
              status: "VERIFIED_WORKING",
              website_status: "VERIFIED_WORKING",
              website_problem: null,
              official_url: audit.url,
              observed_at: audit.observed_at,
              method: "pinned_audit",
              reason: `A permitted pinned audit observed HTTP ${stored.httpStatus} on the identity-correlated official domain.${transient} `
                + "Website presence and reachability are verified; ownership title and service quality remain unreviewed.",
              evidence_url: audit.url,
              // 2xx body kept in-process for contact extraction only.
              audited_page: { url: audit.url, public_page_text: audit.public_page_text, observed_at: audit.observed_at },
            };
          }
          if (stored.outcome === "review_required") {
            // e.g. 403: policy review needed — no verdict either way.
            return unassessed(
              "ASSESSMENT_FAILED",
              `The permitted audit observed HTTP ${stored.httpStatus}, which requires policy review; reachability is inconclusive.`,
              audit.observed_at,
              parsed.toString(),
              "pinned_audit",
            );
          }
          // Failure outcome: keep observing within the bounded budget so a
          // transient server error is distinguished from a reproducible one.
        }
        // Every bounded observation failed.
        const last = observations[observations.length - 1];
        const statuses = observations.map((observation) => observation.httpStatus ?? "unknown").join(", ");
        if (!rootPath) {
          return unassessed(
            "UNKNOWN",
            `The tested URL ${parsed.toString()} returned HTTP ${statuses} on every observation, but it is not the domain root; `
              + "a sub-page failure does not establish whole-site status and needs manual review.",
            last.observed_at,
            parsed.toString(),
            "pinned_audit",
          );
        }
        if (observations.every((observation) => observation.outcome === "not_found")) {
          return persistentProblem(
            observations,
            "broken",
            `The official website root reproducibly returned HTTP ${statuses} (broken page) — distinct from the business having no website.`,
          );
        }
        if (observations.every((observation) => observation.outcome === "http_5xx")) {
          return persistentProblem(
            observations,
            "serious_issue",
            `The official website is currently unreachable: the permitted audit reproducibly observed HTTP ${statuses}.`,
          );
        }
        return unassessed(
          "ASSESSMENT_FAILED",
          `Repeated permitted observations were inconsistent (HTTP ${statuses}); reachability is inconclusive and needs manual review.`,
          last.observed_at,
          parsed.toString(),
          "pinned_audit",
        );
      } catch (err) {
        // Thrown errors (timeout, robots/policy blocks, transport ambiguity)
        // are assessment failures — never evidence about the website itself.
        const stored = failedWebsiteAudit(parsed.toString(), err);
        if (stored.errorCode === "AUDIT_TIMEOUT") {
          return unassessed(
            "ASSESSMENT_FAILED",
            "The website assessment timed out before any observation was recorded.",
            observedAt,
            parsed.toString(),
            "pinned_audit",
          );
        }
        return unassessed(
          "ASSESSMENT_FAILED",
          `The website assessment could not complete (${stored.errorCode}); no website conclusion was recorded.`,
          observedAt,
          parsed.toString(),
          "pinned_audit",
        );
      }
    },
  };
}
