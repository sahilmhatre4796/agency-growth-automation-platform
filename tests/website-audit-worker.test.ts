import { expect, test, vi } from "vitest";
import {
  enrichAuditedOfficialContacts,
  type AuditContactDb,
} from "../packages/server/audit-contact-enrichment.ts";

const job = {
  org_id: "20000000-0000-4000-8000-000000000002",
  lead_id: "10000000-0000-4000-8000-000000000001",
  official_url: "https://wilsonwelding.example.com/",
};

const audited = {
  url: "https://wilsonwelding.example.com/contact",
  public_page_text:
    "Wilson Welding Works\nEmail info@wilsonwelding.example.com for a quote.",
  observed_at: "2026-10-26T10:00:00.000Z",
};

type LeadRow = { business_name: string; website_url: string | null; country: string | null };

function fakeDb(
  lead: LeadRow | null,
  contactError: { message: string } | null = null,
) {
  const maybeSingle = vi.fn(async () => ({ data: lead, error: null }));
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    rpcCalls.push([name, params]);
    return { error: contactError };
  });
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
  }));
  const db = { from, rpc } as unknown as AuditContactDb;
  return { db, from, rpc, rpcCalls };
}

const matchingLead: LeadRow = {
  business_name: "Wilson Welding Works",
  website_url: job.official_url,
  country: "USA",
};

test("contact enrichment stays off unless the operator explicitly enables it", async () => {
  const { db, from, rpc } = fakeDb(matchingLead);
  await enrichAuditedOfficialContacts({ db, env: {}, job, audited, outcome: "ok" });
  await enrichAuditedOfficialContacts({
    db,
    env: { ENABLE_AUDIT_CONTACT_ENRICHMENT: "1" },
    job,
    audited,
    outcome: "ok",
  });
  expect(from).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

test("an enabled successful audit records sourced observations for the exact audited lead", async () => {
  const { db, rpc, rpcCalls } = fakeDb(matchingLead);
  await enrichAuditedOfficialContacts({
    db,
    env: { ENABLE_AUDIT_CONTACT_ENRICHMENT: "true" },
    job,
    audited,
    outcome: "ok",
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  const [name, params] = rpcCalls[0];
  expect(name).toBe("record_vibe_contact_observations");
  expect(params.p_org).toBe(job.org_id);
  expect(params.p_lead).toBe(job.lead_id);
  expect(params.p_provider).toBe("official_website");
  const observations = params.p_observations as Array<Record<string, unknown>>;
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    kind: "email",
    value: "info@wilsonwelding.example.com",
    source_provider: "official_website",
    source_url: audited.url,
  });
});

test("a failed audit or a different stored website records nothing", async () => {
  const mismatch = fakeDb({
    business_name: "Wilson Welding Works",
    website_url: "https://other.example.org/",
    country: "USA",
  });
  await enrichAuditedOfficialContacts({
    db: mismatch.db,
    env: { ENABLE_AUDIT_CONTACT_ENRICHMENT: "true" },
    job,
    audited,
    outcome: "ok",
  });
  expect(mismatch.rpc).not.toHaveBeenCalled();

  const failed = fakeDb(matchingLead);
  await enrichAuditedOfficialContacts({
    db: failed.db,
    env: { ENABLE_AUDIT_CONTACT_ENRICHMENT: "true" },
    job,
    audited,
    outcome: "not_found",
  });
  expect(failed.from).not.toHaveBeenCalled();
  expect(failed.rpc).not.toHaveBeenCalled();
});

test("an enrichment failure stays reviewable and never fails the saved audit", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { db, rpc } = fakeDb(matchingLead, { message: "permission denied" });
  await expect(
    enrichAuditedOfficialContacts({
      db,
      env: { ENABLE_AUDIT_CONTACT_ENRICHMENT: "true" },
      job,
      audited,
      outcome: "ok",
    }),
  ).resolves.toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("OFFICIAL_CONTACT_ENRICHMENT_REVIEW_REQUIRED");
  warn.mockRestore();
});
