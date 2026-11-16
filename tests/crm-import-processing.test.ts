import { beforeEach, expect, test, vi } from "vitest";
import { leadInput } from "../packages/shared/crm";

const state = vi.hoisted(() => ({
  ids: [] as string[],
  calls: [] as string[][],
  workerFails: false,
}));
vi.mock("../apps/web/lib/supabase", () => ({
  supabase: {
    rpc: async (name: string, args: { p_org: string; p_rows: unknown[] }) => {
      if (name !== "import_leads" || args.p_org !== "owner-org") throw new Error("wrong intake target");
      return { data: { added: state.ids.length, skipped: args.p_rows.length - state.ids.length,
        created_lead_ids: state.ids }, error: null };
    },
    functions: {
      invoke: async (name: string, args: { body: { lead_ids: string[] } }) => {
        if (name !== "research-preview-jobs") throw new Error("wrong worker");
        state.calls.push(args.body.lead_ids);
        return { error: state.workerFails ? { message: "unavailable" } : null };
      },
    },
  },
}));

import { crmStore } from "../apps/web/lib/crm-store";
const row = leadInput.parse({ business_name: "Synthetic Business", source_url: "https://example.invalid/listing" });
beforeEach(() => { state.ids = []; state.calls = []; state.workerFails = false; });

test("new intake automatically invokes existing worker in bounded chunks", async () => {
  state.ids = Array.from({ length: 11 }, (_, i) => `lead-${i}`);
  const result = await crmStore(false, "owner-org").import(Array.from({ length: 11 }, () => row));
  expect(result.processing_attempted).toBe(11);
  expect(state.calls).toEqual([state.ids.slice(0, 10), state.ids.slice(10)]);
});

test("duplicate imports do not retrigger work; worker failure does not undo durable intake", async () => {
  await expect(crmStore(false, "owner-org").import([row])).resolves.toMatchObject({
    added: 0, processing_attempted: 0,
  });
  expect(state.calls).toEqual([]);
  state.ids = ["lead-0"];
  state.workerFails = true;
  await expect(crmStore(false, "owner-org").import([row])).resolves.toMatchObject({
    added: 1, processing_attempted: 0,
  });
  expect(state.calls).toEqual([["lead-0"]]);
});
