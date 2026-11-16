import type { auditWebsite } from "./audit.ts";

type Audit = Awaited<ReturnType<typeof auditWebsite>>;
export type StoredWebsiteAudit = {
  outcome: "ok" | "http_5xx" | "not_found" | "review_required";
  checkedUrl: string;
  httpStatus: number | null;
  objective: Record<string, string | number | boolean | null>;
  errorCode: string | null;
};

export function storedWebsiteAudit(audit: Pick<Audit, "url" | "objective">, requestedUrl = audit.url): StoredWebsiteAudit {
  const status = audit.objective.httpStatus;
  const outcome = status >= 200 && status < 300 ? "ok"
    : status >= 500 && status <= 599 ? "http_5xx"
    : status === 404 || status === 410 ? "not_found" : "review_required";
  return {
    outcome,
    checkedUrl: requestedUrl,
    httpStatus: status,
    objective: { ...audit.objective, finalUrl: audit.url },
    errorCode: null,
  };
}

const publicErrorCodes = new Set([
  "SOURCE_PERMISSION_REQUIRED", "URL_NOT_PERMITTED", "PRIVATE_TARGET", "HOST_NOT_APPROVED",
  "DNS_REBINDING_BLOCKED", "ROBOTS_TOO_LARGE", "ROBOTS_RULE_REVIEW_REQUIRED",
  "ROBOTS_REVIEW_REQUIRED", "ROBOTS_DISALLOWED", "INVALID_REDIRECT",
  "TOO_MANY_REDIRECTS", "RESPONSE_TOO_LARGE", "UNSUPPORTED_CONTENT_ENCODING",
  "AUDIT_TIMEOUT", "INVALID_AUDIT_LIMIT", "DNS_PIN_MISMATCH",
]);

export function failedWebsiteAudit(url: string, error: unknown): StoredWebsiteAudit {
  const message = error instanceof Error ? error.message : "";
  return {
    outcome: "review_required",
    checkedUrl: url,
    httpStatus: null,
    objective: {},
    errorCode: publicErrorCodes.has(message) ? message : "NETWORK_OR_POLICY_REVIEW_REQUIRED",
  };
}
