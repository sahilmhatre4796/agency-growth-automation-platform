// A candidate time, not permission to send. PostgreSQL makes the final decision.
export function nextRecipientBusinessSlot(after: Date, timeZone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const start = Math.ceil((after.getTime() + 60_000) / 900_000) * 900_000;
  for (let value = start; value < start + 15 * 86400_000; value += 900_000) {
    const parts = Object.fromEntries(formatter.formatToParts(value).map(({ type, value: part }) => [type, part]));
    if (["Sat", "Sun"].includes(parts.weekday)) continue;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (minutes >= 9 * 60 && minutes < 17 * 60) return new Date(value);
  }
  throw new Error("RECIPIENT_WINDOW_UNAVAILABLE");
}

export const BACKLOG_RETRYABLE_CAPS = new Set([
  "ORGANIZATION_DAILY_CAP", "CAMPAIGN_DAILY_CAP", "NO_ELIGIBLE_SENDER",
]);

export function queuePolicyCode(message: string): string {
  return [...BACKLOG_RETRYABLE_CAPS, "ORGANIZATION_MONTHLY_CAP", "EMAIL_NOT_ENABLED",
    "EMAIL_PERMISSION_REQUIRED", "EMAIL_SUPPRESSED", "DRAFT_NOT_APPROVED",
    "STALE_APPROVAL", "CONTACT_EMAIL_CHANGED", "EMAIL_CONTACT_REQUIRED",
    "CAMPAIGN_NOT_ACTIVE", "SENDER_POLICY_REQUIRED", "OUTBOX_REVIEW_REQUIRED",
    "LEAD_NOT_ELIGIBLE", "RECIPIENT_TIMEZONE_REVIEW"].find((code) => message.includes(code))
    ?? "QUEUE_POLICY_BLOCKED";
}

export async function scheduleApprovedDraft(input: {
  now: Date; timeZone: string;
  enqueue: (scheduledAt: string) => Promise<{ error: string | null }>;
}): Promise<"queued" | "deferred" | "review"> {
  let schedule: Date;
  try { schedule = nextRecipientBusinessSlot(input.now, input.timeZone); }
  catch { return "review"; }
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await input.enqueue(schedule.toISOString());
    if (!result.error) return "queued";
    if (!BACKLOG_RETRYABLE_CAPS.has(queuePolicyCode(result.error))) return "review";
    try { schedule = nextRecipientBusinessSlot(new Date(schedule.getTime() + 86400_000), input.timeZone); }
    catch { return "review"; }
  }
  return "deferred";
}
