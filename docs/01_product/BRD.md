# BRD — Business Requirements Document

## Objective
Create a private, affordable, human-supervised sales operations system for ChainCraft Studio. It must reduce manual administrative effort and improve lead quality without creating uncontrolled spam, hidden fees or misleading AI analytics.

## Business stakeholders
- Owner / sales lead: defines offers, reviews outreach, negotiates, closes deals.
- Sales assistant (future): researches and updates CRM with limited permissions.
- Technology administrator: connects providers, reviews errors, monitors costs.
- Prospects: retain ability to opt out, ask for human response, correct data.

## Business workflows
- Inbound: Capture → deduplicate → classify → assign → reply within policy → schedule → proposal → won/lost.
- Research: Business lead observed → origin and evidence stored → audit → score → human review → optionally prepare approved first contact.
- Email: Draft → factual check → approval → send → reply/opt-out/bounce sync → pause sequence → sales alert.
- WhatsApp: Explicit opt-in or qualifying inbound → authorized message → handoff → timeline and consent log.
- LinkedIn: Operator opens site manually → notes public company details and drafts message → sends manually → logs result.

## Business rules
BR-001 No sending on account connection alone; owner explicitly turns on campaigns.
BR-002 Approval required on every first-contact outbound message (MVP); follow-ups only in allowed, approved sequences and to eligible contacts.
BR-003 No communication to suppressed contacts on any relevant channel. Opt-out applies immediately.
BR-004 An opportunity without verifiable source and evidence must be shown as unverified.
BR-005 Deals can be manually advanced; AI may suggest but cannot mark a deal won or schedule without permission.
BR-006 User can export leads and delete/contact-correct records per policy.
BR-007 Dashboards separate demo, imported, and live records.
BR-008 All paid operations require explicit owner approval and a max spend limit.
BR-009 AI calling is an optional future module only, disabled by default, with its own approval/eligibility checks, pilot criteria and recurring-cost budget; core sales operation functions without it.

## Revenue model (for internal business only)
No customer subscriptions are charged for this application. It is internal sales infrastructure. The commercial goal is website project revenue, which must be entered from actual won deals; no generated or forecast revenue is counted as achieved.

## Operating constraints
- Solo-owner management with limited time, Windows 11 development with Codex.
- Pilot monthly infrastructure target ₹0 using eligible free quotas; not a reliability promise.
- Need Hinglish-capable sales drafts but no fully automatic selling claims.
- Mobile-friendly dashboard, audit trail, one-button pause/kill switch.

## Approvals required
Technical architecture, data/privacy review, provider scopes, first outreach campaign, provider activation, production deployment, any purchases or billing enrollment.

## Optional voice business case — not an MVP dependency
Interested prospects may request a Hindi/Hinglish callback, or incoming calls may be answered by an AI receptionist where properly disclosed. The system may log an owner-approved voice conversation summary into the CRM and offer a handoff/booking. Success is measured by qualified, consenting conversations rather than call volume. Procurement of telephony, live call routing, recordings and automated outbound dialing are excluded from the MVP purchase and launch plan.
