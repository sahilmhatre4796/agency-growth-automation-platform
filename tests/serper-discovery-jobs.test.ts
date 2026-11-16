// Serper discovery Edge Function tests (mocked, no live APIs).
// Tests the exported handler: auth, flag gates, lease, processing, finish.
// All external dependencies are mocked; no Serper API calls are made.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { envGetMock } from "./setup.ts";

import {
  discoverSerperSearchCandidates,
  discoverSerperCandidates,
  discoverySearchLane,
} from "../packages/server/discovery.ts";
import { boundedBody } from "../packages/server/requests.ts";

vi.mock("../packages/server/discovery.ts", () => ({
  discoverSerperSearchCandidates: vi.fn(),
  discoverSerperCandidates: vi.fn(),
  discoverySearchLane: vi.fn(),
  newDiscoveryFilterDiagnostics: vi.fn(() => ({
    raw_results: 0, name_rejected: 0, education_rejected: 0, unsafe_url_rejected: 0,
    snippet_rejected: 0, identity_rejected: 0, duplicate_rejected: 0, accepted: 0,
  })),
}));

vi.mock("../packages/server/research.ts", () => ({
  SerperSearchAdapter: vi.fn(),
}));

vi.mock("../packages/server/requests.ts", () => ({
  boundedBody: vi.fn(),
}));

// Mock the Supabase client used by the edge function (same specifier as edge function code)
vi.mock("npm:@supabase/supabase-js@2.118.0", () => ({
  createClient: vi.fn(),
}));

// Import createClient from the same specifier used in the edge function
import { createClient as _createClient } from "npm:@supabase/supabase-js@2.118.0";
const createClientMock = _createClient as unknown as Mock;
const rpcMock = vi.fn();
const boundedBodyMock = vi.mocked(boundedBody);
const discoverSerperSearchCandidatesMock = vi.mocked(discoverSerperSearchCandidates);
const discoverSerperCandidatesMock = vi.mocked(discoverSerperCandidates);
const discoverySearchLaneMock = vi.mocked(discoverySearchLane);

import { handler } from "../supabase/functions/serper-discovery-jobs/index.ts";

function makeRequest(method = "POST", body = {}, headers: Record<string, string> = {}): Request {
  return {
    method,
    body: JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json", ...headers }),
  } as unknown as Request;
}

function setEnv(vars: Record<string, string>) {
  envGetMock.mockImplementation((key: string) => vars[key] ?? null);
}

beforeEach(() => {
  vi.mocked(rpcMock).mockClear();
  vi.mocked(boundedBodyMock).mockClear();
  vi.mocked(createClientMock).mockClear();
  vi.mocked(discoverSerperSearchCandidatesMock).mockClear();
  vi.mocked(discoverSerperCandidatesMock).mockClear();
  vi.mocked(discoverySearchLaneMock).mockClear();
  boundedBodyMock.mockResolvedValue(new Uint8Array(0));
  rpcMock.mockResolvedValue({ error: null, data: [] });
  createClientMock.mockImplementation(() => ({ rpc: rpcMock }));
});

afterEach(() => {
  // No cleanup needed - setup.ts handles globals
});

describe("Serper discovery Edge Function", () => {
  it("returns 405 for non-POST methods", async () => {
    const res = await handler(makeRequest("GET"));
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 503 when ENABLE_SERPER_DISCOVERY is not true", async () => {
    setEnv({ ENABLE_SERPER_DISCOVERY: "false" });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_DISABLED");
  });

  it("returns 503 when INTERNAL_CRON_SECRET is missing", async () => {
    setEnv({ ENABLE_SERPER_DISCOVERY: "true" });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_NOT_CONFIGURED");
  });

  it("returns 503 when INTERNAL_CRON_SECRET is shorter than 32 chars", async () => {
    setEnv({ ENABLE_SERPER_DISCOVERY: "true", INTERNAL_CRON_SECRET: "short" });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_NOT_CONFIGURED");
  });

  it("returns 503 when SERPER_API_KEY is missing", async () => {
    setEnv({ ENABLE_SERPER_DISCOVERY: "true", INTERNAL_CRON_SECRET: "a".repeat(32) });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_NOT_CONFIGURED");
  });

  it("returns 401 on bad signature", async () => {
    setEnv({
      ENABLE_SERPER_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
      SERPER_API_KEY: "test-key",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });
    const res = await handler(makeRequest("POST", {}, { "X-Cron-Signature": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 503 when lease RPC errors", async () => {
    setEnv({
      ENABLE_SERPER_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
      SERPER_API_KEY: "test-key",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });
    rpcMock.mockResolvedValue({ error: new Error("lease failed"), data: null });

    const res = await handler(makeRequest("POST", {}, { "X-Cron-Signature": "a".repeat(32) }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_QUEUE_UNAVAILABLE");
  });

  it("returns 200 with zero processed when no runs queued", async () => {
    setEnv({
      ENABLE_SERPER_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
      SERPER_API_KEY: "test-key",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });
    rpcMock.mockResolvedValue({ error: null, data: [] });

    const res = await handler(makeRequest("POST", {}, { "X-Cron-Signature": "a".repeat(32) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.completed).toBe(0);
    expect(body.failed).toBe(0);
  });

  it("processes a leased Serper run end to end", async () => {
    setEnv({
      ENABLE_SERPER_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
      SERPER_API_KEY: "test-key",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });

    const leaseToken = "00000000-0000-4000-8000-000000000001";
    const runId = "00000000-0000-4000-8000-000000000100";
    rpcMock.mockResolvedValueOnce({ error: null, data: [{ id: runId, org_id: "00000000-0000-4000-8000-000000000001", lease_token: leaseToken, requested_limit: 1, target_industry: "plumber", target_city: "Phoenix", target_country: "United States", search_mode: "paged_search", search_page: 1, campaign_id: null }] });
    rpcMock.mockResolvedValueOnce({ error: null, data: true });
    rpcMock.mockResolvedValueOnce({ error: null });

    discoverSerperSearchCandidatesMock.mockResolvedValue([]);
    discoverySearchLaneMock.mockReturnValue("website");

    const res = await handler(makeRequest("POST", {}, { "X-Cron-Signature": "a".repeat(32) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.completed).toBe(1);
    expect(body.failed).toBe(0);

    const reserveCall = vi.mocked(rpcMock).mock.calls.find(([name]) => name === "reserve_serper_discovery_credits");
    expect(reserveCall).toBeDefined();
    expect(reserveCall![1].p_run).toBe(runId);
    expect(reserveCall![1].p_token).toBe(leaseToken);

    const finishCall = vi.mocked(rpcMock).mock.calls.find(([name]) => name === "finish_serper_discovery_run");
    expect(finishCall).toBeDefined();
    expect(finishCall![1].p_error).toBeNull();
  });
});
