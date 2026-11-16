import { z } from "zod";
export const stages = [
  "new",
  "researching",
  "qualified",
  "contacted",
  "replied",
  "meeting_booked",
  "proposal_sent",
  "won",
  "lost",
  "disqualified",
] as const;
export const leadInput = z.object({
  business_name: z.string().trim().min(2).max(160),
  website_url: z
    .union([
      z.literal(""),
      z
        .url()
        .refine(
          (v) => ["http:", "https:"].includes(new URL(v).protocol),
          "Use an HTTP(S) website",
        ),
    ])
    .default(""),
  email: z.union([z.literal(""), z.email()]).default(""),
  additional_emails: z.string().trim().max(2000).refine((value) => {
    const emails = value.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
    return emails.length <= 10 && emails.every((email) => z.email().safeParse(email).success);
  }, "Use at most ten valid email addresses").default(""),
  phones: z.string().trim().max(300).refine((value) => {
    const phones = value.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
    return phones.length <= 10 && phones.every((phone) => /^\+[1-9][0-9]{7,14}$/.test(phone));
  }, "Use at most ten E.164 phone numbers").default(""),
  business_category: z.string().trim().max(100).default(""),
  city: z.string().trim().max(100).default(""),
  state_region: z.string().trim().max(120).default(""),
  country: z.string().trim().max(120).default(""),
  identity_claim: z.string().trim().max(500).default(""),
  source_observed_at: z.union([z.literal(""), z.iso.datetime({ offset: true })]).default(""),
  source_type: z
    .enum([
      "inbound",
      "referral",
      "manual",
      "csv",
      "approved_source",
      "meta_form",
    ])
    .default("manual"),
  source_url: z
    .union([
      z.literal(""),
      z.url().refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
    ])
    .default(""),
  status: z.enum(stages).default("new"),
});
export type LeadInput = z.infer<typeof leadInput>;
export type Evidence = {
  id: string;
  claim: string;
  source_url: string;
  observed_at: string;
  confidence: number;
  reviewed: boolean;
  rejected?: boolean;
  kind:
    | "intent"
    | "relevance"
    | "quality"
    | "contactability"
    | "urgency"
    | "observation";
};
export type Score = {
  score: number;
  confidence: number;
  breakdown: Record<string, number>;
  evidence_ids: string[];
  score_version: string;
  human_review_required: boolean;
};
export function scoreLead(evidence: Evidence[], now = Date.now()): Score {
  const valid = evidence.filter(
    (e) =>
      e.reviewed &&
      e.confidence >= 0.7 &&
      e.claim.trim() &&
      Number.isFinite(Date.parse(e.observed_at)) &&
      Date.parse(e.observed_at) <= now &&
      now - Date.parse(e.observed_at) <= 90 * 86400000 &&
      /^https?:\/\//.test(e.source_url),
  );
  const has = (kind: Evidence["kind"]) => valid.some((e) => e.kind === kind);
  const breakdown = {
    intent: has("intent") ? 30 : 0,
    relevance: has("relevance") ? 25 : 0,
    quality: valid.length ? 20 : 0,
    contactability: has("contactability") ? 15 : 0,
    urgency: has("urgency") ? 10 : 0,
  };
  return {
    score: Object.values(breakdown).reduce((a, b) => a + b, 0),
    confidence: valid.length ? Math.min(1, valid.length / 5) : 0,
    breakdown,
    evidence_ids: valid.map((e) => e.id),
    score_version: "rules-v1",
    human_review_required: !has("intent"),
  };
}
export function domainOf(url: string) {
  return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : "";
}
export function identity(input: LeadInput) {
  return `${input.business_name.trim().toLowerCase()}|${domainOf(input.website_url)}`;
}
// RFC 4180-style parser: quoted commas/newlines/doubled quotes, bounded input.
export function parseCSV(text: string): string[][] {
  if (text.length > 1_000_000) throw new Error("CSV exceeds 1 MB.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted) {
        quoted = false;
      } else if (cell === "") {
        quoted = true;
      } else throw new Error("Invalid quote in CSV.");
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length > 501) throw new Error("Import at most 500 leads at once.");
  return rows;
}
export type ImportRow = {
  row: number;
  input?: LeadInput;
  errors: string[];
  duplicate: boolean;
};
export function previewCSV(
  text: string,
  existing: LeadInput[] = [],
): ImportRow[] {
  const [headers, ...rows] = parseCSV(text);
  if (!headers?.includes("business_name"))
    throw new Error("CSV requires a business_name header.");
  if (new Set(headers).size !== headers.length)
    throw new Error("Duplicate headers are not allowed.");
  const seen = new Set(existing.map(identity));
  return rows.map((values, index) => {
    const raw = Object.fromEntries(
      headers.map((key, i) => [key.trim(), values[i]?.trim() ?? ""]),
    );
    const parsed = leadInput.safeParse({
      ...raw,
      source_type: raw.source_type || "csv",
      status: raw.status || "new",
    });
    if (!parsed.success)
      return {
        row: index + 2,
        errors: parsed.error.issues.map(
          (e) => `${e.path.join(".")}: ${e.message}`,
        ),
        duplicate: false,
      };
    const key = identity(parsed.data);
    const duplicate = seen.has(key);
    seen.add(key);
    return {
      row: index + 2,
      input: parsed.data,
      errors:
        values.length !== headers.length
          ? ["Column count does not match headers."]
          : [],
      duplicate,
    };
  });
}
