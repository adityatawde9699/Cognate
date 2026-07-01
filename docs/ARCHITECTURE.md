# Architecture & Tech Stack

## Tech Stack

| Layer | Technology |
|---|---|
| **Shell** | Tauri 2 (Rust backend + WebView), also PWA in browser |
| **Frontend** | React 19, Vite 7, Zustand 5, Chart.js (lazy-loaded) |
| **Fonts** | Space Grotesk (display), Geist + Geist Mono (body/data) |
| **Backend** | Rust 2021 — Tauri commands, `tauri-plugin-sql` (SQLite), `-notification`, `-shell`, `-oauth`, `-updater`; `reqwest`, `tokio`, `serde` |
| **Crypto** | WebCrypto — PBKDF2 → AES-GCM (E2E), ECDSA P-256 (op signing) |
| **Storage** | SQLite (`tauri-plugin-sql`, migrations `001`–`006`); `localStorage` fallback in browser |
| **Sync Relay** | Separate Rust crate (`server/`) — `tiny_http` + `serde_json` |
| **Testing** | Vitest (unit/integration/property), Playwright (e2e), `cargo test` (Rust), clippy `-D warnings` |

## Four Load-Bearing Decisions

### 1. Scheduler in Rust, deterministic; AI is advisor

**Why:**
- Speed, offline capability, and explainability
- AI failures degrade gracefully — the plan still works without an API key
- Deterministic scheduling means you can understand *why* tasks are placed

**Implementation:**
- `planner.rs` (Rust) is mirrored in TypeScript for consistency
- AI enriches but never overrides core scheduling logic
- All scheduling is unit-tested with property-based tests

### 2. CRDT op-log is source of truth; SQLite is a projection; relay is dumb

**Why:**
- One engine unlocks offline + multi-device + multiplayer simultaneously
- Privacy is structural, not a setting
- Conflict resolution happens at the op level, not the relay

**Implementation:**
- Every mutation appends an immutable, causally-ordered operation
- Hybrid Logical Clock (HLC) + Last-Write-Wins (LWW)
- The relay stores only ciphertext; ops are admitted based on ECDSA signatures
- SQLite materializes the op-log for fast queries

### 3. One platform-agnostic TypeScript core; only the storage adapter differs

**Why:**
- Desktop (Tauri), web, and PWA all run the same core logic
- Reduces testing surface and keeps behavior consistent
- Storage is the *only* thing that differs per platform

**Implementation:**
- `src/store.ts` + `src/services/` (platform-agnostic)
- `src/db.js` (SQLite on Tauri, `localStorage` on web)
- Components and hooks are platform-agnostic

### 4. Test pyramid is non-negotiable

**Why:**
- CRDT merge, RBAC admission, crypto, and scheduler logic are complex
- Cross-device sync and first-run flow need e2e coverage
- CI must pass all tiers before merge

**Implementation:**
- ~200 Vitest (unit + integration + property)
- 17 Playwright e2e scenarios
- 13 + 10 Rust tests (both crates)
- CI runs all four suites + `clippy -D warnings`

## System Diagram

```
┌──────────────── WebView (React 19) / PWA / Browser ─────────────────┐
│  PlanView (default)  Board·List·Table·Calendar·Timeline             │
│  CommandPalette (⌘K NL quick-add)   TaskModal   SharedProjects      │
│  ChiefOfStaff banner   Onboarding   i18n                            │
│                                                                     │
│  store.ts (Zustand)         ← platform-agnostic UI state            │
│  services/                  ← the portable core                     │
│    planService · planner mirror · energyModel · chiefOfStaff        │
│    taskService (CQRS choke point)                                   │
│    oplog · oplogStore · projector · syncService   ← CRDT spine      │
│    crypto · identity · collab · shareService      ← E2E + RBAC      │
│    relayService · relayTransport · presence · activity              │
│    aiService · nlQuickAdd · quickAddService · privateAi             │
│  db.js                      ← SQLite (Tauri) / localStorage (web)   │
└───────────────┬──────────────────────────────┬─────────────────────┘
        invoke()/listen() (Tauri IPC)     fetch / relay_fetch
┌───────────────▼──────────────┐   ┌──────────▼──────────────────────┐
│  Rust backend (src-tauri)    │   │  Sync relay (server/, separate)  │
│  planner.rs  plan_day/plan_team│  │  ciphertext-only store-&-forward │
│  calc_priority · pomodoro    │   │  rooms → blobs · version · poll  │
│  ai_generate · oauth_*       │   │  bearer auth · rate limit · disk │
│  secrets (keychain) · backup │   │  worker pool + long-poll (≈1s)   │
│  integrations · relay_fetch  │   └──────────────────────────────────┘
│  SQLite (migrations 001–006) │
└──────────────────────────────┘
```

## Data Flow

1. **User input** → React component → Zustand store → `taskService`
2. **taskService** → generates ops, signs with identity → `oplogStore`
3. **oplogStore** → appends to op-log, projects to SQLite, broadcasts via `syncService`
4. **syncService** → sends encrypted blobs to relay (or stores locally for offline)
5. **Relay** → stores by room ID + device ID, versions with clock
6. **Other devices** → poll relay, decrypt, merge ops, project to local SQLite
7. **UI** → subscribes to store updates → re-renders

## Determinism & Explainability

The scheduler (`planner.rs`) is:
- **Deterministic**: Same inputs → same output, always
- **Explainable**: Every placement includes a reason ("2pm because the client call owns your morning")
- **Learnable**: The closed-loop energy model improves with actual Pomodoro data
- **Interruptible**: Drag a block → re-solves with that block pinned

## Offline Capability

All three platforms (desktop, web, PWA) work offline:

- **Capture**: ⌘K quick-add works without network
- **Viewing**: All views (Plan, Board, Calendar, etc.) render from local SQLite
- **Editing**: Changes queue locally, sync when reconnected
- **Scheduling**: The scheduler runs locally; no backend call needed

## Sync & Privacy

- **Passphrase** → derives AES-GCM key + opaque room ID (never sent)
- **Every op** → signed with ECDSA P-256 (role-based admission on relay)
- **Relay role** → validates signature, checks role permission, stores ciphertext
- **Other devices** → fetch by room ID + version, decrypt, verify signature, merge

A compromised relay **cannot**:
- Read your data (all ciphertext)
- Forge edits (ECDSA signature required)
- Tamper with existing ops (immutable)
- Infer relationships (opaque room IDs)

## Performance Characteristics

| Operation | Latency | Notes |
|---|---|---|
| Schedule 100 tasks | 14 ms | Rust, local |
| Re-plan | 7 ms | Incremental |
| App startup | 180 ms | Loads SQLite + syncs |
| Memory footprint | 60 MB | Typical with 500+ tasks |
| Relay sync latency | ~1 s | Long-poll based |
| E2E encryption | <5 ms | AES-GCM on device |

See [BENCHMARKS](BENCHMARKS.md) for detailed performance profiling.
