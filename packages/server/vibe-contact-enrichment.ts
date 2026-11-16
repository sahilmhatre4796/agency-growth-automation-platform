import { z } from "zod";
import { safeResearchUrl } from "./research.ts";
import { phoneCountryCompatibility } from "./market-targeting.ts";
import { sourceAuthority } from "./source-authority.ts";

export const contactObservationSchema = z.object({
  lead_id: z.uuid(),
  kind: z.enum(["email", "phone", "whatsapp"]),
  value: z.string().trim().min(3).max(254),
  // "osm" is OpenStreetMap tag evidence and must never be reported under the
  // legacy "harvey" label. Persisting it would need a future migration
  // extending vibe_contact_sources (out of scope here; no DB writes occur).
  source_provider: z.enum(["serper", "harvey", "vibe", "official_website", "manual", "scrapling", "osm"]),
  source_url: z.url(),
  observed_at: z.iso.datetime({ offset: true }),
  evidence_excerpt: z.string().trim().min(5).max(320),
  contact_name: z.string().trim().min(3).max(160).nullable().optional(),
  role: z.string().trim().min(2).max(100).nullable().optional(),
  confidence: z.number().min(0).max(1),
}).strict();
export type ContactObservation = z.infer<typeof contactObservationSchema>;

export function normalizeContactValue(kind: ContactObservation["kind"], value: string) {
  if (kind === "email") {
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) || email.includes(".."))
      throw new Error("INVALID_CONTACT_EMAIL");
    return email;
  }
  // No local-country guess: store only an explicitly international number.
  const digits = value.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) throw new Error("INVALID_CONTACT_PHONE");
  return digits;
}

export type ContactPoint = {
  lead_id: string; kind: ContactObservation["kind"]; normalized_value: string;
  observations: ContactObservation[]; source_count: number; corroborated: boolean;
  confidence: number;
};

// Compare only within an already-resolved CRM lead. Similar names across
// businesses never cause this function to merge contact identities.
export function reconcileContactObservations(observations: ContactObservation[]): ContactPoint[] {
  const points = new Map<string, ContactPoint>();
  for (const raw of observations) {
    const item = contactObservationSchema.parse(raw);
    safeResearchUrl(item.source_url);
    const normalized = normalizeContactValue(item.kind, item.value);
    if (!item.evidence_excerpt.toLowerCase().includes(item.value.toLowerCase()))
      throw new Error("CONTACT_EVIDENCE_VALUE_MISSING");
    if (item.kind === "whatsapp" && !/whatsapp|wa\.me|api\.whatsapp/i.test(item.evidence_excerpt))
      throw new Error("WHATSAPP_NOT_EXPLICIT");
    const key = `${item.lead_id}:${item.kind}:${normalized}`;
    const point = points.get(key) ?? { lead_id: item.lead_id, kind: item.kind,
      normalized_value: normalized, observations: [], source_count: 0, corroborated: false, confidence: 0 };
    if (!point.observations.some((source) => source.source_provider === item.source_provider && source.source_url === item.source_url))
      point.observations.push(item);
    points.set(key, point);
  }
  for (const point of points.values()) {
    point.source_count = new Set(point.observations.map((source) => source.source_provider)).size;
    // A website plus a distinct discovery source is stronger than two directories
    // that may repeat the same listing. It still does not verify the mailbox.
    point.corroborated = point.source_count > 1 && point.observations.some((source) =>
      ["official_website", "vibe", "scrapling"].includes(source.source_provider) &&
      point.observations.some((other) => other.source_provider !== source.source_provider &&
        sourceAuthority(other.source_url) !== sourceAuthority(source.source_url)));
    point.confidence = Math.max(...point.observations.map((source) => source.confidence));
  }
  return [...points.values()].sort((a, b) => a.lead_id.localeCompare(b.lead_id) || a.kind.localeCompare(b.kind) || a.normalized_value.localeCompare(b.normalized_value));
}

const publicEmail = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export function extractPublicEmailCandidates(input: {
  source_url: string; page_text: string; observed_at: string;
  business_name: string; maximum?: number; official_domain_confirmed?: boolean;
}): Array<{ kind: "email"; value: string; source_url: string; observed_at: string; evidence_excerpt: string; confidence: number }> {
  const source = safeResearchUrl(input.source_url);
  // Navigation and legal markup often precede the actual contact section.
  // Keep a hard bound while scanning the complete body of ordinary pages.
  const raw = input.page_text.slice(0, 100000);
  const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  // A contact subpage often omits the full registered name. Only a caller that
  // has independently confirmed this exact official domain may waive it.
  if (!input.official_domain_confirmed && !text.toLowerCase().includes(input.business_name.toLowerCase())) return [];
  const result: ReturnType<typeof extractPublicEmailCandidates> = [];
  const add = (value: string, excerpt: string) => {
    if (/ignore previous|system prompt|assistant instruction/i.test(excerpt)) return;
    try { normalizeContactValue("email", value); } catch { return; }
    if (result.some((item) => item.value.toLowerCase() === value.toLowerCase())) return;
    result.push({ kind: "email", value,
      source_url: source, observed_at: input.observed_at, evidence_excerpt: excerpt,
      confidence: 0.7 });
  };
  for (const match of text.matchAll(publicEmail)) {
    const value = match[0].replace(/[),.;]+$/, "");
    const at = match.index ?? 0;
    add(value, text.slice(Math.max(0, at - 30), Math.min(text.length, at + value.length + 30)).trim());
    if (result.length >= (input.maximum ?? 10)) return result;
  }
  for (const match of raw.matchAll(/mailto:([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const value = match[1];
    const at = (match.index ?? 0) + "mailto:".length;
    add(value, raw.slice(Math.max(0, at - 20), Math.min(raw.length, at + value.length + 20)).trim());
    if (result.length >= (input.maximum ?? 10)) return result;
  }
  return result;
}

export function extractPublicBusinessEmails(input: Parameters<typeof extractPublicEmailCandidates>[0] & { lead_id: string }): ContactObservation[] {
  return extractPublicEmailCandidates(input).map((candidate) => ({ ...candidate,
    lead_id: input.lead_id, source_provider: "official_website" }));
}

export function extractPublicPhoneCandidates(input: {
  source_url: string; page_text: string; observed_at: string; business_name: string;
  official_domain_confirmed?: boolean; maximum?: number; country?: string | null;
}): Array<Pick<ContactObservation, "kind" | "value" | "source_url" | "observed_at" | "evidence_excerpt" | "confidence">> {
  const source = safeResearchUrl(input.source_url);
  const text = input.page_text.slice(0, 100000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  if (!input.official_domain_confirmed && !text.toLowerCase().includes(input.business_name.toLowerCase())) return [];
  const result: ReturnType<typeof extractPublicPhoneCandidates> = [];
  for (const match of text.matchAll(/\+[1-9]\d[\d\s().-]{6,22}\d/g)) {
    const value = match[0].trim();
    const at = match.index ?? 0;
    const excerpt = text.slice(Math.max(0, at - 42), Math.min(text.length, at + value.length + 24)).trim();
    const before = text.slice(Math.max(0, at - 42), at);
    const kind = /(?:whatsapp|wa\.me|api\.whatsapp)\s*[:-]?\s*$/i.test(before) ? "whatsapp" :
      /(?:phone|telephone|tel|call|mobile|contact)\s*[:-]?\s*$/i.test(before) ? "phone" : null;
    if (!kind) continue;
    try { normalizeContactValue(kind, value); } catch { continue; }
    if (result.some((item) => item.kind === kind && normalizeContactValue(kind, item.value) === normalizeContactValue(kind, value))) continue;
    const countrySignal = input.country ? phoneCountryCompatibility(value, input.country) : "unknown_market";
    // Different calling codes are not discarded: a public business line can
    // legitimately route abroad. Keep it with lower confidence for review.
    result.push({ kind, value, source_url: source, observed_at: input.observed_at,
      evidence_excerpt: excerpt, confidence: countrySignal === "different_calling_code" ? 0.4 : kind === "whatsapp" ? 0.7 : 0.65 });
    if (result.length >= (input.maximum ?? 5)) break;
  }
  return result;
}
