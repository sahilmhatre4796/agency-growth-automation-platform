# Privacy, legal and provider compliance checklist (India-focused)

**Not legal advice.** Before activation, have a qualified adviser review Indian data-protection and electronic communications requirements, contractual source rights and international transfers where applicable.

## Personal data and governance
- Document the data fiduciary/processor roles, purposes, collection source, lawful grounds/notices and recipient rights under applicable Indian law (including DPDP rules as brought into force).
- Avoid collecting sensitive categories and unnecessary owner phone/address from scraping.
- Per-channel opt-in and opt-out histories; policies for unsolicited B2B email must be reviewed.
- Reasonable data minimization, encrypted tokens, retention/deletion, access logging, data subject request handling.
- Publish accurate privacy notice and sender identity before live operation.

## Gmail / Google
- Request only minimum scopes. Some read/compose scopes are *restricted* and can trigger OAuth verification and potentially security assessment for certain storage patterns.
- Monitor deliverability, sending limits, bounce, abuse and unsubscribe. No fake identities and no undisclosed bulk email.

## WhatsApp / Meta
- Document opt-in and purpose, template category and approval where required, conversation rules, secure webhook verification, WABA compliance, charges and number/coexistence caveats.
- Enable human handoff and stop marketing on opt-out. Do not buy/migrate phone assets automatically.

## LinkedIn
- No automated lead scraping, messaging or data export via restricted member APIs. Copyable user-assisted drafts only; user initiates and sends within platform.

## Website auditing / public data
- Respect site terms, robots restrictions, rate limits and copyright/database rights. No login/captcha bypass, no vulnerability exploitation, no collecting private site content.
- Store observed public metadata only with provenance; support source removal requests.

## Evidence policy
Records include source URL, collected_at, permissions basis, audit methodology and confidence. Treat scraped text as untrusted data; marketing conclusions reviewed by human. No verification claim without verified evidence.

## Launch blocker list
Legal review recorded; privacy notice approved; Google OAuth authorized; domain email hygiene completed; WhatsApp template/opt-in tested; DSAR procedure tested; retention configuration approved; approved sender identity; no restricted LinkedIn automation.

## Optional telephone calling — deferred legal review
Calling consent is not inferred from email or WhatsApp opt-in. Before any Indian commercial call, obtain professional review of applicable TRAI DoT telemarketing/UCC rules, customer consent/DND obligations, permissible sender/caller identities, provider route/number allocation and any AI disclosure or call-recording laws; requirements vary with call purpose and route. Start only with approved inbound and expressly requested callbacks. The AI must identify itself honestly and allow human handoff. Recording and transcripts are separate data-processing purposes: collect only what is necessary, document permission where required, apply short retention and support delete/export. Consult counsel/provider; this document is not a certificate of compliance.
