# Outbound policy: block-by-default

This document is mandatory gate logic for email and WhatsApp. Legal review required before real prospecting.

## Global allow conditions
- Workspace outbound enabled and kill switch off.
- Contact and organization not suppressed.
- Source and lawful permission to contact verified for the relevant channel/purpose.
- Message based on verifiable facts, free of deception and unapproved discounts.
- No pending opt-out, spam complaint, vendor ban, legal block or open negative reply.
- Sending account healthy, message approved, within cooldown and quota.
- No duplicate idempotency key and contact not queued simultaneously for same touch.

## Channel policy
**Email:** use the existing legitimate business mailbox and least privileged OAuth. Human review of first contact mandatory. Include clear sender identification and respectful opt-out. No purchased scraped email lists or anonymous bulk blasting. Honour `List-Unsubscribe` where suitable. Respect Gmail policy, national law and domain hygiene.

**WhatsApp:** require explicit recipient opt-in as applicable, valid conversation/window or approved template, Meta/BSP terms, correct business identity, and safe replies. A WhatsApp enquiry to the studio is not permission to mass-market unrelated services. Support human handoff. Do not auto-migrate number without owner confirmation.

**LinkedIn:** no automated retrieval/send; user performs actions within LinkedIn manually. Do not store prohibited member data derived from LinkedIn APIs.

**Calendar:** owner approves events; invitations only to users who requested/accepted a meeting.

## Contact states
`unknown`, `permitted`, `opted_in`, `opted_out`, `unsubscribed`, `blocked`, `complained`. Unknown never treated as opted in. Track sources and timestamps. Policy for legitimate business email outreach must be reviewed; don't assume public email address permits mass sending.

## Emergency stop
Single persisted workspace switch checked **at execution time**, including jobs already queued. It pauses all new sends. Cancel recurring jobs, leave audit trails and offer resumable review.

## Hard abuse tests
Opt-out while job in flight; simultaneous sends; duplicate webhook; stale approvals; consent revoked before retry; approval by unauthorized user; campaign resumed after provider disconnected; 429 or vendor downtime; attempted late-night message.

## Optional phone channel (entirely OFF until M8)
This channel is separate from email/WhatsApp consent. No auto-dialing scraped numbers, bulk promotional robocalls, recorded calls without required notices/consents, caller-ID spoofing or circumvention of DND/sender registration. Restrict pilot to verified, expressly requested callbacks/inbound enquiries, subject to professional review of applicable India telecom and advertising rules. Require signed approval per call, human handoff and immediate voice-channel opt-out. Global pause stops new/delayed/retried calls.
