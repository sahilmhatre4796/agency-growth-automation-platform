import { expect, test, vi } from "vitest";
import {
  GoogleAPI,
  GmailAdapter,
  CalendarAdapter,
} from "../packages/server/google";
test("Google write adapters default off before transport", async () => {
  const transport = vi.fn();
  const api = new GoogleAPI("synthetic", transport);
  await expect(
    new GmailAdapter(api).send({
      from: "a@example.org",
      to: "b@example.org",
      subject: "test",
      body: "fixture",
      stableMessageId: "<fixture@example.org>",
    }),
  ).rejects.toThrow("DISABLED");
  await expect(
    new CalendarAdapter(api).book({
      start: "2030-01-01T10:00:00Z",
      end: "2030-01-01T11:00:00Z",
      timezone: "UTC",
      calendarId: "primary",
      attendee: "b@example.org",
      approved: true,
      idempotencyKey: "fixture-long-key",
      orgId: "org-a",
    }),
  ).rejects.toThrow("DISABLED");
  expect(transport).not.toHaveBeenCalled();
});
test("header injection rejected and provider receipt validated", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ id: "fixture-receipt", threadId: "fixture-thread" }),
    );
  const mail = new GmailAdapter(new GoogleAPI("synthetic", transport), true);
  const input = {
    from: "a@example.org",
    to: "b@example.org",
    subject: "Hello",
    body: "Fictional test",
    stableMessageId: "<fixture@example.org>",
  };
  await expect(
    mail.send({ ...input, subject: "Injected\r\nBcc: attacker@example.org" }),
  ).rejects.toThrow("INVALID_MAIL_HEADERS");
  expect((await mail.send(input)).id).toBe("fixture-receipt");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("calendar collision blocks event creation", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      calendars: {
        primary: {
          busy: [
            { start: "2030-01-01T10:00:00Z", end: "2030-01-01T11:00:00Z" },
          ],
        },
      },
    }),
  );
  await expect(
    new CalendarAdapter(new GoogleAPI("synthetic", transport), true).book({
      start: "2030-01-01T10:30:00Z",
      end: "2030-01-01T11:30:00Z",
      timezone: "UTC",
      calendarId: "primary",
      attendee: "b@example.org",
      approved: true,
      idempotencyKey: "fixture-long-key-123",
      orgId: "org-a",
    }),
  ).rejects.toThrow("SLOT_UNAVAILABLE");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("revoked token is disconnected and rate limit reported without automatic resend", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("", { status: 401 }))
    .mockResolvedValueOnce(new Response("", { status: 429 }));
  const api = new GoogleAPI("synthetic", transport);
  await expect(api.request("gmail/v1/users/me/profile")).rejects.toThrow(
    "GOOGLE_DISCONNECTED",
  );
  await expect(api.request("gmail/v1/users/me/profile")).rejects.toThrow(
    "RATE_LIMITED",
  );
  expect(transport).toHaveBeenCalledTimes(2);
});
