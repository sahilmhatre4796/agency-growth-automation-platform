// Harvey OSM discovery Edge Function tests (mocked, no live APIs).
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { envGetMock } from "./setup.ts";

import { boundedBody } from "../packages/server/requests.ts";

vi.mock("../packages/server/requests.ts", () => ({
  boundedBody: vi.fn(),
}));

vi.mock("npm:@supabase/supabase-js@2.118.0", () => ({
  createClient: vi.fn(),
}));

import { createClient as _createClient } from "npm:@supabase/supabase-js@2.118.0";
const createClientMock = _createClient as unknown as Mock;
const rpcMock = vi.fn();
const boundedBodyMock = vi.mocked(boundedBody);

import { handler } from "../supabase/functions/harvey-osm-discovery-jobs/index.ts";

// Mock fetch globally for Harvey OSM collector
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

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
  envGetMock.mockReset();
  rpcMock.mockReset();
  boundedBodyMock.mockClear();
  createClientMock.mockReset();
  boundedBodyMock.mockResolvedValue(new Uint8Array(0));
  rpcMock.mockResolvedValue({ error: null, data: [] });
  createClientMock.mockImplementation(() => ({ rpc: rpcMock }));
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    elements: [
      {
        type: "node",
        id: 12345,
        tags: { name: "Test Dentist", website: "https://example.org/dentist" },
        lat: 18.52,
        lon: 73.85,
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } }));
});

afterEach(() => {
});

describe("Harvey OSM discovery Edge Function", () => {
  it("returns 405 for non-POST methods", async () => {
    const res = await handler(makeRequest("GET"));
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 503 when ENABLE_HARVEY_OSM_DISCOVERY is not true", async () => {
    setEnv({ ENABLE_HARVEY_OSM_DISCOVERY: "false" });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_DISABLED");
  });

  it("returns 503 when INTERNAL_CRON_SECRET is missing", async () => {
    setEnv({ ENABLE_HARVEY_OSM_DISCOVERY: "true" });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_NOT_CONFIGURED");
  });

  it("returns 503 when INTERNAL_CRON_SECRET is shorter than 32 chars", async () => {
    setEnv({ ENABLE_HARVEY_OSM_DISCOVERY: "true", INTERNAL_CRON_SECRET: "short" });
    const res = await handler(makeRequest("POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("DISCOVERY_NOT_CONFIGURED");
  });

  it("returns 401 on bad signature", async () => {
    setEnv({
      ENABLE_HARVEY_OSM_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });
    const res = await handler(makeRequest("POST", {}, { "X-Cron-Signature": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 503 when lease RPC errors", async () => {
    setEnv({
      ENABLE_HARVEY_OSM_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
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
      ENABLE_HARVEY_OSM_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
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

  it("processes a leased Harvey run end to end", async () => {
    setEnv({
      ENABLE_HARVEY_OSM_DISCOVERY: "true",
      INTERNAL_CRON_SECRET: "a".repeat(32),
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });

    const leaseToken = "00000000-0000-4000-8000-000000000001";
    const runId = "00000000-0000-4000-8000-000000000200";
    rpcMock.mockResolvedValueOnce({ error: null, data: [{ id: runId, org_id: "00000000-0000-4000-8000-000000000001", lease_token: leaseToken, requested_limit: 2, target_industry: "dentist", target_city: "Pune", target_country: "India", target_latitude: 18.52, target_longitude: 73.85, target_radius_km: 5 }] });
    rpcMock.mockResolvedValueOnce({ error: null, data: { state: "created", lead_id: "00000000-0000-4000-8000-000000000300" } });
    rpcMock.mockResolvedValueOnce({ error: null, data: 1 });
    rpcMock.mockResolvedValueOnce({ error: null });

    const res = await handler(makeRequest("POST", {}, { "X-Cron-Signature": "a".repeat(32) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.completed).toBe(1);
    expect(body.failed).toBe(0);

    const ingestCall = vi.mocked(rpcMock).mock.calls.find(([name]) => name === "ingest_discovered_business");
    expect(ingestCall).toBeDefined();
    expect(ingestCall![1].p_source).toBe("harvey");
    expect(ingestCall![1].p_provider).toBe("harvey_osm");
    expect(ingestCall![1].p_run).toBe(runId);

    const finishCall = vi.mocked(rpcMock).mock.calls.find(([name]) => name === "finish_harvey_osm_discovery_run");
    expect(finishCall).toBeDefined();
    expect(finishCall![1].p_observations).toBe(1);
    expect(finishCall![1].p_error).toBeNull();
  });
});
