import { describe, expect, test } from "vitest";
import {
  selectSender,
  canSendNow,
  handleSendError,
  recordSuccessfulSend,
  type GmailAccount,
} from "../packages/server/multi-gmail.ts";

const now = new Date("2026-11-04T12:00:00.000Z");

function makeAccount(over: Partial<GmailAccount> = {}): GmailAccount {
  return {
    account_id: "00000000-0000-4000-8000-000000000061",
    org_id: "00000000-0000-4000-8000-000000000001",
    email: "owner@example.com",
    display_name: "Owner",
    enabled: true,
    daily_cap: 50,
    sent_today: 0,
    last_send_at: null,
    rate_limited_until: null,
    error_code: null,
    oauth_encrypted: "encrypted",
    ...over,
  };
}

describe("selectSender", () => {
  test("selects an eligible enabled account", () => {
    const accounts = [makeAccount({ email: "a@example.com" }), makeAccount({ email: "b@example.com" })];
    const sender = selectSender({ recipient_email: "prospect@example.com", accounts });
    expect(sender).toBeDefined();
    expect(sender!.email).toBeOneOf(["a@example.com", "b@example.com"]);
  });

  test("same recipient always gets the same sender (conversation continuity)", () => {
    const accounts = [makeAccount({ email: "a@example.com" }), makeAccount({ email: "b@example.com" })];
    const s1 = selectSender({ recipient_email: "prospect@example.com", accounts });
    const s2 = selectSender({ recipient_email: "prospect@example.com", accounts });
    expect(s1!.email).toBe(s2!.email);
  });

  test("skips disabled accounts", () => {
    const accounts = [
      makeAccount({ email: "a@example.com", enabled: false }),
      makeAccount({ email: "b@example.com" }),
    ];
    const sender = selectSender({ recipient_email: "prospect@example.com", accounts });
    expect(sender!.email).toBe("b@example.com");
  });

  test("skips rate-limited accounts", () => {
    const future = new Date(now.getTime() + 60 * 60_000).toISOString();
    const accounts = [
      makeAccount({ email: "a@example.com", rate_limited_until: future }),
      makeAccount({ email: "b@example.com" }),
    ];
    const sender = selectSender({ recipient_email: "prospect@example.com", accounts, now });
    expect(sender!.email).toBe("b@example.com");
  });

  test("skips revoked accounts", () => {
    const accounts = [
      makeAccount({ email: "a@example.com", error_code: "GOOGLE_REVOKED" }),
      makeAccount({ email: "b@example.com" }),
    ];
    const sender = selectSender({ recipient_email: "prospect@example.com", accounts });
    expect(sender!.email).toBe("b@example.com");
  });

  test("returns null when no eligible account", () => {
    const accounts = [makeAccount({ enabled: false })];
    expect(selectSender({ recipient_email: "prospect@example.com", accounts })).toBeNull();
  });

  test("skips accounts at daily cap", () => {
    const accounts = [
      makeAccount({ email: "a@example.com", sent_today: 50, daily_cap: 50 }),
      makeAccount({ email: "b@example.com", sent_today: 0, daily_cap: 50 }),
    ];
    const sender = selectSender({ recipient_email: "prospect@example.com", accounts });
    expect(sender!.email).toBe("b@example.com");
  });
});

describe("canSendNow", () => {
  test("allows send when under cap and interval elapsed", () => {
    const acct = makeAccount({ sent_today: 0, daily_cap: 50 });
    const result = canSendNow({ account: acct, last_send_at: null, now });
    expect(result.allowed).toBe(true);
  });

  test("blocks when at daily cap", () => {
    const acct = makeAccount({ sent_today: 50, daily_cap: 50 });
    const result = canSendNow({ account: acct, last_send_at: null, now });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("daily_cap");
  });

  test("blocks when below min interval", () => {
    const acct = makeAccount({ sent_today: 0, daily_cap: 50 });
    const fiveMinAgo = new Date(now.getTime() - 4 * 60_000).toISOString();
    const result = canSendNow({ account: acct, last_send_at: fiveMinAgo, now });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("min_interval");
  });

  test("allows when min interval elapsed", () => {
    const acct = makeAccount({ sent_today: 0, daily_cap: 50 });
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000).toISOString();
    const result = canSendNow({ account: acct, last_send_at: tenMinAgo, now });
    expect(result.allowed).toBe(true);
  });

  test("blocks revoked account", () => {
    const acct = makeAccount({ sent_today: 0, error_code: "GOOGLE_REVOKED" });
    const result = canSendNow({ account: acct, last_send_at: null, now });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("account_error");
  });
});

describe("handleSendError", () => {
  test("marks revoked account with no backoff", () => {
    const acct = makeAccount({ email: "a@example.com" });
    const { account: updated, backoff_minutes } = handleSendError({
      account: acct,
      code: "GOOGLE_REVOKED",
      now,
    });
    expect(updated.error_code).toBe("GOOGLE_REVOKED");
    expect(updated.rate_limited_until).toBeNull();
    expect(backoff_minutes).toBe(0);
  });

  test("rate-limits on 429 with 60 min backoff", () => {
    const acct = makeAccount({ email: "a@example.com" });
    const { account: updated, backoff_minutes } = handleSendError({
      account: acct,
      code: "GOOGLE_RATE_LIMITED",
      now,
    });
    expect(updated.error_code).toBe("GOOGLE_RATE_LIMITED");
    expect(updated.rate_limited_until).not.toBeNull();
    expect(new Date(updated.rate_limited_until!).getTime()).toBeGreaterThan(now.getTime());
    expect(backoff_minutes).toBe(60);
  });

  test("marks forbidden with 60 min backoff", () => {
    const acct = makeAccount({ email: "a@example.com" });
    const { account: updated, backoff_minutes } = handleSendError({
      account: acct,
      code: "GOOGLE_FORBIDDEN",
      now,
    });
    expect(updated.error_code).toBe("GOOGLE_FORBIDDEN");
    expect(backoff_minutes).toBe(60);
  });
});

describe("recordSuccessfulSend", () => {
  test("increments sent_today, sets last_send_at, clears errors", () => {
    const acct = makeAccount({
      sent_today: 2,
      last_send_at: null,
      rate_limited_until: new Date(now.getTime() + 60_000).toISOString(),
      error_code: "GOOGLE_RATE_LIMITED",
    });
    const updated = recordSuccessfulSend({ account: acct, now });
    expect(updated.sent_today).toBe(3);
    expect(updated.last_send_at).toBe(now.toISOString());
    expect(updated.rate_limited_until).toBeNull();
    expect(updated.error_code).toBeNull();
  });
});
