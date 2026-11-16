# Expected application repository after M0

```text
chaincraft-sales-command-center/
├── README.md / AGENTS.md / PROJECT_STATUS.md / DECISIONS.md
├── apps/
│   └── web/                     # React/Vite static dashboard (M0)
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   ├── features/leads/
│       │   ├── features/drafts/
│       │   ├── features/analytics/
│       │   ├── lib/supabase.ts  # anon key only
│       │   └── styles/tokens.css
│       ├── public/
│       └── package.json
├── packages/
│   └── shared/                  # types, validation, policy models
├── supabase/
│   ├── migrations/
│   ├── functions/
│   │   ├── lead-score/
│   │   ├── draft-create/
│   │   ├── email-send/
│   │   ├── jobs-run/
│   │   └── _shared/            # external adapter interfaces
│   └── tests/
├── tests/
│   ├── integration/
│   └── e2e/
├── docs/
├── contracts/
├── fixtures/
└── prompts/
```

The ZIP contains the specification structure and **empty directories** for future code. It is intentionally *not* a runnable application. Codex must generate, install, and test real application code during M0, logging its changes.

## Future optional M8 folders (not required to scaffold in core)
`services/voice-gateway/` optional runtime; `packages/voice-contracts/` typed schemas; `supabase/migrations_optional/` disabled schema; `tests/voice/` mocked policy/voice tests. Do not add these packages to mandatory core startup commands unless they contain no provider dependencies.
