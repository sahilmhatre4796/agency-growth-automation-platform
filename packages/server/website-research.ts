// Documented official-website research: a bounded, multi-query search protocol
// used when a discovered business has no recorded website URL. This is
// RESEARCH only — it never verifies ownership from a snippet, never claims
// website absence from an empty result, and never qualifies a lead.
// qualifyLeadStrictly remains the sole qualification authority;
// website-assessment.ts maps these outcomes onto the existing assessment
// contract.
//
// Protocol rules (enforced below):
// - At least two distinct query variations must complete before any
//   "not found" conclusion ("An empty result from one query is insufficient").
// - A failed query (provider error, timeout, quota) with no verified
//   candidate yields `incomplete`, never a negative finding.
// - Social profiles, directories and unrelated domains are never the official
//   website; a candidate must correlate with the business identity
//   (domainIdentityMatches) before it is treated as official — and even then
//   the assessor re-checks identity and probes before any verdict.
// - Conflicting identity-correlated candidates are preserved as ambiguous
//   for manual review, never silently picked.
import { safeResearchUrl, type SearchAdapter } from "./research.ts";
import { domainIdentityMatches } from "./website-assessment.ts";
import type { DiscoveredBusiness } from "./discovery-coordinator.ts";

// One executed query: the actual query text, hit count, timestamp and any
// provider error — the documented record of what the research did.
export type ResearchQueryRecord = {
  query: string;
  hits: number;
  observed_at: string;
  error: string | null;
};

// outcome semantics:
// - verified_candidate: exactly one identity-correlated hostname was found.
//   The assessor still re-checks identity and probes before any verdict.
// - unverified_candidates: candidate domain(s) exist but ownership could not
//   be established, or identity candidates conflict — preserved for review.
// - no_candidate: the full documented protocol completed (>=2 queries, no
//   errors) and no credible official-domain candidate appeared. This records
//   the research outcome; it is NOT proof that no website exists anywhere.
// - incomplete: a required query failed (provider error/timeout/quota) with
//   no verified candidate — never a negative website finding.
export type OfficialWebsiteResearch =
  | {
      outcome: "verified_candidate";
      official_url: string;
      source_url: string;
      queries: ResearchQueryRecord[];
      rejected: string[];
    }
  | {
      outcome: "unverified_candidates";
      candidates: string[];
      queries: ResearchQueryRecord[];
      reason: string;
    }
  | {
      outcome: "no_candidate";
      queries: ResearchQueryRecord[];
      sources: string[]; // consulted URLs preserved as evidence
      reason: string;
    }
  | { outcome: "incomplete"; queries: ResearchQueryRecord[]; reason: string };

// Social profiles and directories can never be the official website, even
// when their URL path contains the business name (same host classes
// discovery.ts already excludes from candidate identity).
const EXCLUDED_CANDIDATE_HOST =
  /(^|\.)(instagram|facebook|youtube|tiktok|pinterest|threads|linkedin|booking|aeroleads|indiamart|justdial|sulekha|yelp|yellowpages|yellow|truelocal|tradeindia)\.com$|(^|\.)yellow\.co\.nz$|(^|\.)truelocal\.com\.au$|(^|\.)directory\.example\.org$/;

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function createOfficialWebsiteResearch(deps: {
  adapter: SearchAdapter | null;
  // Bounded protocol: at least two query variations must complete before any
  // negative conclusion; at most five.
  maxQueries?: number;
  now?: () => Date;
}): (business: DiscoveredBusiness) => Promise<OfficialWebsiteResearch> {
  const now = deps.now ?? (() => new Date());
  const queryCount = Math.max(2, Math.min(deps.maxQueries ?? 3, 5));

  return async (business) => {
    const name = normalize(business.business_name).slice(0, 150);
    const location = [business.city, business.state_region, business.country]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .map(normalize)
      .join(" ");
    const variations = [
      `"${name}" ${location} official website`,
      `${name} ${location} website`,
      `${name} ${location} contact email`,
      `${name} official site`,
      `${name} homepage`,
    ];
    const queries = [...new Set(variations.map((query) => query.replace(/\s+/g, " ").trim().slice(0, 300)))]
      .slice(0, queryCount);

    if (!deps.adapter) {
      return {
        outcome: "incomplete",
        queries: [],
        reason: "SERPER_NOT_CONFIGURED: documented website research requires a configured search adapter; "
          + "no negative website conclusion was recorded.",
      };
    }

    const records: ResearchQueryRecord[] = [];
    const sources: string[] = [];
    const identityHosts = new Map<string, string>(); // hostname -> url
    const unverified: string[] = [];
    let failed = false;

    for (const query of queries) {
      const observed_at = now().toISOString();
      try {
        const hits = await deps.adapter.search(query, 5);
        records.push({ query, hits: hits.length, observed_at, error: null });
        for (const hit of hits) {
          let url: string;
          try {
            url = safeResearchUrl(hit.url); // unsafe/malformed URLs never count
          } catch {
            continue;
          }
          let host: string;
          try {
            host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
          } catch {
            continue;
          }
          if (EXCLUDED_CANDIDATE_HOST.test(host)) {
            sources.push(url); // consulted, but can never be the official site
            continue;
          }
          if (domainIdentityMatches(business.business_name, new URL(url))) {
            if (!identityHosts.has(host)) identityHosts.set(host, url);
          } else if (normalize(`${hit.title} ${hit.content}`).includes(normalize(business.business_name))) {
            // The hit names the business but its host does not correlate:
            // a candidate whose ownership cannot be established.
            if (!unverified.includes(url)) unverified.push(url);
          } else {
            sources.push(url); // unrelated noise, consulted only
          }
        }
      } catch (err) {
        failed = true;
        records.push({
          query,
          hits: 0,
          observed_at,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Positive identity evidence survives a later failed query: a found
    // candidate is not a negative finding, so a partial protocol failure
    // does not discard it.
    if (identityHosts.size === 1) {
      const official_url = [...identityHosts.values()][0];
      return {
        outcome: "verified_candidate",
        official_url,
        source_url: official_url,
        queries: records,
        rejected: [...unverified, ...sources],
      };
    }
    if (identityHosts.size > 1) {
      const candidates = [...identityHosts.values()];
      return {
        outcome: "unverified_candidates",
        candidates,
        queries: records,
        reason: `Conflicting identity-correlated candidates (${candidates.join(", ")}); `
          + "ownership is ambiguous and preserved for manual review.",
      };
    }
    if (unverified.length > 0) {
      return {
        outcome: "unverified_candidates",
        candidates: unverified,
        queries: records,
        reason: `Candidate domain(s) mention the business but no hostname identity correlation was established `
          + `(${unverified.join(", ")}); ownership is unverified.`,
      };
    }
    if (failed) {
      const errors = records.filter((record) => record.error).map((record) => record.error).join("; ");
      return {
        outcome: "incomplete",
        queries: records,
        reason: `Documented website research did not complete (${errors}); no website conclusion was recorded.`,
      };
    }
    return {
      outcome: "no_candidate",
      queries: records,
      sources,
      reason: `No official website found after documented research: `
        + `${records.map((record) => `"${record.query}" → ${record.hits} hit(s)`).join("; ")}. `
        + "This records the completed research protocol, not proof that no website exists.",
    };
  };
}
