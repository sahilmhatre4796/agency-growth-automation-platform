# Changelog

All notable changes to this project are documented here. Dates follow ISO 8601.

## 0.1.0 — 2026-11 — In active development

### Core platform
- Multi-tenant CRM with organization-scoped Row-Level Security (RLS) and audit trails.
- Lead discovery engine: Serper search adapter, paged-search mode with bounded reservations,
  anti-directory exclusions, identity, education and credibility filters, and duplicate
  prevention across domain and name.
- Discovery campaigns and queue: org-admin creation, one active campaign per organization,
  paged continuation with row-locked workers, lease recovery, retry with backoff,
  diagnostics per page (raw / name-rejected / identity-rejected / education-rejected /
  snippet-rejected / unsafe-URL / duplicates / accepted).
- Campaign Command Center UI: targeting, exclusions, credit caps, batch creation,
  start / pause / resume / cancel, live polling, per-campaign diagnostics.
- Qualification and review pipeline: evidence-cited scoring, manual-review gates,
  independent-publisher requirements for claims, directory-vs-official-site classification.
- Preview-preparation workflow: evidence-only preview generation, AI-assisted copy
  with strict evidence bindings, dry-run mode, hard outbound-approval gate.
- Website audit: bounded, allowlist-anchored, robots-aware static observation worker.
- Multi-surface Gmail architecture: OAuth connection, sandbox-only onboarding,
  suppression list, caps and approval gates (all default-off).

### Status
- 650 automated tests passing; lint, typecheck (web, root, edge) and production build green.
- Production deployment pending integration validation of remaining integrations.
- Live sending, billable AI, voice and widened provider rollouts deliberately disabled.
