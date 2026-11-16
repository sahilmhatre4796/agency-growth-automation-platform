# Technical Architecture (TAD) — Serverless-first

## Design constraints
0-monthly-spend **goal for limited prototype**, not a promise of indefinite free production. Keep cold starts, Supabase pausing, provider eligibility, rate limits and operating costs visible.

## High-level structure
```text
Cloudflare Pages / static React SPA
  ├── Supabase Auth JWT session; database reads with RLS
  ├── Supabase Edge Functions (policy-checked external side effects)
  │    ├── /leads/import /score /draft /approve
  │    ├── /gmail/connect/callback /gmail/send /gmail/sync
  │    ├── /calendar/availability /calendar/book
  │    ├── /whatsapp/webhook (later)
  │    └── /jobs/run (privileged scheduler only)
  └── Supabase Postgres
       ├── orgs/profiles/leads/contacts/evidence
       ├── conversations/messages/approvals/consents
       ├── campaigns/sequences/job_queue/audit_events
       └── SQL pg_cron (short durable jobs)
External: Groq / Gemini, Google OAuth APIs, Meta WhatsApp API
```

## Deployment
React + Vite avoids pretending Next.js dynamic server features run universally on Pages without an adapter. Store only publishable Supabase URL/anon key and origin URLs in client. Sensitive operations behind verified Edge Functions; apply CORS allowlist.

## Background runner
Use pg_cron + pg_net calling dedicated Edge Function with secret verification, or a database-function job worker permitted by Supabase. Keep jobs short (< platform caps), lease atomically (`FOR UPDATE SKIP LOCKED`), release on crash via lease expiry. No webhook work should block on model generation; enqueue after signature validation.

## Provider modules (typed adapters)
`LeadSourceAdapter`, `AuditAdapter`, `AIProvider`, `MailProvider`, `MessagingProvider`, `CalendarProvider`, `NotificationProvider`. A deterministic fake implementation for each, and integration contract tests. Keep provider payloads away from UI components.

## Trust boundaries
1. Browser is untrusted; verify JWT and role server-side.
2. Public source content and inbound email/WhatsApp are untrusted; validate/sanitize, prevent prompt injection.
3. OAuth secrets in server-only secret manager (never raw access token in general-purpose tables).
4. Side effects must pass policy engine and idempotency queue.
5. Service role credentials restricted to backend admin operations and audited.

## SSRF and crawler safety
Only http/https public DNS targets; block loopback/RFC1918/link-local and cloud metadata IPs, validate redirects and DNS rebinding, enforce max size/time, host/domain throttle, robot and site policies, no auth or CAPTCHA bypass. Static serverless calls cannot handle full headless Chrome reliably; use lightweight HTML metadata/HTTP checks first, defer heavyweight browser audits to opt-in external worker.

## Data events
Persist structured event stream: `lead_created`, `evidence_added`, `score_calculated`, `draft_created`, `draft_approved`, `email_sent`, `reply_received`, `unsubscribe_recorded`, `whatsapp_inbound`, `calendar_booked`, `job_failed`. Counters computed from events/provider confirmations; never fabricated.

## Migration path
For reliable production at volume, consider Supabase Pro and/or worker queue; no forced VPS. The switch to paid infrastructure must be justified with actual uptime needs and measured volume, approved by owner.

## Optional M8 voice boundary
Voice needs real-time, low-latency audio/SIP bridging and a long-running service; **not** suitable as a static Pages app or a short-lived Edge Function for active calls. Keep optional voice gateway independently deployed, connected via authenticated service-side API and signed provider webhooks. CRM can store consent, call requests, summaries, accounting events and feature flags. Reuse existing login, audit, lead and policy services. Core installation and deploy must succeed with no Docker/voice gateway running and zero phone-related secrets.

```
[Core React on Pages] --> [Supabase Auth / Edge / Postgres]
                              ^   |
                              |   +-- optional approved callback request
                    [signed webhook / signed service API]
                              ^   |
                      [OPTIONAL voice gateway]
                              ^   |
                 [STT / LLM / TTS / SIP provider]
```

Do not assume any free hosting supports continuous calls or concurrent sessions; size and cost only after provider-backed benchmark. Details in `docs/10_optional_voice/VOICE_ARCHITECTURE.md`.
