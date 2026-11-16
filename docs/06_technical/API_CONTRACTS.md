# API contracts (proposed, not yet implemented)

All routes invoked as POST to Supabase Edge Functions, except authenticated GET reads (RLS). Version prefix `v1`. Request IDs and OAuth state mandatory. These schemas represent intended behavior; see `contracts/` for machine-readable AI outputs.

## Shared conventions
- `Authorization: Bearer <supabase_access_token>` for user routes.
- `X-Request-Id: uuid` optional inbound / generated server-side.
- `Idempotency-Key` mandatory for all external effects (mail send, calendar booking).
- `X-Cron-Signature` or securely configured token only for internal scheduler, never exposed client-side.
- Responses: `{data, error, request_id}`; error `{code, message, retryable}`. Validate all input.

## CRM
`POST /v1/lead-import-preview` → CSV rows + origin metadata → normalized rows, errors, duplicate candidates. No database writes.
`POST /v1/lead-import-commit` → validated rows + explicit merge choices → new ids, merged ids, skipped rows, audit id.
`POST /v1/lead-score` → `{lead_id, rules_version}` → score, reasons, evidence IDs; `human_review_required` when missing facts.
`POST /v1/website-audit` → `{lead_id, url, source_permission_reference}` → async job id; SSRF/public-access policies required.

## AI
`POST /v1/drafts/create` → `{lead_id, channel:'email', purpose, language}` → `{draft_id, subject, body, evidence_ids, review_required:true}`. No send.
`POST /v1/drafts/approve` → `{draft_id, decision:'approve'|'reject', edited_content?, notes}` → immutable approval with reviewer and content SHA256.

## Gmail
`GET /v1/google/oauth/start?scope_profile=mail_drafts` → Google authorization URL with signed PKCE/state.
`GET /v1/google/oauth/callback` → verified state, token stored server-side, connection id only returned.
`POST /v1/email/send` → `{draft_id, approval_id}` + `Idempotency-Key` → queued job ID; returns never a success before Gmail confirmation.
`POST /v1/email/sync` → admin-only sync request / cron actor → job id.

## Calendar
`POST /v1/calendar/availability` → `{start,end,timezone}` → verified free slots.
`POST /v1/calendar/book` → `{lead_id, start,end,timezone,attendee_email,approval_id}` + idempotency → created event id or error.

## WhatsApp (later gated)
`GET /v1/whatsapp/webhook` for Meta verification challenge with configured token.
`POST /v1/whatsapp/webhook` verify provider signature + dedup → enqueue only.
`POST /v1/whatsapp/send` requires known opt-in, approved template or eligible conversation, admin approval and idempotency.

## Jobs
`POST /v1/jobs/run` trusted scheduler only, bounded batch and lease.
`POST /v1/jobs/:id/retry` authenticated admin only, safe for idempotent status.
`POST /v1/workspace/pause-outbound` atomically sets stop flag; never wait for AI completion.

## Example error
```json
{
  "data": null,
  "error": {"code":"OUTBOUND_NOT_APPROVED","message":"A human must approve first-contact sending.","retryable":false},
  "request_id":"00000000-0000-4000-8000-000000000001"
}
```

## Optional M8 endpoints (do not implement before voice approval)
- `GET /voice/config`: enabled status, provider health and non-secret limits.
- `POST /voice/callback-requests`: create a requested callback with provenance; no call side effect.
- `POST /voice/callback-requests/{id}/approve`: owner-only approval of an eligible callback.
- `POST /voice/callback-requests/{id}/execute`: trusted worker only, performs second policy check and idempotent dispatch IF live calling explicitly enabled.
- `POST /voice/provider-webhook`: raw-body signature + replay verification, event reconciliation.
- `POST /voice/opt-out`: immediate suppression and queue cancellation.
See `docs/10_optional_voice/VOICE_API_CONTRACTS.md`; the core API must work when these endpoints do not exist.
