# Testing

Run the frontend baseline from the repository root:

```bash
npm run typecheck
npm test
npm run build
npm run verify:build
npm run test:e2e
npm run test:pwa
```

Run Rust checks in each independent crate:

```bash
(cd src-tauri && cargo test)
(cd src-tauri && cargo clippy -- -D warnings)
(cd server && cargo test)
(cd server && cargo clippy -- -D warnings)
```

The PR workflow `.github/workflows/test.yml` enforces these checks. Desktop Rust formatting is advisory, not a blocking check. Playwright reports are uploaded in CI; coverage collection is not configured.

## Coverage and limits

Vitest includes `src/**/*.{test,spec}.{ts,tsx}`. The legacy `tests/calcPriority.test.js` is outside that include. Frontend tests cover deterministic planner cases, op-log merge, crypto, role admission, calendar parsing/mapping, and mocked service paths. Several randomized loop tests exercise invariants; there is no dedicated property-testing framework.

Playwright drives the browser build in Chromium with real IndexedDB. The migration tests retain original localStorage data and inject transaction/quota failures. Separate production preview tests check precached assets, offline reload/lazy Settings, a failed deployment, waiting updates across editing tabs, final activation/cache cleanup, a newly added asset and offline reopen. Browser tests also verify encrypted, non-exportable secret-key persistence and replacement-device identity/data recovery. Specs cover render smoke, task flows, onboarding, planning, basic accessibility, and export/import between browser contexts. The sync E2E uses a bundle, not a live encrypted relay. Calendar URL/mapping tests and imported busy-time tests do not validate a live Google/Microsoft OAuth handshake.

Rust tests cover planner/priority/team planning/integration helpers and relay routing/auth/rate-limit/long-poll behavior. Running desktop Rust tests does not exercise an installed app's webview, SQL plugin, tray, notifications, signing, updater, or recovery lifecycle.

Startup duplicate regression tests assert preservation of browser records, no SQL mutations on an existing desktop database, and read-only reporting. Browser E2E additionally checks that matching tasks survive scan and reload. The SQL adapter test uses a mock; native SQLite lifecycle still needs installed-app coverage.

## Production gaps

Native OS smoke tests, hard-kill/previous-release migration fixtures, deployed independent-device relay outage tests, broader engine/DST property fixtures, live OAuth and mobile install/eviction tests remain required. Three independent row/history stores now exercise the v2 batch protocol against a fake relay with actual projection commits; real local HTTP relay tests cover persistence failures and poll saturation. Real SQLite tests now exercise uncheckpointed WAL snapshots, verified restore, corrupt input, required safety-snapshot failure, history/projection/calendar/plan rollback and stale plans. A shared adversarial JSON corpus runs through both planner engines. A green CI run does not establish production readiness. Track acceptance criteria in [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md).

## Local stabilization run — 2026-10-06

TypeScript checking, **283 Vitest tests across 41 files**, **24 Chromium workflow/storage tests**, and **two production offline/update tests** passed. Desktop Rust **37 tests**, relay Rust **16 tests**, and Clippy with warnings denied (including all targets) passed for both crates. Web production build and `git diff --check` passed. Artifact verification is rerun after the production test restores its modified deployment fixture. These are local results; remote CI, installed-platform, live-provider and staging load checks have not run. npm installation/audit reported no remaining advisories after updating Vitest to 4.1.11.

New coverage includes recurring exception cancellation, feed-local VTIMEZONE, RDATE/EXDATE, expansion beyond the saved horizon without resetting source freshness, calendar metadata rollback, cancelled plan preservation, context/signature/ciphertext admission, exact retry after lost acknowledgement, actual three-store task/history convergence, signed invite tampering, old-epoch upload freeze/read isolation, replacement identity recovery and recovery passphrase rewrap. OAuth lifecycle tests mock native HTTP/listener commands: they do not replace real provider authorization tests.

## Plan review and keyboard/touch run — 2026-10-09

Typecheck, 289 Vitest tests across 42 files, and 29 Chromium browser tests passed. Five dedicated Plan regressions cover saved explanations/freshness after reload, captured tasks requiring review, keyboard focus trap/restoration and atomic pinning, conflict/quota failures retaining input and the prior schedule, and a 390px viewport with reachable capture/backlog and non-overlapping blocks. Semantic input fixtures cover task/calendar/hour changes, legacy/corrupt records, atomic pin projection and a committed plan whose UI refresh fails. The final mobile refinements were checked with the dedicated Plan suite.

These checks do not constitute a complete screen-reader audit or a real touch-device/installed-OS matrix. Deployed team acceptance and broader accessibility acceptance remain open.

## Team workflow run — 2026-10-09

Typecheck, **299 Vitest tests across 44 files**, **30 Chromium browser tests**, **40 desktop Rust tests**, and desktop Clippy with warnings denied passed. Both production PWA tests passed after these changes. The web build and artifact isolation check passed. The relay implementation is unchanged; its prior 16-test verification is recorded above.

Team tests use real independent device stores, signed operations and a fake immutable-batch relay. They cover opt-in/title-free availability, unknown/expired availability, member-bound signatures, owner/editor/viewer/revoked-device journeys, busy union capacity, departed assignees, atomic quota rollback, stale tasks/calendar, cross-project rejection and altered proposal contents. A browser journey checks roster diagnostics, assignment preview, stale-calendar rejection and successful apply. A real SQLite transaction test rejects calendar changes before any assignment history commits. These tests do not establish deployed-relay or installed OS acceptance.
