// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ wrongLeadEvidence: false, samePublisher: false }));

vi.mock("../apps/web/lib/supabase", () => ({ supabase: {
  from(table: string) {
    const observed_at = new Date().toISOString();
    const data: Record<string, unknown> = {
      leads: [{ id: "lead-1", business_name: "Cedar Pipe Works" }],
      contacts: [], business_research_reports: [], business_research_jobs: [],
      organizations: { research_provider: "serper", research_monthly_credit_cap: 0 },
      research_credit_usage: [], vibe_contact_points: [],
      research_draft_previews: [{ id: "preview-1", lead_id: "lead-1", report_id: null,
        service_id: "service-1", subjects: ["A website idea for Cedar", "Cedar Pipe Works: a clearer home"],
        body: "AI_DRAFT_BODY_UNIQUE: City Water approved tester directory lists Cedar Pipe Works. If a dedicated website is in your plans, we could explore a clear place for enquiries.",
        confidence: 0.65, evidence_ids: ["fact-1", "corroboration-1"],
        generator: "groq_selected_template", basis: "potential_use_case",
        fact_claim: "City Water approved tester directory lists Cedar Pipe Works.", created_at: observed_at }],
      lead_evidence: [
        { id: "fact-1", lead_id: "lead-1", claim: "City Water approved tester directory lists Cedar Pipe Works at 100 Main Street.",
          source_url: "https://city.example.org/testers", observed_at, confidence: 0.9, reviewed_by: null, rejected_by: null },
        { id: "corroboration-1", lead_id: fixture.wrongLeadEvidence ? "lead-2" : "lead-1",
          claim: "Utility register lists Cedar Pipe Works as a local tester.",
          source_url: fixture.samePublisher ? "https://police.city.example.org/testers" : "https://utility.example.net/testers",
          observed_at, confidence: 0.8, reviewed_by: null, rejected_by: null },
      ],
      service_catalog: [{ id: "service-1", name: "Business websites", status: "disabled" }],
    };
    if (!(table in data)) throw new Error(`Unexpected table ${table}`);
    const result = () => Promise.resolve({ data: data[table], error: null });
    const query = { select: () => query, eq: () => query, not: () => query,
      order: () => query, limit: result, single: result };
    return query;
  },
} }));

import { BusinessResearch } from "../apps/web/components/business-research";

afterEach(() => { cleanup(); fixture.wrongLeadEvidence = false; fixture.samePublisher = false; });

test("owner sees evidence-grounded Groq-selected copy as an unsendable preview", async () => {
  render(<BusinessResearch demo={false} orgId="org-1" role="admin" initialLeadId="lead-1" onOpenEmail={() => {}} />);
  expect(await screen.findByText(/Groq-selected grounded copy/)).toBeTruthy();
  expect(screen.getByText(/AI_DRAFT_BODY_UNIQUE/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "RESEARCH PREVIEW — NOT APPROVED FOR SENDING" })).toBeTruthy();
  expect(screen.getByText(/City Water approved tester directory lists Cedar Pipe Works at 100 Main Street/)).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Public source" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /approve|send/i })).toBeNull();
});

test("wrong-lead evidence hides the preview body", async () => {
  fixture.wrongLeadEvidence = true;
  render(<BusinessResearch demo={false} orgId="org-1" role="admin" initialLeadId="lead-1" onOpenEmail={() => {}} />);
  expect(await screen.findByRole("status")).toHaveProperty("textContent",
    "Source evidence changed or expired. Review it again before using this preview.");
  expect(screen.queryByText(/AI_DRAFT_BODY_UNIQUE/)).toBeNull();
  expect(screen.getByText(/Evidence not currently available/)).toBeTruthy();
});

test("two pages under one publisher do not display as independent evidence", async () => {
  fixture.samePublisher = true;
  render(<BusinessResearch demo={false} orgId="org-1" role="admin" initialLeadId="lead-1" onOpenEmail={() => {}} />);
  expect(await screen.findByText(/Source evidence changed or expired/)).toBeTruthy();
  expect(screen.queryByText(/AI_DRAFT_BODY_UNIQUE/)).toBeNull();
});
