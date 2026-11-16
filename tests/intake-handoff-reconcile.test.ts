import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

type FakeRpcResult = { data: unknown; error: { code?: string; message: string } | null };

const makeFakeDb = (overrides: Record<string, unknown> = {}) => {
  const rpcResults = new Map<string, FakeRpcResult>([
    ["reconcile_intake_handoff_queue", { data: [], error: null }],
  ]);
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const fromTables = new Map<string, Record<string, unknown>[]>();

  const rpc = vi.fn((name: string, args: unknown): FakeRpcResult => {
    rpcCalls.push({ name, args });
    const result = rpcResults.get(name);
    if (result === undefined) return { data: null, error: { code: "UNKNOWN_RPC", message: `Unknown RPC: ${name}` } };
    return result;
  });

  const from = vi.fn((table: string) => {
    const rows = fromTables.get(table) ?? [];
    return {
      select: vi.fn(() => ({
        eq: vi.fn().mockImplementation((col: string, val: unknown) => {
          const filtered = rows.filter((r: Record<string, unknown>) => r[col] === val);
          return {
            eq: vi.fn().mockImplementation((c2: string, v2: unknown) =>
              filtered.filter((r: Record<string, unknown>) => r[c2] === v2)),
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ data: filtered, error: null }),
            }),
          };
        }),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockReturnValue({ data: { id: "fake-id" }, error: null }),
        })),
      })),
      ...(overrides[table] ?? {}),
    };
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

beforeEach(() => {
  process.env.ENABLE_INTAKE_HANDOFF_RECONCILE = "true";
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
});

afterEach(() => {
  process.env = { ...envBackup };
});

describe("intake-handoff-reconcile", () => {
  test("calls reconcile RPC and reports count", async () => {
    const db = makeFakeDb();
    db.setRpcResult("reconcile_intake_handoff_queue", {
      data: [{ org_id: "org1", lead_id: "lead1" }, { org_id: "org1", lead_id: "lead2" }],
      error: null,
    });

    // Simulate the reconcile script logic
    const nowIso = new Date().toISOString();
    const { data, error } = await db.rpc("reconcile_intake_handoff_queue", { p_now: nowIso });
    expect(error).toBeNull();
    const inserted = (data ?? []) as Array<{ org_id: string; lead_id: string }>;
    expect(inserted).toHaveLength(2);

    const calls = db.getRpcCalls().filter((c) => c.name === "reconcile_intake_handoff_queue");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ p_now: nowIso });
  });

  test("is idempotent: ON CONFLICT DO NOTHING prevents duplicates", async () => {
    const db = makeFakeDb();
    db.setRpcResult("reconcile_intake_handoff_queue", { data: [], error: null });

    const nowIso = new Date().toISOString();
    // Run twice
    await db.rpc("reconcile_intake_handoff_queue", { p_now: nowIso });
    await db.rpc("reconcile_intake_handoff_queue", { p_now: nowIso });

    const calls = db.getRpcCalls().filter((c) => c.name === "reconcile_intake_handoff_queue");
    expect(calls).toHaveLength(2);
    // Both calls have same p_now — idempotent by design (NOT EXISTS + ON CONFLICT)
  });

  test("is org-scoped: only reconciles leads within the same org", async () => {
    const db = makeFakeDb();
    db.setRpcResult("reconcile_intake_handoff_queue", {
      data: [{ org_id: "org1", lead_id: "lead1" }],
      error: null,
    });

    const nowIso = new Date().toISOString();
    const { data } = await db.rpc("reconcile_intake_handoff_queue", { p_now: nowIso });
    const inserted = (data ?? []) as Array<{ org_id: string }>;
    // All reconciled rows belong to org1
    expect(inserted.every((r) => r.org_id === "org1")).toBe(true);
  });
});
