# Testing

Cognate has a comprehensive test pyramid: unit tests, integration tests, property-based tests, and end-to-end tests across three platforms (desktop, web, PWA).

## Running Tests

```bash
npm test                       # Vitest: unit + integration + property tests
npm run test:e2e               # Playwright: drives the app in a real browser
(cd src-tauri && cargo test)   # Rust: planner, priority, team plan, integrations
(cd server   && cargo test)    # Rust: relay routing, auth, rate limit, long-poll
```

## CI Coverage

CI (`.github/workflows/test.yml`) runs all four test suites plus `clippy -D warnings` on both Rust crates.

**Current suite:**
- ~200 Vitest (unit + integration + property)
- 17 Playwright e2e scenarios
- 13 Rust tests (src-tauri)
- 10 Rust tests (server relay)
- All green ✅

## What's Tested

**Core deterministic logic:**
- CRDT merge semantics
- RBAC op admission
- Crypto (PBKDF2, AES-GCM, ECDSA)
- Scheduler (plan_day, plan_team)
- Energy model
- Natural-language parser

**Cross-device flows:**
- End-to-end encrypted sync
- Relay routing & long-poll
- Device offline → online recovery

**User workflows:**
- First-run onboarding
- Quick-add → auto-plan → re-flow
- Shared project collaboration
- Calendar OAuth flow

## Property-Based Testing

Some of the most critical properties are verified with property-based tests:

- Scheduler idempotency
- CRDT commutativity (any op order → same result)
- Op-log causality preservation

## CI/CD

The full test suite runs on every push to `main`. Coverage reports and test artifacts are available in GitHub Actions.
