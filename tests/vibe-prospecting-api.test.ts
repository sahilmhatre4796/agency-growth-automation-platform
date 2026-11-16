import { describe, expect, test, vi } from "vitest";
import {
  VibeProspectingProvider,
  getCredits,
  matchBusiness,
  discoverProspects,
  enrichContacts,
  mapDecisionMakersToObservations,
} from "../packages/server/vibe-prospecting-api.ts";
import type { PublicDecisionMaker } from "../packages/server/vibe-prospecting.ts";

const apiKey = "test-api-key-12345";

function fakeFetch(handler: (req: Request, opts?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// ── Credits tests ────────────────────────────────────────────────────────

describe("Vibe credits lookup", () => {
  test("missing API key reports VIBE_NOT_CONFIGURED", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", undefined);
    const result = await getCredits();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VIBE_NOT_CONFIGURED");
    expect(result.error?.status).toBe(0);
    expect(result.error?.retryable).toBe(false);
    vi.unstubAllEnvs();
  });

  test("successful credits lookup returns allocated and remaining", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse({
        response_context: { correlation_id: "corr-123", request_status: "success", time_taken_in_seconds: 0.05 },
        allocated_credits: 100,
        remaining_credits: 85,
        account_type: "trial",
      })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await getCredits();
      expect(result.ok).toBe(true);
      expect(result.credits).toMatchObject({
        allocated: 100,
        remaining: 85,
        accountType: "trial",
        correlationId: "corr-123",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const callArgs = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      expect(String(callArgs[0])).toContain("/v2/credits");
      expect((callArgs[1] as { headers?: Record<string, string> })?.headers).toMatchObject({ api_key: apiKey });
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });

  test("401 authentication error is reported", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse(
        { code: "UNAUTHORIZED", message: "Invalid API key" },
        401,
        { "x-correlation-id": "corr-401" },
      )
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await getCredits();
      expect(result.ok).toBe(false);
      expect(result.error?.status).toBe(401);
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.correlationId).toBe("corr-401");
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });

  test("403 insufficient credits is reported", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse(
        { code: "INSUFFICIENT_CREDITS", message: "You have insufficient credits to perform this operation." },
        403,
      )
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await getCredits();
      expect(result.ok).toBe(false);
      expect(result.error?.status).toBe(403);
      expect(result.error?.retryable).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });
});

// ── Provider lookup tests ────────────────────────────────────────────────

function makeProvider(fetchImpl: typeof fetch): { provider: VibeProspectingProvider; origFetch: typeof fetch } {
  const provider = new VibeProspectingProvider();
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  return { provider, origFetch };
}

function restoreFetch(origFetch: typeof fetch): void {
  globalThis.fetch = origFetch;
}

describe("Vibe provider lookup", () => {
  test("missing API key throws VIBE_NOT_CONFIGURED", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", undefined);
    const provider = new VibeProspectingProvider();
    await expect(
      provider.lookup({ business_name: "Acme", domain: "acme.com", maximum_cost: 10 }),
    ).rejects.toThrow("VIBE_NOT_CONFIGURED");
    vi.unstubAllEnvs();
  });

  test("no business match returns empty array", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const { provider, origFetch } = makeProvider(
      fakeFetch(async () =>
        jsonResponse({
          response_context: { correlation_id: "corr-nomatch", request_status: "success", time_taken_in_seconds: 0.1 },
          matched_businesses: [],
          total_results: 0,
          total_matches: 0,
        })
      )
    );
    try {
      const result = await provider.lookup({ business_name: "Nonexistent", domain: "nonexistent.com", maximum_cost: 10 });
      expect(result).toEqual([]);
    } finally {
      restoreFetch(origFetch);
      vi.unstubAllEnvs();
    }
  });

  test("business match → prospects → enrichment maps to PublicDecisionMaker[]", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);

    const fetch = fakeFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/credits") {
        return jsonResponse({
          response_context: { correlation_id: "corr-credits", request_status: "success", time_taken_in_seconds: 0.01 },
          allocated_credits: 100,
          remaining_credits: 90,
          account_type: "trial",
        });
      }
      if (url.pathname === "/v2/businesses/match") {
        return jsonResponse({
          response_context: { correlation_id: "corr-match", request_status: "success", time_taken_in_seconds: 0.1 },
          matched_businesses: [
            { input: { name: "Acme Corp", domain: "acme.com" }, business_id: "biz-123" },
          ],
          total_results: 1,
          total_matches: 1,
        });
      }
      if (url.pathname === "/v2/prospects") {
        return jsonResponse({
          response_context: { correlation_id: "corr-prospects", request_status: "success", time_taken_in_seconds: 0.2 },
          data: [
            {
              prospect_id: "prospect-1",
              full_name: "Jane Doe",
              job_title: "Director of Engineering",
              job_level_main: "director",
              company_name: "Acme Corp",
              company_website: "https://acme.com",
              linkedin: "linkedin.com/in/janedoe",
              business_id: "biz-123",
            },
          ],
          total_results: 1,
        });
      }
      if (url.pathname === "/v2/prospects/contact_information/enrich") {
        return jsonResponse({
          response_context: { correlation_id: "corr-enrich", request_status: "success", time_taken_in_seconds: 0.3 },
          data: [
            {
              prospect_id: "prospect-1",
              data: {
                professional_email: "jane.doe@acme.com",
                professional_email_status: "valid",
                phone_numbers: [{ phone_number: "+1 555 123 4567" }],
                mobile_phone: "+1 555 123 4567",
              },
            },
          ],
          total_results: 1,
        });
      }
      return jsonResponse({ error: "unknown" }, 404);
    });

    const { provider, origFetch: orig } = makeProvider(fetch);
    try {
      const result = await provider.lookup({ business_name: "Acme Corp", domain: "acme.com", maximum_cost: 10 });
      expect(result.length).toBeGreaterThan(0);
      const maker = result[0];
      expect(maker.full_name).toBe("Jane Doe");
      expect(maker.email).toBe("jane.doe@acme.com");
      expect(maker.email_status).toBe("publicly_sourced");
      expect(maker.confidence).toBeGreaterThan(0);
      expect(maker.confidence).toBeLessThanOrEqual(1);
      // Match Businesses does not return a website URL, so source_url falls
      // back to the prospects URL for this prospect.
      expect(maker.source_url).toBe("https://api.explorium.ai/v2/prospects/prospect-1");
    } finally {
      restoreFetch(orig);
      vi.unstubAllEnvs();
    }
  });

  test("match request sends name and domain to /v2/businesses/match", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);

    let capturedBody: unknown = null;
    const fetch = fakeFetch(async (req, init) => {
      capturedBody = init?.body;
      const url = new URL(req.url);
      if (url.pathname === "/v2/businesses/match") {
        return jsonResponse({
          response_context: { correlation_id: "corr-match", request_status: "success", time_taken_in_seconds: 0.1 },
          matched_businesses: [],
          total_results: 0,
          total_matches: 0,
        });
      }
      return jsonResponse({ error: "unknown" }, 404);
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      await matchBusiness(apiKey, "Acme Corp", "acme.com");
      const body = JSON.parse(String(capturedBody));
      expect(body.businesses_to_match).toEqual([{ name: "Acme Corp", domain: "acme.com" }]);
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });

  test("enrichment failure falls back to prospects without contact details", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);

    const fetch = fakeFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/businesses/match") {
        return jsonResponse({
          response_context: { correlation_id: "corr-match", request_status: "success", time_taken_in_seconds: 0.1 },
          matched_businesses: [{ input: { name: "Acme Corp", domain: "acme.com" }, business_id: "biz-123" }],
          total_results: 1,
          total_matches: 1,
        });
      }
      if (url.pathname === "/v2/prospects") {
        return jsonResponse({
          response_context: { correlation_id: "corr-prospects", request_status: "success", time_taken_in_seconds: 0.2 },
          data: [
            { prospect_id: "prospect-1", full_name: "Bob Smith", job_title: "Owner", company_name: "Acme Corp", company_website: null, linkedin: null, business_id: "biz-123", job_level_main: "owner" },
          ],
          total_results: 1,
        });
      }
      if (url.pathname === "/v2/prospects/contact_information/enrich") {
        return jsonResponse({ error: "internal error" }, 500);
      }
      return jsonResponse({ error: "unknown" }, 404);
    });

    const { provider, origFetch: orig } = makeProvider(fetch);
    try {
      const result = await provider.lookup({ business_name: "Acme Corp", domain: "acme.com", maximum_cost: 10 });
      expect(result.length).toBe(1);
      expect(result[0].email).toBeNull();
      expect(result[0].email_status).toBe("unknown");
      expect(result[0].confidence).toBe(0.5);
    } finally {
      restoreFetch(orig);
      vi.unstubAllEnvs();
    }
  });

  test("zero budget makes no enrichment request", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);

    let matchCalled = false;
    let prospectsCalled = false;
    let enrichCalled = false;

    const fetch = fakeFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/businesses/match") {
        matchCalled = true;
        return jsonResponse({
          response_context: { correlation_id: "corr-match", request_status: "success", time_taken_in_seconds: 0.1 },
          matched_businesses: [{ input: { name: "Acme Corp", domain: "acme.com" }, business_id: "biz-123" }],
          total_results: 1,
          total_matches: 1,
        });
      }
      if (url.pathname === "/v2/prospects") {
        prospectsCalled = true;
        return jsonResponse({
          response_context: { correlation_id: "corr-prospects", request_status: "success", time_taken_in_seconds: 0.2 },
          data: [{ prospect_id: "prospect-1", full_name: "Bob Smith", job_title: "Owner", company_name: "Acme Corp", company_website: null, linkedin: null, business_id: "biz-123", job_level_main: "owner" }],
          total_results: 1,
        });
      }
      if (url.pathname === "/v2/prospects/contact_information/enrich") {
        enrichCalled = true;
        return jsonResponse({ error: "should not be called" }, 500);
      }
      return jsonResponse({ error: "unknown" }, 404);
    });

    const { provider, origFetch: orig } = makeProvider(fetch);
    try {
      // Zero budget: no enrichment should be requested.
      const result = await provider.lookup({ business_name: "Acme Corp", domain: "acme.com", maximum_cost: 0 });
      expect(matchCalled).toBe(true);
      expect(prospectsCalled).toBe(false);
      expect(enrichCalled).toBe(false);
      expect(result.length).toBe(1);
      expect(result[0].email).toBeNull();
      expect(result[0].email_status).toBe("unknown");
      expect(result[0].confidence).toBe(0.5);
      expect(result[0].evidence_excerpt).toContain("no contact enrichment within budget");
    } finally {
      restoreFetch(orig);
      vi.unstubAllEnvs();
    }
  });

  test("insufficient budget (below 5 credits) makes no enrichment request", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);

    let enrichCalled = false;
    const fetch = fakeFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/businesses/match") {
        return jsonResponse({
          response_context: { correlation_id: "corr-match", request_status: "success", time_taken_in_seconds: 0.1 },
          matched_businesses: [{ input: { name: "Acme Corp", domain: "acme.com" }, business_id: "biz-123" }],
          total_results: 1,
          total_matches: 1,
        });
      }
      if (url.pathname === "/v2/prospects/contact_information/enrich") {
        enrichCalled = true;
        return jsonResponse({ error: "should not be called" }, 500);
      }
      return jsonResponse({ error: "unknown" }, 404);
    });

    const { provider, origFetch: orig } = makeProvider(fetch);
    try {
      // 4 credits < 5 credits per prospect: no enrichment.
      const result = await provider.lookup({ business_name: "Acme Corp", domain: "acme.com", maximum_cost: 4 });
      expect(enrichCalled).toBe(false);
      expect(result.length).toBe(1);
      expect(result[0].email).toBeNull();
    } finally {
      restoreFetch(orig);
      vi.unstubAllEnvs();
    }
  });

  test("transport error is retried and then reported", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);

    let attempts = 0;
    const fetch = fakeFetch(async () => {
      attempts++;
      throw new Error("DNS resolution failed");
    });

    const { provider, origFetch: orig } = makeProvider(fetch);
    try {
      await expect(
        provider.lookup({ business_name: "Acme", domain: "acme.com", maximum_cost: 10 }),
      ).rejects.toThrow();
      expect(attempts).toBeGreaterThan(1);
    } finally {
      restoreFetch(orig);
      vi.unstubAllEnvs();
    }
  });
});

// ── Individual function tests ────────────────────────────────────────────

describe("matchBusiness", () => {
  test("returns business match with correlation ID", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse({
        response_context: { correlation_id: "corr-match", request_status: "success", time_taken_in_seconds: 0.1 },
        matched_businesses: [{ input: { name: "Test Corp", domain: "test.com" }, business_id: "biz-456" }],
        total_results: 1,
        total_matches: 1,
      })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await matchBusiness(apiKey, "Test Corp", "test.com");
      expect(result.ok).toBe(true);
      expect(result.match?.businessId).toBe("biz-456");
      expect(result.match?.name).toBe("Test Corp");
      expect(result.match?.domain).toBe("test.com");
      expect(result.match?.website).toBeNull();
      expect(result.match?.correlationId).toBe("corr-match");
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });

  test("422 validation error is not retried", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse({ detail: [{ msg: "field required" }] }, 422)
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await matchBusiness(apiKey, "", "");
      expect(result.ok).toBe(false);
      expect(result.error?.status).toBe(422);
      expect(result.error?.retryable).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });
});

describe("discoverProspects", () => {
  test("maps prospect fields correctly", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse({
        response_context: { correlation_id: "corr-prospects", request_status: "success", time_taken_in_seconds: 0.2 },
        data: [
          {
            prospect_id: "p-1",
            full_name: "John Smith",
            job_title: "Founder & CEO",
            job_level_main: "founder",
            company_name: "Test Corp",
            company_website: "https://test.com",
            linkedin: "linkedin.com/in/johnsmith",
            business_id: "biz-123",
          },
        ],
        total_results: 1,
      })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await discoverProspects(apiKey, "biz-123", 3);
      expect(result.ok).toBe(true);
      expect(result.prospects).toHaveLength(1);
      expect(result.prospects?.[0]).toMatchObject({
        prospectId: "p-1",
        fullName: "John Smith",
        jobTitle: "Founder & CEO",
        jobLevelMain: "founder",
        companyName: "Test Corp",
        companyWebsite: "https://test.com",
        linkedin: "linkedin.com/in/johnsmith",
        businessId: "biz-123",
      });
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });
});

describe("enrichContacts", () => {
  test("maps enriched contact fields correctly", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () =>
      jsonResponse({
        response_context: { correlation_id: "corr-enrich", request_status: "success", time_taken_in_seconds: 0.3 },
        data: [
          {
            prospect_id: "p-1",
            data: {
              professional_email: "john@test.com",
              professional_email_status: "catch_all",
              phone_numbers: [{ phone_number: "+1 555 000 1111" }],
              mobile_phone: "+1 555 000 1111",
            },
          },
        ],
        total_results: 1,
      })
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await enrichContacts(apiKey, ["p-1"]);
      expect(result.ok).toBe(true);
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts?.[0]).toMatchObject({
        prospectId: "p-1",
        professionalEmail: "john@test.com",
        professionalEmailStatus: "catch_all",
        phoneNumbers: ["+1 555 000 1111"],
        mobilePhone: "+1 555 000 1111",
      });
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });

  test("empty prospect list returns empty contacts", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    const fetch = fakeFetch(async () => {
      throw new Error("SHOULD_NOT_BE_CALLED");
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      const result = await enrichContacts(apiKey, []);
      expect(result.ok).toBe(true);
      expect(result.contacts).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });
});

// ── Fallback port mapping tests ──────────────────────────────────────────

describe("mapDecisionMakersToObservations", () => {
  test("maps PublicDecisionMaker[] to ContactObservation[] with vibe provenance", () => {
    const makers: PublicDecisionMaker[] = [
      {
        full_name: "Jane Doe",
        role: "Director of Engineering",
        email: "jane.doe@acme.com",
        email_status: "publicly_sourced",
        source_url: "https://acme.com",
        observed_at: "2026-11-05T00:00:00+00:00",
        evidence_excerpt: "Explorium email jane.doe@acme.com for Jane Doe at Acme Corp",
        confidence: 0.75,
      },
      {
        full_name: "Bob Smith",
        role: "Owner",
        email: null,
        email_status: "unknown",
        source_url: "https://api.explorium.ai/v2/prospects/p-2",
        observed_at: "2026-11-05T00:00:00+00:00",
        evidence_excerpt: "Explorium no email returned for Bob Smith at Acme Corp",
        confidence: 0.5,
      },
    ];

    const observations = mapDecisionMakersToObservations(makers, "lead-123");
    expect(observations).toHaveLength(1); // Only the one with an email.
    expect(observations[0]).toMatchObject({
      lead_id: "lead-123",
      kind: "email",
      value: "jane.doe@acme.com",
      source_provider: "vibe",
      source_url: "https://acme.com",
      contact_name: "Jane Doe",
      role: "Director of Engineering",
      confidence: 0.75,
    });
    expect(observations[0].evidence_excerpt).toContain("jane.doe@acme.com");
  });
});

// ── Security tests ───────────────────────────────────────────────────────

describe("API key security", () => {
  test("provider instance has id 'vibe'", () => {
    expect(new VibeProspectingProvider().id).toBe("vibe");
  });

  test("fetch requests include api_key header but never expose key in URL", async () => {
    vi.stubEnv("VIBE_PROSPECTING_API_KEY", apiKey);
    let capturedInit: RequestInit | undefined;
    const fetch = fakeFetch(async (_req, init) => {
      capturedInit = init;
      return jsonResponse({
        response_context: { correlation_id: "corr-sec", request_status: "success", time_taken_in_seconds: 0.01 },
        allocated_credits: 100,
        remaining_credits: 100,
        account_type: "trial",
      });
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof fetch;
    try {
      await getCredits();
      expect(capturedInit?.headers).toMatchObject({ api_key: apiKey });
      // API key should not appear in URL path
      expect(String(capturedInit?.body ?? "")).not.toContain(apiKey);
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
    }
  });
});
