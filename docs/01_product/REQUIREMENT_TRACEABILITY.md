# Requirement traceability index

| Product feature | Functional IDs | Workflows | Test anchors | Milestone |
|---|---|---|---|---|
| Auth/RLS | FR-001 | - | T-001, T-002, T-017 | M0 |
| Import/dedupe CRM | FR-002, FR-003 | WF01 | T-003, T-018 | M1 |
| Evidence and scoring | FR-004, FR-005 | WF04, WF05, WF12 | T-004, T-005 | M1 |
| Tasks and notifications | FR-006, FR-015 | WF14 | Dashboard smoke | M1/M4 |
| AI drafts | FR-007 | WF06 | T-005, T-010 | M2 |
| Gmail OAuth/send | FR-008, FR-009 | WF07 | T-006, T-009, T-011 | M3 |
| Reply/follow-up | FR-010, FR-011 | WF08, WF09 | T-008, T-009 | M3 |
| Calendar booking | FR-012 | WF13 | T-012 | M4 |
| Audit/public research | FR-013 | WF02, WF03 | T-005, T-016 | M5 |
| Dashboard analytics | FR-014 | WF15 | Metrics reconciliation | M4 |
| WhatsApp/Meta lead sync | FR-016, FR-018 | WF10 | T-013, T-014 | M6 |
| LinkedIn assistant | FR-017 | WF11 | No direct LinkedIn API calls | M7 |
| Safety kill switch | FR-020 | All outbound | T-007, T-008 | M0–M7 |

## Optional voice traceability (deferred)
FR-V01–FR-V10 are in `PRD.md` and map to `docs/10_optional_voice/VOICE_TEST_PLAN.md`, `docs/10_optional_voice/ACTIVATION_CHECKLIST.md`, `docs/10_optional_voice/VOICE_API_CONTRACTS.md`, and optional migration `supabase/migrations_optional/0003_voice_optional.sql`. They are excluded from M0–M7 release gates.
