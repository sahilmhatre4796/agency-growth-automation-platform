import { expect, test } from "vitest";
import { planAutomaticWebsiteObservation } from "../packages/server/automatic-website-observation.ts";

const now = Date.parse("2026-10-25T02:00:00.000Z");
const lead = { id: "10000000-0000-4000-8000-000000000001", country: "USA",
  website_url: null, is_demo: false, status: "researching" };
const audit = { id: "10000000-0000-4000-8000-000000000002",
  checked_url: "https://studio.example/", checked_at: new Date(now - 3600000).toISOString(),
  outcome: "ok", http_status: 200 };
const proposal = { id: "10000000-0000-4000-8000-000000000003",
  source_url: "https://www.openstreetmap.org/node/23", proposed_website_url: "https://studio.example/",
  observed_at: new Date(now - 3600000).toISOString() };

test("one-shot website observation records reachability without asserting a service gap", async () => {
  const input = { lead: { ...lead, website_url: audit.checked_url },
    reviewedAssessmentObservedAt: null, audits: [audit], proposals: [proposal] };
  const result = await planAutomaticWebsiteObservation(input, now);
  expect(result).toMatchObject({ state: "recorded_url_reachable", recorded_url: audit.checked_url,
    checked_url: audit.checked_url, http_status: 200, audit_observation_id: audit.id,
    proposed_website_url: null, observed_at: audit.checked_at });
  expect(result?.reason).toMatch(/ownership and service adequacy remain unreviewed/i);
  expect(result?.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect((await planAutomaticWebsiteObservation(input, now))?.source_fingerprint)
    .toBe(result?.source_fingerprint);
  expect(await planAutomaticWebsiteObservation({ ...input,
    reviewedAssessmentObservedAt: new Date(now - 3600000).toISOString() }, now)).toBeNull();
  expect((await planAutomaticWebsiteObservation({ ...input,
    reviewedAssessmentObservedAt: new Date(now + 3600000).toISOString() }, now))?.state)
    .toBe("recorded_url_reachable");
});

test("a proposed site or failed check stays uncertain and never becomes a missing-site claim", async () => {
  const proposed = await planAutomaticWebsiteObservation({ lead, reviewedAssessmentObservedAt: null,
    audits: [], proposals: [proposal] }, now);
  expect(proposed).toMatchObject({ state: "proposed_unconfirmed",
    proposed_website_url: proposal.proposed_website_url, proposal_source_url: proposal.source_url });
  const failed = await planAutomaticWebsiteObservation({ lead: { ...lead, website_url: audit.checked_url },
    reviewedAssessmentObservedAt: null, audits: [audit, { ...audit,
      id: "10000000-0000-4000-8000-000000000004",
      checked_at: new Date(now - 1800000).toISOString(), outcome: "http_5xx", http_status: 503 }],
    proposals: [] }, now);
  expect(failed?.state).toBe("unknown");
  expect(failed?.reason).toMatch(/HTTP 503.*temporary/i);
  expect(failed?.audit_observation_id).toBe("10000000-0000-4000-8000-000000000004");
  expect(failed?.reason).not.toMatch(/broken|missing website|no website/i);
  const missingUrl = await planAutomaticWebsiteObservation({ lead: { ...lead, website_url: audit.checked_url },
    reviewedAssessmentObservedAt: null, audits: [{ ...audit, outcome: "not_found", http_status: 404 }],
    proposals: [] }, now);
  expect(missingUrl?.state).toBe("unknown");
  expect(missingUrl?.reason).toMatch(/HTTP 404.*does not prove/i);
  const absent = await planAutomaticWebsiteObservation({ lead, reviewedAssessmentObservedAt: null,
    audits: [], proposals: [] }, now);
  expect(absent?.state).toBe("unknown");
  expect(absent?.reason).toContain("remains unknown");
  const later = await planAutomaticWebsiteObservation({ lead, reviewedAssessmentObservedAt: null,
    audits: [], proposals: [] }, now + 31 * 86400000);
  expect(later?.source_fingerprint).not.toBe(absent?.source_fingerprint);
});

test("sourced United States intake enters the same idempotent observation path", async () => {
  const input = { lead: { ...lead, country: "United States", website_url: audit.checked_url },
    reviewedAssessmentObservedAt: null, audits: [audit], proposals: [] };
  const first = await planAutomaticWebsiteObservation(input, now);
  const repeated = await planAutomaticWebsiteObservation(input, now);
  expect(first?.state).toBe("recorded_url_reachable");
  expect(repeated?.source_fingerprint).toBe(first?.source_fingerprint);
  expect((await planAutomaticWebsiteObservation({ ...input, audits: [] }, now))?.state).toBe("unknown");
});

test("non-USA, demo, closed and stale-source records do not get promoted", async () => {
  for (const different of [{ ...lead, country: "India" }, { ...lead, country: null },
    { ...lead, is_demo: true }, { ...lead, status: "disqualified" }]) {
    expect(await planAutomaticWebsiteObservation({ lead: different,
      reviewedAssessmentObservedAt: null, audits: [], proposals: [] }, now)).toBeNull();
  }
  const stale = await planAutomaticWebsiteObservation({ lead, reviewedAssessmentObservedAt: null,
    audits: [], proposals: [{ ...proposal, observed_at: new Date(now - 31 * 86400000).toISOString() }] }, now);
  expect(stale?.state).toBe("unknown");
});
