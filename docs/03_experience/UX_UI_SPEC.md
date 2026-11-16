# UX / UI specification

## Brand direction
Use ChainCraft's premium identity: ivory/warm white surfaces, subtle champagne-gold accents, dark charcoal typography, restrained motion, spacious cards, clear visual hierarchy. Avoid cyberpunk, neon, crowded admin templates and overstated badges.

## Navigation
1. **Overview**: daily actions, warm replies, meetings, automation status, verified totals.
2. **Leads**: filters (source, segment, score, confidence, status, owner), CSV import, duplicate review.
3. **Lead Detail**: evidence and audit, score breakdown, contacts/consent, notes, timeline, messages, tasks, deal value.
4. **Discover**: approved import sources, audit queue, research statuses, source evidence.
5. **Email**: connection state, drafts, approval queue, sequences, replies, bounces, suppressions.
6. **WhatsApp**: not-configured/gated by default; conversations only after verified authorization.
7. **LinkedIn Assistant**: manually entered business context, suggested connection note/DM copy, copy button and manual result logging; never auto-send.
8. **Calendar**: bookings, available slots, upcoming meeting list.
9. **Automation Center**: workflow statuses, job history, retry button, quota dashboard, kill switch.
10. **Analytics & Settings**: actual sourced metrics, connections, roles, retention, usage, export.

## Priority screens
- Dashboard: top 3 metrics = **qualified conversations**, **meetings held**, **won deals**; distinguish this week/last week and data completeness.
- Leads table: last verified activity; risk flags; score + evidence confidence, not just colorful badges.
- Outreach editor: source-backed claim tokens; if claim unsupported, display warning and block approval.
- Automation center: global `PAUSE OUTBOUND` persistent and visually prominent.

## UI states
Every screen supports loading, empty, errors, permission denied, offline, disconnected integration, quota exhausted and real vs demo data state. No fabricated sample customer names outside clearly marked fixtures.

## Responsive acceptance
320–414 px cards stack; side nav collapses; critical approval/pause remain accessible. Minimum touch target around 44 px; use keyboard focus visible and reduced-motion preference. Accessible contrast, form labels, status not conveyed by color alone.

## Copy and tone
Operator-facing English. Generated customer email: professional English or appropriate Hinglish according to explicit selection, respectful and concise, no baseless urgency, fake offers, invented proof, or unsupported price claims.

## Components to implement
DataTable, FilterBar, LeadScoreBreakdown, EvidenceList, ConsentBadge, ApprovalDrawer, ConversationTimeline, QuotaMeter, ActivityLog, ConfirmDialog, ConnectionHealth, GlobalStopControl.

## Optional AI Calling UI (M8)
Add a separate `AI Calls (Optional)` navigation item, visibly disabled/marked Not configured, that never blocks or changes core pages. Proposed screens: Overview (OFF state and activation prerequisites), Browser-only voice simulation, Eligible callbacks (consent + request provenance + time zone), Provider configuration (server-side secrets only), Call history (synthetic/live visibly separated), QA transcripts and redacted summaries, Cost & quotas, and Compliance checklist. `Start real call` remains absent/disabled until all backend gates pass. Always show recording status and human-handoff control; avoid a mass-dialer design.
