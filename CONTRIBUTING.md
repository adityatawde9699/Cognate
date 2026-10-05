# Contributing to Cognate

Thank you for your interest in contributing to Cognate — the local-first,
privacy-first autopilot planner. See [`docs/PRODUCTION_ROADMAP.md`](docs/PRODUCTION_ROADMAP.md) for the product thesis
and roadmap before proposing larger changes.

## Development Setup

1. **Prerequisites:** Node.js (LTS, v22+) and the Rust toolchain (≥ 1.77.2).
   On Linux also install the WebKitGTK build deps (see the README).
2. **Install dependencies:** `npm install`
3. **Run the desktop app:** `npm run tauri dev`
   (or `npm run dev` for the browser/PWA build with the IndexedDB adapter)

## Pull Request Process

1. Branch from `master`.
2. Keep the test pyramid green — PRs must pass:
   - `npm test` (Vitest) and `npm run test:e2e` (Playwright)
   - `cargo test` **and** `cargo clippy -- -D warnings` in **both** `src-tauri/`
     and `server/`
   - `npm run typecheck`, `npm run build`, and `npm run verify:build`
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
- **Protect the operational store.** SQLite/IndexedDB holds task state; task/project commands commit rows and history together. Historical gaps must be audited before replay. Prefer `src/services/taskService.ts`
  for commands; do not treat replay as safe recovery until the roadmap invariants pass.
- **Respect the current trust model.** The relay stores ciphertext; shared-project
  clients verify signed personal/project batches, actor bindings and roles. Desktop
  keychain failures fail closed; browser secrets use an encrypted vault. Epoch
  rotation requires new invitations, and legacy relay migration, journal compaction
  and offline changes across rotation remain open. Document these limits accurately.
- **Design system.** Use the CSS design tokens (`var(--accent)`, `var(--text)`, …)
  rather than hard-coded colors. Banned: the font Inter and AI-generic purple/neon
  palettes — make distinctive, intentional choices.
