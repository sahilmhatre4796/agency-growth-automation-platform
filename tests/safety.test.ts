import { expect, test } from "vitest";
import {
  FEATURES,
  outboundDecision,
  type PolicyContext,
} from "../packages/shared/safety";
import { fakeProviders } from "../packages/shared/providers";
const context: PolicyContext = {
  role: "admin",
  orgMatches: true,
  paused: false,
  approved: true,
  permission: true,
  suppressed: false,
  connected: true,
  remaining: 10,
  withinWindow: true,
  duplicate: false,
};
test("every feature defaults off; eligible request still cannot send", () => {
  expect(Object.values(FEATURES).every((v) => v === false)).toBe(true);
  expect(outboundDecision(context)).toEqual({
    allowed: false,
    reason: "LIVE_OPERATIONS_DISABLED",
  });
});
test.each([
  { paused: true },
  { approved: false },
  { suppressed: true },
  { remaining: 0 },
  { orgMatches: false },
  { duplicate: true },
  { withinWindow: false },
  { permission: false },
  { connected: false },
])("safety rejects %j", (patch) => {
  expect(outboundDecision({ ...context, ...patch }).allowed).toBe(false);
});
test("fake adapters cannot perform external writes", async () => {
  const p = fakeProviders();
  await expect(p.mail.send()).rejects.toThrow("DISABLED");
  await expect(p.messaging.send()).rejects.toThrow("DISABLED");
  await expect(p.calendar.book()).rejects.toThrow("DISABLED");
  expect((await p.ai.generate({ evidenceIds: [] })).data.reviewRequired).toBe(
    true,
  );
  expect((await p.calendar.availability()).verifiedLive).toBe(false);
});
