# Contributing to Cognate

Thank you for your interest in contributing to Cognate — the local-first,
privacy-first autopilot planner. See [`plan.md`](plan.md) for the product thesis
and roadmap before proposing larger changes.

## Development Setup

1. **Prerequisites:** Node.js (LTS, v22+) and the Rust toolchain (≥ 1.77.2).
   On Linux also install the WebKitGTK build deps (see the README).
2. **Install dependencies:** `npm install`
3. **Run the desktop app:** `npm run tauri dev`
   (or `npm run dev` for the browser/PWA build with the localStorage fallback)

## Pull Request Process

1. Branch from `master`.
2. Keep the test pyramid green — PRs must pass:
   - `npm test` (Vitest) and `npm run test:e2e` (Playwright)
   - `cargo test` **and** `cargo clippy -- -D warnings` in **both** `src-tauri/`
     and `server/`
   - `npx tsc --noEmit`
3. Add tests for new logic. Pure, platform-agnostic logic lives in `src/services`
   and should be unit-/property-tested; cross-cutting flows get an e2e spec.
4. Open the PR.

## Architecture Notes

Cognate is a **Tauri 2 + React 19 + SQLite** app with a deterministic Rust
scheduler and a CRDT sync spine. A few conventions worth knowing:

- **Deterministic core, AI as advisor.** Scheduling, NL quick-add parsing, RBAC,
  and CRDT merge are deterministic and tested; AI only *enriches* and must degrade
  gracefully when no key/model is available (offline must keep working).
- **One platform-agnostic core.** Keep logic in `src/store.ts` + `src/services/*`
  (no DOM, no direct storage). Only `src/db.js` touches storage, so the same core
  runs on desktop, web, and the PWA.
- **The op-log is the source of truth.** Every task mutation funnels through
  `src/services/taskService.ts`; SQLite is a projection. Don't bypass that seam.
- **Security is structural.** Secrets go in the OS keychain (never plaintext); the
  relay only ever sees ciphertext; shared-doc writes are signed and role-checked.
  Don't weaken these.
- **Design system.** Use the CSS design tokens (`var(--accent)`, `var(--text)`, …)
  rather than hard-coded colors. Banned: the font Inter and AI-generic purple/neon
  palettes — make distinctive, intentional choices.
