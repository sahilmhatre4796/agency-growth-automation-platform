import { expect, test } from "vitest";
import {
  leadInput,
  parseCSV,
  previewCSV,
  scoreLead,
  type Evidence,
} from "../packages/shared/crm";
test("50 fictional records import consistently and repeated rows are marked duplicates", () => {
  const csv =
    "business_name,website_url,email\n" +
    Array.from(
      { length: 50 },
      (_, i) =>
        `Fixture ${i},https://fixture${i}.example,owner${i}@example.com`,
    ).join("\n");
  const first = previewCSV(csv);
  expect(first).toHaveLength(50);
  expect(first.every((r) => !r.errors.length && !r.duplicate)).toBe(true);
  expect(
    previewCSV(
      csv,
      first.map((r) => r.input!),
    ).every((r) => r.duplicate),
  ).toBe(true);
});
test("CSV escaping and malformed inputs", () => {
  expect(parseCSV('business_name,city\n"Example, ""Studio""",Delhi')).toEqual([
    ["business_name", "city"],
    ['Example, "Studio"', "Delhi"],
  ]);
  expect(() => parseCSV('"unclosed')).toThrow();
  expect(() => previewCSV("email,email\nx,x")).toThrow();
  expect(
    previewCSV("business_name,email\nX,nope")[0].errors.length,
  ).toBeGreaterThan(0);
  expect(
    leadInput.safeParse({
      business_name: "Fixture",
      website_url: "javascript:alert(1)",
    }).success,
  ).toBe(false);
});
test("intake keeps sourced location and distinct public contact fields without accepting guessed addresses", () => {
  const input = previewCSV("business_name,country,state_region,city,source_url,additional_emails,phones\nSynthetic Jeweler,United States,Nevada,Reno,https://fixture.example/contact,hello@fixture.example,+1555010013")[0].input!;
  expect(input).toMatchObject({ country: "United States", state_region: "Nevada", city: "Reno",
    source_url: "https://fixture.example/contact", additional_emails: "hello@fixture.example", phones: "+1555010013" });
  expect(leadInput.safeParse({ business_name: "Fixture", additional_emails: "guessed-at-example" }).success).toBe(false);
  expect(leadInput.safeParse({ business_name: "Fixture", phones: "7755550123" }).success).toBe(false);
});
test("no evidence means no inferred intent or invented score", () => {
  expect(scoreLead([])).toMatchObject({
    score: 0,
    confidence: 0,
    human_review_required: true,
  });
});
test("only reviewed recent source evidence counts, old website never implies intent", () => {
  const e: Evidence = {
    id: "e1",
    claim: "Observed website metadata",
    source_url: "https://example.org",
    observed_at: new Date().toISOString(),
    confidence: 0.9,
    reviewed: true,
    kind: "observation",
  };
  expect(scoreLead([e])).toMatchObject({
    score: 20,
    human_review_required: true,
  });
  expect(scoreLead([{ ...e, reviewed: false }]).score).toBe(0);
  expect(scoreLead([{ ...e, observed_at: "2000-01-01" }]).score).toBe(0);
  expect(scoreLead([{ ...e, observed_at: "2100-01-01" }]).score).toBe(0);
  expect(scoreLead([{ ...e, kind: "intent" }]).breakdown.intent).toBe(30);
});
