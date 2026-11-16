import { safeResearchUrl } from "./research.ts";
import { canonicalDiscoveryCountry } from "./market-targeting.ts";

type Lead = { id: string; country: string | null; website_url: string | null; is_demo: boolean; status: string };
type Audit = { id: string; checked_url: string; checked_at: string; outcome: string; http_status: number | null };
type Proposal = { id: string; source_url: string; proposed_website_url: string; observed_at: string };

export type AutomaticWebsiteObservation = {
  state: "recorded_url_reachable" | "proposed_unconfirmed" | "unknown";
  recorded_url: string | null; checked_url: string | null; audit_observation_id: string | null;
  http_status: number | null; proposed_website_url: string | null; proposal_source_url: string | null;
  reason: string; confidence: number; observed_at: string; source_fingerprint: string;
};

export async function planAutomaticWebsiteObservation(input: {
  lead: Lead; reviewedAssessmentObservedAt: string | null; audits: Audit[]; proposals: Proposal[];
}, now = Date.now()): Promise<AutomaticWebsiteObservation | null> {
  const { lead } = input;
  if (canonicalDiscoveryCountry(lead.country ?? "") !== "United States" || lead.is_demo || ["disqualified", "lost", "won"].includes(lead.status) ||
    (input.reviewedAssessmentObservedAt && Date.parse(input.reviewedAssessmentObservedAt) <= now &&
      Date.parse(input.reviewedAssessmentObservedAt) > now - 30 * 86400000)) return null;
  const recent = (value: string) => Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= now && Date.parse(value) > now - 30 * 86400000;
  const audit = lead.website_url ? input.audits.filter((item) =>
    item.checked_url === lead.website_url && recent(item.checked_at))
    .sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0] : undefined;
  const proposal = !lead.website_url ? input.proposals.filter((item) => {
    try { return recent(item.observed_at) && safeResearchUrl(item.source_url) &&
      safeResearchUrl(item.proposed_website_url); } catch { return false; }
  }).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0] : undefined;
  const reachable = !!audit && audit.outcome === "ok" && audit.http_status !== null &&
    audit.http_status >= 200 && audit.http_status < 300;
  const state = reachable ? "recorded_url_reachable" : proposal ? "proposed_unconfirmed" : "unknown";
  const reason = reachable
    ? `A permitted pinned audit returned HTTP ${audit!.http_status} for the recorded business URL. Site ownership and service adequacy remain unreviewed.`
    : proposal ? "A discovery source proposes a website. Ownership and reachability are unconfirmed."
      : audit?.outcome === "http_5xx"
        ? `A current pinned check returned HTTP ${audit.http_status} for the recorded URL. This may be temporary; website presence and service adequacy remain unconfirmed.`
        : audit?.outcome === "not_found"
          ? `A current pinned check returned HTTP ${audit.http_status} for the recorded URL. That URL was not found at that time; this does not prove the business lacks a website.`
          : audit?.outcome === "review_required"
            ? "The pinned website check needs policy or network review. Reachability and website presence remain unconfirmed."
      : lead.website_url ? "A business URL is recorded, but no current successful pinned audit establishes reachability."
        : "No official business URL is recorded. Website presence or absence remains unknown.";
  const snapshot = JSON.stringify({ lead: lead.id, website: lead.website_url, audit: audit?.id ?? null,
    proposal: proposal?.id ?? null, state,
    unknown_period: !audit && !proposal ? Math.floor(now / (30 * 86400000)) : null });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot)));
  const source_fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { state, recorded_url: lead.website_url, checked_url: audit?.checked_url ?? null,
    audit_observation_id: audit?.id ?? null, http_status: audit?.http_status ?? null,
    proposed_website_url: proposal?.proposed_website_url ?? null,
    proposal_source_url: proposal?.source_url ?? null, reason,
    confidence: reachable ? 0.75 : proposal ? 0.45 : 0.2,
    observed_at: audit?.checked_at ?? proposal?.observed_at ?? new Date(now).toISOString(), source_fingerprint };
}
