import { expect, test } from "vitest";
import { nextRecipientBusinessSlot, queuePolicyCode, scheduleApprovedDraft } from "../packages/server/gmail-backlog";

test("recipient scheduling waits for the next local business window", () => {
  expect(nextRecipientBusinessSlot(new Date("2026-10-23T22:00:00Z"), "America/New_York").toISOString())
    .toBe("2026-10-26T13:00:00.000Z");
  expect(nextRecipientBusinessSlot(new Date("2026-10-23T07:15:00Z"), "Asia/Dubai").toISOString())
    .toBe("2026-10-23T07:30:00.000Z");
  expect(nextRecipientBusinessSlot(new Date("2026-11-02T13:00:00Z"), "America/New_York").toISOString())
    .toBe("2026-11-02T14:00:00.000Z");
});

test("ten synthetic approved drafts defer across recipient business days without duplicate queue rows", async () => {
  const byDraft = new Map<number, string>();
  const byDay = new Map<string, number>();
  for (let id = 0; id < 10; id++) {
    const enqueue = async (scheduledAt: string) => {
      if (byDraft.has(id)) return { error: null };
      const day = scheduledAt.slice(0, 10);
      if ((byDay.get(day) ?? 0) >= 2) return { error: "ORGANIZATION_DAILY_CAP" };
      byDraft.set(id, scheduledAt);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      return { error: null };
    };
    expect(await scheduleApprovedDraft({ now: new Date("2026-10-23T13:00:00Z"),
      timeZone: "America/New_York", enqueue })).toBe("queued");
    expect(await scheduleApprovedDraft({ now: new Date("2026-10-23T13:00:00Z"),
      timeZone: "America/New_York", enqueue })).toBe("queued");
  }
  expect(byDraft.size).toBe(10);
  expect([...byDay.values()]).toEqual([2, 2, 2, 2, 2]);
  expect([...byDay.keys()]).toEqual(["2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
  expect(await scheduleApprovedDraft({ now: new Date(), timeZone: "America/New_York",
    enqueue: async () => ({ error: "EMAIL_SUPPRESSED" }) })).toBe("review");
});

test("invalid timezone and policy failures never become an automatic queue approval", () => {
  expect(() => nextRecipientBusinessSlot(new Date(), "Unknown/Zone")).toThrow();
  expect(queuePolicyCode("ORGANIZATION_DAILY_CAP: daily ceiling reached")).toBe("ORGANIZATION_DAILY_CAP");
  expect(queuePolicyCode("EMAIL_PERMISSION_REQUIRED")).toBe("EMAIL_PERMISSION_REQUIRED");
  expect(queuePolicyCode("unrecognized database failure")).toBe("QUEUE_POLICY_BLOCKED");
});
