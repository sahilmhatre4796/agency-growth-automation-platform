# Automation catalog — 15 workflows (no calling)

Every workflow defines trigger, input, permissions, output, failures and audit event. No job may activate an external side effect without the `OUTBOUND_POLICY.md` gate.

| ID | Name | Trigger | Side effect / result | Pilot stage |
|---|---|---|---|---|
| WF01 | CSV/manual lead import | Owner upload | Normalize, detect possible duplicates, create records | MVP |
| WF02 | Permitted prospect research | Owner initiates | Capture business facts with URL/time and permitted origin | Beta |
| WF03 | Website audit | Owner approves domain | Rate-limited public fetch; mobile/SSL/tech indicators; evidence | Beta |
| WF04 | Lead evidence extraction | New evidence | AI extracts structured claims w/ evidence IDs or flags unknown | MVP |
| WF05 | AI lead scoring | Evidence changed | Deterministic score with AI rationale checked against evidence | MVP |
| WF06 | Email drafting | Owner requests draft | Specific verifiable intro and CTA for approval | MVP |
| WF07 | Gmail approved send | Approved draft + eligible contact | Mail via authorized account; store provider ID | Beta |
| WF08 | Reply sync | Scheduled OAuth task / push later | Associate thread; suggest sentiment; update pipeline | Beta |
| WF09 | Email follow-up | Eligible schedule due | Skip on reply/opt-out; approval/caps; track send | Beta |
| WF10 | WhatsApp conversation | Authorized inbound/webhook | Track opted-in messages, template gate, reply suggestions | Later |
| WF11 | LinkedIn assistant | Manual request | Copyable text; no platform automation | Beta |
| WF12 | Qualification | New inbound/reply | Extract budget, need, urgency and missing info; owner verification | MVP |
| WF13 | Calendar booking | Owner approves slot | Check free/busy; create event; audit | Beta |
| WF14 | Notifications | Qualified reply / job failure / appointment | In-app alert (email optional later) | MVP |
| WF15 | Orchestrator / scheduler / reports | Cron + owner task | Lease jobs; retry safely; build daily report from events | Beta |

## WF07 email send sequence
1. Load immutable draft snapshot and contact with org scoping.
2. Confirm channel eligibility and consent/legal basis recorded; suppression absent; policy version current.
3. Confirm explicit owner approval and active campaign with `can_send = true`.
4. Check per-contact cooldown, hourly/daily budget and Gmail connection.
5. Reserve idempotency key and mark `processing`; call Gmail send with MIME + stable `Message-ID`.
6. Persist Gmail result and immutable audit row; mark `completed`.
7. If provider times out, reconcile by Message-ID / thread state before retry; do not blindly resend.

## WF08 reply sync
Poll with narrow access or use Gmail push after verified setup. Deduplicate by provider message id; identify existing thread. On human reply, pause follow-up pending review by default. Detect opt-out keywords with deterministic matcher + human review. Do not let model-only classification override explicit opt-out.

## WF09 follow-up
Eligible only after appropriate permission, documented policy and sequence approval; stop on positive, negative, unsubscribe, invalid email, complaint, manually held deal or lost stage. Hard maximum 2 follow-ups by default; configurable downward. Minimum delays set through policy, not hard-coded in prompt.

## WF10 WhatsApp
Webhook signature verified; `wa_id` mapped to eligible contact; process inbound in customer service window when policy allows. Proactive templates only when approved and appropriate. Disable until Meta Business/WABA setup and consent audit complete. Handle delivery/read/failure callbacks without counting delivery as qualified lead.

## WF15 scheduler
Supabase cron invokes short worker every ~5–15 minutes (configurable). Uses database atomic leases and max attempts; enforces spend/usage budgets. Large crawling or long-running n8n-style automations require separate future worker, not infinite Edge Function retries.

## Optional workflows (disabled until M8)
**WF-V1 Browser rehearsal:** fixture → mock STT/LLM/TTS → synthetic dialogue → evaluator → demonstration call record. No number, recording or live credentials.
**WF-V2 Requested callback:** contact requests callback (provenance + timestamp) → owner reviews identity, allowed contact hours and max cost → approves one callback → double check suppression/consent and hard global kill switch → telephony initiation with idempotency key → provider events → handoff/summary. No unsolicited sequences.
**WF-V3 Inbound receptionist:** supported business number (later approved) → disclose AI identity → confirmation to continue → service questions / qualification → schedule or human handoff → sanitized CRM update.
**WF-V4 Voice stop/opt-out:** immediate call termination where possible, voice suppression record, outbound queue cancellation, human review and audit event.
**WF-V5 Spend guard:** preflight remaining daily minutes/paise → cap ongoing conversation, force graceful termination/handoff → reconcile actual provider invoice and alert. Cost overruns remain possible due to provider billing delays.
Voice workflows must not be scheduled or loaded when disabled. See `docs/10_optional_voice/VOICE_WORKFLOWS.md`.
