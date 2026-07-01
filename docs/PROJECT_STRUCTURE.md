# Project Structure

```
Cognate/
├── plan.md                     # the product thesis + roadmap (Acts 0–5)
├── index.html · vite.config.js · vitest.config.js · playwright.config.ts
├── package.json                # Node.js dependencies
├── tsconfig.json
├── Cargo.toml, Cargo.lock      # Workspace (src-tauri + server)
│
├── docs/                       # This documentation
│   ├── ARCHITECTURE.md         # Tech stack, design decisions, data flow
│   ├── TESTING.md              # Test pyramid, coverage, CI
│   ├── RELAY.md                # Sync relay architecture & deployment
│   └── PROJECT_STRUCTURE.md    # This file
│
├── public/                     # Static assets
│   ├── manifest.webmanifest    # PWA manifest
│   ├── sw.js                   # Service worker (offline support)
│   └── icons/                  # App icons
│
├── src/                        # Platform-agnostic core + React UI
│   ├── App.tsx                 # Root component
│   ├── main.tsx                # Entry point
│   ├── store.ts                # Zustand state (UI state, not data)
│   ├── i18n.ts                 # Internationalization (EN, ES, DE, FR)
│   ├── style.css               # Global styles
│   ├── db.js / db.d.ts         # Storage adapter (SQLite for Tauri, localStorage for web)
│   ├── logger.js               # Logging
│   │
│   ├── components/
│   │   ├── PlanView.tsx        # The default hero view (time blocks)
│   │   ├── Board.tsx           # Kanban board
│   │   ├── Calendar.tsx        # Calendar view
│   │   ├── ListView.tsx        # List view
│   │   ├── TableView.tsx       # Table view
│   │   ├── TimelineView.tsx    # Timeline view
│   │   ├── CommandPalette.tsx  # ⌘K quick-add
│   │   ├── TaskModal.tsx       # Task editing
│   │   ├── SharedProjects.tsx  # Collaboration UI
│   │   ├── Onboarding.tsx      # First-run flow
│   │   ├── ChiefOfStaff.tsx    # AI advisor banner
│   │   ├── Sidebar.tsx         # Navigation
│   │   ├── Titlebar.tsx        # App header
│   │   ├── Toast.tsx           # Notifications
│   │   ├── Pomodoro.tsx        # Focus timer
│   │   ├── FocusMode.tsx       # Distraction-free mode
│   │   ├── Modals/             # Task/settings/recovery modals
│   │   └── Settings/           # Settings pages
│   │
│   ├── hooks/
│   │   ├── useAutoReflow.ts    # Re-plan on calendar changes
│   │   ├── useAutoSync.ts      # Sync with relay periodically
│   │   ├── useAutoShareSync.ts # Shared project updates
│   │   ├── useAutoUpdate.ts    # Check for app updates
│   │   ├── useDeadlineWatcher.ts    # Deadline notifications
│   │   ├── useMorningBrief.ts  # Morning briefing
│   │   ├── usePomodoroConfig.ts     # Focus timer settings
│   │   ├── useFocusTrap.ts     # A11y focus management
│   │   ├── useShortcuts.ts     # Keyboard shortcuts
│   │   ├── useTasks.ts         # Task query/filter
│   │   ├── useTheme.ts         # Dark/light mode
│   │   ├── useVisibleTasks.ts  # View-aware filtering
│   │   └── useDataSafety.ts    # Auto-backup & integrity checks
│   │
│   ├── services/               # The portable core engine
│   │   │
│   │   # Scheduling & planning
│   │   ├── planService.ts      # Public API: schedule tasks
│   │   ├── energyModel.ts      # Closed-loop energy curve
│   │   ├── chiefOfStaff.ts     # AI advisor logic
│   │   ├── teamPlanService.ts  # Team scheduling
│   │   │
│   │   # CRDT & sync spine
│   │   ├── oplog.ts            # Immutable op definitions
│   │   ├── oplogStore.ts       # Op-log storage & projection
│   │   ├── projector.ts        # Projects op-log → SQLite
│   │   ├── syncService.ts      # Sync orchestration
│   │   │
│   │   # Encryption & identity
│   │   ├── crypto.ts           # PBKDF2, AES-GCM, ECDSA
│   │   ├── identity.ts         # Device identity & signing
│   │   ├── collab.ts           # Op filtering by RBAC
│   │   ├── collabProjection.ts # Shared project state
│   │   ├── shareService.ts     # Share/revoke logic
│   │   │
│   │   # Relay & network
│   │   ├── relayService.ts     # Relay communication
│   │   ├── relayTransport.ts   # HTTP fetch wrapper
│   │   ├── presenceService.ts  # Who's online
│   │   ├── activity.ts         # Activity feed
│   │   │
│   │   # AI & capture
│   │   ├── aiService.ts        # Multi-provider LLM
│   │   ├── nlQuickAdd.ts       # NL → structured capture
│   │   ├── quickAddService.ts  # Quick-add flow
│   │   ├── privateAi.ts        # Local Ollama support
│   │   │
│   │   # Integrations
│   │   ├── calendarSyncService.ts  # iCal + OAuth sync
│   │   ├── oauthCalendarService.ts # Google/Outlook free/busy
│   │   ├── icalService.ts      # iCal parsing
│   │   ├── importService.ts    # Task import
│   │   │
│   │   # Data safety
│   │   ├── backupService.ts    # Timestamped backups
│   │   ├── recoveryService.ts  # Encrypted recovery kit
│   │   │
│   │   # Utils
│   │   ├── customFields.ts     # Custom task fields
│   │   ├── dedupe.ts           # Task deduplication
│   │   └── history.ts          # Undo/redo
│   │
│   └── utils/
│       ├── secrets.ts          # OS keychain integration
│       ├── pwa.ts              # PWA installation
│       ├── notify.ts           # Desktop notifications
│       ├── export.ts           # Export to CSV/JSON
│       └── toast.ts            # Toast notifications
│
├── src-tauri/                  # Rust backend
│   ├── Cargo.toml
│   ├── build.rs                # Build script (icons, resources)
│   ├── tauri.conf.json         # Tauri config
│   │
│   ├── migrations/
│   │   ├── 001_init.sql        # Initial schema
│   │   ├── 002_tasks.sql
│   │   ├── 003_shared.sql
│   │   ├── 004_oplog.sql
│   │   ├── 005_activity.sql
│   │   └── 006_sync.sql
│   │
│   ├── src/
│   │   ├── lib.rs              # Tauri command handlers
│   │   ├── planner.rs          # Deterministic scheduler (core)
│   │   ├── ai.rs               # AI provider integration
│   │   ├── integrations.rs     # OAuth, iCal, etc.
│   │   ├── secrets.rs          # OS keychain wrapper
│   │   ├── backup.rs           # Backup/restore logic
│   │   └── ...
│   │
│   ├── capabilities/           # Tauri app capabilities
│   ├── icons/                  # Icon sources
│   └── target/                 # Build output (ignored)
│
├── server/                     # Separate Rust crate: E2E relay
│   ├── Cargo.toml
│   ├── README.md               # Relay deployment guide
│   ├── src/
│   │   ├── main.rs             # Entry point
│   │   ├── routes.rs           # API endpoints
│   │   ├── auth.rs             # Bearer token auth
│   │   ├── rate_limit.rs       # Per-IP rate limiting
│   │   ├── storage.rs          # Persistent blob store
│   │   └── ...
│   └── target/                 # Build output (ignored)
│
├── e2e/
│   ├── smoke.spec.ts           # Basic app functionality
│   ├── plan.spec.ts            # Scheduling & reflow
│   ├── sync.spec.ts            # Cross-device sync
│   ├── onboarding.spec.ts      # First-run flow
│   ├── task-flow.spec.ts       # Task creation → completion
│   ├── a11y.spec.ts            # Accessibility tests
│   └── playwright.config.ts    # Playwright config
│
├── tests/
│   └── calcPriority.test.js    # Standalone priority tests
│
├── scripts/
│   └── gen-icons.mjs           # Icon generation
│
├── .github/workflows/
│   ├── test.yml                # Full test suite CI
│   └── release.yml             # Build & publish
│
├── README.md                   # This file
├── CONTRIBUTING.md             # Contributing guidelines
├── LICENSE.txt
├── SECURITY.md                 # Security policy & reporting
└── SIGNING.md                  # Code signing & releases
```

## Key Abstractions

### `store.ts` (Zustand)
Holds UI state: current view, sidebar open/closed, theme, filter. **Not** the data; data lives in the op-log.

### `services/oplogStore.ts`
The *actual* data store. Every task mutation is appended as an immutable, causally-ordered operation. SQLite is a materialized view.

### `services/taskService.ts`
The CQRS command choke point. All task mutations go through here → oplog → relay (if sharing).

### `services/projector.ts`
Materializes the op-log into a queryable SQLite schema. Runs on every op-append.

### `services/syncService.ts`
Orchestrates sync:
1. Fetch op-log versions from relay
2. Decrypt and merge incoming ops
3. Verify ECDSA signatures + RBAC
4. Update local op-log → trigger projector

### `services/crypto.ts`
- PBKDF2: Passphrase → key + room ID
- AES-GCM: Encrypt/decrypt blobs
- ECDSA P-256: Sign and verify ops

### `src/db.js`
**The platform abstraction.** Provides a single SQL interface:
- **Tauri**: Delegates to `tauri-plugin-sql` → SQLite
- **Web/PWA**: Delegates to `localStorage` (simple key-value fallback)

All services use `db.query()`, `db.insert()`, etc. and don't know which backend they're on.

## Testing Organization

```
src/                           # Source files
  ├── services/
  │   ├── planService.ts       ← source
  │   ├── planService.test.ts  ← unit tests
  │   ├── oplog.ts
  │   ├── oplog.test.ts        ← CRDT merge tests
  │   └── ...
  │
  ├── hooks/
  │   ├── useTasks.ts
  │   ├── useTasks.test.ts
  │   └── ...
  │
  └── utils/
      ├── export.ts
      ├── export.test.ts
      └── ...

e2e/                           # Full-app tests
  ├── plan.spec.ts             ← Scheduling + reflow
  ├── sync.spec.ts             ← Cross-device
  ├── onboarding.spec.ts       ← First-run
  └── ...

src-tauri/src/                 # Rust backend
  ├── planner.rs               ← source
  ├── planner.rs tests         ← unit tests
  └── ...
```

## Build Artifacts

- **Desktop**: `src-tauri/target/release/bundle/` (DMG, AppImage, MSI)
- **Web/PWA**: `dist/` (HTML + JS + service worker)
- **Relay**: `server/target/release/cognate-relay` (binary)
