// Multi-Gmail account management: up to ten independently connected Gmail
// accounts. Provides consistent sender selection per prospect (never rotates
// to bypass limits), per-account rate limiting, enable/disable controls, and
// error handling (revoked / rate-limited / forbidden). Nothing is sent unless
// ENABLE_LIVE_EMAIL === "true".
//
// All external dependencies (OAuth token storage, refresh, Gmail API calls)
// are injected so every behaviour can be tested synthetically.
import { z } from "zod";

export type GmailAccount = {
  account_id: string;
  org_id: string;
  email: string;
  display_name: string;
  enabled: boolean;
  daily_cap: number;
  sent_today: number;
  last_send_at: string | null;
  rate_limited_until: string | null;
  error_code: string | null; // "GOOGLE_REVOKED" | "GOOGLE_DISCONNECTED" | "GOOGLE_FORBIDDEN" | null
  oauth_encrypted: string; // encrypted refresh token (caller manages encryption)
};

export type AccountPort = {
  // Returns all Gmail accounts for an org.
  listAccounts(input: { org_id: string }): Promise<GmailAccount[]>;
  // Updates an account's send counters / error state.
  updateAccount(input: {
    account_id: string;
    sent_today?: number;
    last_send_at?: string | null;
    rate_limited_until?: string | null;
    error_code?: string | null;
    enabled?: boolean;
  }): Promise<void>;
  // Resets daily counters (called by a daily job).
  resetDailyCounters(input: { org_id: string; date: string }): Promise<number>;
};

export type GmailSendPort = {
  // Sends via a specific account's OAuth access token. Returns null if live
  // email is disabled.
  send(input: {
    account_email: string;
    access_token: string;
    to: string;
    subject: string;
    body: string;
    thread_id?: string | null;
    reply_to_rfc_id?: string | null;
  }): Promise<{ provider_id: string; thread_id: string } | null>;
};

// Consistent sender selection: hash the recipient to pick an account, then
// skip disabled / rate-limited / error accounts. Same recipient always gets
// the same sender so conversations stay on one thread/account.
export function selectSender(input: {
  recipient_email: string;
  accounts: GmailAccount[];
  now?: Date;
}): GmailAccount | null {
  const accounts = input.accounts.filter((a) => a.enabled);
  if (accounts.length === 0) return null;

  const now = input.now ?? new Date();
  const eligible = accounts.filter((a) => {
    if (!a.enabled) return false;
    if (a.error_code === "GOOGLE_REVOKED" || a.error_code === "GOOGLE_DISCONNECTED")
      return false;
    if (a.rate_limited_until && new Date(a.rate_limited_until) > now) return false;
    if (a.sent_today >= a.daily_cap) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // Stable hash of recipient -> account index, so the same prospect always
  // reaches the same account (conversation continuity).
  let hash = 0;
  for (let i = 0; i < input.recipient_email.length; i++) {
    hash = (hash * 31 + input.recipient_email.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % eligible.length;
  return eligible[index];
}

export type RateLimitConfig = {
  // One new prospect email every 5-10 minutes per account (conservative).
  min_interval_ms: number;
  max_per_day: number;
};

// Enforces account-level pacing: min interval between sends + daily cap.
export function canSendNow(input: {
  account: GmailAccount;
  last_send_at: string | null;
  now?: Date;
  config?: Partial<RateLimitConfig>;
}): { allowed: boolean; reason?: string } {
  const config: RateLimitConfig = {
    min_interval_ms: 5 * 60_000, // 5 minutes
    max_per_day: 100,
    ...input.config,
  };
  const now = input.now ?? new Date();
  const account = input.account;
  if (!account.enabled) return { allowed: false, reason: "account_disabled" };
  if (
    account.error_code === "GOOGLE_REVOKED" ||
    account.error_code === "GOOGLE_DISCONNECTED"
  )
    return { allowed: false, reason: "account_error" };
  if (account.rate_limited_until && new Date(account.rate_limited_until) > now)
    return { allowed: false, reason: "account_rate_limited" };
  if (account.sent_today >= account.daily_cap)
    return { allowed: false, reason: "daily_cap" };
  if (account.sent_today >= config.max_per_day)
    return { allowed: false, reason: "global_cap" };
  if (input.last_send_at) {
    const elapsed = now.getTime() - new Date(input.last_send_at).getTime();
    if (elapsed < config.min_interval_ms) {
      return { allowed: false, reason: "min_interval" };
    }
  }
  return { allowed: true };
}

// Handle a send error: mark revoked/disconnected/forbidden accounts, rate-limit
// on 429, otherwise record a generic error.
export function handleSendError(input: {
  account: GmailAccount;
  code: string;
  now?: Date;
}): { account: GmailAccount; backoff_minutes: number } {
  const now = input.now ?? new Date();
  const account = { ...input.account };
  let backoffMinutes = 15;

  switch (input.code) {
    case "GOOGLE_REVOKED":
    case "GOOGLE_DISCONNECTED":
      account.error_code = input.code;
      backoffMinutes = 0;
      break;
    case "GOOGLE_FORBIDDEN":
      account.error_code = input.code;
      backoffMinutes = 60;
      break;
    case "GOOGLE_RATE_LIMITED":
      account.error_code = input.code;
      backoffMinutes = 60;
      break;
    default:
      account.error_code = input.code;
      backoffMinutes = 15;
      break;
  }

  if (backoffMinutes > 0) {
    account.rate_limited_until = new Date(
      now.getTime() + backoffMinutes * 60_000,
    ).toISOString();
  }

  return { account, backoff_minutes: backoffMinutes };
}

// Record a successful send: increment counters, clear error state.
export function recordSuccessfulSend(input: {
  account: GmailAccount;
  now?: Date;
}): GmailAccount {
  const now = input.now ?? new Date();
  return {
    ...input.account,
    sent_today: input.account.sent_today + 1,
    last_send_at: now.toISOString(),
    rate_limited_until: null,
    error_code: null,
  };
}

// Validate a complete account config.
export const accountSchema = z.object({
  account_id: z.uuid(),
  org_id: z.uuid(),
  email: z.string().email(),
  display_name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  daily_cap: z.number().int().min(1).max(1000).default(50),
  sent_today: z.number().int().min(0).default(0),
  last_send_at: z.string().nullable().optional(),
  rate_limited_until: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  oauth_encrypted: z.string().min(1),
});

