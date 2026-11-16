import { z } from "zod";

export type VerificationStatus = "valid" | "invalid" | "unknown" | "risky" | "suppressed";
export type VerificationResult = {
  status: VerificationStatus;
  provider: string;
  evidence: {
    syntax: "pass" | "fail";
    domain: "exists" | "nxdomain" | "unknown";
    mx: "present" | "null_mx" | "absent" | "unknown";
    fallback_address: boolean | null;
    disposable: boolean;
    role_account?: boolean;
    full_inbox?: boolean;
    duplicate_contacts?: number;
    smtp?: "not_checked" | "deliverable" | "undeliverable" | "catch_all" | "inconclusive";
    reason: string;
  };
};

const dnsResponse = z.object({
  Status: z.number().int(),
  Answer: z.array(z.object({ type: z.number().int(), data: z.string() })).optional(),
});
type DnsResponse = z.infer<typeof dnsResponse>;
export interface DnsResolver {
  resolve(domain: string, type: "MX" | "A" | "AAAA"): Promise<DnsResponse>;
}

// A deliberately small starter set. It is evidence of known disposable domains,
// not a claim that all other domains are non-disposable.
export const starterDisposableDomains = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "yopmail.com",
]);

export class CloudflareDnsResolver implements DnsResolver {
  constructor(private transport: typeof fetch = fetch) {}
  async resolve(domain: string, type: "MX" | "A" | "AAAA") {
    const url = `https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name: domain, type })}`;
    const response = await this.transport(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("DNS_PROVIDER_UNAVAILABLE");
    return dnsResponse.parse(await response.json());
  }
}

export interface AdvancedEmailVerifier {
  verify(email: string): Promise<{
    is_reachable?: string;
    syntax?: { is_valid_syntax?: boolean };
    mx?: { accepts_mail?: boolean };
    misc?: { is_disposable?: boolean; is_role_account?: boolean };
    smtp?: { is_catch_all?: boolean; is_deliverable?: boolean; can_connect_smtp?: boolean; is_disabled?: boolean; has_full_inbox?: boolean };
  }>;
}

// Optional adapter for an approved, separately hosted Reacher service. No SMTP
// probe runs from Supabase Edge; endpoint and token are server-only settings.
export class ReacherHttpAdapter implements AdvancedEmailVerifier {
  constructor(private endpoint: string, private token: string, private transport: typeof fetch = fetch) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || !token || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error("REACHER_NOT_CONFIGURED");
  }
  async verify(email: string) {
    const response = await this.transport(new URL("/v0/check_email", this.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ to_email: email }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("REACHER_UNAVAILABLE");
    return z.object({
      is_reachable: z.enum(["safe", "risky", "invalid", "unknown"]).optional(),
      syntax: z.object({ is_valid_syntax: z.boolean().optional() }).optional(),
      mx: z.object({ accepts_mail: z.boolean().optional() }).optional(),
      misc: z.object({ is_disposable: z.boolean().optional(), is_role_account: z.boolean().optional() }).optional(),
      smtp: z.object({
        is_catch_all: z.boolean().optional(), is_deliverable: z.boolean().optional(),
        can_connect_smtp: z.boolean().optional(), is_disabled: z.boolean().optional(), has_full_inbox: z.boolean().optional(),
      }).optional(),
    }).parse(await response.json());
  }
}

const syntax = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export async function verifyEmailAddress(input: {
  email: string;
  resolver: DnsResolver;
  disposableDomains?: ReadonlySet<string>;
  advanced?: AdvancedEmailVerifier;
}): Promise<VerificationResult> {
  const email = input.email.trim().toLowerCase();
  const base: VerificationResult["evidence"] = {
    syntax: "fail", domain: "unknown", mx: "unknown", fallback_address: null,
    disposable: false, smtp: "not_checked", reason: "Syntax not valid",
  };
  if (email.length > 254 || !syntax.test(email) || email.includes(".."))
    return { status: "invalid", provider: "basic_dns", evidence: base };
  const domain = email.split("@")[1];
  base.syntax = "pass";
  base.disposable = (input.disposableDomains ?? starterDisposableDomains).has(domain);
  let mx: DnsResponse;
  try {
    mx = await input.resolver.resolve(domain, "MX");
  } catch {
    return { status: "unknown", provider: "basic_dns", evidence: { ...base, reason: "DNS lookup failed; mailbox status is unknown" } };
  }
  if (mx.Status === 3)
    return { status: "invalid", provider: "basic_dns", evidence: { ...base, domain: "nxdomain", mx: "absent", reason: "Domain does not exist" } };
  if (mx.Status !== 0)
    return { status: "unknown", provider: "basic_dns", evidence: { ...base, reason: "DNS lookup was inconclusive" } };
  base.domain = "exists";
  const records = (mx.Answer ?? []).filter((answer) => answer.type === 15);
  if (records.some((answer) => /^\s*0\s+\.\s*$/.test(answer.data)))
    return { status: "invalid", provider: "basic_dns", evidence: { ...base, mx: "null_mx", reason: "Domain explicitly does not accept mail (null MX)" } };
  if (records.length) base.mx = "present";
  else {
    base.mx = "absent";
    try {
      const [a, aaaa] = await Promise.all([
        input.resolver.resolve(domain, "A"), input.resolver.resolve(domain, "AAAA"),
      ]);
      base.fallback_address = [a, aaaa].some((answer) =>
        answer.Status === 0 && (answer.Answer ?? []).some((record) => record.type === 1 || record.type === 28));
      if (!base.fallback_address && [a, aaaa].every((answer) => answer.Status === 0 || answer.Status === 3))
        return { status: "invalid", provider: "basic_dns", evidence: { ...base, reason: "No MX or fallback address records" } };
    } catch {
      return { status: "unknown", provider: "basic_dns", evidence: { ...base, reason: "Mail routing could not be determined" } };
    }
  }
  let status: VerificationStatus = base.disposable ? "risky" : "unknown";
  base.reason = base.disposable ? "Known disposable domain" : base.mx === "present"
    ? "Syntax and MX checks passed; mailbox existence was not proven" : "No MX; fallback routing needs review";
  if (input.advanced) {
    try {
      const advanced = await input.advanced.verify(email);
      const decisiveInvalid = advanced.is_reachable === "invalid" || advanced.syntax?.is_valid_syntax === false || advanced.mx?.accepts_mail === false;
      if (decisiveInvalid) {
        status = "invalid";
        base.reason = "Reacher reported the address invalid; review before any outreach";
      } else if (advanced.is_reachable === "safe" && base.mx === "present" && !base.disposable) {
        status = "valid";
        base.reason = "Reacher reported the address safe; delivery is not guaranteed";
      } else if (advanced.is_reachable === "unknown" || !advanced.is_reachable) {
        status = "unknown";
        base.reason = "Reacher could not establish mailbox reachability";
      } else if (advanced.is_reachable === "risky") {
        status = "risky";
        base.reason = "Reacher reported reachability risk";
      }
      if (advanced.misc?.is_disposable) { status = "risky"; base.disposable = true; base.reason = "Reacher marked the domain disposable"; }
      if (advanced.misc?.is_role_account) { status = "risky"; base.role_account = true; base.reason = "Role mailbox needs owner review"; }
      if (advanced.smtp?.has_full_inbox) { status = "risky"; base.full_inbox = true; base.reason = "Reacher reported a full inbox"; }
      if (advanced.smtp?.is_catch_all) { status = "risky"; base.smtp = "catch_all"; base.reason = "Catch-all mailbox needs review"; }
      else if (advanced.smtp?.can_connect_smtp && advanced.smtp.is_deliverable && !advanced.smtp.is_disabled) base.smtp = "deliverable";
      else if (advanced.smtp?.can_connect_smtp && (advanced.smtp.is_disabled || advanced.smtp.is_deliverable === false)) {
        base.smtp = "undeliverable";
        status = "risky";
        base.reason = "SMTP refusal may be policy-related; manual review required";
      } else base.smtp = "inconclusive";
      if (decisiveInvalid) {
        status = "invalid";
        base.reason = "Reacher reported the address invalid; review before any outreach";
      }
    } catch {
      base.smtp = "inconclusive";
      if (status === "valid") status = "unknown";
      base.reason = "Optional SMTP check unavailable; mailbox status is unknown";
    }
  }
  return { status, provider: input.advanced ? "basic_dns+reacher" : "basic_dns", evidence: base };
}
