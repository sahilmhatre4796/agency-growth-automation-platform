import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ selection: "" }));
vi.mock("../apps/web/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "leads") throw new Error(`Unexpected table ${table}`);
      const builder = {
        select: (selection: string) => { state.selection = selection; return builder; },
        eq: () => builder,
        order: () => builder,
        limit: async () => ({
          data: [{ id: "lead-a", business_name: "Synthetic Studio", contacts: [{ email: null }, { email: "test@example.invalid" }] }],
          error: state.selection.includes("contacts!contacts_org_id_lead_id_fkey") ? null : { message: "Ambiguous relationship" },
        }),
      };
      return builder;
    },
  },
}));
import { crmStore } from "../apps/web/lib/crm-store";

test("live CRM directory specifies the tenant-bound contact relationship", async () => {
  const rows = await crmStore(false, "synthetic-org").list();
  expect(state.selection).toContain("contacts!contacts_org_id_lead_id_fkey(email)");
  expect(rows).toHaveLength(1);
  expect(rows[0].email).toBe("test@example.invalid");
});
