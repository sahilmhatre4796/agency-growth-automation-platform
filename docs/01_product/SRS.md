# SRS — Software Requirements Specification

## System boundaries
Browser client ↔ Supabase Auth/PostgreSQL/Edge Functions. Secret-bearing Gmail, Calendar, Groq, Gemini and WhatsApp calls occur exclusively from backend functions. No service-role key in browser. No client direct calls to AI keys.

## Non-functional requirements (measurable pilot targets)
| ID | Requirement | Measure |
|---|---|---|
| NFR-001 | Security | RLS passes negative tenant access tests; secrets absent from built JS |
| NFR-002 | Accessibility | Keyboard navigable; semantic labels; WCAG 2.2 AA target |
| NFR-003 | Responsiveness | 360 px mobile through desktop; no horizontal overflow |
| NFR-004 | Performance | Warm p95 CRM list API <1.5 s on pilot dataset of 1k leads (measure, do not assume) |
| NFR-005 | Reliability | No duplicate external send on timeout/retry; durable jobs and idempotency |
| NFR-006 | Observability | Correlation id, event type, status, retry count, sanitized error; no tokens or message bodies in logs by default |
| NFR-007 | Cost | Daily model/send quotas; stop on any configured cap; meter against vendor dashboard |
| NFR-008 | Privacy | Per-contact retention and suppression, export/delete requests and consent provenance |
| NFR-009 | Recovery | Documented DB export/restore test before production, not dependent on free backups |
| NFR-010 | Portability | Provider-specific behavior behind typed adapter interfaces |
| NFR-011 | Testability | Fake provider adapters and deterministic fixtures, CI unit/integration/security checks |

## Errors and state
- Reject invalid input with field-specific errors (422), unauthenticated 401, forbidden 403, missing 404, conflict 409, rate-limited 429 with backoff, vendor unavailable 502/503.
- All external jobs must carry `idempotency_key`, `attempt`, `next_run_at`, `last_error_code`, `owner_org_id`, `policy_version`.
- Processing must be safe under at-least-once delivery, duplicate webhook events and clock skew.
- External write actions tracked as `pending_approval` → `eligible` → `queued` → `processing` → `completed`/`failed`/`suppressed`.

## Data constraints
- `org_id` enforced on every sensitive record.
- Contact channels stored normalized but retain original display value if needed.
- No unverified email inferred from guessed patterns.
- Consent: record channel, source, timestamp, permitted purpose, evidence and revocation timestamp.
- Do not store unrelated scraped personal data. Domain checks implement SSRF protections.

## Interfaces
Use API_CONTRACTS.md; frontend shall never bypass server-side policy gate for outbound side effects.

## Critical failure behavior
- Vendor quota exceeded → hold, do not switch to billable plan.
- OAuth revoked → mark disconnected and pause associated jobs.
- Unknown WhatsApp consent/template → block outbound.
- Database down → pause outbound; do not buffer risky sends in browser.
- Supabase free project paused → show degraded-mode notice; owner manually restores; do not falsify activity.
- AI returns non-JSON or ungrounded facts → fallback to manual drafting rather than send.

## Optional subsystem: voice (M8 only)
- Voice service MUST remain separately deployable and disabled with two-sided feature gates (UI + server), with no automatic upgrade from core-only state.
- Voice connection/authentication MAY be implemented as mocked adapters before real provider access. The request/response formats are in `docs/10_optional_voice/VOICE_API_CONTRACTS.md`.
- Every phone action MUST enforce campaign/global kill switch, explicit callback intent, channel consent state, applicable telecom permissions and exclusions, timezone/quiet hours, rate limits, per-call minutes and monetary budgets, approval, idempotency, provider signature verification and audit logging.
- The agent MUST disclose that it is AI, offer a human operator, avoid deceptive claims, and stop on opt-out. Recording MUST be a separate optional permission with default OFF.
- Non-voice features MUST pass all acceptance tests and deploy without any voice environment variables, services, paid accounts or phone numbers.
