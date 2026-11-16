# User stories and acceptance

- **US-01** As owner, I upload an inbound CSV and the system flags duplicates before merging so I do not annoy an existing prospect. Acceptance: show preview/validation error rows and user chooses merge actions.
- **US-02** As owner, I need to know *why* a lead scored highly. Acceptance: category breakdown with source links and update timestamp; score without evidence clearly downgraded.
- **US-03** As owner, I generate a personalized first email in 10 seconds without inventing facts. Acceptance: every specific claim points to lead evidence and AI output is editable.
- **US-04** As owner, I review the email before sending. Acceptance: sending blocked until I click approve, contact is eligible, sending provider connected, daily cap not hit.
- **US-05** As owner, I can immediately stop contact after they reply 'not interested'. Acceptance: pending jobs become suppressed before next send, outbound cannot run for that channel.
- **US-06** As owner, I see replies matched to the correct thread. Acceptance: Gmail message ID + thread ID dedupe, sanitized content display, sent vs received labels.
- **US-07** As owner, I can see if an AI job failed. Acceptance: human-readable status, retry count, safe retry that never resends completed messages.
- **US-08** As owner, I schedule a consultation without double booking. Acceptance: check availability before creating event and verify event result.
- **US-09** As owner, I prepare LinkedIn outreach without violating platform rules. Acceptance: no LinkedIn login, scraping or send API; draft copied manually.
- **US-10** As owner, I see whether WhatsApp is actually enabled. Acceptance: disabled until provider tokens, webhooks, opt-in and approved messaging tested.
- **US-11** As owner, I know what it costs. Acceptance: track estimated model token use, function invocations, warnings and provider link; unknown cost labeled unknown.
- **US-12** As operator, I can export/delete a contact and retain a minimal irreversible suppression record where lawful/needed to avoid future outreach. Acceptance: policy rules and audit evidence.

## Deferred optional voice stories
- As an owner, I see **AI Calls — Optional (Off)** and can configure a mock demo without activating any live call service.
- As an owner, I can require human approval for a callback requested by an inbound lead, view the allowed time window and estimated maximum cost, then approve once.
- As a prospect, I am told this is an AI agent and can ask for a person, stop the call, decline recording or opt out of future calls.
- As an owner, I can view sanitized outcomes and handoff tasks without storing recordings by default.
- As an admin, I can stop all live calls immediately and confirm queued/retrying actions cannot dial.
