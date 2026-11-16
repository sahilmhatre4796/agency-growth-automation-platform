// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const data = vi.hoisted(() => ({
  vibe_contact_points: [
    { id: "phone", lead_id: "india", kind: "phone", display_value: "+91 99999 00000", review_status: "pending", contact_name: "Synthetic Owner" },
    { id: "email", lead_id: "india", kind: "email", display_value: "hello@synthetic.example", review_status: "approved", contact_name: null },
    { id: "unsupported", lead_id: "india", kind: "phone", display_value: "+91 88888 00000", review_status: "pending", contact_name: null },
  ],
  vibe_contact_sources: [
    { point_id: "phone", source_url: "https://directory.example/synthetic", source_provider: "harvey" },
    { point_id: "email", source_url: "https://synthetic.example/contact", source_provider: "official_website" },
  ],
  lead_service_matches: [{ lead_id: "india", service_id: "website", status: "verified_gap", reason: "Reviewed public website searches", evidence_ids: ["e1"], assessed_at: "2026-10-23T00:00:00Z" }],
  lead_evidence: [{ id: "e1", lead_id: "india", source_url: "https://directory.example/synthetic", reviewed_by: "owner", observed_at: "2026-10-23T00:00:00Z" }],
  service_catalog: [{ id: "website", name: "Business website" }],
  lead_website_assessments: [{ lead_id: "india", status: "NO_OFFICIAL_WEBSITE_DISCOVERED", observed_at: "2026-10-23T00:00:00Z" }],
  lead_qualifications: [{ lead_id: "india", status: "QUALIFIED", evaluated_at: "2026-10-23T00:00:00Z" }],
}));
vi.mock("../apps/web/lib/supabase", () => ({ supabase: { from(table: string) {
  const builder = { select: () => builder, eq: () => builder, in: () => builder, order: () => builder,
    limit: () => Promise.resolve({ data: (data as Record<string, unknown>)[table], error: null }) };
  return builder;
} } }));
import { IndiaManualCallingQueue } from "../apps/web/components/india-manual-calling-queue";
import type { RecordLead } from "../apps/web/lib/crm-store";
import { leadInput } from "../packages/shared/crm";
afterEach(cleanup);

const leads = [
  { ...leadInput.parse({ business_name: "Synthetic Jaipur Workshop", city: "Jaipur" }), id: "india", state_region: "Rajasthan", country: "India", is_demo: false, created_at: "2026-10-23T00:00:00Z", deal_value_paise: null },
  { ...leadInput.parse({ business_name: "Synthetic Austin Workshop", city: "Austin" }), id: "us", country: "United States", is_demo: false, created_at: "2026-10-23T00:00:00Z", deal_value_paise: null },
  { ...leadInput.parse({ business_name: "Rejected Jaipur Search Snippet", city: "Jaipur" }), id: "rejected", country: "India", status: "disqualified", is_demo: false, created_at: "2026-10-23T00:00:00Z", deal_value_paise: null },
] satisfies RecordLead[];

test("owner calling queue preserves sourced Indian contacts and evidence without including overseas leads", async () => {
  render(<IndiaManualCallingQueue demo={false} orgId="synthetic-org" role="admin" leads={leads} onOpenLead={() => {}} />);
  const panel = screen.getByRole("region", { name: "India manual calling queue" });
  expect(await within(panel).findByText("+91 99999 00000 · pending")).toBeTruthy();
  expect(within(panel).getByText("hello@synthetic.example · approved")).toBeTruthy();
  expect(within(panel).getByText("Business website")).toBeTruthy();
  expect(within(panel).getByText("Synthetic Owner")).toBeTruthy();
  expect(within(panel).getAllByRole("link", { name: "Public source" })).toHaveLength(2);
  expect(within(panel).queryByText("+91 88888 00000 · pending")).toBeNull();
  expect(within(panel).queryByText("Synthetic Austin Workshop")).toBeNull();
  expect(within(panel).queryByText("Rejected Jaipur Search Snippet")).toBeNull();
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Has sourced business phone" }));
  expect(within(panel).getByText("Synthetic Jaipur Workshop")).toBeTruthy();
});

test("calling queue never presents an unreviewed service claim as qualified", async () => {
  const previous = data.lead_qualifications[0].status;
  data.lead_qualifications[0].status = "RESEARCH_NEEDED";
  try {
    render(<IndiaManualCallingQueue demo={false} orgId="synthetic-org" role="admin" leads={leads} onOpenLead={() => {}} />);
    expect(await screen.findByText("+91 99999 00000 · pending")).toBeTruthy();
    expect(screen.getByText("Research hold")).toBeTruthy();
    expect(screen.queryByText("Business website")).toBeNull();
  } finally { data.lead_qualifications[0].status = previous; }
});
