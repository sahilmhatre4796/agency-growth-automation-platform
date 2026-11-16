import { z } from "zod";
import type { Evidence } from "./crm.ts";
export const draftSchema = z
  .object({
    subject: z.string().min(1).max(160),
    body: z.string().min(1).max(3000),
    language: z.enum(["en", "hi", "hinglish"]),
    evidence_ids_used: z.array(z.uuid()).max(20),
    unsupported_claims: z.array(z.string()).max(20),
    review_required: z.literal(true),
  })
  .strict();
export type DraftSuggestion = z.infer<typeof draftSchema>;
export const selectionSchema = z
  .object({
    evidence_ids: z.array(z.uuid()).max(3),
    language: z.enum(["en", "hi", "hinglish"]),
  })
  .strict();
export function eligibleEvidence(evidence: Evidence[], now = Date.now()) {
  return evidence.filter(
    (e) =>
      e.reviewed &&
      e.confidence >= 0.7 &&
      /^https?:\/\//.test(e.source_url) &&
      Date.parse(e.observed_at) <= now &&
      now - Date.parse(e.observed_at) <= 90 * 86400000 &&
      !/(ignore.{0,30}instructions|system prompt|api[_ -]?key|<script|guarantee|discount|password)/i.test(
        e.claim,
      ),
  );
}
// AI selects from an evidence allowlist. Final factual copy is rendered from reviewed
// source quotes, never from unconstrained model prose. Human review is still required.
export function renderGroundedDraft(
  evidence: Evidence[],
  selection: unknown,
): DraftSuggestion {
  const chosen = selectionSchema.parse(selection);
  const allowed = eligibleEvidence(evidence);
  if (new Set(chosen.evidence_ids).size !== chosen.evidence_ids.length)
    throw new Error("DUPLICATE_EVIDENCE");
  const facts = chosen.evidence_ids.map((id) => {
    const e = allowed.find((e) => e.id === id);
    if (!e) throw new Error("UNGROUNDED_EVIDENCE");
    return e.claim
      .replace(/<[^>]*>/g, "")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
  });
  const quotes = facts.length
    ? "\n\nSource observations for discussion:\n" +
      facts.map((f) => `“${f}”`).join("\n")
    : "";
  const body =
    chosen.language === "en"
      ? `Hello,\n\nI’m reaching out from ChainCraft Studio about website development and redesign.${quotes}\n\nWould you be open to discussing whether a website consultation would be useful?\n\nIf you prefer no further contact, please let us know.\nChainCraft Studio`
      : chosen.language === "hinglish"
        ? `Namaste,\n\nMain ChainCraft Studio se website development aur redesign ke baare mein sampark kar raha hoon.${quotes}\n\nKya aap website consultation par baat karna chahenge?\n\nAgar aap aage sampark nahi chahte, kripya bata dein.\nChainCraft Studio`
        : `नमस्ते,\n\nमैं ChainCraft Studio से वेबसाइट विकास और रीडिज़ाइन के बारे में संपर्क कर रहा हूँ।${quotes}\n\nक्या आप वेबसाइट परामर्श पर बात करना चाहेंगे?\n\nयदि आप आगे संपर्क नहीं चाहते हैं, तो कृपया हमें बताएँ।\nChainCraft Studio`;
  return draftSchema.parse({
    subject:
      chosen.language === "en"
        ? "A website conversation"
        : "Website consultation · ChainCraft Studio",
    body,
    language: chosen.language,
    evidence_ids_used: chosen.evidence_ids,
    unsupported_claims: [],
    review_required: true,
  });
}
