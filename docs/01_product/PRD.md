# PRD — Product Requirements Document
Version 1.0 · Status: Build baseline · Priority P0/P1/P2. All IDs are stable for acceptance and traceability.

## Product narrative
ChainCraft Sales Command Center is a responsive **internal-only** workspace with a unified lead list, evidence-backed research, AI-assisted content, campaign approvals, multi-channel conversation timeline, tasks, appointments, and results dashboard.

## Primary user journeys
**U1 Inbound WhatsApp/Meta enquiry:** manually import or approved webhook → match/merge contact → label source → parse service intent → suggest qualification questions → approved reply/template → follow-up task → meeting/proposal.

**U2 Prospect research:** import company/domain from permitted source → capture legal source URL/time and public claims → optional constrained website audit → score with explanation → owner approves suitable outreach or archives.

**U3 Email workflow:** lead with eligible address → AI draft based only on evidence → human edits → approve and send through connected Gmail → sync thread → positive/negative/reply detection → suppress or schedule allowed next step.

**U4 Appointment:** qualified lead chooses suitable slot → check owner availability via Calendar API → owner approves invitation → meeting stored with source trail.

**U5 Daily operation:** alerts show hot inbound, unsent drafts, blocked jobs, reply queue, appointments and usage ceilings.

## Functional requirements
| ID | Priority | Requirement | Acceptance summary |
|---|---|---|---|
| FR-001 | P0 | Single organization auth with admin role and RLS | Unknown users cannot access any lead |
| FR-002 | P0 | Lead CRUD, contact sources and CSV import | Validation, dedupe and audit events |
| FR-003 | P0 | Lead timeline and stage pipeline | Changes attributed to actor/time |
| FR-004 | P0 | Evidence attachments, source URL, fetch timestamp | Unverified claims clearly marked |
| FR-005 | P0 | Explainable lead scoring; rules + optional AI | Score breakdown, no hallucinated evidence |
| FR-006 | P0 | Owner task inbox and reminders | Due/overdue and completed states |
| FR-007 | P0 | Email draft generation using AI provider adapter | Draft contains verified claims only |
| FR-008 | P1 | Google OAuth Gmail connection and draft sync | Least-privileged scopes, disconnect |
| FR-009 | P1 | Approval-based email sending | No send without eligibility and approval |
| FR-010 | P1 | Inbox/reply sync, sentiment flags and threading | Opt-out stops any pending sequence |
| FR-011 | P1 | Follow-up sequences and worker scheduler | Idempotent, retries, quota and pause |
| FR-012 | P1 | Calendar availability and booking | Conflict checks, explicit confirmation |
| FR-013 | P1 | Public website health signals | Safe fetch, permission and per-host limits |
| FR-014 | P1 | Dashboard metrics from actual events | Demo records excluded from production KPIs |
| FR-015 | P1 | Notification center for hot replies/jobs | User can acknowledge and filter |
| FR-016 | P2 | Meta WhatsApp Business API | Verified webhooks, approved opt-in/template rules |
| FR-017 | P2 | LinkedIn task assistant | Only copyable drafts and manual activity logs |
| FR-018 | P2 | Authorized Meta lead form ingestion | Duplicate-safe; permission reviewed |
| FR-019 | P2 | Multi-campaign reporting and attribution | Channel and evidence provenance |
| FR-020 | P0 | Kill switch and spend/quota meter | All outbound stops immediately |

## Interaction requirements
- New prospect cannot send automatically on creation.
- A lead's status includes `new`, `researching`, `qualified`, `contacted`, `replied`, `meeting_booked`, `proposal_sent`, `won`, `lost`, `disqualified`; status transitions recorded.
- Score includes confidence and reason; never equate score with actual intent.
- Unified timeline distinguishes human action, AI recommendation, external event and automation.
- All AI message drafts have 'Source evidence' and editable 'Claims used'.
- All automation controls show active, paused, quota-blocked or error.

## Non-goals
AI calling, cold bulk sender, automatic LinkedIn messaging, autonomous negotiation/discounting, guaranteed lead generation, e-commerce storefront, customer-facing SaaS.

## Release definitions
**MVP:** FR-001..007, FR-020 plus synthetic data/local tests. **Beta:** FR-008..015 with approved actual account and small consented pilot. **Later:** FR-016..019 subject to legal/provider checks.

## Exit metrics
Pilot owner can import 50 fictional test records with no duplicates, produce evidence-cited scores, approve 5 test emails without accidental sends, sync test replies, book 2 test appointments, prove kill switch, inspect audit logs. See TEST_PLAN.

## Optional voice addendum (M8, intentionally non-blocking)
**Activation flag:** `ENABLE_AI_CALLING=false`. UI appears as **Optional — Not enabled** until owner explicitly activates the module after review. No core P0/P1 requirement depends on it.

**U6 (future):** warm lead explicitly requests a callback → authenticated operator reviews call eligibility, timezone and budget → approves one callback → compliant telephony gateway places call → agent identifies itself as AI, confirms willingness to proceed, discusses ChainCraft service basics, and offers human handoff → verified event and concise transcript summary stored per policy. Inbound receptionist flow is separately opt-in via a supported business number.

| ID | Priority | Optional requirement | Acceptance summary |
|---|---|---|---|
| FR-V01 | P2 / M8 | Optional voice tab and provider connection status | Disabled state clear; no live gateway loaded |
| FR-V02 | P2 / M8 | Browser-based mock conversational rehearsal | Synthetic leads only; no real calls or cost |
| FR-V03 | P2 / M8 | Warm callback eligibility and explicit approval | No implicit consent; disallowed contacts blocked |
| FR-V04 | P2 / M8 | Inbound receptionist via approved provider | Number verified, disclosure, human transfer, fail-closed |
| FR-V05 | P2 / M8 | Hindi/English/Hinglish agent with source-grounded FAQs | No invented pricing/guarantees; uncertain cases handed to human |
| FR-V06 | P2 / M8 | Voice CRM timeline and optional summaries | Source/version/timestamps recorded; minimum PII |
| FR-V07 | P2 / M8 | Call budgets, limits, quiet hours, opt-out and kill switch | Zero caps initially; tested before enabling |
| FR-V08 | P2 / M8 | Recording separately consented and controlled | Default OFF; opt-out and deletion tested |
| FR-V09 | P2 / M8 | Provider fallback/handoff and failure recovery | No duplicate calls on retries |
| FR-V10 | P2 / M8 | Telephony/account/compliance readiness check | Written owner approval, legal/provider review |

Read `docs/10_optional_voice/` for complete voice specifications, costs, security and test cases. No provider compatibility or live calling support is asserted without a successful test.
