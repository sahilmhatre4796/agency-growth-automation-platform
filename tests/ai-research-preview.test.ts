import { expect, test } from "vitest";
import { buildAISelectedResearchPreview } from "../packages/server/ai-research-preview.ts";

const now = Date.parse("2026-10-25T02:00:00.000Z");
const leadId = "10000000-0000-4000-8000-000000000001";
const otherLeadId = "10000000-0000-4000-8000-000000000002";
const factId = "10000000-0000-4000-8000-000000000003";
const corroborationId = "10000000-0000-4000-8000-000000000004";
const otherFactId = "10000000-0000-4000-8000-000000000005";

const fact = {
  id: factId, lead_id: leadId, source_url: "https://city.example/testers",
  claim: "City Water approved tester directory lists Cedar Pipe Works at 100 Main Street, phone +1555010009, email hello@example.org. Directory does not prove website absence.",
  confidence: 0.9, observed_at: new Date(now).toISOString(), reviewed_by: null, rejected_by: null,
};
const corroboration = {
  ...fact, id: corroborationId, source_url: "https://utility.test/testers",
  claim: "Regional Utility register lists Cedar Pipe Works as a local tester.",
};
const otherFact = {
  ...fact, id: otherFactId, lead_id: otherLeadId,
  claim: "City Water directory lists Another Business at 100 Main Street.",
};
const input = {
  leadId, businessName: "Cedar Pipe Works",
  evidence: [fact, corroboration, otherFact], selection: {
    fact_id: factId, cta_variant: "short_example", subject_variant: "second",
  },
  serviceKey: "service_01" as const, serviceName: "Business websites",
  matchConfidence: 0.65, websiteStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED",
};

test("Groq-selected evidence produces only grounded, conditional internal copy", () => {
  const preview = buildAISelectedResearchPreview(input, now);
  expect(preview).toMatchObject({
    generator: "groq_selected_template", state: "research_review", basis: "potential_use_case",
    evidence_ids: [factId, corroborationId],
    fact_claim: "City Water approved tester directory lists Cedar Pipe Works.",
  });
  expect(preview.body).toContain(preview.fact_claim);
  expect(preview.body).toContain("If a dedicated website is in your plans");
  expect(preview.body).toContain("Would a short example help?");
  expect(preview.subjects).toEqual([
    "Cedar Pipe: a clearer online home", "A website idea for Cedar Pipe",
  ]);
  const first = buildAISelectedResearchPreview({ ...input, selection: {
    fact_id: factId, cta_variant: "brief_example", subject_variant: "first",
  } }, now);
  expect(first.subjects).toEqual([...preview.subjects].reverse());
  expect(first.body).toContain("Would a brief example be useful?");
  expect(preview.body).not.toMatch(/hello@|\+1555010009|has no website|website absence/i);
  expect(fact.claim).toContain("hello@example.org");
  expect(preview).not.toHaveProperty("contact_id");
  expect(preview).not.toHaveProperty("sender_connection_id");
  expect(preview).not.toHaveProperty("outbox_id");
});

test("AI cannot select another lead's evidence or inject an unsupported claim", () => {
  expect(() => buildAISelectedResearchPreview({ ...input,
    selection: { fact_id: otherFactId, cta_variant: "brief_example", subject_variant: "first" } }, now))
    .toThrow("AI_EVIDENCE_NOT_FOR_LEAD");
  expect(() => buildAISelectedResearchPreview({ ...input,
    selection: { fact_id: factId, cta_variant: "brief_example", subject_variant: "first",
      claim: "Cedar Pipe Works has no website." } }, now)).toThrow();
  expect(() => buildAISelectedResearchPreview({ ...input,
    evidence: [{ ...fact, claim: "City Water lists a different business at 100 Main Street." }, corroboration] }, now))
    .toThrow("PUBLIC_FACT_REVIEW_REQUIRED");
  expect(() => buildAISelectedResearchPreview({ ...input,
    evidence: [fact, { ...corroboration, lead_id: otherLeadId }] }, now))
    .toThrow("INDEPENDENT_IDENTITY_EVIDENCE_REQUIRED");
});
