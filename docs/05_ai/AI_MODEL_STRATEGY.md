# AI provider strategy and quality controls

## Objectives
Generate helpful drafts and structured lead assessments at the lowest feasible **marginal API cost**, within free quotas when available, without leaking unnecessary personal data or inventing facts.

## Provider choice
- Primary: Groq `openai/gpt-oss-120b` (current published rate limits must be queried/configured at deployment).
- Fallback: eligible Gemini Flash/Flash-Lite model if actually available on owner's free API plan, privacy terms accepted, and budget allows.
- Optional local Ollama development mode, not a requirement for a cloud deployment.

## Adapter interface
`AIProvider.generateJSON({task, schema, sanitized_context, max_tokens, timeout_ms, idempotency_key}) -> {validated_data, usage, model_id, latency_ms, safety_flags}`.

Data masking: never send OAuth tokens, full customer histories, personal mobile numbers, addresses, financial data, sensitive personal attributes or secret commercial negotiations to an LLM unless explicitly justified and reviewed. Use minimum business-relevant evidence.

## Deterministic lead score (initial weights, configurable)
- Expressed intent / inbound enquiry: 0–30
- Relevance to ChainCraft offer: 0–25
- Evidence quality and recency: 0–20
- Accessible, permitted communication route: 0–15
- Timing/urgency from **explicit** statements: 0–10

Do not confuse an old website with explicit purchase intent. AI may explain inputs and suggest labels but must not invent extra points. Store score computation version, evidence IDs, uncertainty and human override.

## Draft quality rules
- Every non-generic, specific statement must reference evidence ID.
- Never claim 'free audit', guaranteed conversion, discount, 150+ work proof, a specific price or previous relationship unless approved business facts and current offer record exist.
- Personalization refers only to observed/verified business facts.
- Avoid aggressive subject lines and fake scarcity. Short copy and honest purpose.
- Model outputs drafts only, never authorizes send.

## Fallback and rate-limit behavior
429: read `Retry-After`, enqueue with delay, preserve provider budget; do not silently switch to a billable model. Timeout: 2 limited retries with backoff. Invalid JSON: one structured retry; then queue for manual review. Provider outage: show degraded state; CRM remains functional.

## Evaluation dataset
Create 50 synthetic leads (none real) with known ground-truth signals: inbound intent, no site, bad site, opted out, competitor, bounce, unspecified budget, unrelated business, duplicates, and insufficient evidence. Compare structured scores and draft fact accuracy. Track `hallucinated_claim_rate` and `approval_edit_rate`.

## Required evidence
Prompt and schema version; model ID; request purpose; redacted input digest; evidence identifiers; token usage and cost estimate; JSON validation outcome. Never log raw unredacted prompt by default.

## Optional voice model selection (deferred)
Voice quality is evaluated end-to-end; no low per-token rate is enough. Compare STT Hindi/Hinglish word accuracy, interruption handling, turn latency, TTS intelligibility, noise tolerance, provider data-handling terms, and all-in ₹/connected minute. Dograh/LiveKit/Pipecat are implementation candidates, NOT endorsed performance claims. Preferred development stage: browser simulation with mock transcripts; production voice requires separate telephony and optionally paid real-time compute. Keep model prompts locked to ChainCraft-approved product facts and human transfer for pricing disputes.
