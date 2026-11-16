import { z } from "zod";
export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function oauthChallenge(verifier: string) {
  if (verifier.length < 43 || verifier.length > 128)
    throw new Error("INVALID_PKCE_VERIFIER");
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}
export async function googleAuthorization(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
  profile: "mail" | "calendar";
  loginHint?: string;
}) {
  const redirect = new URL(input.redirectUri);
  if (
    redirect.protocol !== "https:" &&
    redirect.hostname !== "localhost" &&
    redirect.hostname !== "127.0.0.1"
  )
    throw new Error("INSECURE_REDIRECT");
  if (input.state.length < 32) throw new Error("INVALID_STATE");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  const scopes =
    input.profile === "mail"
      ? [
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.readonly",
        ]
      : [
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/calendar.freebusy",
        ];
  scopes.push("openid", "email");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state: input.state,
    code_challenge: await oauthChallenge(input.verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}
export function validateOAuthCallback(input: {
  state: string;
  expectedState: string;
  expiresAt: number;
  used: boolean;
  redirectUri: string;
  expectedRedirect: string;
}) {
  if (
    input.used ||
    Date.now() > input.expiresAt ||
    input.state.length < 32 ||
    input.state !== input.expectedState ||
    input.redirectUri !== input.expectedRedirect
  )
    throw new Error("OAUTH_STATE_REJECTED");
}
export async function encryptToken(
  token: string,
  key: CryptoKey,
  orgId: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(orgId) },
    key,
    new TextEncoder().encode(token),
  );
  return {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(encrypted)),
  };
}
export async function decryptToken(
  record: { iv: number[]; ciphertext: number[] },
  key: CryptoKey,
  orgId: string,
) {
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(record.iv),
      additionalData: new TextEncoder().encode(orgId),
    },
    key,
    new Uint8Array(record.ciphertext),
  );
  return new TextDecoder().decode(data);
}
export function classifyReply(text: string) {
  const clean = text.trim().slice(0, 10000);
  if (
    /\b(unsubscribe|stop|remove me|do not contact|don't contact|opt.?out)\b|संपर्क न करें|band karo/i.test(
      clean,
    )
  )
    return {
      label: "unsubscribe",
      confidence: 1,
      stopFollowups: true,
      humanReview: false,
    };
  if (/\b(not interested|no thanks|not now)\b/i.test(clean))
    return {
      label: "negative",
      confidence: 0.8,
      stopFollowups: true,
      humanReview: true,
    };
  if (
    /\b(meeting|schedule|pricing|quote|interested|new website|redesign)\b/i.test(
      clean,
    )
  )
    return {
      label: "question",
      confidence: 0.6,
      stopFollowups: true,
      humanReview: true,
    };
  return {
    label: "unknown",
    confidence: 0,
    stopFollowups: true,
    humanReview: true,
  };
}
export async function verifyWhatsAppSignature(
  raw: Uint8Array,
  signature: string,
  secret: string,
) {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = new Uint8Array(
    signature
      .slice(7)
      .match(/../g)!
      .map((v) => parseInt(v, 16)),
  );
  return crypto.subtle.verify("HMAC", key, bytes, new Uint8Array(raw));
}
export function whatsappEligibility(input: {
  optedIn: boolean;
  optedOut: boolean;
  lastInboundAt: number | null;
  templateApproved: boolean;
  now: number;
}) {
  if (!input.optedIn || input.optedOut) return false;
  return (
    input.templateApproved ||
    (input.lastInboundAt !== null &&
      input.lastInboundAt <= input.now &&
      input.now - input.lastInboundAt < 24 * 3600000)
  );
}
export const meetingInput = z
  .object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1),
    approved: z.literal(true),
    idempotencyKey: z.string().min(16),
  })
  .refine(
    (x) =>
      Date.parse(x.end) > Date.parse(x.start) &&
      Date.parse(x.start) > Date.now(),
    "Invalid meeting interval",
  );
export function slotAvailable(
  start: number,
  end: number,
  busy: { start: number; end: number }[],
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return false;
  return busy.every((b) => end <= b.start || start >= b.end);
}
export interface ReconciledMail {
  lookup(stableMessageId: string): Promise<string | null>;
  send(stableMessageId: string): Promise<string>;
}
export type Delivery = {
  state: "queued" | "processing" | "uncertain" | "completed";
  stableMessageId: string;
  providerId?: string;
};
// Persist processing before using this function. Any unknown prior attempt must
// reconcile; absence in provider search is not permission to blindly resend.
export async function deliverOnce(
  job: Delivery,
  provider: ReconciledMail,
  persist: (job: Delivery) => Promise<void>,
  eligible: () => Promise<boolean>,
) {
  if (job.state === "completed") return job;
  if (!(await eligible())) throw new Error("OUTBOUND_POLICY_BLOCKED");
  if (job.state === "processing" || job.state === "uncertain") {
    const receipt = await provider.lookup(job.stableMessageId);
    if (!receipt) throw new Error("MANUAL_RECONCILIATION_REQUIRED");
    const completed = {
      ...job,
      state: "completed" as const,
      providerId: receipt,
    };
    await persist(completed);
    return completed;
  }
  await persist({ ...job, state: "processing" });
  if (!(await eligible())) throw new Error("OUTBOUND_POLICY_BLOCKED");
  try {
    const receipt = await provider.send(job.stableMessageId);
    const completed = {
      ...job,
      state: "completed" as const,
      providerId: receipt,
    };
    await persist(completed);
    return completed;
  } catch {
    await persist({ ...job, state: "uncertain" });
    throw new Error("DELIVERY_UNCERTAIN");
  }
}
