# Implementation progress — ledger updated 2026-11-18 (HEAD `de9e5d1`, v3.1.0-rc.7)

Part I below is a fresh audit of the current checkout (2026-11-18); it supersedes the original v3.0.3 audit. This ledger records implementation status and outstanding acceptance evidence per task. Cognate remains under production stabilization. [v3.1.0-rc.6](https://github.com/adityatawde9699/Cognate/releases/tag/v3.1.0-rc.6) and [v3.1.0-rc.7](https://github.com/adityatawde9699/Cognate/releases/tag/v3.1.0-rc.7) are prereleases; rc.7's tagged checks, packaging, signatures, manifest and checksums were verified on 2026-10-13. No stable production release has been made.

| Task | Current status | Evidence and remaining work |
|---|---|---|
| R01 | Implemented, local checks pass | Startup and Housekeeping only report matching task IDs. Browser preservation/reload and mocked desktop no-write regressions pass. Installed desktop smoke remains external. |
| R02 | Implemented, tagged remote CI passes | Blocking typecheck/build/artifact gates alongside existing tests/Clippy. Corrected unsupported documentation claims. Rust formatting (desktop crate and relay) is now a blocking CI check, pending its first remote run; relay clippy omits `--all-targets` (A1, R32). |
| R03 | Backup/restore implementation and SQLite fixtures pass; platform matrix pending | SQLite online snapshots include uncheckpointed WAL; integrity/schema validation, fsync/rename publication, mandatory safety snapshot, adapter drain/pool close, transactional restore. Corruption, WAL, safety-snapshot failure, and rollback tests use real SQLite. Hard-kill and previous-release migration/installed OS fixtures remain. |
| R04 | Audit and explicit repair implemented | Field-level row/history/tombstone comparisons include Trash and projects. Preserved export and local audit snapshot; desktop pre-repair backup; stale snapshot rejection and provenance. Repair leaves task rows untouched. Log-only entities remain flagged for review; no automatic cutover. |
| R05 | Atomic task/project commands and durable batch outbox implemented | SQLite transactions and IndexedDB workspace transactions commit rows, operations, and local clock together. Injected history/quota failures preserve both layers. R14 now uses durable unacknowledged operations plus a persisted exact-ciphertext pending batch. |
| R06 | Implemented for tasks, projects, milestones and templates; settings stay per-device by design | CRUD, Trash/purge, undo, focus counts, reorder, scheduling, project detach/delete, and idempotent monthly-clamped recurrence enter history atomically. Calendar source replacement is transactional. Milestones (`milestone:<id>`) and templates (`template:<id>`) are op-log entities with per-field last-writer-wins on both engines (`recordSync.ts`, `operation_store.rs` `RECORD_TABLES`); records from before this are logged once on the next sync; sync, bundle import and recovery rebuild them from history. Settings are not replicated: they hold device paths, keys and per-device preferences. Shared projects do not carry milestones. |
| R07 | Guarded atomic import/projection implemented | Historical local gaps block destructive projection. Full row/project/history preconditions reject stale import; native and browser commit the projection with admitted operations together. Injected native projection insert failure retains old rows/history. Installed runtime/crash fixtures remain. |
| R08 | IndexedDB adapter and retained legacy migration implemented | Versioned workspace plus original localStorage snapshot, strict durability transactions, quota errors, revision/domain preconditions. Browser tests cover interrupted migration, failed save with retained input, stale cross-tab writes, reload, and bundle import. UI cross-tab subscriptions, storage eviction/recovery UX and large-profile measurements remain. |
| R09 | Structural/collision admission implemented | JSON/clock/depth/count/size bounds, canonical collision rejection, equal timestamp conflict rejection, native transactional admission. Entity-specific semantic validators and fuzz corpus expansion remain. |
| R10 | Implemented | Browser workspace and native task commands persist HLC; local recordings refresh from history; restart/clock rollback identity tests pass. Signing keys are checked for a matching pair and actor binding; partial/missing registered keys fail explicitly. Browser multi-tab key registration is now transactional; remote operations more than five minutes ahead of local time are rejected on every remote entry point (`MAX_REMOTE_SKEW_MS` in `oplog.ts`: v2 batches, shared-project signed ops, bundle/relay merges); recovery kits restore an identity onto an empty workspace, and **Replace device identity** (Settings → Sharing; `replaceDeviceIdentity` in `identity.ts`, native `replace_device_identity`) retires a lost or exposed key: it mints a new actor whose clock starts past all history, refuses any actor already in history, records the retired actor, and re-logs that device's own data under the new key so peers receive edits the old key can no longer sign. Shared projects must re-invite the replaced device. |
| R11 | Input contract implemented and shared adversarial corpus passes | Both engines bound work windows, duration, dates, importance, energy/curve, IDs and busy intervals. Missing/out-of-bounds/colliding pins become explicit unscheduled conflicts in stable ID order. Corpus is shared between Rust/TS. Broader property testing remains R26. |
| R12 | Implemented; expanded calendar fixtures pass | UTC/IANA and feed-local VTIMEZONE, detached exceptions/cancellation, RDATE/EXDATE, DST/overnight/all-day clipping. Source freshness/coverage/timezone metadata commits with events; Plan shows stale/legacy warnings. Retained feed re-expands beyond its horizon without resetting freshness; connected calendars refresh outside coverage. Legacy wall-time sources require explicit refresh/reimport. Wider provider-export and installed timezone matrix remains. |
| R13 | Atomic plan/reflow implementation verified locally | Durable workspace snapshots, stale rejection, one schedule/history/revision/rationale commit; drag/pin and completed occupancy fixtures pass. Cancellation preserves prior plan; calendar changes trigger debounced reflow with in-flight guard. Installed native cancellation/window fixtures remain external. |
| R14 | V2 signed incremental protocol implemented; local convergence passes | Immutable context-bound ECDSA batches (local authors only), durable exact-ciphertext outbox, verified acknowledgements, endpoint/room-scoped persisted cursors and actor-key pins, five-minute future-clock rejection, bounded rounds and persisted automatic retry backoff/diagnostics. Three independent row/history stores converge through outage, duplicate delivery and reconnect. Unreadable/tampered/gapped pages never advance cursors. Legacy blobs retained for explicit bundle migration. Journal compaction, explicit workspace key/endpoint migration, larger profiles and deployed multi-device fault evidence remain. |
| R15 | Signed context/invites and revoke epochs implemented | Strict project/task/member/comment scope and genesis/device key pins. Owner-signed invitations reject tampering, trust replacement and epoch downgrade. Revocation checkpoints current content, publishes an old-room signed freeze, then rotates secret/room/epoch; clients preflight before uploads and pause on a newer epoch. Remaining members receive new signed invites externally; old-epoch data remains readable to previous members. Local revoked-device tests pass. Offline edit transfer across rotation, project moves between shares and hostile relay withholding need further policy/evidence. |
| R16 | Encrypted browser vault and identity recovery implemented | Desktop fail-closed keychain and verified migration. Browser secrets encrypted with a non-exportable IndexedDB CryptoKey; verified migration redacts legacy plaintext secret copies while retaining task/history evidence. Recovery v2 contains signing identity, tasks/projects/history and relay/share capabilities; random salt, PBKDF2-SHA256/600000 iterations; empty replacement-only restore, transactional identity/data marker and retryable capability restoration. Passphrase rewrap UI/API and browser/native rollback tests. Retire the old device; calendars/templates/settings require separate backup. Browser vault is accessible to same-origin scripts. Changing an active workspace passphrase/relay is blocked until an explicit signed-history migration is provided; recovery-kit passphrase changes work. Installed keychain crash/recovery and complete device replacement matrix remain. |
| R17 | Durable batch journal, quotas and metrics implemented | Immutable v2 batch IDs/cursors survive restart; duplicate ciphertext gets the same acknowledgement, collisions return 409. File-synced publication before success, persistence failure returns 503 preserves memory, corrupt startup fails, bounded payload/store/room/journal/rate/poll limits. Auth-gated aggregate /metrics and TLS proxy guide. Real local HTTP persistence-failure and poll-saturation/health tests pass. Actual disk-full, slow-upload and public staging load validation remain; proxy request deadlines are required. |
| R18 | Loopback/token lifecycle implemented; live provider evidence pending | Bound 127.0.0.1:8788 callback before consent, exact state/path/host, bounded reads, ten-minute listener, cancellation and automatic Tauri handoff; opens external consent browser. PKCE pending state is secret storage; replay/single-exchange guards, single-flight token refresh, disconnect-during-refresh rejection, scheduled availability refresh, Microsoft pagination with fixed endpoint validation, bounded native responses and atomic metadata/events. Mock lifecycle tests pass. Real Google/Microsoft registration, connect/refresh/revoke/recovery and installed callback tests remain external. |
| R19 | Offline/update lifecycle verified in Chromium | Full content-versioned precache; update notification and persistent-storage request UI. Workers wait for all old clients to close. Production tests verify offline boot/lazy Settings, failed deployment preserving old shell, unsaved editor survival while update waits, final activation/cache cleanup and offline reopen. Real mobile installation, storage eviction and installed-browser matrix remain external. |
| R20 | Saved-plan review and capture workflow implemented | Semantic planner inputs are stored with the atomic plan record and checked on entry/reload, task changes, settings/calendar events and focus. Current, missing, changed/legacy and unreadable plan states retain tasks and explanations. Capture/review entry points, persisted overflow reasons and explicit write-versus-refresh failures. Browser regressions cover reload, capture, conflict and quota failure. Live provider and installed acceptance remain external. |
| R21 | Core keyboard/touch planner implemented; broader audit pending | Native buttons replace click-only block/backlog titles; pin state is announced. Reschedule dialog uses labelled inputs, focus trapping/restoration and atomic move/pin/reflow; errors preserve input. Narrow layout scrolls to the backlog, fits the editor and scales short blocks to avoid overlapping controls; 390px regression passes. Existing reduced-motion support retained. An automated axe WCAG 2 A/AA scan (`e2e/axe.spec.ts`) of Plan, Dashboard, Tasks, the task editor and Settings fails the build on serious/critical violations; it found and fixed unlabeled settings controls, invalid view-switch ARIA roles, a non-focusable scrolling timeline, and low-contrast completed cards. Full application focus/order audit, genuine screen-reader and installed/touch-device matrix remain pending. |
| R22 | Local team journeys implemented; deployed acceptance pending | Opt-in, member-signed, title-free busy intervals and working hours expire after 15 minutes. Missing/stale/read-only members are excluded with diagnostics; busy unions reduce capacity and departed explicit assignees remain unroutable. Assignment review binds caller, day, share epoch, roster, tasks and planning inputs; one guarded SQLite/IndexedDB history batch applies all assignments. Signed fake-relay owner/editor/viewer/revoked-device, quota, stale/mutated proposal and browser review journeys pass. Deployed independent-device and live-calendar acceptance remain external. |
| R23 | Implemented; live provider acceptance pending | Exact remote endpoint/system/prompt preview and explicit consent before each remote request; loopback classification uses the actual destination. Requests can be cancelled, Rust enforces bounded time/response size/no redirects, and strict whole-response schemas reject unknown IDs, coercions and invalid dates. Offline quick capture falls back without AI; estimate provenance persists with atomic scheduling writes. AI contract/privacy tests pass. Provider-specific live tests and real local-model offline acceptance remain. |
| R24 | Linux isolated native smoke passes; Windows/macOS installed matrix open | Linux Tauri WebDriver verified webview/window/tray registration, OS keychain and cache probes, UI-to-SQLite task commit, coherent backup/restore, second-instance focus and acknowledged write after hard kill. Update requires a verified pre-update backup and drains database writes before signed install; mocked update failure/order tests pass. CI cross-platform native storage tests are added. Windows/macOS installed smoke, native notification delivery/actions, shell-specific tray/menu behavior and installed update/restore remain. |
| R25 | Implemented; baseline captured with provisional regression gates | Session-only diagnostics store bounded, allowlisted operation/outcome/time data; export contains no task IDs/text, URLs, prompts or credentials. Sync health/retry state and notification outcomes are visible. Reproducible TypeScript and real relay harnesses retain raw samples and CPU/memory/latency metadata. Local reports record 10k-task/50k-op work and 250 durable relay uploads; CI checks generous measured-baseline regression ceilings. Native/browser startup and interaction, SQLite, signed-client sync and public load remain unmeasured. |
| R26 | Branch CI and local gates pass; installed acceptance pending | Added shared Rust/TypeScript planner runner and 272-case adversarial/seeded parity gate; native SQLite tests cover six historical schema prefixes, reopen, additive migration and injected rollback; Linux WebDriver tests backup/restore, single instance and hard kill; existing browser, PWA, relay outage/replay and recovery suites retained. Branch workflow [38301619235](https://github.com/adityatawde9699/Cognate/actions/runs/38301619235) passed Linux native smoke/bench/parity and Windows/macOS native Rust test/Clippy/parity. Windows/macOS installed native runs, live providers/relay, mobile eviction and remaining fault matrix still block completion. |
| R28 | Open | No PWA field study or native mobile decision evidence exists. |
| R27 | Candidate pipeline verified; production acceptance pending | rc.6 passed tagged blocking checks and Linux/macOS/Windows packaging. Version/MSI parity, six updater signatures, nine manifest entries, 14 asset checksums and 15 published download links verified. OS signing/notarization, installed upgrade/data-restore and web deployment/rollback acceptance remain pending. |

Local verification is recorded in [TESTING.md](docs/TESTING.md). R23 and the measured portions of R25 are implemented; R24 and R26 have substantial local gates, and the remote branch workflow passed. Installed Windows/macOS acceptance, provider and OAuth validation, deployed relay tests, and release acceptance remain open. Cognate is not production-ready while these checks remain open. Dependency installation found a Vitest advisory; upgrading to 4.1.11 produced a clean npm audit.

## Next implementation sequence

R12–R22 have local implementation and regression evidence with deployed/installed acceptance limits recorded above. R23 now has privacy review, strict output contracts, cancellation, offline fallback, persisted provenance, and contract tests; live providers remain to validate. R24's isolated Linux lifecycle suite and R25's reproducible local measurements are implemented. R26's Linux native smoke, database recovery, differential planner, performance, relay replay, browser and PWA gates, plus Windows/macOS native Rust contract jobs, passed remote branch workflow 38301619235 and tagged workflow 38302836329. The rc.7 prerelease's three platform packages, six updater signatures, nine manifest entries and 14-asset checksum file were verified. Address the 2026-11-18 audit additions R29–R31 (web CSP and least-privilege capabilities, IPC fetch validation, relay panic resilience) alongside the acceptance work. Finish the real Windows/macOS installed-app matrix, provider/OAuth and deployed relay trials, disk/slow-client/load faults, mobile eviction study, and remaining protocol policy work. No production deployment has been performed.

---


---

# Part I — Current-state technical audit (2026-11-18)

**Scope.** The audit covers commit `de9e5d1` on `master` (version `3.1.0-rc.7`), the only repository in scope. It replaces the original v3.0.3 audit of commit `d04dac5`, which described code that has since been rewritten. Findings are labelled **Fact** (cited file and line, or output of a command run for this audit), **Assumption** (a reasoned inference that was not directly verified), or **Recommendation**. Line numbers refer to `de9e5d1`.

**What could not be inspected.** Installed Windows and macOS builds, live Google and Microsoft OAuth, a deployed relay, mobile browsers, the GitHub Discussions/Insights pages, and `cargo audit` (it is not installed locally). These are marked *Unable to verify* wherever they matter.

## A1. Executive summary

**Fact.** Cognate is a GPL-3.0, local-first planner. It has three parts: a React 19/Vite web client, a Tauri 2 desktop shell with SQLite, and a small Rust relay that stores only ciphertext. Its core assets are:

- a deterministic day planner implemented twice, in Rust ([src-tauri/src/planner.rs](src-tauri/src/planner.rs)) and TypeScript ([src/services/planService.ts](src/services/planService.ts)), with a 272-case parity gate;
- a signed, hybrid-logical-clock operation log that commits atomically with its projection on both SQLite and IndexedDB;
- an end-to-end encrypted, signed incremental sync protocol (v3 key derivation: passphrase plus random setup code, PBKDF2 600k, HKDF).

The v3.0.3 audit's critical data-integrity defects have local implementations and regression tests (ledger rows R01–R17). Startup deduplication no longer deletes tasks, writes are atomic, operation-ID collisions are rejected, backups use online snapshots, and relay writes are fsync-acknowledged.

**Fact (verification run for this audit).**

- `npm run typecheck` passes.
- Vitest passes: 53 files, 387 tests.
- `npm run build` and `verify:build` pass.
- Desktop `cargo test` passes 44 tests; `cargo clippy --all-targets -D warnings` is clean.
- Relay `cargo test` passes 35 tests. Relay `cargo clippy -D warnings` is clean, but `cargo clippy --all-targets -D warnings` fails on a test-only lint at [server/src/main.rs:683](server/src/main.rs#L683) (`clippy::int_plus_one`, Rust 1.98). CI runs relay clippy without `--all-targets`, so the gate misses this.
- `npm audit --omit=dev` reports 0 production vulnerabilities. The full `npm audit` reports 7 advisories (6 high, 1 moderate), all in dev/build tooling (`picomatch`, `source-map-js`, `@vitest/mocker` via vite/vitest).
- E2E, PWA and native smoke suites were not re-run for this audit. CI run 41452523518 (2026-11-02) passed them.

**Verdict.** This is a well-engineered *release candidate*, not a production product. The remaining blockers are acceptance evidence, not missing architecture:

- no OS code signing or notarization;
- Windows and macOS installed apps not exercised;
- live OAuth providers not validated;
- no deployed relay;
- no mobile evidence.

The new defects found by this audit are medium or low severity. The main ones are a missing web CSP, broad Tauri SQL capabilities, three IPC fetchers with weaker validation than their siblings, and relay mutex-poisoning panics. They are listed as R29–R35 in A15. Weighted score: **6.0 / 10** (A14).

## A2. Repository discovery and technology stack

**Fact.**

- **History:** 102 commits from 2026-03-14 to 2026-11-02, 59 of them since 2026-10-01. Two author identities belong to one maintainer.
- **Branches and tags:** five prerelease tags `v3.1.0-rc.3` … `rc.7`, plus one stale remote branch, `copilot/fix-github-actions-job`.
- **GitHub:** public, 4 stars, 0 forks. The issue tracker has 0 issues; there is one closed Copilot PR.

| Layer | Technology (resolved version) | Purpose | License |
|---|---|---|---|
| UI | React 19.2.4, Zustand 5.0.12, Chart.js 4.5.1, Font Awesome 7.2, Fontsource Geist / Space Grotesk | Views, state, analytics charts, icons, fonts | MIT / OFL / CC-BY (icons) |
| Calendar | ical.js 2.2.1 | ICS parsing, recurrence, VTIMEZONE | MPL-2.0 |
| Build/test | Vite 7.3.6, TypeScript 5.9.3, Vitest 4.1.11, Playwright 1.61.1 | Bundling, typing, unit and browser tests | MIT / Apache-2.0 |
| Desktop | Tauri 2.10 (api/cli), plugins sql 2.3, notification, log, shell, process, updater, single-instance; `tauri-plugin-oauth 2.0.0-rc` | Native shell, SQLite, OS integration, signed updates | MIT/Apache-2.0 |
| Native Rust | sqlx `=0.8.6` + libsqlite3-sys `=0.30.1` (pinned for raw backup ABI), reqwest 0.12, tokio, chrono, serde | Transactional store, online backup, bounded HTTP | MIT/Apache-2.0 |
| Relay | tiny_http 0.12, serde_json, sha2 0.11, subtle 2.6 (crate version `0.1.0`) | Ciphertext journal, auth, quotas | MIT/Apache-2.0 |
| Browser storage | IndexedDB ([src/services/browserStorage.ts](src/services/browserStorage.ts)), retained localStorage migration source | Transactional web store | — |
| Crypto | WebCrypto: AES-GCM-256, PBKDF2-SHA256, HKDF-SHA256, ECDSA P-256 | Sync/share encryption, signatures, recovery kits | — |
| CI | GitHub Actions: `test.yml` (Ubuntu full gate + Windows/macOS native contracts), `release.yml` (3-OS Tauri packaging after checks), Pages for `site/` | Gates and packaging | — |

Source layout: `src/` (React plus 40+ services, each with co-located tests), `src-tauri/` (desktop crate, six SQL migrations, `planner-fixture` binary), `server/` (relay crate), `e2e/` (9 specs) and `e2e-production/` (offline PWA), `scripts/` (parity, benchmarks, KAT, native smoke), `benchmarks/` (two recorded runs), `docs/` (8 documents), `site/` (marketing page). There is no root Cargo workspace, Docker configuration or mobile project.

**License note.** GPL-3.0 is compatible with every listed dependency. It does constrain commercial closed-source distribution: anyone distributing a derivative must ship its source.

## A3. Architecture assessment

~~~mermaid
flowchart TD
    UI[React views] --> Cmd[Task / plan / project commands]
    Cmd --> Admit[Validation + op admission: schema, bounds, collision, HLC]
    Admit --> Native[Desktop: Tauri IPC → operation_store.rs SQLite transaction]
    Admit --> Web[Browser: IndexedDB workspace transaction]
    Native --> Outbox[(rows + ops + clock + outbox)]
    Web --> Outbox
    Cmd --> Planner{Planner}
    Planner --> RS[Rust planner.rs] & TS[TS planService mirror]
    Outbox --> Sync[batchSync / relayService v3: seal + ECDSA sign]
    Sync --> Relay[Relay: fsync journal, quotas, rate limits, cursors]
    UI --> Adapters[calendar ICS/OAuth, AI, notifications, updater, backup]
~~~

**Strengths (Fact).**

- **One durable mutation path.** Rows, operations and clock state commit together. Native: [src-tauri/src/operation_store.rs](src-tauri/src/operation_store.rs) `apply_projection_with_identity` (lines 308–335) opens one transaction and checks history preconditions. Browser: the equivalent IndexedDB transaction.
- **A planner contract shared by two engines,** checked by `npm run test:parity` against the `planner-fixture` binary.
- **A ciphertext-only relay** with an explicit durability contract: tmp-file write, `sync_all`, rename, then directory fsync ([server/src/store.rs:106-128](server/src/store.rs#L106-L128)).
- **Fail-closed secret storage**: [src/utils/secrets.ts:24](src/utils/secrets.ts#L24) and [:43](src/utils/secrets.ts#L43) throw instead of writing plaintext.

**Anti-patterns and risks.**

| Issue | Evidence | Why it matters | Recommendation |
|---|---|---|---|
| Webview holds raw SQL authority | `sql:allow-execute` in [src-tauri/capabilities/default.json:14](src-tauri/capabilities/default.json#L14) | Any script injection in the webview can bypass the atomic command layer and the op-log invariant | Move remaining direct SQL behind typed Rust commands; then drop `sql:allow-execute` (R29) |
| Mixed-responsibility mega-modules | [src/db.js](src/db.js) 1,328 lines; [src/style.css](src/style.css) 4,150; [SettingsModal.tsx](src/components/Modals/SettingsModal.tsx) 761; [migrationService.ts](src/services/migrationService.ts) 681 | Platform branching, persistence and policy interleave; regressions are hard to localize | Split `db.js` into `native/`, `web/` and `contract` modules behind one interface (R33) |
| Three sync key generations co-exist | v1 `deriveKey` (150k iterations, fixed salt) at [src/services/crypto.ts:16-17,57](src/services/crypto.ts#L57) is called only from tests; the v2 fixed-salt room at [:73-76](src/services/crypto.ts#L73-L76) is still called by [relayService.ts:146,162](src/services/relayService.ts#L146) for migration; v3 is at [:371](src/services/crypto.ts#L371) | Dead and legacy crypto widens the review surface and keeps an offline-guessable room identifier reachable | Delete v1; set a v2 sunset date (R34) |
| Relay `main.rs` still large | 1,282 lines, but only lines 1–337 are runtime code; the rest is tests | Low risk: modularisation (`auth`, `quota`, `ratelimit`, `routes`, `store`) is real | Move tests into `server/tests/` |
| Version drift | relay crate `0.1.0` versus app `3.1.0-rc.7` | Release notes cannot map relay builds to client protocol versions | Version the relay with the protocol (R32) |

**Assumption.** The planner's free-window greedy search (`plan`, [planner.rs:234-330](src-tauri/src/planner.rs#L234-L330)) is O(n log n + n·w) for n tasks and w free windows. That is adequate for one person's day, and matches the 10k-task measurement in A8.

## A4. Feature implementation verification matrix

Statuses follow the brief: *Fully implemented / Partially implemented / Prototype / Mock/demo only / Not implemented / Unable to verify*. "Fully implemented" means the code path exists and is tested locally. It does not mean installed or production acceptance.

| Feature | Claimed | Actual implementation | Evidence | Status |
|---|---|---|---|---|
| Task CRUD, Trash, undo, recurrence | Local-first task manager | Atomic commands with op history on SQLite and IndexedDB | [taskService.ts](src/services/taskService.ts), `atomicTasks.test.ts`, `recurrence.test.ts`, `task-flow.spec.ts` | Fully implemented |
| Natural-language quick add | Fast capture | Parser and service; offline fallback without AI | [nlQuickAdd.ts](src/services/nlQuickAdd.ts), tests | Fully implemented (English-centric) |
| Deterministic day planner | Rust + TS parity | Both engines; 272-case parity gate; explicit conflicts | [planner.rs](src-tauri/src/planner.rs), [planService.ts](src/services/planService.ts), `scripts/reliability.mjs` | Fully implemented |
| Atomic plan / auto-reflow | Plans are all-or-nothing | Snapshot-checked single commit; debounced reflow | `atomicPlans.test.ts`, `planReview.test.ts`, `plan-review.spec.ts` | Fully implemented |
| Energy-aware scheduling | Learns your energy | Heuristic over completion hour and Pomodoro counts | [energyModel.ts](src/services/energyModel.ts) | Partially implemented (heuristic, unvalidated) |
| Op-log / CRDT convergence | Source of truth | HLC, collision rejection, admission bounds, durable outbox | [oplog.ts](src/services/oplog.ts), [operation_store.rs](src-tauri/src/operation_store.rs), `batchProjection.test.ts` | Fully implemented (task/project only) |
| Milestone/template/settings replication | `recordSync.test.ts`, `operation_store` record tests | Milestones and templates in the op-log; settings per-device by design | Ledger R06 | Implemented |
| Personal E2E sync | Encrypted, signed | v3 KDF + signed batches, cursors, acknowledgements, retry | [relayService.ts](src/services/relayService.ts), [batchSync.ts](src/services/batchSync.ts), `relayServiceV3.test.ts` | Fully implemented locally; deployed relay *Unable to verify* |
| Shared projects, roles, revocation | Team sharing | Signed invites, scoped admission, epoch rotation | [collab.ts](src/services/collab.ts), [shareService.ts](src/services/shareService.ts), `team-review.spec.ts` | Partially implemented (offline-edit transfer across epochs and hostile withholding open) |
| Team capacity plan | Team planning | Member-signed busy intervals, assignment review | `teamPlanService`, `plan_team` in planner.rs | Fully implemented locally |
| ICS import and subscription | Calendar import | ical.js recurrence, VTIMEZONE, DST, overnight clipping | [calendarSyncService.ts](src/services/calendarSyncService.ts), fixtures | Fully implemented |
| Google / Microsoft calendar | OAuth free/busy | Loopback PKCE, state checks, refresh, pagination | [oauthCalendarService.ts](src/services/oauthCalendarService.ts), [integrations.rs:162-210](src-tauri/src/integrations.rs#L162-L210) | Unable to verify (mocked lifecycle only) |
| AI helpers (10 providers) | AI productivity | Desktop-only HTTP wrapper with consent preview and strict schemas | [ai.rs](src-tauri/src/ai.rs), [aiValidation.ts](src/services/aiValidation.ts) | Fully implemented; live providers *Unable to verify* |
| Slack / Discord notifications | Integrations | Posts to a user-supplied webhook URL | [integrations.rs:40-63](src-tauri/src/integrations.rs#L40-L63) | Partially implemented (no URL validation; no tests found) |
| Backup / restore | Recoverable | SQLite online snapshot, integrity check, transactional restore | [backup.rs](src-tauri/src/backup.rs), `backupService.test.ts` | Fully implemented on Linux; Windows/macOS installed *Unable to verify* |
| Recovery kit | Device replacement | v2 kit with identity, tasks, history and capabilities | [recoveryService.ts](src/services/recoveryService.ts) | Fully implemented (calendars/templates/settings excluded) |
| PWA offline | Works offline | Content-versioned precache, update lifecycle | `public/sw.js`, `e2e-production/offline.spec.ts` | Fully implemented in Chromium; mobile *Unable to verify* |
| Tray, notifications, updater | Native app | Code plus Linux WebDriver smoke; verified pre-update backup | [lib.rs](src-tauri/src/lib.rs), `scripts/native-smoke.mjs` | Partially implemented (Windows/macOS installed open) |
| OS code signing / notarization | Signed releases | Updater signatures only; Apple/Windows certificate steps commented out | [release.yml:67-73](.github/workflows/release.yml#L67-L73) | Not implemented |
| iOS / Android native | Early README history claimed | No mobile project | Repository tree | Not implemented |
| Analytics keyboard shortcut | — | Commented-out TODO | [useShortcuts.ts:64](src/hooks/useShortcuts.ts#L64) | Not implemented |

## A5. Security audit report

**Strengths (Fact).**

- AES-GCM with random 96-bit nonces.
- v3 sync key derivation: passphrase NFKD normalisation, a 16-byte random setup code in the PBKDF2 salt, 600k iterations, and HKDF domain separation ([crypto.ts:371-395](src/services/crypto.ts#L371-L395)).
- Recovery exports use a random salt.
- Shared-project operations are signed with ECDSA P-256.
- Relay token comparison is constant-time ([server/src/auth.rs:26](server/src/auth.rs#L26)).
- The relay refuses to start without a token on a non-loopback address unless `RELAY_ALLOW_OPEN=1` ([server/src/main.rs:258](server/src/main.rs#L258)).
- Body, store, room and actor quotas ([server/src/quota.rs:7-12](server/src/quota.rs#L7-L12)) and per-IP rate limits.
- AI and calendar HTTP clients are bounded, with no redirects and HTTPS-or-loopback rules ([ai.rs:30-38](src-tauri/src/ai.rs#L30-L38), [integrations.rs:17-26,139](src-tauri/src/integrations.rs#L17-L26)).
- The desktop CSP exists ([tauri.conf.json:27](src-tauri/tauri.conf.json#L27)).
- No `innerHTML` or `dangerouslySetInnerHTML` sinks in `src/`.
- Dynamic SQL in `operation_store.rs:65,328` interpolates only compile-time table and column constants, never user values, so it is not injectable.

No Critical findings were confirmed.

| ID | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| S1 | Medium | Web/PWA build has no Content-Security-Policy | [index.html:4-15](index.html#L4-L15) has no CSP meta tag; the CSP exists only in the Tauri config. The browser vault keeps a non-exportable key usable by same-origin script (ledger R16) | Add a strict CSP meta tag or hosting header matching the Tauri policy; add a build check (R29) |
| S2 | Medium | Webview is granted unrestricted SQL execution | `sql:allow-execute`, `sql:allow-select` at [default.json:14-15](src-tauri/capabilities/default.json#L14-L15) | Narrow to typed commands; this limits the blast radius of any future XSS (R29) |
| S3 | Medium | Relay panics cascade through mutex poisoning | 13 `lock().unwrap()`/`unwrap()` calls in [server/src/routes.rs](server/src/routes.rs) (e.g. lines 65, 132, 208); fixed worker threads at [main.rs:327](server/src/main.rs#L327) do not catch panics | One panic while a lock is held poisons the store. Every later request then panics, until all workers die (denial of service). Use `lock().unwrap_or_else(PoisonError::into_inner)` or `catch_unwind` per request and supervise workers (R31) |
| S4 | Low | `relay_fetch` reads unbounded responses | [integrations.rs:116](src-tauri/src/integrations.rs#L116) `resp.text()`; the sibling calls use `bounded_text` | A hostile or misconfigured relay can exhaust desktop memory. Use `bounded_text` with the relay page bound (R30) |
| S5 | Low | Notification webhooks accept any URL and scheme | [integrations.rs:40-63](src-tauri/src/integrations.rs#L40-L63) posts to `url_or_token` without parsing | Task text can be sent over plain HTTP or to an internal host. Require HTTPS and the `hooks.slack.com` / `discord.com` hosts (R30) |
| S6 | Low | ICS subscriptions allow plain `http://` | [integrations.rs:72](src-tauri/src/integrations.rs#L72) | A network attacker can inject busy time; there is no credential exposure. Warn, or upgrade to HTTPS (R30) |
| S7 | Low | Custom AI endpoint accepts any HTTPS host, including private-network hosts | [ai.rs:34-38](src-tauri/src/ai.rs#L34-L38) | User-configured, consent-previewed; low risk. Document it; optionally flag RFC1918 destinations as "local network" in the consent preview |
| S8 | Low | Legacy v2 room ID uses a fixed salt | [crypto.ts:75](src/services/crypto.ts#L75), still called from [relayService.ts:146,162](src/services/relayService.ts#L146) | Weak passphrases remain offline-guessable for un-migrated users. Publish a sunset date (R34) |
| S9 | Info | Dev-tooling advisories | `npm audit`: picomatch ReDoS GHSA-fc5q-39xc-vjpf, source-map-js GHSA-68fv-2mgg-jv7q, @vitest/mocker; production tree clean | `npm audit fix`; bump vite and vitest patch versions (R32) |
| S10 | Info | Unsigned OS binaries | [release.yml:67-73](.github/workflows/release.yml#L67-L73) | SmartScreen and Gatekeeper warnings; users cannot verify the publisher (ledger R27) |
| S11 | Info | Unused release-candidate OAuth plugin is registered at runtime | [lib.rs:114](src-tauri/src/lib.rs#L114) `tauri_plugin_oauth::init()`; the working flow uses its own listener at [integrations.rs:177](src-tauri/src/integrations.rs#L177); no JS caller | Unneeded attack surface and a pre-release dependency. Remove it (R32) |

Other areas checked:

- **Secrets in git:** no committed keys or tokens were found in the tracked tree. **Assumption:** the full `git log -p` history was not exhaustively scanned for secrets; adding `gitleaks` to CI is recommended.
- **Not applicable:** CSRF (no cookie sessions), file upload (none), container security (no Docker files), server-side SQL injection (the relay has no database).

## A6. Code quality report

**Fact.**

- **Size.** About 26k non-test source lines across TS/JS/Rust/CSS. The largest modules are listed in A3.
- **Type safety.** 134 occurrences of `: any`, `as any`, or `@ts-ignore`/`@ts-expect-error` in non-test `src/`. Rust non-test code has few `unwrap()` calls outside the relay, which has 13 in `routes.rs` (see S3).
- **Swallowed errors.** 16 empty-catch sites. Most are benign (clipboard, persisted-storage query, request cancellation). Sync paths swallow real failures:
  - [useAutoShareSync.ts:46](src/hooks/useAutoShareSync.ts#L46) `syncShare(...).catch(() => {})`;
  - [SharedProjects.tsx:127,140](src/components/SharedProjects.tsx#L127);
  - [migrationService.ts:675](src/services/migrationService.ts#L675).

  These conflict with the R25 diagnostics goal. Route them to `diagnostics.ts` (R33).
- **Style.** Recent Rust is written in dense single-line style (e.g. [operation_store.rs:308-335](src-tauri/src/operation_store.rs#L308-L335), [integrations.rs:139](src-tauri/src/integrations.rs#L139)). Rust formatting is still advisory in CI ([test.yml:82](.github/workflows/test.yml#L82) `continue-on-error: true`). This hurts review and diff quality. Make `cargo fmt --check` blocking after one formatting commit (R33).
- **Duplication.** The planner is deliberately duplicated in Rust and TS. That is justified by the web target and controlled by the parity gate. Task field lists are repeated three times in `operation_store.rs` (lines 53–55 and 314–316) and again in TS. Generate them from one schema list (R33).
- **Tests.** Co-located tests for nearly every service, including adversarial ones (collision, tamper, quota, failpoint, hard kill). Documentation honesty is itself tested ([src/docs-honesty.test.ts](src/docs-honesty.test.ts)). No coverage percentage is measured ([docs/TESTING.md](docs/TESTING.md)). `tests/calcPriority.test.js` remains outside the Vitest include.
- **Dead code.** v1 `deriveKey` ([crypto.ts:57](src/services/crypto.ts#L57)), the unused OAuth plugin (S11), and the commented analytics shortcut.

## A7. AI/ML assessment

**Fact.** Cognate trains no models and has no datasets, embeddings, retrieval/vector store, fine-tuning or offline evaluation harness. [ai.rs](src-tauri/src/ai.rs) is a provider router: Anthropic native, plus nine OpenAI-compatible providers including Ollama and llama.cpp. It is called for quick-add enrichment, drafts, tag/priority suggestions, duration/energy estimates and briefs.

**What is above a plain wrapper:**

- consent previews show the exact endpoint and prompt before each remote request;
- destination-based loopback classification;
- 10 s connect and 60 s total timeouts, no redirects, and bounded responses;
- truncation and refusal detection ([ai.rs:189-191](src-tauri/src/ai.rs#L189-L191));
- whole-response strict schemas that reject unknown IDs and type coercions ([aiValidation.ts](src/services/aiValidation.ts));
- cancellation;
- estimate provenance persisted with scheduling writes.

The schedule itself is always computed by the deterministic planner, which limits the effect of hallucinations to input estimates.

**Verdict.** The AI component is a carefully guarded API wrapper; the product's real intelligence is the deterministic planner. The energy model ([energyModel.ts](src/services/energyModel.ts)) is an unvalidated heuristic.

**Recommendation.** Before marketing AI estimation quality, measure estimate accuracy against actual focus time on opt-in local data (P3).

## A8. Performance and scalability

**Fact (recorded runs).** Both runs were on an i7-13620H and are labelled by the harness as non-browser and non-native.

- **TS planner** ([benchmarks/2026-10-11-node.json](benchmarks/2026-10-11-node.json)): median 0.09 ms for 100 tasks, 0.32 ms for 1k, 3.23 ms for 10k (p95 4.72 ms).
- **50k operations:** admission and merge median 303 ms; materialization 156 ms; task projection 156 ms; history serialization 37 ms.
- **Relay** ([benchmarks/2026-10-11-relay.json](benchmarks/2026-10-11-relay.json)): 250 fsync-backed uploads in 2.1 s, median 8.3 ms, p95 14.2 ms, peak RSS 159 MB. Restart replay, duplicate acknowledgement and collision rejection were all verified.

**Not measured:** browser or desktop startup, interaction latency, SQLite query latency at 10k+ tasks, signed multi-client sync, mobile.

**Scalability (Fact plus Assumption).** The relay is a single process with an in-memory map, a whole-store JSON journal, and hard caps: 32 MiB store, 1,000 rooms, 128 actors, 8 MiB per room ([quota.rs:7-12](server/src/quota.rs#L7-L12)). Its thread-per-worker model ties long polls to workers. That suits self-hosting for an individual or small team, not a public multi-tenant service. Horizontal scaling would need a different store, a deliberate redesign rather than tuning.

**Recommendation.** Capture desktop cold start and IndexedDB 10k-task load before v4.0. The 303 ms 50k-op merge suggests journal compaction (ledger R14) is needed before history grows past roughly 100k operations.

## A9. Dependency and technology assessment

**Fact.**

- **Outdated packages.** `npm outdated` shows patch/minor drift across the Tauri JS plugins (e.g. plugin-updater 2.10.1 → 2.14.1, plugin-sql 2.3.2 → 2.6.0), React 19.2.4 → 19.3.1, and Vite 7.3.6 → 7.3.8. Majors are also available: Vite 8, Vitest 5, TypeScript 7, @vitejs/plugin-react 6.
- **Pinned crates.** `sqlx =0.8.6` and `libsqlite3-sys =0.30.1` are pinned on purpose: raw backup handles need a matching ABI. This is justified, but it blocks routine updates and needs an owner.
- **Redundancy.** Three variable font families plus the full Font Awesome package (A2) add weight. This is not measured; check the bundle report. `tauri-plugin-oauth` is unused (S11).
- **Lock-in.** Tauri is the main platform dependency, and an acceptable one: it is MIT/Apache-licensed, and the web build runs without it. Providers are pluggable. The relay protocol is the project's own and documented in [docs/RELAY.md](docs/RELAY.md).

**Recommendation.** Take patch/minor updates in one PR after the release candidate. Defer major upgrades (Vite 8, Vitest 5, TypeScript 7) until after v4.0 (R32).

## A10. Product and competitive analysis

**Problem.** "Open the app and get a current, explainable plan that is safe to change", with local-first privacy.

**Audience.** Privacy-conscious individuals and small teams, plus self-hosters.

**Competitive landscape.** This is based on general product knowledge and was **not re-verified for this audit**; treat it as an assumption.

- **Auto-schedulers:** Motion and Reclaim.ai (cloud, AI auto-scheduling, deep calendar integration).
- **Daily-planning rituals:** Sunsama and Akiflow (cloud, paid).
- **Mature task managers:** Todoist and TickTick (cloud, broad platform coverage).
- **Open-source local planners:** Super Productivity (local-first, no end-to-end encrypted relay).

**Differentiators (Fact from code).** No competitor named above combines the following, as far as general knowledge goes (not re-verified):

- deterministic, explainable planning that works offline and is identical in browser and desktop;
- end-to-end encrypted, *signed* sync through a relay the user can host;
- shared projects with key-rotation revocation;
- AI that is optional and consent-previewed.

The novelty is in the integration and the engineering rigour, not in any single algorithm. The planner is a greedy heuristic, and CRDT/HLC operation logs are established techniques.

**Product maturity.** Release candidate with zero external issues or contributors. There is no user-research evidence (ledger R28). Commercial potential is limited by GPL-3.0 and by competing against well-funded cloud tools. The plausible paths are open-source plus paid hosted relay or support, or a privacy niche.

## A11. Repository health and maintenance

**Fact.**

- **Activity.** Single maintainer, actively developed: the latest commit is 2026-11-02, 16 days before this audit, which is a pause rather than abandonment.
- **Commit discipline.** Conventional commits mapped to roadmap IDs.
- **CI reliability.** Mixed but recovering. Of the last 10 runs, 6 passed and 4 failed. The failures (2026-10-11 and 2026-11-02) were fixed by the following commit, and HEAD is green (run 41452523518).
- **Releases.** Five release-candidate tags; rc.7's artifacts and signatures were verified (ledger R27). No stable release.
- **Gaps.** No external contributors, no issue triage history, and a stale remote branch (`copilot/fix-github-actions-job`).
- **Bus factor.** 1. This is the largest maintenance risk.

## A12. Technical debt inventory

| Debt | Evidence | Consequence | Item |
|---|---|---|---|
| Mega-modules | `db.js` 1,328, `style.css` 4,150, `SettingsModal.tsx` 761, `migrationService.ts` 681 lines | Slow review; platform branches interleaved | R33 |
| Advisory Rust formatting, dense one-line Rust | [test.yml:82](.github/workflows/test.yml#L82) | Unreviewable diffs in critical storage code | R33 |
| Weak typing pockets | 134 `any`/ignore sites | Contract drift at IPC and storage boundaries | R33 |
| Swallowed sync errors | A6 list | Users are not told sync failed | R33 |
| Legacy crypto generations | A3, S8 | Larger audit surface | R34 |
| Repeated schema field lists | operation_store.rs, TS adapters | Column added in one place, missed in another | R33 |
| Relay clippy gate excludes tests | CI runs relay clippy without `--all-targets`; local failure at main.rs:683 | Lint debt accumulates in tests | R32 |
| No coverage measurement | docs/TESTING.md | Untested branches are invisible | R35 |
| Entities outside history | settings (R06, by design) | Per-device; back up the database to keep them | R06 |
| Journal compaction absent | R14 ledger; 50k-op merge at 303 ms | History growth degrades sync and startup | R14 |

## A13. Multiple repository comparison

Not applicable. Only the Cognate repository was provided. Its `server/` relay and `site/` folders are sub-projects of the same product and should stay together.

## A14. Weighted technical scorecard

Method: each criterion is scored 0–10 from the evidence above, then weighted toward production risk. The weighted mean is rounded to one decimal place. Scores judge the **current release candidate against a production bar**, not effort.

| Criterion | Weight | Score | Rationale |
|---|---:|---:|---|
| Security | 15 | 6 | Strong crypto and fail-closed secrets; but no web CSP, broad SQL capability, relay panic DoS, unsigned OS binaries |
| Architecture | 12 | 7 | One atomic mutation path, a clean relay boundary, a parity-checked planner; webview SQL authority and `db.js` coupling remain |
| Code quality | 12 | 6 | Rigorous logic and tests, but mega-modules, 134 `any` sites, dense unformatted Rust, swallowed errors |
| Testing | 12 | 7 | 387 unit, 44 + 35 Rust, about 35 browser tests, parity, KAT, native smoke and fault tests; no coverage, no installed Windows/macOS or live-provider runs |
| Product readiness | 12 | 4 | Release candidate only; no OS signing, unvalidated OAuth, no deployed relay or user study |
| Maintainability | 10 | 6 | Excellent traceability (ledger ↔ commits ↔ tests); bus factor of 1 and large modules |
| Performance | 8 | 7 | Measured and fast for target sizes; startup and interaction unmeasured |
| Scalability | 7 | 4 | Single-process relay with hard caps; suited to self-hosting by design |
| Documentation | 7 | 7 | Honest, tested README claims and detailed ledger; this roadmap previously audited a stale commit |
| Innovation | 5 | 6 | Rare combination of offline deterministic planning and signed end-to-end sync; techniques individually established |
| **Weighted overall** | 100 | **6.0** | (90+84+72+84+48+60+56+28+49+30)/100 |

## A15. Prioritized improvement roadmap (audit additions)

The existing R01–R28 items remain authoritative; their open acceptance work is in the ledger above. This audit adds R29–R35 and re-ranks the existing open work:

- **P0 (release blockers, existing):**
  - R27 OS signing and notarization plus installed upgrade/restore;
  - R24/R26 Windows/macOS installed matrix;
  - R18 live OAuth;
  - R17 deployed relay faults (disk-full, slow client, load).
- **P1:** R29, R30, R31 below; R16 browser-vault same-origin exposure, which R29's CSP mitigates.
- **P2:** R32, R33, R34, R35; R14 journal compaction.
- **P3:** R28 mobile decision; AI estimate accuracy study (A7); R22 deployed team trials.

### R29 — Web CSP and least-privilege Tauri capabilities

- **Priority / complexity:** P1 / M.
- **Problem:** The web build lacks a CSP, and the desktop webview can execute arbitrary SQL.
- **Evidence:** S1, S2.
- **Solution:** Add a CSP meta tag or hosting header equivalent to [tauri.conf.json:27](src-tauri/tauri.conf.json#L27), and assert it in `scripts/verify-build.mjs`. Route remaining `db.js` SQL through typed Rust commands, then remove `sql:allow-execute` and `sql:allow-select`.
- **Files:** `index.html`, `scripts/verify-build.mjs`, `src-tauri/capabilities/default.json`, `src/db.js`, `src-tauri/src/operation_store.rs`.
- **Benefit:** Script injection can no longer silently rewrite data outside the op-log or read the browser vault.

### R30 — Uniform validation for desktop network IPC

- **Priority / complexity:** P1 / S.
- **Problem:** `relay_fetch`, `send_notification` and `fetch_ics` are weaker than the AI and OAuth fetchers.
- **Evidence:** S4–S6.
- **Solution:** Use `bounded_text` everywhere. Require HTTPS plus a host allowlist for webhooks. Upgrade ICS to HTTPS or warn when it is plain HTTP. Add a unit test per command, mirroring `calendar_tokens_cannot_be_sent_to_arbitrary_endpoints`.
- **Files:** `src-tauri/src/integrations.rs`.
- **Benefit:** Bounded memory, and no task text sent over cleartext.

### R31 — Relay panic resilience

- **Priority / complexity:** P1 / S.
- **Problem:** A single panic can poison the shared mutexes and kill every worker.
- **Evidence:** S3.
- **Solution:** Recover poisoned locks and replace the `get_mut(...).unwrap()` calls in `routes.rs` with `?`-style 500 responses. Wrap `serve` in `catch_unwind` and count panics in `/metrics`. Add a test that injects a panic and then expects the relay to keep serving.
- **Files:** `server/src/routes.rs`, `server/src/main.rs`.
- **Benefit:** The relay keeps serving after a bug instead of degrading to a total outage.

### R32 — Dependency and gate hygiene

- **Priority / complexity:** P2 / S.
- **Problem:** Dev advisories, an unused release-candidate plugin, version drift, and a clippy gate that skips tests.
- **Evidence:** S9, S11, A3, A1.
- **Solution:**
  - run `npm audit fix` and take patch/minor bumps;
  - remove `tauri-plugin-oauth` from `Cargo.toml` and `lib.rs`;
  - version the relay with the protocol;
  - change CI relay clippy to `--all-targets` and fix [main.rs:683](server/src/main.rs#L683);
  - add `cargo audit` and `gitleaks` jobs;
  - delete the stale remote branch.
- **Files:** `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `server/Cargo.toml`, `.github/workflows/test.yml`.
- **Benefit:** A smaller supply-chain surface, and gates that match what local tooling checks.

### R33 — Code health without a rewrite

- **Priority / complexity:** P2 / L, done incrementally.
- **Problem:** Mega-modules, `any` usage, swallowed sync errors, unformatted Rust, and repeated field lists.
- **Evidence:** A6, A12.
- **Solution:**
  - one `cargo fmt` commit, then make the formatting check blocking;
  - split `db.js` by platform behind its existing `db.d.ts` contract;
  - split `SettingsModal` per settings panel;
  - route swallowed sync errors to `diagnostics.ts`;
  - generate the task/project field lists from one source;
  - set a ratchet that lets the `any` count only fall.
- **Files:** `src/db.js`, `src/components/Modals/SettingsModal.tsx`, `src/hooks/useAutoShareSync.ts`, `src/components/SharedProjects.tsx`, `src-tauri/src/operation_store.rs`.
- **Benefit:** Faster, safer review of storage code; sync failures become visible.

### R34 — Retire legacy key derivation

- **Priority / complexity:** P2 / S.
- **Problem:** The v1 (dead) and v2 (fixed-salt) derivations remain.
- **Evidence:** A3, S8.
- **Solution:** Delete v1 `deriveKey` and its tests. Show a v3 migration prompt and announce a v2-room sunset release; after that release, remove `deriveRoomId`. Keep known-answer test (KAT) vectors for v3.
- **Files:** `src/services/crypto.ts`, `relayService.ts`, `migrationService.ts`.
- **Benefit:** A smaller crypto audit surface; no reachable offline-guessable room IDs.

### R35 — Measure coverage

- **Priority / complexity:** P2 / S.
- **Problem:** Branch coverage of critical modules is unknown.
- **Evidence:** [docs/TESTING.md](docs/TESTING.md).
- **Solution:** Report `vitest --coverage` and `cargo llvm-cov` as CI artifacts. Set per-module floors for `oplog`, `operation_store`, `crypto` and `collab` only, with no global percentage gate. Fold `tests/calcPriority.test.js` into `src/` or delete it.
- **Files:** `vitest.config.js`, `.github/workflows/test.yml`.
- **Benefit:** Evidence for the "tested" claims in this roadmap.

## A16. Final verdict and strategic recommendations

1. **Do not start new features before v4.0.** The architecture is now sound. The remaining value lies in *acceptance evidence*: signing and notarization, the installed Windows/macOS matrix, live OAuth, and a deployed relay fault trial.
2. **Close the cheap security gaps first** (R29–R31, about one week of work, an assumption). They are the only new code-level risks this audit found.
3. **Pay down code-health debt incrementally** (R32–R33), starting with blocking Rust formatting and a `db.js` split. Do not rewrite.
4. **Position Cognate as a privacy-first, self-hostable planner.** Do not compete with cloud AI schedulers on breadth. Keep AI optional and keep the deterministic planner at the centre.
5. **Reduce the bus factor.** Publish contributor-facing architecture notes generated from this audit, label "good first issues" from R32/R33, and open the issue tracker for users of the release candidate.

**Overall:** 6.0/10. A credible, unusually well-tested release candidate. Production readiness depends on distribution and live-environment evidence, not on redesign.

---

# Part II — Production plan (sections 15–29)

The section numbers are kept from the original roadmap because commits, the ledger and [docs/TESTING.md](docs/TESTING.md) refer to them. Sections 1–14 of the original v3.0.3 audit are superseded by Part I. The task definitions below (R01–R28) are unchanged; their current status is in the ledger at the top of this file.

## 15. Target Architecture

~~~mermaid
flowchart TD
    UI[React UI: Today, Inbox, Tasks, Calendar, Team] --> App[Application commands and queries]
    App --> Domain[Validated task, calendar, membership policies]
    Domain --> Solver[One planner contract: Rust desktop, tested TS web mirror]
    App --> Commit[Atomic local commit]
    Commit --> Ops[Validated op-log and durable outbox]
    Commit --> Proj[Queryable projections]
    Ops --> Store[SQLite desktop / IndexedDB web]
    Proj --> Store
    Ops --> Crypto[Workspace or share encryption and signatures]
    Crypto --> Relay[Bounded ciphertext relay]
    App --> Adapters[Calendar, AI, notifications, OS services]
~~~

One command layer should validate input, commit the operation plus projection, and return an explicit success or error result. The op-log can become authoritative after a measured, reversible migration proves replay equals the existing database on real data. Keep the Rust planner and TypeScript web path with a shared input/output contract and differential corpus; browser Rust/WASM is an option only if parity maintenance proves costly. Use platform adapters for storage, secrets, notifications, calendar transport, updates, and file operations. Keep the relay simple and ciphertext-only, with bounded, durable writes and an explicit threat model.

## 16. Development Phases

| Phase and release | Dependency-aware outcome | Tasks |
|---|---|---|
| 0 — v3.x baseline and data protection | Stop unintended deletion; make checks and claims honest; prove backups | R01–R03 |
| 1 — v3.x local data integrity | Audit existing data, make writes atomic, cover mutations, reconcile safely | R04–R07 |
| 2 — v3.x planner correctness | Validate inputs, calendar time, and atomic reflow | R11–R13 |
| 3 — v4.0 durable web storage and sync | Migrate browser data; validate operations and identity; harden personal/shared sync and relay | R08–R10, R14–R17 |
| 4 — v4.0 integrations and product loop | Complete OAuth, PWA offline behavior, Today workflow, accessibility | R18–R21 |
| 5 — v4.0 native and release readiness | Platform polish, diagnostics, reproducible tests, signed releases | R24–R27 |
| 6 — v4.x measured additions | Team workflow and AI privacy/quality improvements | R22–R23 |
| 7 — v5+ decision | Pilot native mobile only against proven PWA gaps | R28 |

Security, recovery, and observability are gates within these phases, not work postponed until the end.

## 17. Detailed Task Breakdown

Effort is XS/S/M/L/XL. Risk is implementation or migration risk. Each done condition is a reviewable acceptance test.

### R01 — Stop automatic task deletion

- **Priority / effort / risk:** P0 / S / Low.
- **Why:** Startup deduplication can erase intentionally identical tasks.
- **Current implementation:** initDb calls dedupeTasks in [src/db.js](src/db.js).
- **Required change:** Disable automatic content-based deletion; report suspected duplicates by ID and origin.
- **Files/modules:** src/db.js, deduplication tests.
- **Dependencies:** None.
- **Definition of done:** Boot never deletes a user task; a fixture with intentionally identical tasks remains intact.

### R02 — Establish an enforced baseline

- **Priority / effort / risk:** P0 / S / Low.
- **Why:** Documentation and CI overstate the guarantees currently checked.
- **Current implementation:** Local checks pass, but CI omits typecheck and build gates.
- **Required change:** Add typecheck, production build, and build verification gates; correct README, architecture, testing, and benchmark claims.
- **Files/modules:** .github/workflows/test.yml, README.md, docs/.
- **Dependencies:** None.
- **Definition of done:** Pull requests fail on any required check and documentation matches implementation.

### R03 — Prove backup and restore

- **Priority / effort / risk:** P0 / L / High.
- **Why:** A live file copy can be inconsistent or replaced while SQLite holds a connection.
- **Current implementation:** Checkpoint errors are swallowed before a live database file is copied.
- **Required change:** Use SQLite online backup or a quiesced verified snapshot; close/reopen connections for restore and run integrity checks.
- **Files/modules:** src-tauri/src/backup.rs, src/services/backupService.ts, database adapter.
- **Dependencies:** R02.
- **Definition of done:** Crash, WAL, and migration restore fixtures preserve every row and operation.

### R04 — Audit and repair historical op-log gaps

- **Priority / effort / risk:** P0 / L / High.
- **Why:** Existing replay is incomplete, and blind cutover risks loss.
- **Current implementation:** Backfill checks whether an entity appears in the log, not whether its latest fields match.
- **Required change:** Compare every task/project field with projected history, save a pre-migration snapshot, and generate explicit repair operations with provenance.
- **Files/modules:** src/services/oplogStore.ts, src/services/projector.ts, database adapter.
- **Dependencies:** R03.
- **Definition of done:** A reversible report identifies differences, and repair yields equal state without silent deletion.

### R05 — Make commands atomic

- **Priority / effort / risk:** P0 / XL / High.
- **Why:** Database success and op-log failure currently diverge.
- **Current implementation:** taskService writes the DB and begins best-effort logging separately.
- **Required change:** Add a validated command transaction that commits the operation, projection, and outbox together, with explicit errors.
- **Files/modules:** src/services/taskService.ts, database adapter, src/services/oplogStore.ts.
- **Dependencies:** R03–R04.
- **Definition of done:** Injected failures leave both data layers committed or both unchanged.

### R06 — Cover every durable mutation

- **Priority / effort / risk:** P0 / L / High.
- **Why:** Undo, reorder, recurrence, planning, and projects bypass history.
- **Current implementation:** These paths call direct database helpers or only partly log changes.
- **Required change:** Route durable mutations through R05 and make recurrence identity idempotent.
- **Files/modules:** taskService, planService, quickAddService, history and project code.
- **Dependencies:** R05.
- **Definition of done:** Replay reconstructs all supported user actions, including recurrence and undo.

### R07 — Make projection and reconciliation safe

- **Priority / effort / risk:** P0 / L / High.
- **Why:** Incomplete replay can overwrite newer local data.
- **Current implementation:** Reconciliation performs individual upserts and deletes.
- **Required change:** Gate cutover on parity, apply validated batches transactionally with revision checks, and support rollback.
- **Files/modules:** src/services/syncService.ts, src/services/projector.ts, database adapter.
- **Dependencies:** R04–R06.
- **Definition of done:** Interrupted import and duplicate replay preserve a consistent database.

### R08 — Migrate web storage

- **Priority / effort / risk:** P1 / XL / High.
- **Why:** Whole-array localStorage writes do not scale or provide transactional safety.
- **Current implementation:** Browser fallback stores data synchronously in localStorage.
- **Required change:** Prototype and adopt a transactional IndexedDB adapter with versioned import, quota handling, and cross-tab coordination.
- **Files/modules:** src/db.js, new web storage adapter and migration tests.
- **Dependencies:** R05–R07.
- **Definition of done:** Existing browser profiles upgrade and survive interrupted migration.

### R09 — Validate operations and collisions

- **Priority / effort / risk:** P0 / M / Medium.
- **Why:** The same operation ID can carry different values and produce different final states by arrival order.
- **Current implementation:** Merge accepts the first duplicate ID.
- **Required change:** Add schema/version checks, canonical content commitment or explicit collision rejection, size bounds, and a deterministic tie policy.
- **Files/modules:** src/services/oplog.ts, append and ingest paths.
- **Dependencies:** R04.
- **Definition of done:** Permutation, collision, malformed, and replay tests converge or reject deterministically.

### R10 — Persist clock and device identity safely

- **Priority / effort / risk:** P0 / M / Medium.
- **Why:** Restart and clock rollback can undermine unique operation identities.
- **Current implementation:** Clock state is reconstructed from a max-op scan and actor ID is stored as a setting.
- **Required change:** Persist HLC state, bind actor to a stable device key, and define skew and registration rules.
- **Files/modules:** src/services/oplogStore.ts, src/services/identity.ts, migrations.
- **Dependencies:** R09.
- **Definition of done:** Restart and clock rollback cannot reuse an operation identity.

### R11 — Define planner input contracts

- **Priority / effort / risk:** P0 / M / Medium.
- **Why:** Pins and numeric extremes can produce invalid plans.
- **Current implementation:** Pinned blocks bypass collision checks.
- **Required change:** Validate duration, work window, busy intervals, pinned conflicts, importance, and energy curve on both engines.
- **Files/modules:** src-tauri/src/planner.rs, src/services/planService.ts.
- **Dependencies:** R02.
- **Definition of done:** An adversarial shared corpus returns valid blocks or explicit conflicts in Rust and TypeScript.

### R12 — Model calendar time correctly

- **Priority / effort / risk:** P0 / L / High.
- **Why:** DST, overnight events, and recurrence affect availability.
- **Current implementation:** Local wall strings and a narrow ICS parser omit or misinterpret busy intervals.
- **Required change:** Use explicit timezone/instant semantics, clip intervals by day, show source freshness, and expand recurrence under tested rules.
- **Files/modules:** planService, calendarSyncService, oauthCalendarService, calendar schema.
- **Dependencies:** R11.
- **Definition of done:** DST and midnight fixtures never double-book or omit busy time.

### R13 — Commit plans atomically and reflow safely

- **Priority / effort / risk:** P0 / L / High.
- **Why:** A failed or stale solve can leave a partial day.
- **Current implementation:** Planning clears schedules and writes blocks one by one.
- **Required change:** Add plan revision and snapshot validation, a single commit, cancellable/debounced reflow, and persisted rationale.
- **Files/modules:** planService, src/hooks/useAutoReflow.ts, PlanView.
- **Dependencies:** R05–R06, R11–R12.
- **Definition of done:** Edits during solving are retained and the plan remains all-or-nothing.

### R14 — Harden personal sync protocol

- **Priority / effort / risk:** P0 / L / High.
- **Why:** Unsigned whole-log snapshots are fragile and propagation is delayed.
- **Current implementation:** syncNow pushes then pulls sealed per-actor blobs.
- **Required change:** Add authenticated operation batches, cursors and acknowledgements, bounded retries, and convergence diagnostics.
- **Files/modules:** src/services/relayService.ts, relayTransport, syncService.
- **Dependencies:** R07, R09–R10.
- **Definition of done:** Three independent stores converge through outage, duplicate delivery, and reconnect tests.

### R15 — Scope shared authorization and revocation

- **Priority / effort / risk:** P0 / L / High.
- **Why:** Client role checks do not constrain entity scope, and revoked members retain the read key.
- **Current implementation:** authorize receives genesis but no strict project scope; existing share secret remains in use.
- **Required change:** Bind operations to share/project, validate roster history, and define key rotation and revoke epochs.
- **Files/modules:** src/services/collab.ts, shareService, crypto.
- **Dependencies:** R09–R10, R14.
- **Definition of done:** A malicious editor cannot alter another project and a removed member cannot read new-epoch data.

### R16 — Fix secrets and key lifecycle

- **Priority / effort / risk:** P0 / L / High.
- **Why:** Keychain failure can fall back to plaintext settings; recovery omits owner identity.
- **Current implementation:** secrets.ts uses settings fallback and the kit lacks the owner signing key.
- **Required change:** Fail closed or use an explicit encrypted fallback; version the KDF; support identity backup, replacement, and passphrase changes.
- **Files/modules:** src/utils/secrets.ts, src/services/crypto.ts, recoveryService, src-tauri/src/secrets.rs.
- **Dependencies:** R03, R10, R15.
- **Definition of done:** A locked keychain never silently writes plaintext, and recovery limits are tested and shown to users.

### R17 — Bound and durably acknowledge relay writes

- **Priority / effort / risk:** P1 / L / Medium.
- **Why:** Best-effort persistence and unbounded blobs threaten availability and correctness.
- **Current implementation:** One JSON snapshot is rewritten per PUT while long polls occupy workers.
- **Required change:** Add request/storage quotas, durable atomic writes with reported errors, bounded polls/concurrency, metrics, and a TLS deployment guide.
- **Files/modules:** server/src/main.rs.
- **Dependencies:** R14.
- **Definition of done:** Disk-full, oversized request, restart, and poll-load tests produce bounded, correct responses.

### R18 — Complete calendar OAuth

- **Priority / effort / risk:** P0 / L / High.
- **Why:** The live integration and token lifecycle are unverified.
- **Current implementation:** Users paste a code and generated state is not checked on completion.
- **Required change:** Add loopback callback and state validation, fixed provider endpoints, token failure handling, scheduled refresh, and atomic event replacement.
- **Files/modules:** src/services/oauthCalendarService.ts, src-tauri/src/integrations.rs, CalendarAccount.
- **Dependencies:** R12, R16.
- **Definition of done:** Live test accounts connect, refresh, revoke, and recover without token leaks.

### R19 — Make PWA offline lifecycle reliable

- **Priority / effort / risk:** P1 / M / Medium.
- **Why:** First offline launch may lack hashed application assets.
- **Current implementation:** The worker installs a shell-only cache list.
- **Required change:** Precache versioned build assets, handle update/rollback UX and storage persistence, and add offline launch tests.
- **Files/modules:** public/sw.js, src/pwa.ts, build configuration.
- **Dependencies:** R08.
- **Definition of done:** A fresh install relaunches offline, upgrades cleanly, and retains local data.

### R20 — Center the Today workflow

- **Priority / effort / risk:** P1 / L / Medium.
- **Why:** Returning users may need to plan manually and rationale disappears after restart.
- **Current implementation:** Plan/Today overlap, and reasons are transient.
- **Required change:** Show a trustworthy initial plan, freshness/conflicts, capture-to-review flow, and safe failure states.
- **Files/modules:** src/App.tsx, Sidebar, PlanView, TaskModal.
- **Dependencies:** R11–R13, R18.
- **Definition of done:** Returning users see a current, explainable day or a clear reason planning cannot complete; failed edits preserve input.

### R21 — Accessibility and touch pass

- **Priority / effort / risk:** P1 / M / Low.
- **Why:** Drag-only or dense controls limit use.
- **Current implementation:** Two narrow accessibility E2E checks exist.
- **Required change:** Add keyboard pin/reschedule, focus/order audit, touch layouts, reduced motion, and screen-reader testing.
- **Files/modules:** Components, src/style.css, E2E.
- **Dependencies:** R20.
- **Definition of done:** The core workflow works without drag, mouse, or a wide viewport.

### R22 — Complete team workflow

- **Priority / effort / risk:** P2 / L / Medium.
- **Why:** Permissions alone do not make team planning trustworthy.
- **Current implementation:** Comments and presence exist, but teammate calendars default to empty.
- **Required change:** Add invite acceptance, roster diagnostics, assignment review, and explicit capacity/unavailable-calendar states.
- **Files/modules:** SharedProjects, shareService, teamPlanService.
- **Dependencies:** R15, R17, R20.
- **Definition of done:** Owner/editor/viewer journeys and revoked-device scenarios pass.

### R23 — Validate AI advice and privacy

- **Priority / effort / risk:** P2 / M / Medium.
- **Why:** AI estimates affect plans and remote endpoints can be misclassified as private.
- **Current implementation:** Provider URL checks and output validation are partial.
- **Required change:** Verify local URLs, preview data sent to remote providers, validate output schemas, add timeouts/cancellation, and record estimate provenance.
- **Files/modules:** privateAi, aiService, src-tauri/src/ai.rs, planService.
- **Dependencies:** R16, R20.
- **Definition of done:** Offline fallback always works and a remote provider is never labeled local.

### R24 — Native desktop polish

- **Priority / effort / risk:** P1 / L / Medium.
- **Why:** A packaged webview still needs dependable OS behavior.
- **Current implementation:** Tray and updater code exist with little installed-app validation.
- **Required change:** Test window/tray lifecycle, notification actions, install/update recovery, keychain, and filesystem behavior by OS.
- **Files/modules:** Tauri lib/config, Titlebar, notify/update services.
- **Dependencies:** R03, R16, R20.
- **Definition of done:** Installed Windows/macOS/Linux smoke matrix passes.

### R25 — Diagnostics and measured performance

- **Priority / effort / risk:** P1 / M / Low.
- **Why:** Sync failures can be hidden and benchmark claims are unsupported.
- **Current implementation:** Console warnings and static benchmark numbers.
- **Required change:** Add privacy-safe diagnostics, sync health UI, reproducible task/op/relay benchmarks, and measured budgets.
- **Files/modules:** Logger, hooks, relay, benchmark harness, docs.
- **Dependencies:** R13–R17.
- **Definition of done:** 100/1k/10k tasks and 50k operations have recorded CPU, memory, and latency results.

### R26 — Expand reliability gates

- **Priority / effort / risk:** P1 / L / Medium.
- **Why:** Current suites miss real database, native, and fault paths.
- **Current implementation:** Ubuntu browser and Rust unit suites.
- **Required change:** Add migration, recovery, multi-device fault, Rust/TS parity, PWA, and OS smoke suites.
- **Files/modules:** tests/, e2e/, workflows.
- **Dependencies:** R03–R25 as features land.
- **Definition of done:** A release candidate passes the coverage matrix in section 20.

### R27 — Build a verified release pipeline

- **Priority / effort / risk:** P1 / L / High.
- **Why:** Tags can bypass test gates and artifacts lack independent verification.
- **Current implementation:** Draft Tauri build workflow.
- **Required change:** Gate version parity, explicit OS/architecture matrix, checksums, signing/notarization, updater verification, web deployment, and rollback smoke.
- **Files/modules:** .github/workflows/release.yml, SIGNING.md, scripts.
- **Dependencies:** R24, R26.
- **Definition of done:** Every published artifact installs, updates, and restores test data.

### R28 — Decide native mobile from evidence

- **Priority / effort / risk:** P3 / M / Medium.
- **Why:** PWA may be sufficient for capture, but perhaps not for background or native flows.
- **Current implementation:** No native mobile project.
- **Required change:** Run a PWA field study; pilot Tauri mobile or another client only for demonstrated unmet needs.
- **Files/modules:** Mobile pilot/config only after decision.
- **Dependencies:** R08, R19–R21, R25.
- **Definition of done:** Measured criteria justify either building or deferring native clients.

## 18. Dependency Graph

~~~mermaid
flowchart LR
    R01 --> R04
    R02 --> R03 --> R04 --> R05 --> R06 --> R07
    R04 --> R09 --> R10 --> R14 --> R15
    R07 --> R08 --> R19
    R07 --> R14 --> R17
    R02 --> R11 --> R12 --> R13 --> R20 --> R21
    R05 --> R13
    R12 --> R18 --> R20
    R10 --> R16 --> R18
    R15 --> R16
    R15 --> R22
    R20 --> R23
    R20 --> R24
    R17 --> R25 --> R26 --> R27
    R24 --> R27
    R19 --> R28
    R21 --> R28
~~~

The graph expresses hard prerequisites; independent branches can progress concurrently after the data safety baseline.

## 19. Platform Compatibility Matrix

Supported means code exists; it does not imply installed-app validation in this audit.

| Capability | Windows | macOS | Linux | Web | Android | iOS |
|---|---|---|---|---|---|---|
| Task UI and local planner | Supported, Rust | Supported, Rust | Supported, Rust | Supported, TS | PWA limited | PWA limited |
| Local durable store | SQLite | SQLite | SQLite | localStorage limited | PWA storage limited | PWA storage limited |
| Offline editing | Supported, native unverified | Supported, native unverified | Supported, native unverified | Limited by cache/storage | PWA limited | PWA limited |
| Relay sync | Supported, native unverified | Supported, native unverified | Supported, native unverified | Supported, limited | PWA limited | PWA limited |
| Shared projects | Supported, partial | Supported, partial | Supported, partial | Supported, partial | PWA limited | PWA limited |
| Google/Outlook OAuth | Partial desktop | Partial desktop | Partial desktop | Not supported | Not supported | Not supported |
| ICS text import | Supported | Supported | Supported | Supported | PWA supported | PWA supported |
| ICS URL fetch | Supported desktop | Supported desktop | Supported desktop | Not supported | Not supported | Not supported |
| AI provider calls | Supported desktop | Supported desktop | Supported desktop | Not supported | Not supported | Not supported |
| Notifications | Native code, unverified | Native code, unverified | Native code, unverified | Foreground API limited | PWA limited | PWA limited; no Cognate push |
| Tray/menu | Native tray code | Native tray code | Native tray code | N/A | N/A | N/A |
| Local backup/restore | Partial | Partial | Partial | Not supported | Not supported | Not supported |
| Signed auto-update | Configured, release unverified | Configured, release unverified | Configured, release unverified | Service worker limited | PWA lifecycle limited | PWA lifecycle limited |
| Native mobile client | N/A | N/A | N/A | N/A | Future decision | Future decision |

## 20. Testing Strategy

Use a small set of release-blocking invariants: an acknowledged write survives restart; replay matches the projection; any order of the same valid operation set yields the same state; duplicate delivery changes nothing; unauthorized operations never change state; a plan has no unreported collision; restore returns the exact pre-failure dataset.

Exercise offline-first transitions with independent stores: online; offline; offline to online; online to offline; intermittent or slow network; unavailable or restarted relay; device or browser restart; application crash; corrupt DB or op-log; partial batch; and duplicate batch. Expected behavior is local editing with explicit pending state, durable queued changes, bounded retry, no partial projection, and a visible recovery path when validation fails. Malformed data must not be silently skipped while reporting synced.

Add differential planner fixtures for Rust and TypeScript, real SQLite migration tests from each released schema, IndexedDB upgrade tests, restore tests with WAL writes, and a live relay process fault suite. Keep existing Chromium flows; add installed-app smoke tests and mobile viewport/device tests where they protect a real workflow.

## 21. Security Strategy

Prioritize the demonstrated boundaries: remove plaintext secret fallback; bind personal and shared operations to authenticated identities and document scope; reject malformed or colliding IDs; define replay and freshness checks; rotate share keys after revocation; and test recovery of owner authority. Version cryptographic envelopes and KDF parameters so upgrades are possible. A strong random share secret already exists; workspace passphrase policy and room derivation need redesign against guessing.

Restrict Rust network IPC destinations and request sizes, minimize Tauri SQL and shell capabilities, give the web build a CSP, enforce OAuth state/PKCE callback validation, store tokens only in an approved secret backend, and redact credentials from errors and logs. Add dependency and secret scanning to CI. The relay needs TLS expectations, authentication suitable to its deployment tier, per-room and per-IP limits, storage quotas, malformed-blob handling, and audit metrics. Update authenticity depends on verified updater signatures; broad distribution also needs Windows signing and macOS notarization.

## 22. Performance Strategy

Treat [docs/BENCHMARKS.md](docs/BENCHMARKS.md) figures as unverified claims. Build a reproducible harness using fixed hardware descriptions, dataset seeds, cold and warm runs, and percentile reporting. Measure 100, 1,000, and 10,000 tasks; 50,000 operations; large shared workspaces; many members; and large sync batches. Record planner latency, op append/projection/storage latency, render interaction latency, startup, sync latency, CPU, peak memory, and relay disk write cost. Include mobile PWA cold and offline startup. Compare before and after storage and protocol changes; set budgets from measured user experience rather than the current document's numbers.

## 23. Recovery & Disaster Strategy

A desktop SQLite backup can recover local task data only if its file copy is coherent and available. The current encrypted recovery kit restores relay/share capabilities, not task data or the owner signing identity. Relay loss is recoverable from surviving devices or verified local backups; a lost sole device plus lost relay and no backup is not recoverable. A lost passphrase or share secret cannot decrypt existing ciphertext. Revoked read access cannot be retroactively withdrawn from already decrypted data.

Implement versioned encrypted export containing data plus required identity material under a separately managed recovery passphrase, with clear scope and integrity checks. Keep local scheduled backups, an optional user-controlled external export, pre-migration snapshots, and a tested restore wizard. For corruption, quarantine bad records, preserve raw files, check integrity, restore the last verified snapshot, then replay only validated later operations. Never auto-repair by deleting ambiguous tasks.

| Failure | Recoverable with | Current limit |
|---|---|---|
| Local database corruption | Verified local snapshot plus validated later operations | Backup coherence and replay completeness are unproven |
| Failed migration | Pre-migration snapshot and tested rollback path | No full upgrade/rollback matrix |
| Lost device | Surviving device or verified export with identity material | Recovery kit lacks task data and owner signing identity |
| Lost passphrase/share secret | Separately retained capability or another authorized device | Ciphertext alone cannot recover the key |
| Relay loss | Surviving local data or verified backup | Relay is not a backup |
| Revoked member | New key epoch for future ciphertext | Previously read data cannot be retracted |

## 24. Release Engineering

The required pipeline is commit → formatting/lint/typecheck → unit and property tests → real storage/integration tests → browser and native smoke tests → dependency/security checks → reproducible web and desktop builds → artifact inspection/checksums → updater signing and OS signing/notarization → draft publication → clean-install/update/restore smoke → publish. Version parity must be checked across package.json, Cargo.toml, and tauri.conf.json. Test Windows, Linux, macOS Intel, and macOS Apple Silicon explicitly before claiming all four targets. Publish the web/PWA from dist/ only after its offline and update lifecycle passes. Keep rollback instructions and a compatible data migration policy; application rollback cannot blindly downgrade a database schema.

## 25. Technical Debt Register

Superseded by the refreshed inventory in [A12](#a12-technical-debt-inventory). The original register's items that have since been addressed (missing transaction abstraction, silent relay persistence, mixed source-of-truth claims) are closed by R03, R05, R07 and R17.

## 26. MVP vs Production vs Future

**Cognate v3.x stabilization:** R01–R07 and R09–R13. Stop automatic deletion, preserve recoverable backups, establish a truthful local data model, and make the day plan valid and atomic. Keep advanced sync/collaboration labels qualified until their guarantees are demonstrated.

**Cognate v4.0 Production:** Complete R08, R14–R21, and R24–R27. Require proven offline startup, durable browser storage, authenticated sync, scoped collaboration, calendar freshness, tested recovery, installed desktop behavior, and verified release artifacts.

**Cognate v4.x:** R22–R23, guided by actual team and AI usage. Improve collaboration and private AI after the planner and data path are dependable.

**Cognate v5+:** R28 only if PWA field evidence shows native mobile access is necessary. Avoid adding infrastructure or clients without a product requirement they solve.

## 27. First 20 Tasks

The exact implementation sequence, with files and acceptance conditions, concludes this report after the production checklist.

## 28. Definition of Done

A production task is done when its behavior is documented at the user boundary; failures return explicit states; storage and recovery invariants have fault tests; security-sensitive inputs are validated; TypeScript, build verification, Vitest, relevant Rust suites, E2E, and applicable OS smoke checks pass; and migration or rollback steps are tested on data from the previous release. A unit test that mirrors implementation is insufficient.

## 29. Final Production Checklist

- [x] No startup path silently deletes tasks. (R01; local regressions pass, installed desktop smoke pending.)
- [ ] Every acknowledged local mutation survives crash and replays to the same projection.
- [ ] Planner reports pin, meeting, timezone, DST, and capacity conflicts explicitly.
- [ ] Browser storage upgrade and first offline PWA launch are tested.
- [ ] Personal and shared sync converge under duplication, reordering, outages, and malicious input.
- [ ] Secret storage, key replacement, revocation, and recovery limits are tested and accurately explained.
- [ ] Calendar OAuth and recurring/overnight busy time are validated with live providers.
- [ ] Backups restore after WAL activity, failed migrations, and interrupted updates.
- [ ] Installed Windows/macOS/Linux builds pass clean-install, notification, tray, and update tests.
- [ ] Release artifacts have verified signatures, checksums, update metadata, and a rollback procedure.

The first 20 things to implement, in order:

1. **[P0] Stop automatic task deduplication.**
   - Files: src/db.js:354, deduplication tests.
   - Reason: Startup can delete intentionally identical tasks.
   - Depends on: None.
   - Done when: Boot performs no content-based deletion and reports suspected legacy duplicates without changing them.

2. **[P0] Enforce the repository baseline in CI and correct claims.**
   - Files: .github/workflows/test.yml, README.md, docs/.
   - Reason: Typecheck/build gates and architecture claims currently diverge from code.
   - Depends on: None.
   - Done when: PR checks include typecheck, build, verification, tests, and accurate status documentation.

3. **[P0] Replace unverified database file-copy recovery.**
   - Files: src-tauri/src/backup.rs, backupService, database adapter.
   - Reason: Checkpoint failures are swallowed and restore may race an open connection.
   - Depends on: 2.
   - Done when: Backup and restore preserve data through WAL writes, crash, and migration fixtures.

4. **[P0] Audit existing task rows against the op-log before cutover.**
   - Files: src/services/oplogStore.ts, projector, database adapter.
   - Reason: Current backfill checks only whether an entity ID occurs in the log.
   - Depends on: 3.
   - Done when: A reversible report identifies every missing or differing field and repairs it without silent loss.

5. **[P0] Commit task command, operation, and projection atomically.**
   - Files: src/services/taskService.ts, database adapter, oplogStore.
   - Reason: Database writes succeed while best-effort logging can fail.
   - Depends on: 3, 4.
   - Done when: Injected failures leave both data layers committed or both unchanged.

6. **[P0] Route every durable mutation through that command path.**
   - Files: taskService, planService, quickAddService, history, project services.
   - Reason: Undo, reorder, recurrence, planning, and projects bypass parts of the log.
   - Depends on: 5.
   - Done when: Replay reconstructs all supported user actions, including recurrence and undo.

7. **[P0] Make projection and import transactional.**
   - Files: src/services/syncService.ts, projector, database adapter.
   - Reason: An incomplete log can overwrite local rows during reconciliation.
   - Depends on: 4–6.
   - Done when: Parity is checked before cutover and interrupted imports leave a consistent database.

8. **[P1] Migrate browser data from localStorage to transactional storage.**
   - Files: src/db.js, new IndexedDB adapter and migration tests.
   - Reason: Whole-array rewrites, quota, and cross-tab writes threaten browser data.
   - Depends on: 5–7.
   - Done when: An existing browser profile upgrades safely, including after interruption.

9. **[P0] Validate operation schemas and reject ID collisions.**
   - Files: src/services/oplog.ts, append and ingest paths.
   - Reason: Different final states were reproduced for the same colliding operations in different orders.
   - Depends on: 4.
   - Done when: Malformed, duplicate, replayed, and colliding operations converge or are rejected deterministically.

10. **[P0] Persist HLC and bind actor identity to a device key.**
    - Files: oplogStore, src/services/identity.ts, migrations.
    - Reason: Restart and clock state currently rely on scanning stored operations.
    - Depends on: 9.
    - Done when: Restart and clock rollback cannot reuse an operation identity.

11. **[P0] Validate planner inputs and pinned conflicts.**
    - Files: src-tauri/src/planner.rs, src/services/planService.ts.
    - Reason: Conflicting or out-of-range pins can be shown as a valid plan.
    - Depends on: 2.
    - Done when: Both engines return valid blocks or explicit conflict results for adversarial inputs.

12. **[P0] Introduce a timezone-aware calendar interval model.**
    - Files: planService, calendarSyncService, oauthCalendarService, calendar migration.
    - Reason: Overnight events, DST, and timezone changes can hide busy time.
    - Depends on: 11.
    - Done when: DST and midnight fixtures occupy every affected planning interval correctly.

13. **[P0] Commit plans atomically and reject stale reflows.**
    - Files: planService, src/hooks/useAutoReflow.ts, PlanView.
    - Reason: Planning clears and rewrites blocks one by one while tasks can change.
    - Depends on: 5, 6, 11, 12.
    - Done when: A failed or stale solve leaves the prior valid plan intact.

14. **[P0] Replace personal whole-log sync with authenticated, acknowledged batches.**
    - Files: src/services/relayService.ts, syncService, relayTransport.
    - Reason: Personal operations are unsigned and push-before-pull delays propagation.
    - Depends on: 7, 9, 10.
    - Done when: Three devices converge through outages, duplicate delivery, and reconnect.

15. **[P0] Bind shared operations to their project and implement revocation epochs.**
    - Files: src/services/collab.ts, shareService, crypto.
    - Reason: Role checks lack strict entity scope and revoked members retain the read key.
    - Depends on: 9, 10, 14.
    - Done when: An authorized malicious editor cannot alter another project and a removed member cannot read new-epoch data.

16. **[P0] Remove silent plaintext secret fallback and define key recovery.**
    - Files: src/utils/secrets.ts, secrets.rs, crypto, recoveryService.
    - Reason: Keychain failure can place private keys and tokens in settings; recovery omits owner authority.
    - Depends on: 3, 10, 15.
    - Done when: Keychain failure is explicit, plaintext fallback is absent, and device replacement tests state exactly what recovers.

17. **[P1] Make relay acknowledgements durable and resources bounded.**
    - Files: server/src/main.rs.
    - Reason: Persistence errors are ignored and each PUT can rewrite an unbounded JSON store.
    - Depends on: 14.
    - Done when: Disk-full, oversized request, restart, and long-poll load tests produce bounded, correct responses.

18. **[P0] Finish and validate Google/Microsoft OAuth.**
    - Files: src/services/oauthCalendarService.ts, integrations.rs, CalendarAccount.
    - Reason: State is generated but not verified and the live handshake is untested.
    - Depends on: 12, 16.
    - Done when: Live accounts connect, refresh, revoke, and replace busy data without leaking tokens.

19. **[P1] Make first-install PWA offline startup and updates reliable.**
    - Files: public/sw.js, pwa.ts, build configuration.
    - Reason: The install cache does not guarantee required hashed assets are available offline.
    - Depends on: 8.
    - Done when: A fresh install opens offline, updates cleanly, and retains local data.

20. **[P1] Turn Today into the complete capture-to-work loop.**
    - Files: src/App.tsx, Sidebar, PlanView, TaskModal.
    - Reason: Returning users can see an empty or stale plan, rationale is transient, and edit failures can look successful.
    - Depends on: 11–13, 18.
    - Done when: Opening Cognate shows a current explainable plan or a clear reason it cannot, and failed edits preserve the user's input.
