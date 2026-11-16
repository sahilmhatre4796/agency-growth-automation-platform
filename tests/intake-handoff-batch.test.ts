import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchWorker } from "../scripts/intake-handoff-batch-worker.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// Minimal fake Supabase client matching the methods used by the batch worker.
// Every chainable method returns the mock object itself; select() returns table rows.
type FakeRpcResult = { data: unknown; error: { code?: string; message: string } | null };

const makeFakeDb = () => {
  const rpcResults = new Map<string, FakeRpcResult>([
    ["reclaim_expired_intake_handoff_leases", { data: [], error: null }],
    ["reclaim_expired_intake_handoff_preview_leases", { data: [], error: null }],
    ["claim_intake_handoff_queue_rows", { data: [], error: null }],
    ["claim_intake_handoff_preview_idempotent", { data: [], error: null }],
    ["complete_intake_handoff_queue_row", { data: null, error: null }],
    ["manual_review_intake_handoff_queue_row", { data: null, error: null }],
    ["fail_intake_handoff_queue_row", { data: null, error: null }],
    ["finalize_intake_handoff_preview", { data: null, error: null }],
  ]);
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const fromTables = new Map<string, Record<string, unknown>[]>();

  const rpc = vi.fn((name: string, args: unknown): FakeRpcResult => {
    rpcCalls.push({ name, args });
    const result = rpcResults.get(name);
    if (result === undefined) return { data: null, error: { code: "UNKNOWN_RPC", message: `Unknown RPC: ${name}` } };
    return result;
  });

  const chainMock = (rows: Record<string, unknown>[]) => {
    const obj: Record<string, unknown> = {
      select: vi.fn(() => chainMock(rows)),
      eq: vi.fn().mockImplementation((col: string, val: unknown) =>
        chainMock(rows.filter((r) => r[col] === val))),
      not: vi.fn().mockImplementation((col: string, op: string, val: unknown) =>
        chainMock(rows.filter((r) => r[col] !== val))),
      lte: vi.fn().mockImplementation((col: string, val: unknown) =>
        chainMock(rows.filter((r) => {
          const v = r[col];
          return v !== null && v !== undefined && String(v) <= String(val);
        }))),
      lt: vi.fn().mockImplementation((col: string, val: unknown) =>
        chainMock(rows.filter((r) => {
          const v = r[col];
          return v !== null && v !== undefined && String(v) < String(val);
        }))),
      is: vi.fn().mockImplementation((col: string, val: unknown) =>
        chainMock(rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val)))),
      order: vi.fn(() => chainMock(rows)),
      limit: vi.fn(() => chainMock(rows)),
      maybeSingle: vi.fn().mockReturnValue({ data: rows[0] ?? null, error: null }),
      single: vi.fn().mockReturnValue({ data: rows[0] ?? null, error: null }),
      insert: vi.fn(() => chainMock([])),
      update: vi.fn(() => chainMock([])),
      or: vi.fn(() => chainMock(rows)),
      then: vi.fn((resolve: (value: { data: Record<string, unknown>[] | null; error: { code?: string; message: string } | null }) => void) =>
        resolve({ data: rows, error: null })),
    };
    return obj;
  };

  const from = vi.fn((table: string) => {
    const rows = fromTables.get(table) ?? [];
    return chainMock(rows);
  });

  return {
    rpc,
    from,
    rpcCalls,
    setRpcResult: (name: string, result: FakeRpcResult) => rpcResults.set(name, result),
    setTableRows: (table: string, rows: Record<string, unknown>[]) => fromTables.set(table, rows),
    getRpcCalls: () => rpcCalls,
  };
};

const envBackup = { ...process.env };
const originalFetchBackup = globalThis.fetch;

// Fixtures whose planIntakeHandoff action is "request_preview_handoff"
// (evidence present + no official website assessment), plus the claimed queue row.
const seedPreviewFixtures = (db: ReturnType<typeof makeFakeDb>) => {
  db.setTableRows("leads", [{ id: "11111111-1111-4111-8111-111111111111", org_id: "org1", business_name: "Test", website_url: null, country: "US", is_demo: false, status: "new" }]);
  db.setTableRows("lead_evidence", [
    { org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", source_url: "https://yellowpages.example.com/listing", rejected_by: null },
    { org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", source_url: "https://chamber.example.org/profile", rejected_by: null },
  ]);
  db.setTableRows("lead_service_matches", []);
  db.setTableRows("service_catalog", [{ org_id: "org1", id: "s1", service_key: "service_01" }]);
  db.setTableRows("lead_website_assessments", [
    { org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", status: "NO_OFFICIAL_WEBSITE_DISCOVERED", official_url: null, observed_at: new Date().toISOString() },
  ]);
  db.setTableRows("website_audit_observations", []);
  db.setTableRows("lead_discovery_sources", []);
  db.setTableRows("vibe_contact_points", []);
  db.setTableRows("tasks", []);
  db.setTableRows("lead_intake_handoff_queue", [
    { id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", state: "claimed", attempt_count: 0, next_retry_at: null, claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z" },
  ]);
};

beforeEach(() => {
  process.env.ENABLE_INTAKE_HANDOFF_BATCH = "true";
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.INTERNAL_CRON_SECRET = "s".repeat(40);
});

afterEach(() => {
  process.env = { ...envBackup };
});

describe("createBatchWorker", () => {
  test("claims and processes one pending row per org", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "qualification", claim_token: "t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null,
    });
    db.setTableRows("leads", [{ id: "11111111-1111-4111-8111-111111111111", org_id: "org1", business_name: "Test", website_url: null, country: "US", is_demo: false, status: "new" }]);
    db.setTableRows("lead_evidence", []);
    db.setTableRows("lead_service_matches", []);
    db.setTableRows("service_catalog", [{ id: "s1", service_key: "service_01" }]);
    db.setTableRows("lead_website_assessments", []);
    db.setTableRows("website_audit_observations", []);
    db.setTableRows("lead_discovery_sources", []);
    db.setTableRows("vibe_contact_points", []);
    db.setTableRows("tasks", []);
    db.setTableRows("lead_intake_handoff_queue", [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "qualification", state: "pending", attempt_count: 0, next_retry_at: null, claim_token: null, lease_until: null }]);

    const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
    await processBatch();

    const claimCalls = db.getRpcCalls().filter((c) => c.name === "claim_intake_handoff_queue_rows");
    expect(claimCalls).toHaveLength(1);
    const terminalCalls = db.getRpcCalls().filter((c) =>
      c.name === "complete_intake_handoff_queue_row" || c.name === "manual_review_intake_handoff_queue_row");
    expect(terminalCalls).toHaveLength(1);
  });

  test("reclaims expired leases atomically with fresh token", async () => {
    const db = makeFakeDb();
    db.setRpcResult("reclaim_expired_intake_handoff_leases", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "qualification", claim_token: "t-fresh", lease_until: "2026-01-02T00:00:00Z", attempt_count: 0 }],
      error: null,
    });
    db.setRpcResult("claim_intake_handoff_queue_rows", { data: [], error: null });
    db.setTableRows("leads", [{ id: "11111111-1111-4111-8111-111111111111", org_id: "org1", business_name: "Test", website_url: null, country: "US", is_demo: false, status: "new" }]);
    db.setTableRows("lead_evidence", []);
    db.setTableRows("lead_service_matches", []);
    db.setTableRows("service_catalog", [{ id: "s1", service_key: "service_01" }]);
    db.setTableRows("lead_website_assessments", []);
    db.setTableRows("website_audit_observations", []);
    db.setTableRows("lead_discovery_sources", []);
    db.setTableRows("vibe_contact_points", []);
    db.setTableRows("tasks", []);
    db.setTableRows("lead_intake_handoff_queue", [
      { id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "qualification", state: "pending", attempt_count: 0, next_retry_at: null, claim_token: null, lease_until: null },
      { id: "r2", org_id: "org1", lead_id: "lead2", stage: "qualification", state: "claimed", attempt_count: 0, next_retry_at: "2026-01-01T00:00:00Z", claim_token: "old-token", lease_until: "2026-01-01T00:00:00Z" },
    ]);

    const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
    await processBatch();

    const reclaimCalls = db.getRpcCalls().filter((c) => c.name === "reclaim_expired_intake_handoff_leases");
    expect(reclaimCalls).toHaveLength(1);
  });

  test("fresh idempotency claim proceeds to preview and finalizes with the idempotency token", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null,
    });
    // Real SQL contract: the claim RPC returns a row ONLY on fresh INSERT.
    db.setRpcResult("claim_intake_handoff_preview_idempotent", {
      data: [{ org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", claim_token: "idem-t2", lease_until: "2026-01-01T00:00:00Z", status: "processing", preview_id: null, result: null }],
      error: null,
    });
    // finalize must report a real update (boolean true) for the queue to complete.
    db.setRpcResult("finalize_intake_handoff_preview", { data: true, error: null });
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const finalizeCalls = db.getRpcCalls().filter((c) => c.name === "finalize_intake_handoff_preview");
    expect(finalizeCalls).toHaveLength(1);
    // B3: the idempotency claim's own token, never the queue lease token.
    expect(finalizeCalls[0].args).toMatchObject({ p_claim_token: "idem-t2" });
    const completeCalls = db.getRpcCalls().filter((c) => c.name === "complete_intake_handoff_queue_row");
    expect(completeCalls).toHaveLength(1);
    const failCalls = db.getRpcCalls().filter((c) => c.name === "fail_intake_handoff_queue_row");
    expect(failCalls).toHaveLength(0);
  });

  test("existing completed idempotency row completes queue without preview", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null,
    });
    // Empty claim result (conflict) — NOT a completed marker.
    db.setRpcResult("claim_intake_handoff_preview_idempotent", { data: [], error: null });
    db.setTableRows("intake_handoff_preview_idempotent", [{
      org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", operation: "intake_handoff_preview",
      status: "completed", lease_until: "2026-01-01T00:00:00Z",
    }]);
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getRpcCalls().filter((c) => c.name === "finalize_intake_handoff_preview")).toHaveLength(0);
    expect(db.getRpcCalls().filter((c) => c.name === "complete_intake_handoff_queue_row")).toHaveLength(1);
    expect(db.getRpcCalls().filter((c) => c.name === "fail_intake_handoff_queue_row")).toHaveLength(0);
  });

  test("active processing idempotency lease leaves queue row for later recovery", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null,
    });
    db.setRpcResult("claim_intake_handoff_preview_idempotent", { data: [], error: null });
    db.setTableRows("intake_handoff_preview_idempotent", [{
      org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", operation: "intake_handoff_preview",
      status: "processing", lease_until: new Date(Date.now() + 60000).toISOString(),
    }]);
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    // Another worker owns the preview: no completion, no failure, no finalize.
    expect(fetchSpy).not.toHaveBeenCalled();
    const terminal = db.getRpcCalls().filter((c) =>
      c.name === "complete_intake_handoff_queue_row" || c.name === "fail_intake_handoff_queue_row" ||
      c.name === "manual_review_intake_handoff_queue_row" || c.name === "finalize_intake_handoff_preview");
    expect(terminal).toHaveLength(0);
  });

  test("expired preview lease reclaimed this batch is used to run the preview", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null });
    db.setRpcResult("claim_intake_handoff_preview_idempotent", { data: [], error: null });
    // Crash between claim and finalize left an expired processing lease; the
    // batch recovery path reclaimed it with a fresh token.
    db.setRpcResult("reclaim_expired_intake_handoff_preview_leases", {
      data: [{ org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", claim_token: "reclaimed-t9", lease_until: "2026-01-01T00:10:00Z" }],
      error: null });
    db.setRpcResult("finalize_intake_handoff_preview", { data: true, error: null });
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const finalizeCalls = db.getRpcCalls().filter((c) => c.name === "finalize_intake_handoff_preview");
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0].args).toMatchObject({ p_claim_token: "reclaimed-t9" });
    expect(db.getRpcCalls().filter((c) => c.name === "complete_intake_handoff_queue_row")).toHaveLength(1);
  });

  test("stale finalize token fails queue row instead of completing it", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 1 }],
      error: null });
    db.setRpcResult("claim_intake_handoff_preview_idempotent", {
      data: [{ org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", claim_token: "idem-t2", lease_until: "2026-01-01T00:00:00Z", status: "processing", preview_id: null, result: null }],
      error: null });
    // Lease was reclaimed elsewhere: finalize is a zero-row no-op (false).
    db.setRpcResult("finalize_intake_handoff_preview", { data: false, error: null });
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    expect(db.getRpcCalls().filter((c) => c.name === "finalize_intake_handoff_preview")).toHaveLength(1);
    expect(db.getRpcCalls().filter((c) => c.name === "complete_intake_handoff_queue_row")).toHaveLength(0);
    const failCalls = db.getRpcCalls().filter((c) => c.name === "fail_intake_handoff_queue_row");
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0].args).toMatchObject({ p_attempt_count: 2 });
  });

  test("disabled preview service routes to manual review, not completion", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null });
    db.setRpcResult("claim_intake_handoff_preview_idempotent", {
      data: [{ org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", claim_token: "idem-t2", lease_until: "2026-01-01T00:00:00Z", status: "processing", preview_id: null, result: null }],
      error: null });
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: "RESEARCH_PREVIEW_JOBS_DISABLED" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    expect(db.getRpcCalls().filter((c) => c.name === "manual_review_intake_handoff_queue_row")).toHaveLength(1);
    expect(db.getRpcCalls().filter((c) => c.name === "complete_intake_handoff_queue_row")).toHaveLength(0);
    expect(db.getRpcCalls().filter((c) => c.name === "fail_intake_handoff_queue_row")).toHaveLength(0);
  });

  test("unconfigured preview secret routes to manual review, not completion", async () => {
    delete process.env.INTERNAL_CRON_SECRET;
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "queue-t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null });
    db.setRpcResult("claim_intake_handoff_preview_idempotent", {
      data: [{ org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", claim_token: "idem-t2", lease_until: "2026-01-01T00:00:00Z", status: "processing", preview_id: null, result: null }],
      error: null });
    seedPreviewFixtures(db);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
      await processBatch();
    } finally {
      globalThis.fetch = originalFetchBackup;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getRpcCalls().filter((c) => c.name === "manual_review_intake_handoff_queue_row")).toHaveLength(1);
    expect(db.getRpcCalls().filter((c) => c.name === "complete_intake_handoff_queue_row")).toHaveLength(0);
  });

  test("scans claims per org", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "qualification", claim_token: "t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 0 }],
      error: null,
    });
    db.setTableRows("leads", [{ id: "11111111-1111-4111-8111-111111111111", org_id: "org1", business_name: "Test", website_url: null, country: "US", is_demo: false, status: "new" }]);
    db.setTableRows("lead_evidence", []);
    db.setTableRows("lead_service_matches", []);
    db.setTableRows("service_catalog", [{ id: "s1", service_key: "service_01" }]);
    db.setTableRows("lead_website_assessments", []);
    db.setTableRows("website_audit_observations", []);
    db.setTableRows("lead_discovery_sources", []);
    db.setTableRows("vibe_contact_points", []);
    db.setTableRows("tasks", []);
    db.setTableRows("lead_intake_handoff_queue", [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "qualification", state: "pending", attempt_count: 0, next_retry_at: null, claim_token: null, lease_until: null }]);

    const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
    await processBatch();

    const claimCalls = db.getRpcCalls().filter((c) => c.name === "claim_intake_handoff_queue_rows");
    expect(claimCalls[0].args).toMatchObject({ p_org_id: "org1" });
  });

  test("fails row with backoff after max attempts", async () => {
    const db = makeFakeDb();
    db.setRpcResult("claim_intake_handoff_queue_rows", {
      data: [{ id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", claim_token: "t1", lease_until: "2026-01-01T00:00:00Z", attempt_count: 2 }],
      error: null,
    });
    db.setTableRows("leads", [{ id: "11111111-1111-4111-8111-111111111111", org_id: "org1", business_name: "Test", website_url: null, country: "US", is_demo: false, status: "new" }]);
    db.setTableRows("lead_evidence", [
      { org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", source_url: "https://yellowpages.example.com/listing", rejected_by: null },
      { org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", source_url: "https://chamber.example.org/profile", rejected_by: null },
    ]);
    db.setTableRows("lead_service_matches", []);
    db.setTableRows("service_catalog", [{ org_id: "org1", id: "s1", service_key: "service_01" }]);
    db.setTableRows("lead_website_assessments", [
      { org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", status: "NO_OFFICIAL_WEBSITE_DISCOVERED", official_url: null, observed_at: new Date().toISOString() },
    ]);
    db.setTableRows("website_audit_observations", []);
    db.setTableRows("lead_discovery_sources", []);
    db.setTableRows("vibe_contact_points", []);
    db.setTableRows("tasks", []);
    db.setTableRows("lead_intake_handoff_queue", [
      { id: "r0", org_id: "org1", lead_id: "lead0", stage: "qualification", state: "pending", attempt_count: 0, next_retry_at: null, claim_token: null, lease_until: null },
      { id: "r1", org_id: "org1", lead_id: "11111111-1111-4111-8111-111111111111", stage: "preview", state: "claimed", attempt_count: 2, next_retry_at: null, claim_token: "t1", lease_until: "2026-01-01T00:00:00Z" },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("preview down")) as unknown as typeof fetch;

    const { processBatch } = createBatchWorker(db as unknown as SupabaseClient);
    await processBatch();

    globalThis.fetch = originalFetch;

    const failCalls = db.getRpcCalls().filter((c) => c.name === "fail_intake_handoff_queue_row");
    expect(failCalls).toHaveLength(1);
    // attempt_count 2 + 1 = 3 >= MAX_ATTEMPTS (3), so next_retry_at should be null (terminal)
    const failArgs = failCalls[0].args as { p_next_retry_at: string | null; p_attempt_count: number };
    expect(failArgs.p_next_retry_at).toBeNull();
    expect(failArgs.p_attempt_count).toBe(3);
  });
});
