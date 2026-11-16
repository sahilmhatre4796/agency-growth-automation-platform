# Contracts
These JSON Schemas define **proposed AI output formats**, not direct API request authentication. Validate using Zod/Ajv and additional semantic checks: sum of breakdown components must equal total score; all evidence IDs must belong to lead/org; no unsupported claims can be approved for sending. Schemas alone do not establish factual grounding or eligibility to contact someone.

Optional M8 voice contracts: `call_request.schema.json` (user-requested callback only), `call_event.schema.json` (normalized verified call event, not the provider webhook format), `call_summary.schema.json` (minimal non-sensitive AI call result). Validate these server-side; browser JSON validation is insufficient.
