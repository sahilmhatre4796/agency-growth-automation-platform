# Security threat model and controls

## Threats
T1 Cross-organization customer data leakage. T2 Browser leaked service credentials. T3 Prompt injection from untrusted website or inbound email. T4 SSRF/internal network crawl. T5 Duplicate or unauthorized external sends. T6 CSRF/OAuth account takeover. T7 Spam/phishing or false claims. T8 Compromised webhook. T9 Data deletion failure. T10 Vendor account abuse or runaway spending.

## Required mitigations
- All tables holding data have RLS; role checks in Edge Functions; `service_role` only in restricted worker; unit/integration tests with two orgs.
- Secrets in environment/secret vault only. `.gitignore` excludes `.env*` except `.env.example`. No real token in screenshots/issues.
- AI input untrusted; schema validate; evidence allowlist; no raw tool execution from model text.
- Public URL validator: resolve DNS, IP-block private/localhost/link-local/metadata targets and revalidate redirect destination; enforce timeout/body-size/robots/domain throttles.
- OAuth: exact redirect allowlist, PKCE/state, HTTPS, encrypted token storage, minimal scopes and account disconnect.
- Webhooks: verify provider signature before parse; bounded JSON sizes, raw body validation, replay prevention and provider event ID uniqueness.
- Side effects: user approval, consent/policy gate, campaign kill switch, idempotent transactional outbox and safe retry reconciliation.
- Audit events immutable for grants, approvals, sends, exports, connection, deletes and role changes.
- Data encryption in transit and provider rest; avoid storing raw HTML/email PII unnecessarily.
- Rate limits at edge by identity and per vendor; cost caps and alert threshold.
- CSP, secure headers, dependency audits, input escaping, accessibility.

## Security release gates
- [ ] Anonymous and cross-org RLS negative tests pass.
- [ ] Service role absent from browser build and repo history.
- [ ] No secret logged.
- [ ] SSRF test fixtures blocked (127.0.0.1, 169.254.169.254, DNS redirect-to-private).
- [ ] Malicious email prompt injection has no outbound effect.
- [ ] Duplicate webhook/scheduler events do not trigger second send.
- [ ] Global kill switch blocks already-queued future outbound.
- [ ] Unsubscribe and compliance suppression tests pass.
- [ ] OAuth state/revoked tokens tested.
- [ ] Data export/delete procedures demonstrated in dev.

## Incident workflow
Pause outbound globally, revoke compromised credentials, preserve sanitized audit events, notify owner, investigate affected lead ids, restore only after postmortem and approval.

## Optional phone attack surface (M8)
Threats include premium-rate/incorrect outbound dialing, phone-number enumeration, spoofed call webhooks, recordings/transcripts exposing PII, prompt injection through spoken instructions, AI agent impersonation, unexpected telephony charges, call retries causing multiple dials and cross-org transcript access. Require callback approval, verified consent provenance and DND/quiet-hour policy, E.164 phone validation, separate outbound kill switch, signed webhook replay defense, immutable call audit, server-only secrets, no live client-side dial endpoint, minute/budget caps, minimum transcript retention and redacted logs. Recording remains OFF. All tests must pass before optional enablement.
