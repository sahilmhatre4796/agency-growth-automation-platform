import { expect, test } from "vitest";
import { websiteCheckSignal } from "../packages/server/website-gap";

const now = Date.parse("2026-10-20T12:00:00Z");
const url = "https://business.example.org/";
const check = (id: string, at: string, outcome: string, http_status: number | null, checked_url = url) =>
  ({ id, checked_at: at, checked_url, outcome, http_status });

test("reachable site suppresses an old repeated-server-error review signal", () => {
  const checks = [
    check("a", "2026-10-18T10:00:00Z", "http_5xx", 503),
    check("b", "2026-10-19T11:00:00Z", "http_5xx", 503),
    check("c", "2026-10-20T11:00:00Z", "ok", 200),
  ];
  expect(websiteCheckSignal(checks, url, now)).toEqual({ signal: "reachable", supportingIds: ["c"] });
});

test("two recent 5xx observations 24 hours apart flag review, not a service-gap verdict", () => {
  const signal = websiteCheckSignal([
    check("a", "2026-10-18T10:00:00Z", "http_5xx", 502),
    check("b", "2026-10-19T11:00:00Z", "http_5xx", 503),
  ], url, now);
  expect(signal).toEqual({ signal: "repeated_server_error_review", supportingIds: ["a", "b"] });
  expect(signal).not.toHaveProperty("serviceGap");
});

test("one failure, too-close checks, policy uncertainty and wrong domain do not imply a problem", () => {
  expect(websiteCheckSignal([check("a", "2026-10-20T11:00:00Z", "http_5xx", 503)], url, now).signal).toBe("uncertain");
  expect(websiteCheckSignal([
    check("a", "2026-10-20T09:00:00Z", "http_5xx", 503),
    check("b", "2026-10-20T11:00:00Z", "http_5xx", 503),
  ], url, now).signal).toBe("uncertain");
  expect(websiteCheckSignal([
    check("a", "2026-10-18T10:00:00Z", "http_5xx", 503),
    check("x", "2026-10-19T10:00:00Z", "review_required", null),
    check("b", "2026-10-20T11:00:00Z", "http_5xx", 503),
  ], url, now).signal).toBe("uncertain");
  expect(websiteCheckSignal([check("a", "2026-10-18T10:00:00Z", "http_5xx", 503, "https://other.example.org/")], url, now).signal).toBe("uncertain");
});
