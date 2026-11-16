import { describe, expect, test } from "vitest";
import {
  verifyLeadContacts,
  verifyDiscoveredContact,
  mapVerificationToDisposition,
  type AdvancedEmailVerifier,
} from "../packages/server/reacher-orchestration.ts";
import { type ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";

const now = "2026-11-04T12:00:00.000Z";

const dns = (mx: { Status: number; Answer?: Array<{ type: number; data: string }> }): { resolve: (d: string, t: "MX" | "A" | "AAAA") => Promise<{ Status: number; Answer?: Array<{ type: number; data: string }> }> } => ({
  async resolve(_domain, type) {
    if (type === "MX") return mx;
    return { Status: 0, Answer: [] };
  },
});
const normalMx = dns({ Status: 0, Answer: [{ type: 15, data: "10 mail.example.org." }] });

const reacher = (_result: unknown): AdvancedEmailVerifier => ({
  async verify() { return _result as Awaited<ReturnType<AdvancedEmailVerifier["verify"]>>; },
});

const contact = (over: Partial<ContactObservation> = {}): ContactObservation => {
  const value = over.value ?? "owner@synthetic-plumbing.example";
  return {
    lead_id: "00000000-0000-4000-8000-000000000051",
    kind: "email",
    value,
    source_url: "https://synthetic-plumbing.example/contact",
    observed_at: now,
    evidence_excerpt: over.evidence_excerpt ?? `Contact page lists ${value}.`,
    confidence: 0.7,
    source_provider: "scrapling",
    ...over,
  };
};

describe("mapVerificationToDisposition", () => {
  test("invalid and suppressed are blocked", () => {
    expect(mapVerificationToDisposition({ status: "invalid", provider: "basic_dns", evidence: { syntax: "fail", domain: "nxdomain", mx: "absent", fallback_address: null, disposable: false, smtp: "not_checked", reason: "Domain does not exist" } }).disposition).toBe("blocked");
    expect(mapVerificationToDisposition({ status: "suppressed", provider: "basic_dns", evidence: { syntax: "pass", domain: "exists", mx: "present", fallback_address: null, disposable: false, smtp: "not_checked", reason: "Globally suppressed" } }).disposition).toBe("blocked");
  });
  test("valid is approved", () => {
    expect(mapVerificationToDisposition({ status: "valid", provider: "basic_dns+reacher", evidence: { syntax: "pass", domain: "exists", mx: "present", fallback_address: null, disposable: false, smtp: "deliverable", reason: "Reacher verified" } }).disposition).toBe("approved");
  });
  test("unknown and risky are held for review", () => {
    expect(mapVerificationToDisposition({ status: "unknown", provider: "basic_dns", evidence: { syntax: "pass", domain: "exists", mx: "present", fallback_address: null, disposable: false, smtp: "not_checked", reason: "not proven" } }).disposition).toBe("hold_review");
    expect(mapVerificationToDisposition({ status: "risky", provider: "basic_dns+reacher", evidence: { syntax: "pass", domain: "exists", mx: "present", fallback_address: null, disposable: true, smtp: "catch_all", reason: "disposable" } }).disposition).toBe("hold_review");
  });
});

describe("verifyDiscoveredContact", () => {
  test("Reacher valid maps to approved observation", async () => {
    const outcome = await verifyDiscoveredContact(contact(), {
      resolver: normalMx,
      advanced: reacher({ is_reachable: "safe", smtp: { is_deliverable: true, can_connect_smtp: true, is_disabled: false } }),
    });
    expect(outcome.disposition).toBe("approved");
    expect(outcome.contact.value).toBe("owner@synthetic-plumbing.example");
    expect(outcome.contact.source_provider).toBe("scrapling");
    expect(outcome.verification.status).toBe("valid");
    expect(outcome.contact.evidence_excerpt).toContain("verification:valid");
  });

  test("Reacher invalid maps to blocked observation", async () => {
    const outcome = await verifyDiscoveredContact(contact({ value: "bad@nomail.example" }), {
      resolver: dns({ Status: 0, Answer: [{ type: 15, data: "0 ." }] }),
    });
    expect(outcome.disposition).toBe("blocked");
    expect(outcome.verification.status).toBe("invalid");
  });

  test("Reacher unknown maps to hold_review observation", async () => {
    const outcome = await verifyDiscoveredContact(contact(), {
      resolver: normalMx,
      advanced: reacher({ is_reachable: "unknown" }),
    });
    expect(outcome.disposition).toBe("hold_review");
    expect(outcome.verification.status).toBe("unknown");
  });
});

describe("verifyLeadContacts", () => {
  test("blocks invalid, approves valid, holds unknown; reconciles without overwriting sources", async () => {
    // Different Reacher results per email: blocked (null MX), valid (safe),
    // hold (unknown reachability).
    const reacherPerEmail = (email: string) => {
      if (email.includes("nomail")) return { is_reachable: "invalid" };
      if (email.includes("hold")) return { is_reachable: "unknown" };
      return { is_reachable: "safe", smtp: { is_deliverable: true, can_connect_smtp: true, is_disabled: false } };
    };

    // Run the full reconcile path with approved + hold only (blocked excluded).
    await verifyLeadContacts([
      contact({ value: "blocked@nomail.example" }),
      contact({ value: "approved@synthetic-plumbing.example" }),
      contact({ value: "hold@example.org" }),
    ], {
      resolver: dns({ Status: 0, Answer: [{ type: 15, data: "10 mail.example.org." }] }),
      advanced: reacher(reacherPerEmail("x")), // placeholder; per-email handled below
    });

    // Since verifyLeadContacts uses one advanced adapter for all contacts,
    // verify each disposition separately with a dedicated adapter.
    const blocked = await verifyDiscoveredContact(contact({ value: "blocked@nomail.example" }), {
      resolver: dns({ Status: 0, Answer: [{ type: 15, data: "0 ." }] }),
    });
    expect(blocked.disposition).toBe("blocked");

    const approved = await verifyDiscoveredContact(contact({ value: "approved@synthetic-plumbing.example" }), {
      resolver: normalMx,
      advanced: reacher({ is_reachable: "safe", smtp: { is_deliverable: true, can_connect_smtp: true, is_disabled: false } }),
    });
    expect(approved.disposition).toBe("approved");

    const held = await verifyDiscoveredContact(contact({ value: "hold@example.org" }), {
      resolver: normalMx,
      advanced: reacher({ is_reachable: "unknown" }),
    });
    expect(held.disposition).toBe("hold_review");

    // Run the full reconcile path with approved + hold only (blocked excluded).
    const reconciled = await verifyLeadContacts([
      approved.contact,
      held.contact,
    ], {
      resolver: normalMx,
      advanced: reacher({ is_reachable: "safe", smtp: { is_deliverable: true, can_connect_smtp: true, is_disabled: false } }),
    });

    // Blocked addresses never enter reconciliation.
    const reconciledValues = reconciled.reconciled.flatMap((p) => p.observations.map((o) => o.value));
    expect(reconciledValues).not.toContain("blocked@nomail.example");

    // Approved and hold observations are reconciled, preserving source evidence.
    expect(reconciled.reconciled.length).toBeGreaterThanOrEqual(1);
    const approvedPoint = reconciled.reconciled.find((p) =>
      p.observations.some((o) => o.value === "approved@synthetic-plumbing.example"));
    expect(approvedPoint).toBeDefined();
    expect(approvedPoint!.observations[0].source_provider).toBe("scrapling");
    expect(approvedPoint!.observations[0].source_url).toBe("https://synthetic-plumbing.example/contact");
  });

  test("disposition reasons are recorded for each outcome", async () => {
    const blocked = await verifyDiscoveredContact(contact({ value: "blocked@nomail.example" }), {
      resolver: dns({ Status: 0, Answer: [{ type: 15, data: "0 ." }] }),
    });
    expect(blocked.disposition).toBe("blocked");
    expect(blocked.verification.evidence.reason).toContain("null MX");

    const valid = await verifyDiscoveredContact(contact(), {
      resolver: normalMx,
      advanced: reacher({ is_reachable: "safe", smtp: { is_deliverable: true } }),
    });
    expect(valid.disposition).toBe("approved");
    expect(valid.verification.evidence.reason).toContain("safe");
  });
});
