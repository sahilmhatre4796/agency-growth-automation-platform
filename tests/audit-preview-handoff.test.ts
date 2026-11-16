import { expect, test, vi } from "vitest";
import { handoffCompletedWebsiteAudit } from "../packages/server/audit-preview-handoff.ts";
import { hasCurrentAuditHandoff, isBoundedAuditHandoff } from "../packages/server/research-preview.ts";

const leadId = "10000000-0000-4000-8000-000000000001";
const input = { supabaseUrl: "https://staging.supabase.co", internalSecret: "x".repeat(32), leadId };

test("a completed one-job audit invokes only the existing scoped preview endpoint", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ created: 0, held: 1, provider_calls: 0, outbound_events: 0 }));
  expect(await handoffCompletedWebsiteAudit(input, fetcher)).toBe("submitted");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe("https://staging.supabase.co/functions/v1/research-preview-jobs");
  expect(JSON.parse(init!.body as string)).toEqual({ lead_ids: [leadId] });
  expect(new Headers(init!.headers).get("X-Audit-Handoff")).toBe("1");
  expect(isBoundedAuditHandoff(true, "1", [leadId])).toBe(true);
  expect(isBoundedAuditHandoff(true, "1", [leadId, leadId])).toBe(false);
  expect(isBoundedAuditHandoff(false, "1", [leadId])).toBe(false);
  expect(isBoundedAuditHandoff(true, null, [leadId])).toBe(false);
  const now = Date.parse("2026-10-25T08:00:00Z");
  expect(hasCurrentAuditHandoff("2026-10-25T07:59:00Z", now)).toBe(true);
  expect(hasCurrentAuditHandoff("2026-10-25T07:49:00Z", now)).toBe(false);
  expect(hasCurrentAuditHandoff("2026-10-25T08:01:00Z", now)).toBe(false);
});

test("missing secret fails closed and a failed handoff never retries the site or preview", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
  expect(await handoffCompletedWebsiteAudit({ ...input, internalSecret: undefined }, fetcher))
    .toBe("not_configured");
  expect(fetcher).not.toHaveBeenCalled();
  await expect(handoffCompletedWebsiteAudit(input, fetcher)).rejects.toThrow("AUDIT_PREVIEW_HANDOFF_FAILED");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(handoffCompletedWebsiteAudit({ ...input, supabaseUrl: "http://staging.supabase.co" }, fetcher))
    .rejects.toThrow("INVALID_SUPABASE_URL");
});
