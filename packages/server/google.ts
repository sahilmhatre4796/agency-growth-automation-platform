import { z } from "zod";
import { base64url, slotAvailable } from "./integrations.ts";
export class GoogleAPIError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export class GoogleAPI {
  constructor(
    private accessToken: string,
    private transport: typeof fetch = fetch,
  ) {}
  async request(path: string, init: RequestInit = {}) {
    const response = await this.transport(
      "https://www.googleapis.com/" + path,
      {
        ...init,
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          ...init.headers,
          Authorization: `Bearer ${this.accessToken}`,
        },
      },
    );
    if (!response.ok)
      throw new GoogleAPIError(
        response.status === 401
          ? "GOOGLE_DISCONNECTED"
          : response.status === 403
            ? "GOOGLE_FORBIDDEN"
          : response.status === 429
            ? "GOOGLE_RATE_LIMITED"
            : response.status === 409
              ? "PROVIDER_CONFLICT"
              : "GOOGLE_UNAVAILABLE",
        response.status,
      );
    const text = await response.text();
    if (text.length > 2_000_000)
      throw new GoogleAPIError("PROVIDER_RESPONSE_TOO_LARGE", 502);
    return text ? JSON.parse(text) : null;
  }
}
export class GmailAdapter {
  constructor(
    private api: GoogleAPI,
    private liveEnabled = false,
  ) {}
  async lookup(stableMessageId: string) {
    const payload = z
      .object({ messages: z.array(z.object({ id: z.string() })).optional() })
      .parse(
        await this.api.request(
          "gmail/v1/users/me/messages?" +
            new URLSearchParams({
              q: `rfc822msgid:${stableMessageId}`,
              maxResults: "2",
            }),
        ),
      );
    if ((payload.messages?.length ?? 0) > 1)
      throw new Error("AMBIGUOUS_RECONCILIATION");
    return payload.messages?.[0]?.id ?? null;
  }
  async send(input: {
    from: string;
    senderName?: string;
    to: string;
    subject: string;
    body: string;
    stableMessageId: string;
    threadId?: string | null;
    replyToId?: string | null;
  }) {
    if (!this.liveEnabled) throw new Error("LIVE_EMAIL_DISABLED");
    z.email().parse(input.from);
    z.email().parse(input.to);
    if (
      /[\r\n]/.test(input.subject) ||
      /[\r\n]/.test(input.senderName ?? "") ||
      (input.senderName?.length ?? 0) > 120 ||
      !/^<[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+>$/.test(input.stableMessageId) ||
      input.subject.length > 160 ||
      input.body.length > 3000 ||
      Boolean(input.threadId) !== Boolean(input.replyToId) ||
      (input.threadId != null && !/^[A-Za-z0-9_-]{1,200}$/.test(input.threadId)) ||
      (input.replyToId != null && !/^<[^<>\s\r\n]{1,200}>$/.test(input.replyToId))
    )
      throw new Error("INVALID_MAIL_HEADERS");
    const subject = base64url(new TextEncoder().encode(input.subject))
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const sender = input.senderName
      ? `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(input.senderName)))}?= <${input.from}>`
      : input.from;
    const replyHeaders = input.replyToId ? `In-Reply-To: ${input.replyToId}\r\nReferences: ${input.replyToId}\r\n` : "";
    const mime = `From: ${sender}\r\nTo: ${input.to}\r\nSubject: =?UTF-8?B?${subject}${"=".repeat((4 - (subject.length % 4)) % 4)}?=\r\nMessage-ID: ${input.stableMessageId}\r\n${replyHeaders}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(String.fromCharCode(...new TextEncoder().encode(input.body)))}`;
    return z
      .object({ id: z.string(), threadId: z.string() })
      .parse(
        await this.api.request("gmail/v1/users/me/messages/send", {
          method: "POST",
          body: JSON.stringify({
            raw: base64url(new TextEncoder().encode(mime)),
            ...(input.threadId ? { threadId: input.threadId } : {}),
          }),
        }),
      );
  }
  async thread(id: string) {
    return this.api.request(
      `gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`,
    );
  }
  async profile() {
    return z.object({ emailAddress: z.email(), historyId: z.string() }).parse(
      await this.api.request("gmail/v1/users/me/profile"),
    );
  }
  async list(label: "INBOX" | "SENT", pageToken?: string) {
    return z.object({
      messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
      nextPageToken: z.string().optional(),
    }).parse(await this.api.request("gmail/v1/users/me/messages?" +
      new URLSearchParams({ labelIds: label, maxResults: "100", ...(pageToken ? { pageToken } : {}) })));
  }
  async message(id: string) {
    return z.object({
      id: z.string(), threadId: z.string(), historyId: z.string().optional(),
      internalDate: z.string(), labelIds: z.array(z.string()).optional(),
      payload: z.object({
        headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        body: z.object({ data: z.string().optional() }).optional(),
        parts: z.array(z.unknown()).optional(),
      }),
      snippet: z.string().optional(),
    }).parse(await this.api.request(`gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`));
  }
  async history(startHistoryId: string, pageToken?: string) {
    return z.object({
      historyId: z.string(),
      nextPageToken: z.string().optional(),
      history: z.array(z.object({
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string(), threadId: z.string() }) })).optional(),
      })).optional(),
    }).parse(await this.api.request("gmail/v1/users/me/history?" +
      new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "100", ...(pageToken ? { pageToken } : {}) })));
  }
}
export class CalendarAdapter {
  constructor(
    private api: GoogleAPI,
    private liveInvitesEnabled = false,
  ) {}
  async availability(input: {
    start: string;
    end: string;
    calendarId: string;
    timezone: string;
  }) {
    if (
      Date.parse(input.end) <= Date.parse(input.start) ||
      !Number.isFinite(Date.parse(input.start))
    )
      throw new Error("INVALID_INTERVAL");
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    const payload = z
      .object({
        calendars: z.record(
          z.string(),
          z.object({
            busy: z.array(
              z.object({
                start: z.iso.datetime({ offset: true }),
                end: z.iso.datetime({ offset: true }),
              }),
            ),
            errors: z.array(z.unknown()).optional(),
          }),
        ),
      })
      .parse(
        await this.api.request("calendar/v3/freeBusy", {
          method: "POST",
          body: JSON.stringify({
            timeMin: input.start,
            timeMax: input.end,
            timeZone: input.timezone,
            items: [{ id: input.calendarId }],
          }),
        }),
      );
    const calendar = payload.calendars[input.calendarId];
    if (!calendar || calendar.errors?.length)
      throw new Error("CALENDAR_UNAVAILABLE");
    return calendar.busy;
  }
  async book(input: {
    start: string;
    end: string;
    timezone: string;
    calendarId: string;
    attendee: string;
    approved: boolean;
    idempotencyKey: string;
    orgId: string;
  }) {
    if (!this.liveInvitesEnabled || !input.approved)
      throw new Error("LIVE_INVITATIONS_DISABLED");
    z.email().parse(input.attendee);
    if (
      input.idempotencyKey.length < 16 ||
      Date.parse(input.start) <= Date.now()
    )
      throw new Error("INVALID_BOOKING");
    const busy = await this.availability(input);
    if (
      !slotAvailable(
        Date.parse(input.start),
        Date.parse(input.end),
        busy.map((b) => ({
          start: Date.parse(b.start),
          end: Date.parse(b.end),
        })),
      )
    )
      throw new Error("SLOT_UNAVAILABLE");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input.orgId + ":" + input.idempotencyKey),
    );
    const id = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return z
      .object({ id: z.string(), status: z.string() })
      .parse(
        await this.api.request(
          `calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=all`,
          {
            method: "POST",
            body: JSON.stringify({
              id,
              summary: "ChainCraft Studio consultation",
              start: { dateTime: input.start, timeZone: input.timezone },
              end: { dateTime: input.end, timeZone: input.timezone },
              attendees: [{ email: input.attendee }],
            }),
          },
        ),
      );
  }
}
export async function exchangeGoogleCode(
  input: {
    code: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  },
  transport: typeof fetch = fetch,
) {
  const response = await transport("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  return z
    .object({
      access_token: z.string(),
      refresh_token: z.string().optional(),
      expires_in: z.number().positive(),
      token_type: z.literal("Bearer"),
      scope: z.string(),
    })
    .parse(await response.json());
}
export async function refreshGoogleToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}, transport: typeof fetch = fetch) {
  const response = await transport("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (response.status === 400 || response.status === 401) {
    const text = (await response.text()).slice(0, 2048);
    let providerCode = "";
    try { providerCode = z.object({ error: z.string() }).parse(JSON.parse(text)).error; } catch { /* provider error is untrusted */ }
    throw new GoogleAPIError(providerCode === "invalid_grant" ? "GOOGLE_REVOKED" : "GOOGLE_REFRESH_UNAVAILABLE", response.status);
  }
  if (!response.ok) throw new GoogleAPIError("GOOGLE_REFRESH_UNAVAILABLE", response.status);
  return z.object({ access_token: z.string(), expires_in: z.number().positive(), token_type: z.literal("Bearer"), scope: z.string().optional() }).parse(await response.json());
}
