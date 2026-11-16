# M8 optional AI voice prompt — **use only after owner explicitly starts M8**

You are implementing the **optional** AI Calling module for ChainCraft Studio, not changing its core MVP. Before writing code, read `AGENTS.md`, `DECISIONS.md`, `docs/10_optional_voice/README.md` and EVERY document in `docs/10_optional_voice/`, plus the core security, privacy, schema and testing docs.

**Phase M8a only, unless the owner explicitly authorizes more:**
1. Prove core builds and tests with no voice packages or secrets installed.
2. Create a separately isolated TypeScript interface for mock voice provider and structured voice events; add feature flags false by default.
3. Implement the optional Off-state navigation and a browser-only synthetic rehearsal (no actual dialing/audio vendor APIs required).
4. Add policy checker unit tests covering permission provenance, signed approval, suppression, business hours, costs, duration, global pause, duplicate dispatch, recording off and provider event replay.
5. Propose Dograh vs LiveKit Agents vs Pipecat evaluation plan and provider quotation checklist, but do NOT connect or buy anything.
6. Run lint, typecheck, tests and build; report actual failures. Keep PROJECT_STATUS/TASKS/CHANGELOG updated.

For later M8b/M8c: ask for independent explicit approval, current provider/legal/telecom route review, verified budgets, signed webhook handling and full test results. Never use a contact list as permission to call. Never perform unsolicited automatic dialing, pretend to be a human, record without separately reviewed permission, or use production keys without an approved secrets plan. Stop if any preflight is missing. The default state after implementation remains OFF.
