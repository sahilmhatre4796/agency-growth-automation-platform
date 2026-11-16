import { describe, expect, test } from "vitest";
import {
  harveyLeadSchema,
  mapHarveyLeadToIntake,
  shouldSubmitToChainCraft,
  submitHarveyLeadToChainCraft,
  type HarveyLead,
  type IntakeRpcPort,
} from "../packages/server/harvey-integration.ts";

const now = "2026-11-04T12:00:00.000Z";

function qualification(over: Partial<HarveyLead["qualification"]> = {}): NonNullable<HarveyLead["qualification"]> {
  return {
    is_genuine_business: true,
    meets_target_criteria: true,
    has_official_website: false,
    website_status: "NO_OFFICIAL_WEBSITE_FOUND",
    recommended_service: "service_01",
    service_reason: "No official website found",
    worth_contacting: true,
    additional_research: [],
    ...over,
  };
}

function lead(over: Partial<HarveyLead> = {}): HarveyLead {
  return {
    provider_record_id: "harvey-rec-1",
    business_name: "Synthetic Plumbing",
    website_url: null,
    city: "Ada",
    state_region: "Idaho",
    country: "USA",
    source_url: "https://osm.example/listing/1",
    observed_at: now,
    evidence: [],
    qualification: qualification(),
    ...over,
  };
}

function rpcPort(result: { state: string; lead_id: string } | null = null, shouldThrow = false): IntakeRpcPort {
  return {
    call: async () => {
      if (shouldThrow) throw new Error("RPC_DOWN");
      return result ?? { state: "created", lead_id: "00000000-0000-4000-8000-000000000071" };
    },
  };
}

describe("harveyLeadSchema", () => {
  test("accepts a valid lead", () => {
    const parsed = harveyLeadSchema.parse(lead());
    expect(parsed.business_name).toBe("Synthetic Plumbing");
    expect(parsed.provider_record_id).toBe("harvey-rec-1");
  });

  test("rejects missing provider_record_id", () => {
    expect(() => harveyLeadSchema.parse({ ...lead(), provider_record_id: "" })).toThrow();
  });

  test("rejects invalid website_url", () => {
    expect(() =>
      harveyLeadSchema.parse({ ...lead(), website_url: "not-a-url" as unknown as string })
    ).toThrow();
  });
});

describe("mapHarveyLeadToIntake", () => {
  test("maps a Harvey lead to the intake RPC call", () => {
    const call = mapHarveyLeadToIntake({
      org_id: "org-1",
      run_id: "run-1",
      lead: lead({ website_url: "https://synthetic-plumbing.example/" }),
    });

    expect(call.p_org).toBe("org-1");
    expect(call.p_run).toBe("run-1");
    expect(call.p_source).toBe("harvey");
    expect(call.p_provider).toBe("harvey_osm");
    expect(call.p_name).toBe("Synthetic Plumbing");
    expect(call.p_website).toBe("https://synthetic-plumbing.example/");
    expect(call.p_city).toBe("Ada");
    expect(call.p_country).toBe("USA");
    expect(call.p_source_url).toBe("https://osm.example/listing/1");
    expect(call.p_provider_record_id).toBe("harvey-rec-1");
  });
});

describe("shouldSubmitToChainCraft", () => {
  test("submits a qualified lead", () => {
    const decision = shouldSubmitToChainCraft(lead());
    expect(decision.submit).toBe(true);
    expect(decision.reason).toBe("Qualified by Harvey");
  });

  test("rejects a non-genuine business", () => {
    const decision = shouldSubmitToChainCraft(
      lead({ qualification: qualification({ is_genuine_business: false }) }),
    );
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe("Not a genuine business");
  });

  test("rejects a business that does not meet target criteria", () => {
    const decision = shouldSubmitToChainCraft(
      lead({ qualification: qualification({ meets_target_criteria: false }) }),
    );
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe("Does not meet target criteria");
  });

  test("rejects a lead not worth contacting", () => {
    const decision = shouldSubmitToChainCraft(
      lead({ qualification: qualification({ worth_contacting: false }) }),
    );
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe("Not worth contacting");
  });

  test("rejects a lead with no qualification", () => {
    const decision = shouldSubmitToChainCraft(
      lead({ qualification: undefined }),
    );
    expect(decision.submit).toBe(false);
    expect(decision.reason).toBe("No qualification decision from Harvey");
  });
});

describe("submitHarveyLeadToChainCraft", () => {
  test("submits a qualified lead and returns the lead id", async () => {
    const result = await submitHarveyLeadToChainCraft({
      org_id: "org-1",
      run_id: "run-1",
      lead: lead(),
      rpc: rpcPort({ state: "created", lead_id: "lead-1" }),
    });

    expect(result.submitted).toBe(true);
    expect(result.lead_id).toBe("lead-1");
    expect(result.reason).toBe("submitted");
  });

  test("does not submit an unqualified lead", async () => {
    const rpc = rpcPort(null, true); // should never be called
    const result = await submitHarveyLeadToChainCraft({
      org_id: "org-1",
      run_id: "run-1",
      lead: lead({ qualification: undefined }),
      rpc,
    });

    expect(result.submitted).toBe(false);
    expect(result.reason).toBe("No qualification decision from Harvey");
  });

  test("fails closed when the intake RPC is unavailable", async () => {
    const result = await submitHarveyLeadToChainCraft({
      org_id: "org-1",
      run_id: "run-1",
      lead: lead(),
      rpc: rpcPort(null, true),
    });

    expect(result.submitted).toBe(false);
    expect(result.reason).toContain("intake_rpc_failed");
  });
});
