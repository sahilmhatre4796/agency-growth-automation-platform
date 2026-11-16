import { expect, test, vi } from "vitest";
import { GoogleAPI, GmailAdapter, GoogleAPIError, refreshGoogleToken } from "../packages/server/google";
import { classifyGmailReply, emailIdentifierHash, parseGmailMessage, sendOnce, syncGmailPage } from "../packages/server/gmail-multi";

const id = "10000000-0000-4000-8000-000000000001";
test("refresh separates revoked authorization from temporary provider failure", async () => {
  const revoked = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
  await expect(refreshGoogleToken({ refreshToken: "fixture", clientId: "fixture", clientSecret: "fixture" }, revoked))
    .rejects.toMatchObject({ code: "GOOGLE_REVOKED" });
  const down = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 503 }));
  await expect(refreshGoogleToken({ refreshToken: "fixture", clientId: "fixture", clientSecret: "fixture" }, down))
    .rejects.toMatchObject({ code: "GOOGLE_REFRESH_UNAVAILABLE" });
  const valid = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    access_token: "new-fixture", expires_in: 3600, token_type: "Bearer",
  }));
  expect((await refreshGoogleToken({ refreshToken: "fixture", clientId: "fixture", clientSecret: "fixture" }, valid)).access_token)
    .toBe("new-fixture");
});

test("provider acceptance after worker restart is reconciled without duplicate send", async () => {
  let sent = false;
  const transport = vi.fn<typeof fetch>(async (request, init) => {
    const path = String(request);
    if (path.includes("messages?") && !sent) return Response.json({});
    if (path.includes("messages?") && sent) return Response.json({ messages: [{ id: "provider-1" }] });
    if (path.endsWith("messages/provider-1?format=full")) return Response.json({
      id: "provider-1", threadId: "thread-1", internalDate: String(Date.now()), payload: {},
    });
    if (path.endsWith("messages/send") && init?.method === "POST") {
      sent = true;
      return Response.json({ id: "provider-1", threadId: "thread-1" });
    }
    throw new Error("Unexpected fixture request");
  });
  const adapter = new GmailAdapter(new GoogleAPI("fixture-token", transport), true);
  const input = { adapter, outboxId: id, from: "sender@example.org", senderName: "Fixture",
    to: "recipient@example.org", subject: "Hello", body: "Approved test copy" };
  expect((await sendOnce(input)).reconciled).toBe(false);
  expect((await sendOnce(input)).reconciled).toBe(true);
  expect(transport.mock.calls.filter(([url]) => String(url).endsWith("messages/send"))).toHaveLength(1);
});

test("message parser retains mailbox ownership and classifies opt-out conservatively", async () => {
  const raw = {
    id: "mail-1", threadId: "thread-1", internalDate: String(Date.now()),
    payload: { headers: [
      { name: "From", value: "Prospect <prospect@example.org>" },
      { name: "To", value: "sender@example.org" },
      { name: "Subject", value: "Re: Hello" },
      { name: "Message-ID", value: "<mail-1@example.org>" },
    ], body: { data: btoa("Please unsubscribe me") } },
  };
  const parsed = parseGmailMessage(raw, "sender@example.org");
  expect(parsed).toMatchObject({ direction: "inbound", peer: "prospect@example.org", classification: "opt_out", providerThread: "thread-1" });
  expect(() => parseGmailMessage(raw, "other@example.org")).toThrow("MESSAGE_NOT_FOR_ACCOUNT");
  expect(classifyGmailReply("Could we schedule a call?")).toBe("meeting_request");
  const a = await emailIdentifierHash("prospect@example.org", "s".repeat(32));
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(a).not.toBe(await emailIdentifierHash("other@example.org", "s".repeat(32)));
});
test("account-scoped Gmail labels allow alias and BCC mail without trusting unrelated messages", () => {
  const base = { id: "alias-1", threadId: "thread-alias", internalDate: String(Date.now()) };
  const bcc = { ...base, labelIds: ["INBOX"], payload: { headers: [
    { name: "From", value: "prospect@example.org" }, { name: "To", value: "Undisclosed recipients:;" },
  ] } };
  expect(parseGmailMessage(bcc, "sender@example.org")).toMatchObject({ direction: "inbound", peer: "prospect@example.org" });
  const aliasSent = { ...base, id: "alias-2", labelIds: ["SENT"], payload: { headers: [
    { name: "From", value: "alias@example.org" }, { name: "To", value: "prospect@example.org" },
  ] } };
  expect(parseGmailMessage(aliasSent, "sender@example.org")).toMatchObject({ direction: "outbound", peer: "prospect@example.org" });
  expect(() => parseGmailMessage({ ...bcc, labelIds: [] }, "sender@example.org")).toThrow("MESSAGE_NOT_FOR_ACCOUNT");
});

test("sent mail with multiple recipients stays unresolved instead of attaching to the first contact", () => {
  const base = { id: "multi-1", threadId: "thread-multi", internalDate: String(Date.now()), labelIds: ["SENT"] };
  for (const headers of [
    [{ name: "From", value: "sender@example.org" }, { name: "To", value: "a@example.org, b@example.org" }],
    [{ name: "From", value: "sender@example.org" }, { name: "To", value: "a@example.org" }, { name: "Cc", value: "b@example.org" }],
    [{ name: "From", value: "sender@example.org" }, { name: "To", value: "a@example.org" }, { name: "Bcc", value: "b@example.org" }],
  ]) {
    expect(() => parseGmailMessage({ ...base, payload: { headers } }, "sender@example.org"))
      .toThrow("RECIPIENT_REVIEW_REQUIRED");
  }
});

test("sync commits each fetched message before returning the next page token", async () => {
  const transport = vi.fn<typeof fetch>(async (request) => {
    const path = String(request);
    if (path.includes("messages?") && path.includes("labelIds=INBOX"))
      return Response.json({ messages: [{ id: "mail-1", threadId: "thread-1" }], nextPageToken: "page-2" });
    if (path.endsWith("messages/mail-1?format=full"))
      return Response.json({ id: "mail-1", threadId: "thread-1", internalDate: String(Date.now()),
        payload: { headers: [{ name: "From", value: "prospect@example.org" }, { name: "To", value: "sender@example.org" }] } });
    throw new GoogleAPIError("UNEXPECTED", 500);
  });
  const accept = vi.fn(async () => {});
  const token = await syncGmailPage({ adapter: new GmailAdapter(new GoogleAPI("fixture", transport)),
    account: "sender@example.org", label: "INBOX", accept });
  expect(token).toBe("page-2");
  expect(accept).toHaveBeenCalledOnce();
});
test("sync records an unparseable message for review and still ingests later mail", async () => {
  const transport = vi.fn<typeof fetch>(async (request) => {
    const path = String(request);
    if (path.includes("messages?") && path.includes("labelIds=SENT"))
      return Response.json({ messages: [{ id: "bad-1", threadId: "thread-bad" }, { id: "good-2", threadId: "thread-good" }] });
    if (path.endsWith("messages/bad-1?format=full"))
      return Response.json({ id: "bad-1", threadId: "thread-bad", internalDate: String(Date.now()), labelIds: ["SENT"],
        payload: { headers: [{ name: "From", value: "sender@example.org" }, { name: "To", value: "a@example.org, b@example.org" }] } });
    if (path.endsWith("messages/good-2?format=full"))
      return Response.json({ id: "good-2", threadId: "thread-good", internalDate: String(Date.now()), labelIds: ["SENT"],
        payload: { headers: [{ name: "From", value: "sender@example.org" }, { name: "To", value: "a@example.org" }] } });
    throw new GoogleAPIError("UNEXPECTED", 500);
  });
  const accept = vi.fn(async () => {});
  const onParseError = vi.fn(async () => {});
  const token = await syncGmailPage({ adapter: new GmailAdapter(new GoogleAPI("fixture", transport)),
    account: "sender@example.org", label: "SENT", accept, onParseError });
  expect(token).toBeNull();
  expect(onParseError).toHaveBeenCalledWith(expect.objectContaining({ id: "bad-1" }), "RECIPIENT_REVIEW_REQUIRED");
  expect(accept).toHaveBeenCalledWith(expect.objectContaining({ providerId: "good-2" }));
});

test("follow-up send retains Gmail thread and RFC reply references", async () => {
  let payload: { raw: string; threadId?: string } = { raw: "" };
  const transport = vi.fn<typeof fetch>(async (_request, init) => {
    payload = JSON.parse(String(init?.body));
    return Response.json({ id: "receipt", threadId: "thread-1" });
  });
  const adapter = new GmailAdapter(new GoogleAPI("fixture", transport), true);
  await expect(adapter.send({ from: "sender@example.org", to: "prospect@example.org",
    subject: "Re: Hello", body: "Approved follow-up", stableMessageId: "<fixture@example.org>",
    threadId: "thread-1", replyToId: "<original@example.org>" })).resolves.toMatchObject({ threadId: "thread-1" });
  expect(payload.threadId).toBe("thread-1");
  const mime = Buffer.from(payload.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  expect(mime).toContain("In-Reply-To: <original@example.org>\r\nReferences: <original@example.org>");
  await expect(adapter.send({ from: "sender@example.org", to: "prospect@example.org",
    subject: "Hello", body: "Fixture", stableMessageId: "<fixture@example.org>", threadId: "thread-1" }))
    .rejects.toThrow("INVALID_MAIL_HEADERS");
  expect(transport).toHaveBeenCalledOnce();
});
