import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ errorTable: "", filters: [] as Array<[string, string, string]> }));
vi.mock("../apps/web/lib/supabase", () => ({
  supabase: {
    from(table: string) {
      const data: Record<string, unknown[]> = {
        contacts: [], lead_evidence: [], lead_notes: [], tasks: [], lead_scores: [],
        audit_events: [], lead_score_overrides: [],
        vibe_contact_points: [
          { id: "point-1", kind: "email", display_value: "hello@example.invalid", review_status: "pending" },
          { id: "point-2", kind: "phone", display_value: "+91 9999999999", review_status: "rejected" },
        ],
        vibe_contact_sources: [{ point_id: "point-1", source_url: "https://business.example/contact", source_provider: "official_website" }],
        lead_website_assessments: [{ status: "UNKNOWN", official_url: null, reason: "Official site not established", observed_at: "2026-10-26T00:00:00Z" }],
      };
      if (!(table in data)) throw new Error(`Unexpected table ${table}`);
      const result = () => ({ data: data[table], error: state.errorTable === table ? { message: "denied" } : null });
      const builder = { select: () => builder, eq: (field: string, value: string) => { state.filters.push([table, field, value]); return builder; }, order: () => builder, limit: () => builder,
        then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve) };
      return builder;
    },
  },
}));

import { crmStore } from "../apps/web/lib/crm-store";
beforeEach(() => { state.errorTable = ""; state.filters = []; });

test("CRM detail keeps public contact observations separate from reviewed contacts", async () => {
  const detail = await crmStore(false, "synthetic-org").detail("lead-a");
  expect(detail.contacts).toEqual([]);
  expect(detail.publicContacts).toMatchObject([
    { id: "point-1", review_status: "pending" },
    { id: "point-2", review_status: "rejected" },
  ]);
  expect(detail.publicContactSources).toEqual([
    { point_id: "point-1", source_url: "https://business.example/contact", source_provider: "official_website" },
  ]);
  expect(detail.websiteAssessment).toMatchObject({ status: "UNKNOWN", reason: "Official site not established" });
  expect(state.filters).toContainEqual(["lead_website_assessments", "org_id", "synthetic-org"]);
  expect(state.filters).toContainEqual(["lead_website_assessments", "lead_id", "lead-a"]);
});

test("CRM detail fails closed when public contact evidence cannot be read", async () => {
  state.errorTable = "vibe_contact_sources";
  await expect(crmStore(false, "synthetic-org").detail("lead-a"))
    .rejects.toThrow("Check permissions and connection");
});

test("CRM detail fails closed when the saved website assessment cannot be read", async () => {
  state.errorTable = "lead_website_assessments";
  await expect(crmStore(false, "synthetic-org").detail("lead-a"))
    .rejects.toThrow("Check permissions and connection");
});
