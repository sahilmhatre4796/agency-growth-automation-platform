import { expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  googleAuthorization,
  validateOAuthCallback,
  encryptToken,
  decryptToken,
  classifyReply,
  verifyWhatsAppSignature,
  whatsappEligibility,
  slotAvailable,
  deliverOnce,
  type Delivery,
} from "../packages/server/integrations";
test("OAuth uses state/PKCE and rejects stale, replayed and altered redirects", async () => {
  const url = new URL(
    await googleAuthorization({
      clientId: "fixture",
      redirectUri: "https://example.org/callback",
      state: "s".repeat(32),
      verifier: "v".repeat(43),
      profile: "mail",
    }),
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const valid = {
    state: "s".repeat(32),
    expectedState: "s".repeat(32),
    expiresAt: Date.now() + 1000,
    used: false,
    redirectUri: "https://example.org/callback",
    expectedRedirect: "https://example.org/callback",
  };
  expect(() => validateOAuthCallback(valid)).not.toThrow();
  for (const patch of [
    { used: true },
    { expiresAt: 0 },
    { state: "bad" },
    { redirectUri: "https://evil.example/callback" },
  ])
    expect(() => validateOAuthCallback({ ...valid, ...patch })).toThrow();
});
test("encrypted tokens are bound to the organization", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const stored = await encryptToken("synthetic-token", key, "org-a");
  expect(await decryptToken(stored, key, "org-a")).toBe("synthetic-token");
  await expect(decryptToken(stored, key, "org-b")).rejects.toThrow();
});
test("explicit opt-out overrides apparent interest and every human reply pauses sequence", () => {
  expect(classifyReply("Interested, but unsubscribe me")).toMatchObject({
    label: "unsubscribe",
    stopFollowups: true,
  });
  expect(classifyReply("Sounds fine")).toMatchObject({
    label: "unknown",
    humanReview: true,
    stopFollowups: true,
  });
});
test("WhatsApp signature rejects tamper and eligibility checks exact 24-hour boundary", async () => {
  const raw = new TextEncoder().encode('{"fixture":true}'),
    secret = "test-only";
  const signature =
    "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  expect(await verifyWhatsAppSignature(raw, signature, secret)).toBe(true);
  expect(
    await verifyWhatsAppSignature(
      new TextEncoder().encode("{}"),
      signature,
      secret,
    ),
  ).toBe(false);
  const input = {
    optedIn: true,
    optedOut: false,
    lastInboundAt: 0,
    templateApproved: false,
    now: 24 * 3600000,
  };
  expect(whatsappEligibility(input)).toBe(false);
  expect(whatsappEligibility({ ...input, now: 1 })).toBe(true);
  expect(
    whatsappEligibility({ ...input, optedOut: true, templateApproved: true }),
  ).toBe(false);
});
test("calendar overlapping slots rejected, adjacent slots accepted", () => {
  expect(slotAvailable(10, 20, [{ start: 19, end: 30 }])).toBe(false);
  expect(slotAvailable(10, 20, [{ start: 20, end: 30 }])).toBe(true);
});
test("timeout after provider acceptance reconciles and never sends twice", async () => {
  let accepted = false;
  let stored: Delivery = { state: "queued", stableMessageId: "fixture-id" };
  const provider = {
    send: vi.fn(async () => {
      accepted = true;
      throw new Error("timeout");
    }),
    lookup: vi.fn(async () => (accepted ? "receipt-1" : null)),
  };
  const persist = async (job: Delivery) => {
    stored = job;
  };
  await expect(
    deliverOnce(stored, provider, persist, async () => true),
  ).rejects.toThrow("DELIVERY_UNCERTAIN");
  const result = await deliverOnce(stored, provider, persist, async () => true);
  expect(result.providerId).toBe("receipt-1");
  expect(provider.send).toHaveBeenCalledTimes(1);
});
test("kill switch at execution stops queued messages; unknown delivery never blindly retries", async () => {
  const provider = {
    send: vi.fn(async () => "receipt"),
    lookup: vi.fn(async () => null),
  };
  const persist = vi.fn(async () => {});
  await expect(
    deliverOnce(
      { state: "queued", stableMessageId: "fixture" },
      provider,
      persist,
      async () => false,
    ),
  ).rejects.toThrow("POLICY_BLOCKED");
  await expect(
    deliverOnce(
      { state: "uncertain", stableMessageId: "fixture" },
      provider,
      persist,
      async () => true,
    ),
  ).rejects.toThrow("MANUAL_RECONCILIATION");
  expect(provider.send).not.toHaveBeenCalled();
});
