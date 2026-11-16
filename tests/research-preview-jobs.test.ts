// research-preview-jobs Edge Function tests: real handler, mocked transport.
// Deno is not installed locally, so the handler is imported directly using the
// existing harvey/serper pattern — npm: imports are mocked and Deno.env is
// stubbed by tests/setup.ts. The 5 org_id contract cases run against the real
// request parser, auth, and org-isolation guard; only PostgREST is faked.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { envGetMock } from "./setup.ts";

vi.mock("npm:@supabase/supabase-js@2.118.0", () => ({
  createClient: vi.fn(),
}));

import { createClient as _createClient } from "npm:@supabase/supabase-js@2.118.0";
import { handler } from "../supabase/functions/research-preview-jobs/index.ts";

// The npm: module is vi.mock'd above, so this is the factory's vi.fn().
const createClientMock = _createClient as unknown as Mock;

const SECRET = "internal-cron-secret-0123456789abcdef"; // 38 chars >= 32
const ANON_KEY = "anon-key-for-tests";
const SERVICE_KEY = "service-key-for-tests";
const ORIGIN = "https://app.test";
const orgA = "00000000-0000-4000-8000-000000000601";
const orgB = "00000000-0000-4000-8000-000000000602";
const leadA = "00000000-0000-4000-8000-000000000603";

let queryLog: string[] = [];

// Chainable query builder that records every call and resolves with a fixed
// result (thenable, matching PostgrestBuilder await semantics).
const makeBuilder = (label: string, result: { data: unknown; error: unknown }) => {
  const b: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "gt", "gte", "lt", "lte", "order", "limit", "or", "not"]) {
    b[method] = (...args: unknown[]) => {
      queryLog.push(`${label}.${method}(${args.map((a) => String(a)).join(",")})`);
      return b;
    };
  }
  b.maybeSingle = async () => { queryLog.push(`${label}.maybeSingle`); return result; };
  b.single = async () => result;
  b.then = (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return b;
};

const serviceClient = () => ({
  from: (table: string) => makeBuilder(table, { data: [], error: null }),
  rpc: vi.fn(async () => ({ data: null, error: null })),
});

const ownerClient = (leadRows: Array<{ id: string; org_id: string }>) => ({
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
  from: (table: string) =>
    table === "leads" ? makeBuilder(table, { data: leadRows, error: null })
      : table === "memberships" ? makeBuilder(table, { data: { role: "admin" }, error: null })
      : makeBuilder(table, { data: [], error: null }),
});

const setEnv = (overrides: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    INTERNAL_CRON_SECRET: SECRET,
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SUPABASE_ANON_KEY: ANON_KEY,
    ALLOWED_ORIGIN: ORIGIN,
    ENABLE_RESEARCH_PREVIEW_JOBS: "true",
  };
  envGetMock.mockImplementation((key: string) => ({ ...base, ...overrides })[key]);
};

const post = (body: unknown, headers: Record<string, string> = {}): Request =>
  ({ method: "POST", headers: new Headers({ "content-type": "application/json", ...headers }),
    json: async () => body }) as unknown as Request;

beforeEach(() => {
  queryLog = [];
  createClientMock.mockReset();
  setEnv();
});

describe("research-preview-jobs org_id contract", () => {
  it("accepts a valid internal request with org_id and scopes the report query to it", async () => {
    createClientMock.mockImplementation(() => serviceClient());
    const res = await handler(post({ lead_ids: [leadA], org_id: orgA }, { "X-Cron-Signature": SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.lead_results)).toBe(true);
    expect(queryLog).toContain(`business_research_reports.eq(org_id,${orgA})`);
    // Internal callers never build an owner-scoped client.
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a non-internal request whose org_id matches the leads' owning org", async () => {
    createClientMock.mockImplementation((url: string, key: string) =>
      key === ANON_KEY ? ownerClient([{ id: leadA, org_id: orgA }]) : serviceClient());
    const res = await handler(post({ lead_ids: [leadA], org_id: orgA }, {
      Origin: ORIGIN, Authorization: "Bearer user-token",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.lead_results)).toBe(true);
    expect(queryLog).toContain(`leads.in(id,${leadA})`);
    expect(queryLog).toContain(`memberships.eq(org_id,${orgA})`);
    expect(queryLog).toContain(`business_research_reports.eq(org_id,${orgA})`);
  });

  it("returns 403 when a non-internal org_id does not match the leads' owning org", async () => {
    createClientMock.mockImplementation((url: string, key: string) =>
      key === ANON_KEY ? ownerClient([{ id: leadA, org_id: orgA }]) : serviceClient());
    const res = await handler(post({ lead_ids: [leadA], org_id: orgB }, {
      Origin: ORIGIN, Authorization: "Bearer user-token",
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "LEAD_SCOPE_DENIED" });
    // Denied before any report or preview query runs.
    expect(queryLog.some((entry) => entry.startsWith("business_research_reports"))).toBe(false);
    expect(queryLog.some((entry) => entry.startsWith("intake_handoff_preview_idempotent"))).toBe(false);
  });

  it("returns 400 for a malformed org_id before any client is built", async () => {
    const res = await handler(post({ lead_ids: [leadA], org_id: "not-a-uuid" }, { "X-Cron-Signature": SECRET }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("keeps org_id-less requests unchanged: no lead_results and no idempotency query", async () => {
    createClientMock.mockImplementation(() => serviceClient());
    const res = await handler(post({ lead_ids: [leadA] }, { "X-Cron-Signature": SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect("lead_results" in body).toBe(false);
    expect(queryLog.some((entry) => entry.includes("intake_handoff_preview_idempotent"))).toBe(false);
    expect(queryLog.some((entry) => entry.startsWith("business_research_reports.eq(org_id"))).toBe(false);
  });
});
