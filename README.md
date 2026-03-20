# Cognote

Cognote is a cross-platform desktop task management application built with Tauri 2, React 19, and SQLite. It provides a local-first task board with a Pomodoro timer, automated priority scoring, tag-based filtering, and optional outbound notification delivery to Slack, Discord, and Telegram via webhook and bot APIs. The application runs natively on Windows, macOS, and Linux, embedding the frontend inside a Tauri WebView with a Rust backend that handles timer state, IPC commands, and data persistence through a local SQLite database.

---

## Features

- **Task board** — Two-column view (Pending / Completed) with drag-and-drop reordering persisted to the database
- **Task CRUD** — Create, read, update, and delete tasks including title, description, tags, deadline, importance (1–5), and effort (1–5)
- **Automated priority scoring** — Rust command (`calc_priority`) computes a weighted score from importance, effort, and deadline proximity; classifies tasks as `low`, `medium`, or `high`; JavaScript fallback available for browser-only runs
- **Pomodoro timer** — 25-minute countdown managed entirely in Rust (`toggle_pomodoro`, `reset_pomodoro`) with per-second tick events emitted to the frontend; completed sessions increment `pomodoros_spent` on the linked task
- **Sidebar filters** — Per-view filters: All Tasks, Due Today, High Priority, and tag-based filters derived dynamically from task data
- **Full-text search** — Client-side search across task title, description, and tags via Zustand store
- **Analytics panel** — Bar chart (Chart.js) showing task completions for the last 7 days; priority breakdown display; completion streak counter; focus hours derived from Pomodoro count (partial: chart data is currently static stub, not wired to `getStats()`)
- **Data export** — Download all tasks as CSV or JSON from the Analytics panel
- **Settings panel** — Configurable Pomodoro work/break durations stored in SQLite; auto-start break toggle
- **Webhook integrations** — Outbound notifications to Slack (Incoming Webhook), Discord (Incoming Webhook), and Telegram (Bot API) configured in Settings
- **Calendar OAuth — Experimental** — `start_oauth` Tauri command generates OAuth 2.0 authorization URLs for Google Calendar and Microsoft Outlook; the OAuth callback handling (token exchange, calendar sync) is not implemented; the command opens the browser to the provider login page only
- **System tray** — Tray icon with "Show Cognote" and "Quit" context menu items; left-click restores the window
- **Keyboard shortcuts** — `N` new task, `/` focus search, `1`/`2`/`3` switch filters, `T` toggle theme, `Escape` close modal
- **Theme toggle** — Light/dark theme switching via `useTheme` hook
- **localStorage fallback** — All database operations fall back to `localStorage` when running outside Tauri (browser/Vite dev server)
- **Desktop notifications** — `tauri-plugin-notification` is registered; notification dispatch is not wired to any application event in the current codebase
- **Seed data** — On first launch, six example tasks are inserted with representative priorities, tags, and deadlines

---

## Tech Stack

### Runtime
| Component | Version |
|---|---|
| Tauri | 2.x |
| Rust | ≥ 1.77.2 |
| Node.js | LTS (project does not pin a version) |

### Languages
- TypeScript 5.x (frontend logic and React components)
- JavaScript (ES modules — `db.js`, `state.js`, `format.js`, `toast.js`)
- Rust 2021 edition (Tauri backend and IPC commands)
- SQL (SQLite schema and parameterized queries)

### Frontend Framework & Libraries
| Package | Role |
|---|---|
| React 19 | UI framework |
| Vite 7 | Dev server and bundler |
| Zustand 5 | Client-side state management |
| Chart.js 4 | Analytics bar chart |
| `@fontsource/inter` | Bundled typeface |
| `@fortawesome/fontawesome-free` | Icon set |

### Backend (Rust crates)
| Crate | Role |
|---|---|
| `tauri 2` | App shell, IPC, event bus, tray |
| `tauri-plugin-sql` (SQLite) | SQLite driver with migration support |
| `tauri-plugin-log` | Structured logging at `Info` level and above |
| `tauri-plugin-notification` | Native OS notifications (registered, not wired) |
| `tauri-plugin-shell` | Opens external URLs from Rust commands |
| `tauri-plugin-oauth` | OAuth localhost redirect server |
| `reqwest 0.12` | HTTP client for webhook delivery |
| `tokio 1` (full) | Async runtime for the Pomodoro loop and HTTP calls |
| `serde` / `serde_json` | Serialization |
| `chrono 0.4` | Date arithmetic for deadline scoring |

### Database
- SQLite via `tauri-plugin-sql`; database file: `cognote.db` in the Tauri app data directory
- Single migration (`001_init.sql`) creates `tasks` and `app_state` tables

### Development Tools
| Tool | Role |
|---|---|
| Vitest 4 | JavaScript unit tests |
| `@tauri-apps/cli` | Tauri dev/build commands |
| TypeScript compiler | Type checking |
| Vite | HMR dev server on port 1420 |

---

## Architecture

Cognote follows a two-process architecture as required by Tauri: a Rust process (the backend) and a WebView process (the frontend). The two processes communicate exclusively through Tauri's IPC mechanism.

```
┌─────────────────── WebView (Vite + React 19) ───────────────────┐
│                                                                  │
│  App.tsx                                                         │
│  ├── Titlebar          ← custom window chrome (decorations=false)│
│  ├── Sidebar           ← filter nav + stats + tag list          │
│  ├── Board             ← Pending / Completed columns + DnD      │
│  │   └── TaskCard      ← individual task display                │
│  ├── Pomodoro          ← timer chip (drives invoke calls)        │
│  ├── Analytics         ← Chart.js panel + CSV/JSON export        │
│  ├── TaskModal         ← create / edit form                      │
│  └── SettingsModal     ← pomo config + webhook inputs + OAuth    │
│                                                                  │
│  store.ts (Zustand)    ← UI state: filter, tasks, modals        │
│  db.js                 ← SQLite abstraction + localStorage shim  │
└──────────────┬───────────────────────────────────────────────────┘
               │  invoke() / listen()  (Tauri IPC)
┌──────────────▼───────────────────── Rust Backend ───────────────┐
│  lib.rs                                                          │
│  ├── app_ready()       ← returns CARGO_PKG_VERSION              │
│  ├── calc_priority()   ← weighted score → low/medium/high       │
│  ├── toggle_pomodoro() ← starts async Tokio loop, emits ticks   │
│  ├── reset_pomodoro()  ← resets PomoState to 25:00              │
│  └── integrations.rs                                             │
│      ├── send_notification() ← HTTP POST to Slack/Discord/TG    │
│      └── start_oauth()       ← generates OAuth URL (stub)       │
│                                                                  │
│  Plugins: tauri-plugin-sql (SQLite), tauri-plugin-log,          │
│           tauri-plugin-notification, tauri-plugin-shell,         │
│           tauri-plugin-oauth                                     │
└─────────────────────────────────────────────────────────────────┘
               │
          SQLite (cognote.db)
          ├── tasks      (13 columns)
          └── app_state  (key/value store for settings and seeded flag)
```

**Data flow for task creation:**
1. User submits the Task Modal form in the WebView.
2. `createTask()` in `db.js` calls `invoke('calc_priority')` to obtain the priority label from Rust.
3. The result is inserted into SQLite via `tauri-plugin-sql`.
4. A `refresh-tasks` DOM event triggers `Board` to reload the task list from the database.

**Pomodoro flow:**
1. Frontend calls `invoke('toggle_pomodoro')`.
2. Rust spawns a Tokio async task that decrements `PomoState.time_left` every second and emits `pomo-tick` events.
3. The `Pomodoro` React component listens to `pomo-tick` via `listen()` and updates the display.
4. On completion, Rust emits `pomo-finished`; the frontend dispatches a local `CustomEvent` for audio or further handling.

---

## Setup & Installation

### Prerequisites

| Requirement | Notes |
|---|---|
| Rust toolchain | Install via [rustup.rs](https://rustup.rs). Minimum: 1.77.2 |
| Microsoft C++ Build Tools | Windows only. Required for the Rust linker (`link.exe`) |
| Node.js | LTS release recommended |
| npm | Included with Node.js |
| WebView2 runtime | Windows only. Usually pre-installed on Windows 10/11 |

On **Windows**, if `link.exe` is not found during `cargo build`, install the "Desktop development with C++" workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).

### Environment Variables

The following variables are read at runtime by the Rust backend. The application will substitute placeholder strings if they are absent; OAuth flows will not function without them.

| Variable | Required For | Default if Absent |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google Calendar OAuth | `"YOUR_CLIENT_ID"` |
| `MICROSOFT_CLIENT_ID` | Microsoft Outlook OAuth | `"YOUR_CLIENT_ID"` |

Set these in your shell environment or a `.env` file before running `npm run tauri dev`. Note: Vite forwards only variables prefixed with `VITE_` or `TAURI_ENV_*` to the frontend; the two variables above are read directly by Rust via `std::env::var`.

### Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd cognote   # or the repository directory name

# 2. Install JavaScript dependencies
npm install

# 3. (Optional) Verify Rust toolchain
cargo --version   # must be ≥ 1.77.2

# 4. Launch the application in development mode
npm run tauri dev
```

`npm run tauri dev` runs Vite on port 1420 and Cargo in parallel. The Tauri window opens automatically when both are ready.

### Building for Distribution

```bash
npm run tauri build
```

Output bundles (installer, `.exe`, `.dmg`, `.AppImage` depending on platform) are written to `src-tauri/target/release/bundle/`.

### Database

The SQLite database (`cognote.db`) is created automatically on first launch by `tauri-plugin-sql` using the migration in `src-tauri/migrations/001_init.sql`. No manual database setup is required. The file location is determined by Tauri's app data directory convention for the target OS.

---

## Usage

### Running in Development

```bash
npm run tauri dev
```

The Vite dev server starts on `http://localhost:1420`. The Tauri window opens and connects to it. Hot module replacement is active for frontend changes. Rust changes trigger a Tauri restart.

### Running Frontend Only (Browser)

```bash
npm run dev
```

Opens the frontend in a browser at `http://localhost:1420`. In this mode, SQLite is unavailable and all data is stored in `localStorage` under the key `cn_tasks_v2`. Tauri IPC calls are bypassed through the `IS_TAURI` guard in `db.js`.

### Running Tests

```bash
npm test
```

Runs Vitest tests. Currently two test files exist:

- `tests/calcPriority.test.js` — 4 unit tests covering the JavaScript priority scoring fallback logic
- `src/store.test.ts` — Zustand store tests (file present; content not shown in this analysis)

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `N` | Open new task modal |
| `/` | Focus search input |
| `1` | Show all tasks |
| `2` | Show tasks due today |
| `3` | Show high-priority tasks |
| `T` | Toggle light/dark theme |
| `Escape` | Close active modal / blur input |

### Webhook Integration

In Settings, enter a webhook URL for Discord or Slack, or a bot token plus chat ID for Telegram. These values are stored in the `app_state` SQLite table. Notifications are sent by invoking the Rust `send_notification` command, which performs an HTTP POST via `reqwest`. There is no in-app trigger that automatically calls this command; it must be invoked programmatically.

### Data Export

From the Analytics panel, click **CSV** or **JSON** to download all tasks. The export reads directly from the active database or `localStorage` fallback.

---

## Project Structure

```
cognote/
├── index.html                  # Vite HTML entry point
├── package.json                # npm scripts and JS dependencies
├── tsconfig.json               # TypeScript configuration
├── vite.config.js              # Vite + Tauri dev server configuration
├── vitest.config.js            # Vitest test runner configuration
│
├── src/                        # Frontend source (TypeScript + React)
│   ├── main.tsx                # React DOM entry; mounts <App />
│   ├── App.tsx                 # Root component; layout composition
│   ├── store.ts                # Zustand store (UI state only)
│   ├── db.js                   # SQLite/localStorage abstraction layer
│   ├── db.d.ts                 # TypeScript declarations for db.js
│   ├── logger.js               # Tauri log plugin wrapper
│   ├── state.js                # Legacy state helpers (superseded by store.ts)
│   ├── style.css               # Global styles (~39 KB)
│   ├── vite-env.d.ts           # Vite environment type shim
│   ├── store.test.ts           # Zustand store unit tests
│   │
│   ├── components/
│   │   ├── Board.tsx           # Two-column task board with drag-and-drop
│   │   ├── TaskCard.tsx        # Individual task card (display + actions)
│   │   ├── Sidebar.tsx         # Navigation, filters, stats, tag list
│   │   ├── Pomodoro.tsx        # Timer chip wired to Rust via IPC events
│   │   ├── Analytics.tsx       # Chart.js bar chart + export buttons
│   │   ├── Titlebar.tsx        # Custom window chrome
│   │   └── Modals/
│   │       ├── TaskModal.tsx   # Create/edit task form
│   │       └── SettingsModal.tsx  # Pomodoro config, webhooks, OAuth
│   │
│   ├── hooks/
│   │   ├── useShortcuts.ts     # Global keyboard shortcut bindings
│   │   ├── useTasks.ts         # Task-loading helper hook
│   │   └── useTheme.ts         # Theme persistence hook
│   │
│   └── utils/
│       ├── export.ts           # CSV and JSON export functions
│       ├── audio.ts            # Audio playback utilities
│       ├── format.js           # Date/time formatting helpers
│       ├── toast.js            # Lightweight toast notification helper
│       └── toast.d.ts          # TypeScript declarations for toast.js
│
├── tests/
│   └── calcPriority.test.js    # Unit tests for JS priority scoring
│
└── src-tauri/                  # Rust backend (Tauri)
    ├── Cargo.toml              # Rust package manifest and dependencies
    ├── Cargo.lock              # Dependency lock file
    ├── build.rs                # Tauri build script
    ├── tauri.conf.json         # Tauri app configuration (window, CSP, bundle)
    ├── capabilities/
    │   └── default.json        # Tauri capability permissions manifest
    ├── migrations/
    │   └── 001_init.sql        # Initial SQLite schema (tasks + app_state)
    ├── icons/                  # App icons for all platforms
    └── src/
        ├── main.rs             # Binary entry point (calls lib::run())
        ├── lib.rs              # Plugin registration, IPC commands, tray setup
        └── integrations.rs     # Webhook dispatch and OAuth URL generation
```

---

## Known Limitations

- **Analytics chart uses static data.** The `Analytics` component renders a hardcoded dataset (`[1, 5, 2, 8, 3, 0, 4]`) instead of values from `getStats()`. The stat counters in the analytics panel display `0` unconditionally. The `getStats()` function in `db.js` is correctly implemented but not connected to the component.

- **OAuth is incomplete.** `start_oauth` generates an authorization URL and opens it in the browser, but does not implement the PKCE code exchange, token storage, or any calendar read/write operations. Connecting Google Calendar or Outlook from Settings initiates browser navigation only.

- **Desktop notifications are not triggered.** `tauri-plugin-notification` is registered in the plugin chain, but no application event (task completion, Pomodoro end, deadline) currently calls into it.

- **Pomodoro duration ignores settings.** The timer is hardcoded to 25 minutes in both the Rust backend (`PomoState { time_left: 25 * 60 }`) and the React component (`25 * 60`). Settings panel fields for work/short-break/long-break durations are saved to the database but are not read by the timer logic.

- **Webhook invocation has no in-app trigger.** The `send_notification` Rust command exists and functions, but no UI action in the current codebase calls it automatically. Manual invocation via Tauri devtools or code modification is required.

- **`state.js` is a legacy artifact.** The file exists alongside `store.ts` and appears to be an earlier global state implementation. It is not imported by any current component based on this analysis.

- **Test coverage is minimal.** The test suite contains one file with 4 unit tests covering the JavaScript priority calculation fallback. No tests cover the React components, Zustand store integration, database operations, or Rust commands.

- **No CI/CD pipeline.** The `.github` directory is present but no workflow files were found in this analysis. There is no automated test, lint, or build pipeline.

- **SQLite JSON1 dependency.** Tag filtering uses the `json_each()` function, which requires SQLite 3.38 or later. This is satisfied by modern Tauri-bundled SQLite builds but is an implicit requirement not documented anywhere in the project.

- **Webhook tokens stored in plaintext.** Discord webhooks, Slack webhooks, and Telegram bot tokens are stored as plain text strings in the SQLite `app_state` table with no encryption.

- **Window decorations disabled by default.** `"decorations": false` in `tauri.conf.json` removes the OS title bar. The custom `Titlebar` component provides window drag functionality, but native OS window management behaviors (snap, maximize gestures) may differ by platform.

---

## Future Improvements

- Wire `getStats()` return values to the `Analytics` component to display live chart data and accurate stat counters.
- Complete the OAuth calendar integration: implement PKCE token exchange, secure token storage, and calendar event read/write via the Google Calendar and Microsoft Graph APIs.
- Read saved Pomodoro duration settings in both the Rust timer state and the React component at startup rather than using hardcoded values.
- Add an in-app trigger for desktop notifications on Pomodoro completion and task deadline.
- Add a mechanism (e.g., a dedicated "notify" button on a task card) that calls `send_notification` with configured webhook targets.
- Expand test coverage: add component tests using a React testing library, store integration tests, and Rust unit tests for `calc_priority` edge cases.
- Set up a GitHub Actions workflow for lint → test → release build on version tags.
- Encrypt sensitive settings (webhook URLs, bot tokens) using the OS keychain or a Tauri secrets plugin rather than plaintext SQLite storage.
- Remove or formally deprecate `state.js` to eliminate dead code.
- Add a `rust-toolchain.toml` file to pin the Rust version for reproducible builds across contributor environments.

---

## Screenshots / Demo

No screenshots or demo recordings are included in the repository. Add application screenshots to a `/docs/screenshots/` directory and link them here.

---

## License

See [LICENSE.txt](LICENSE.txt) for full license terms.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Security

See [SECURITY.md](SECURITY.md) for the security policy and vulnerability reporting process.
