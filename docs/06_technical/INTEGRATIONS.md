# Integration setup plan and credential checklist

No credential is included, and nothing here is connected. Each integration stays `not_connected` until a live test verifies it.

## 1 Supabase
Create a free dev project; obtain project URL + **anon/public key** (browser-allowed). Manage service-role key and DB password exclusively in server secret store. Enable Auth, set allowed redirect URLs, test RLS. Configure email verification for login and harden admin access.

## 2 Cloudflare Pages
Create static React/Vite deployment; build command `npm run build`, output `dist`. Only public variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Set security headers; lock preview environment if sensitive. Static Pages free quota is distinct from Functions/Workers quotas.

## 3 Groq
Create API key server-side, test allowed model via official models endpoint and rate-limits dashboard. Start with `openai/gpt-oss-120b` only if available; set max tokens/day and request budgets in app. Avoid silent upgrade to paid tier.

## 4 Gemini (optional fallback)
Use only an eligible currently supported model and explicit account quota. Verify terms for processing customer/business context; send only redacted, non-sensitive evidence. Disable fallback when uncertain about price or privacy.

## 5 Gmail / Google OAuth
Create Google Cloud project; set OAuth consent audience, verified redirect URIs, test-user list if in testing. Review least privileged scopes:
- `gmail.send`: sensitive, for sending only.
- `gmail.readonly`: restricted, for reply reading (verification/security requirements may apply).
- `gmail.compose`: restricted, for draft management.
OAuth for private/test app differs from publicly distributed apps; never assume an internal app avoids all review. Use PKCE/state, encrypt refresh token, detect revocation, disconnect/revoke flow. Gmail API quota is **not** the same as mailbox sending limits. Prefer time-bounded polling in MVP over Pub/Sub push unless set up properly; Gmail watch requires renewal at least every seven days.

## 6 Google Calendar
Use appropriate calendar event/freebusy scopes and approval before booking. Store provider event ID and timezone. Never fabricate available times if provider unavailable.

## 7 Meta WhatsApp Business Platform (later)
Check WhatsApp Business Account (WABA), phone-number onboarding / coexistence risk, verified webhook, app permissions, template approvals, opt-in proof and Meta current country pricing. Use test number first. Production sending OFF until all gates and policies pass.

## 8 LinkedIn
No official prospecting/messaging API assumed; the app offers local drafting and manual tracking only. Do not import/scrape member data using LinkedIn APIs for sales lead lists.

## 9 Lead sources
Inbound CSV, Meta lead exports, webform submissions, referral records and approved business data. If programmatic research: explicit domain allowlist, access rules, provenance. No unapproved Google Maps scraping or contact harvesting.

## Connection health checklist
- OAuth scopes and consent shown to owner.
- Test read succeeds with a seeded test record; write action preview only.
- Signature/auth + rate limit errors tested.
- Token expiry/revoke/resume tested.
- Costs and vendor console link shown.
- Disconnect revokes local access and pauses related jobs.

## Optional M8 voice integrations — deliberately NOT connected
Evaluate self-hosted Dograh, LiveKit Agents or Pipecat; test an eligible India telephony/SIP provider, STT/TTS/LLM, webhook routing and transfer support separately. The selected tech stack must support Hindi/Hinglish, call costs and compliance requirements proven by live sandbox/provider tests. No account setup, numbers, SIP trunk, paid credits or provider env keys are required for M0–M7. Activation and contracts are specified in `docs/10_optional_voice`.
