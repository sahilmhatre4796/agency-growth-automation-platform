import { describe, expect, test } from "vitest";
import { verifyEmailAddress, type DnsResolver } from "../packages/server/email-verification.ts";

const dns = (mx: { Status: number; Answer?: Array<{ type: number; data: string }> }, fallback = false): DnsResolver => ({
  async resolve(_domain, type) {
    if (type === "MX") return mx;
    return { Status: 0, Answer: fallback && type === "A" ? [{ type: 1, data: "203.0.113.8" }] : [] };
  },
});
const normalMx = dns({ Status: 0, Answer: [{ type: 15, data: "10 mail.example.org." }] });

describe("email verification evidence", () => {
  test("DNS-only MX evidence leaves mailbox reachability unknown", async () => {
    const result = await verifyEmailAddress({ email: "Person@Example.org", resolver: normalMx });
    expect(result.status).toBe("unknown");
    expect(result.evidence).toMatchObject({ syntax: "pass", mx: "present", smtp: "not_checked" });
    expect(result.evidence.reason).toContain("not proven");
  });
  test("malformed syntax is invalid without a DNS request", async () => {
    const result = await verifyEmailAddress({ email: "bad@@example.org", resolver: { resolve: () => { throw new Error("DNS must not run"); } } });
    expect(result.status).toBe("invalid");
    expect(result.evidence.syntax).toBe("fail");
  });
  test("NXDOMAIN is invalid", async () => {
    expect((await verifyEmailAddress({ email: "a@missing.example", resolver: dns({ Status: 3 }) })).status).toBe("invalid");
  });
  test("null MX and no fallback routing are invalid", async () => {
    expect((await verifyEmailAddress({ email: "a@nomail.example", resolver: dns({ Status: 0, Answer: [{ type: 15, data: "0 ." }] }) })).evidence.mx).toBe("null_mx");
    expect((await verifyEmailAddress({ email: "a@noroute.example", resolver: dns({ Status: 0 }) })).status).toBe("invalid");
  });
  test("an A-only fallback is unknown, not falsely invalid", async () => {
    const result = await verifyEmailAddress({ email: "a@fallback.example", resolver: dns({ Status: 0 }, true) });
    expect(result.status).toBe("unknown");
    expect(result.evidence.fallback_address).toBe(true);
  });
  test("known disposable domains require review", async () => {
    const result = await verifyEmailAddress({ email: "a@mailinator.com", resolver: normalMx });
    expect(result.status).toBe("risky");
    expect(result.evidence.disposable).toBe(true);
  });
  test("catch-all result is risky", async () => {
    const result = await verifyEmailAddress({ email: "a@example.org", resolver: normalMx, advanced: { verify: async () => ({ smtp: { is_catch_all: true } }) } });
    expect(result.status).toBe("risky");
    expect(result.evidence.smtp).toBe("catch_all");
  });
  test("Reacher reachability and mailbox risk override DNS-only optimism", async () => {
    const verify = (result: Awaited<ReturnType<NonNullable<Parameters<typeof verifyEmailAddress>[0]["advanced"]>["verify"]>>) =>
      verifyEmailAddress({ email: "a@example.org", resolver: normalMx, advanced: { verify: async () => result } });
    expect((await verify({ is_reachable: "unknown" })).status).toBe("unknown");
    expect((await verify({ is_reachable: "safe" })).status).toBe("valid");
    expect((await verify({ is_reachable: "invalid", smtp: { is_catch_all: true } })).status).toBe("invalid");
    expect((await verify({ is_reachable: "risky" })).status).toBe("risky");
    expect((await verify({ is_reachable: "safe", misc: { is_role_account: true } })).status).toBe("risky");
    expect((await verify({ is_reachable: "safe", smtp: { has_full_inbox: true } })).status).toBe("risky");
    expect((await verify({ is_reachable: "safe", syntax: { is_valid_syntax: false } })).status).toBe("invalid");
  });
  test("SMTP timeout and blocked probe never invalidate a mailbox", async () => {
    for (const message of ["timeout", "blocked"]) {
      const result = await verifyEmailAddress({ email: "a@example.org", resolver: normalMx, advanced: { verify: async () => { throw new Error(message); } } });
      expect(result.status).toBe("unknown");
      expect(result.evidence.smtp).toBe("inconclusive");
    }
  });
  test("DNS service failure is unknown", async () => {
    const result = await verifyEmailAddress({ email: "a@example.org", resolver: { resolve: async () => { throw new Error("unavailable"); } } });
    expect(result.status).toBe("unknown");
  });
});
