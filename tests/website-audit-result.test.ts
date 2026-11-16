import { expect, test } from "vitest";
import { failedWebsiteAudit, storedWebsiteAudit } from "../packages/server/website-audit-result";

const audit = (status: number) => ({
  url: "https://example.org/", observed_at: "2026-10-20T00:00:00Z",
  objective: { httpStatus: status, https: true, title: null, hasViewport: false, hasDescription: false, hasContactPath: false },
  subjective: [], limitations: [],
});

test("objective HTTP observations never become an automatic service-gap verdict", () => {
  expect(storedWebsiteAudit(audit(200)).outcome).toBe("ok");
  expect(storedWebsiteAudit(audit(503)).outcome).toBe("http_5xx");
  expect(storedWebsiteAudit(audit(404)).outcome).toBe("not_found");
  expect(storedWebsiteAudit(audit(403)).outcome).toBe("review_required");
  expect(storedWebsiteAudit(audit(503))).not.toHaveProperty("serviceGap");
});

test("network failures store only allowlisted codes and require owner review", () => {
  expect(failedWebsiteAudit("https://example.org/", new Error("ROBOTS_DISALLOWED"))).toMatchObject({ outcome: "review_required", errorCode: "ROBOTS_DISALLOWED", httpStatus: null });
  expect(failedWebsiteAudit("https://example.org/", new Error("secret token in error"))).toMatchObject({ outcome: "review_required", errorCode: "NETWORK_OR_POLICY_REVIEW_REQUIRED", objective: {} });
});
