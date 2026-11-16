// Phase 44 worker tests: the bounded continuation loop and its HTTP wrapper.
// No network, no database: the worker only dispatches durable pages.
import { describe, expect, it, vi, afterEach } from "vitest";

import { runCampaignContinuation } from "../packages/server/campaign-continuation.ts";
import { createContinuationWorker } from "../scripts/campaign-continuation-worker.ts";

const noSleep = async () => {};

afterEach(() => { vi.unstubAllGlobals(); });

describe("runCampaignContinuation", () => {
  it("stops when the queue is idle", async () => {
    const step = vi.fn(async () => ({ processed: 0, idle: true }));
    const result = await runCampaignContinuation(step, { maxPages: 5, maxDurationMs: 1000, sleep: noSleep });
    expect(result.stoppedBy).toBe("idle");
    expect(result.pages).toBe(0);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("keeps working while pages are produced and stops at the page cap", async () => {
    let calls = 0;
    const step = vi.fn(async () => {
      calls += 1;
      return { processed: 1, advanced: calls === 1 ? ["campaign-1"] : [] };
    });
    const result = await runCampaignContinuation(step, { maxPages: 3, maxDurationMs: 10_000, sleep: noSleep });
    expect(result.stoppedBy).toBe("page_cap");
    expect(result.pages).toBe(3);
    expect(result.advanced).toEqual(["campaign-1"]);
  });

  it("stops at the deadline without claiming more pages", async () => {
    let now = 0;
    const step = vi.fn(async () => {
      now += 600;
      return { processed: 1 };
    });
    const result = await runCampaignContinuation(step, {
      maxPages: 100, maxDurationMs: 1000, sleep: noSleep, now: () => now,
    });
    expect(result.stoppedBy).toBe("deadline");
    expect(result.pages).toBeLessThan(100);
  });

  it("reports a failing step instead of pretending the batch is done", async () => {
    const step = vi.fn(async () => { throw new Error("CAMPAIGN_CLAIM_FAILED:db down"); });
    const result = await runCampaignContinuation(step, { maxPages: 5, maxDurationMs: 1000, sleep: noSleep });
    expect(result.stoppedBy).toBe("error");
    expect(result.error).toContain("CAMPAIGN_CLAIM_FAILED");
  });
});

describe("campaign continuation worker", () => {
  const secret = "a".repeat(32);
  const url = "https://example.supabase.co";

  it("treats a disabled discovery function as idle rather than a failure", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "DISCOVERY_DISABLED" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createContinuationWorker({ url, secret, sleep: noSleep });
    expect(result.stoppedBy).toBe("idle");
    expect(result.pages).toBe(0);
  });

  it("keeps dispatching pages while the worker answers with work", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      const processed = calls < 3 ? 1 : 0;
      return new Response(JSON.stringify({ processed, completed: processed, campaigns_advanced: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createContinuationWorker({ url, secret, sleep: noSleep });
    expect(result.stoppedBy).toBe("idle");
    expect(result.pages).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ mode: "campaign" }));
  });

  it("fails loudly when the worker function returns an error status", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createContinuationWorker({ url, secret, sleep: noSleep });
    expect(result.stoppedBy).toBe("error");
    expect(result.error).toContain("WORKER_HTTP_401");
  });
});
