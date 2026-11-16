# Database design — PostgreSQL + Supabase Auth

`supabase/migrations/0001_core.sql` is a **starter development migration** with tenancy, contact + lead provenance, communications metadata, consent/suppression, jobs and audit trail. It intentionally does not store decrypted OAuth tokens. `0002_policies.sql` creates initial RLS policies; test on local Supabase, use `supabase db reset` only in disposable dev instances.

## Entities
- `organizations`, `memberships`: security boundary, roles.
- `leads`, `contacts`: separate company opportunity from person/contact point.
- `lead_evidence`, `lead_scores`: proof, timestamp, confidence, score reason.
- `consent_records`, `suppressions`: per-channel contact policy trail.
- `campaigns`, `outbound_drafts`, `message_events`: approved messaging lifecycle.
- `jobs`: durable work, idempotency, bounded retries and locking.
- `appointments`, `tasks`: work and meetings.
- `audit_events`: immutable significant actions with actor and redacted metadata.

## Future schema milestones
- `external_connections`: store only connection metadata and secure *reference* to tokens, not decrypted secrets.
- `email_threads` / provider message mapping tables with uniqueness on provider ID.
- `sequence_definitions`, `sequence_enrollments`, `sequence_steps` for follow-up sequences.
- `workflow_runs`, `usage_budgets`, `vendor_usage`, `unsub_requests` and data-deletion requests.
- `provider_webhook_events` with unique hash and signature audit.

## Design decisions
1. Use UUID primary keys, timestamptz, stable org_id and explicit status check constraints.
2. JSONB is permitted for limited metadata, not as replacement for core relationships.
3. Unique constraints for `org_id` + domain/email normalized where appropriate; handle fuzzy duplicates via review queue.
4. Never cascade-delete suppression records blindly: legal minimum needed to avoid recontact must be reviewed.
5. RLS is **required** even for single-user pilot. Test access from a second test identity and anonymous client.
6. Do not use a service_role key from the browser; avoid unrestricted SECURITY DEFINER functions without audited permissions.

## Migration QA
- Tables created and indices are queryable.
- Anonymous cannot SELECT PII.
- Organization A can't read/write B data.
- Inserting row with mismatched org ID rejected.
- Malicious client cannot mark its own membership admin.
- Job idempotency uniqueness tested.
- Backups: manually export DB on a cadence defined before production and test restore.

## Data retention proposal (subject to legal review)
- Cold research evidence: 90 days without verified interest.
- Failed/unresponsive leads: 180 days if no legitimate reason to keep longer.
- Customer/contract matters: retain as needed under contract/tax and applicable law.
- Opt-out suppression: minimal hashed address/identifier necessary to avoid recontact; review retention and deletion requests.
- Raw third-party message payloads: short-term only for troubleshooting, not permanent by default.

## Optional M8 call data (not part of baseline migrations)
Voice adds `voice_agent_configs`, `call_requests`, `call_sessions`, `call_events`, `call_usage_daily` and a `voice` consent/suppression channel. The **draft-only** migration lives under `supabase/migrations_optional/0003_voice_optional.sql` and must **not** be copied into automatic migrations until M8 testing and legal/privacy review. Prefer no recordings; transcripts and raw audio storage require separate schema, retention and consent review. Enforce org/lead/contact consistency in server validators and composite FKs before any production data (the initial core draft already flags cross-org reference risks).
