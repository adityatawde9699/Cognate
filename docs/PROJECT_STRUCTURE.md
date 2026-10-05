# Project Structure

The frontend, desktop, and relay are separate build targets. There is no root Cargo workspace or native mobile project.

| Path | Purpose |
|---|---|
| `src/App.tsx`, `src/main.tsx` | React application and bootstrap |
| `src/store.ts` | Zustand UI state and cached task data |
| `src/db.js`, `src/db.d.ts` | SQLite/IndexedDB adapter and TypeScript declarations |
| `src/components/` | Plan, board, list, table, calendar, timeline, and other views |
| `src/components/Modals/` | TaskModal, SettingsModal, task generation and templates |
| `src/components/Settings/` | Calendar, backup, updates, language, and sync settings |
| `src/hooks/` | Task loading, reflow, sync, data safety, reminders, and UI hooks |
| `src/services/` | Task commands, planners, op-log, sync, crypto, calendar, and AI services; colocated Vitest tests |
| `src/utils/` | Export, secrets, PWA, audio, notifications, formatting, toast |
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | Desktop crate dependencies |
| `src-tauri/src/` | Rust planner, AI, integrations, secrets, backups, reminders, application commands |
| `src-tauri/migrations/` | `001_init.sql`, `002_projects.sql`, `003_milestones.sql`, `004_trash.sql`, `005_schedule.sql`, `006_oplog.sql` |
| `src-tauri/capabilities/`, `src-tauri/tauri.conf.json` | Desktop permissions and packaging |
| `server/Cargo.toml`, `server/Cargo.lock` | Independent relay crate dependencies |
| `server/src/main.rs` | Relay routing, auth, rate limits, persistence, and tests |
| `e2e/`, `playwright.config.ts` | Chromium browser workflows and runner configuration |
| `tests/calcPriority.test.js` | Standalone legacy priority test; outside Vitest's configured include |
| `scripts/` | Icon generation and build artifact verification |
| `public/` | PWA manifest/service worker and static icon assets |
| `dist/` | Generated web build |
| `site/` | Separate static marketing website |
| `.github/workflows/` | Test checks, desktop release, static website publishing |
| `docs/PRODUCTION_ROADMAP.md` | Production audit, priorities, acceptance criteria, and implementation progress |

`taskService.ts` is the intended command boundary, but some mutations bypass it. `oplogStore.ts` mirrors only part of local history; `projector.ts` is pure projection/diff logic invoked by sync reconciliation. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing these paths, especially before implementing replay or recovery.
