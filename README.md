# Cognate

![License](https://img.shields.io/github/license/adityatawde9699/Cognate)
![Tests](https://github.com/adityatawde9699/Cognate/actions/workflows/test.yml/badge.svg)
![Release](https://github.com/adityatawde9699/Cognate/actions/workflows/release.yml/badge.svg)
![Platforms](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux%20%7C%20web-blue)

**Cognate is the planner that plans your day — privately.**

Cognate is a task planner under production stabilization. Auto-plan creates day blocks from tasks and imported busy time. Planning runs locally in Rust on desktop and TypeScript in the browser; optional AI providers advise on tasks.

Desktop stores tasks in SQLite; browser/PWA uses transactional IndexedDB with retained legacy migration snapshots. Task/project history, plan commits and verified SQLite backups now have atomicity/failure tests. Signed incremental sync, revoke epochs, encrypted browser secrets and identity recovery now have local regression evidence; live OAuth, installed-app and staging/mobile validation remain production blockers. See the [production roadmap](docs/PRODUCTION_ROADMAP.md).

---

## Jump To

- [Why Cognate?](#why-cognate) — How it compares
- [Features](#features) — What you get
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Status & Roadmap](#roadmap)
- [Docs](#documentation)
- [License](#license)

---

## Why Cognate?

| Problem | Your Current Setup | Cognate |
|---|---|---|
| Dragging tasks around all day | Manual (or no scheduling) | **Auto-planned** as time blocks |
| Cloud vendor lock-in | Everything in the cloud | **Local-first** + optional sync |
| AI requires cloud API | Dependent on OpenAI/Claude | **Local Ollama** or your own key |
| Losing data offline | Must stay connected | **Local editing**; offline shell and sync recovery need validation |
| Server reading your data | Trust the corporation | **E2E encrypted**, server can't read it |
| Meetings trash your plan | Stale schedule, manual fix | **Auto-reflow** when schedule changes |
| Can't work as a team | Lone wolf or group chats | **Shared projects** (prototype) |
| "Smart" planning is fragile | Single point of failure | **Deterministic scheduler** you can audit |

Open the Plan view and use Auto-plan to schedule local work. Automatic reflow and calendar refresh have reliability gaps tracked in the roadmap.

---

## Features

**Planning & Scheduling**
- 🕐 **Auto-plan your day** — tasks scheduled as time blocks across your real calendar, respecting deadlines, priority, duration, energy, and meetings
- 🔄 **Auto-reflow** — when a meeting lands or work slips, a polling hook can request a re-plan; atomic commits and stale-plan protection remain open
- ⚡ **Energy-aware** — uses completion/scheduled-hour and Pomodoro heuristics; learning quality is unverified
- 📅 **Calendar sync** — Google/Outlook connection code and `.ics` import exist; live OAuth and timezone/recurrence handling need validation

**Capture & Workspace**
- ⌘K **Natural-language quick-add** — type "call Sam tomorrow 5pm 30m #work" → fully scheduled and pinned
- 📋 **6 views** — Plan (hero), Board (Kanban), List, Table, Calendar, Timeline (switch by keystroke)
- 🔖 **Rich tasks** — title, description, tags, deadlines, priority/effort, projects, milestones, subtasks, custom fields
- 🍅 **Pomodoro + Focus mode** — built-in timers and distraction-free working

**Privacy & Sync**
- 🔒 **End-to-end encrypted** — your server/relay *cannot* read your data, even if compromised
- 📱 **Local editing** — persisted tasks can be edited locally; offline PWA startup and reconnect fault behavior remain unverified
- 🔄 **CRDT sync** — edit tasks on laptop and phone simultaneously; operation merging exists; incomplete logging and malformed collisions remain blockers
- 🌐 **PWA companion** — installable browser shell; first-install offline/update lifecycle is unverified

**Team Collaboration** *(prototype)*
- 👥 **Share projects** — invites and encrypted relay polling; delivery timing is unverified
- 🎯 **Roles & RBAC** — viewer / commenter / editor / owner, signatures and role checks on clients; project scope and read-key revocation remain open
- 💬 **Comments & presence** — see who's online and thread discussions per task
- ⚖️ **Team auto-plan** — balance work across your roster by capacity; schedule each person's day

**AI (Your Model, Your Choice)**
- 🧠 **Multi-provider** — Claude, OpenAI, OpenRouter, Groq, Gemini, xAI, **local Ollama**
- 🚫 **Go private (1-click)** — selects Ollama; use a local endpoint, as custom remote URL validation remains open
- 🔮 **AI advisors** — improve descriptions, break into subtasks, estimate duration, suggest tags, advise on overcommitment

**Trust & Reliability**
- ↩️ **Undo/redo + Trash** — soft-delete with restore
- 💾 **Timestamped backups** — verified desktop SQLite online snapshots, including WAL; installed recovery matrix remains open
- 🎯 **Chief of Staff** — morning brief + overcommitment nudge
- 🛡️ **Secure secrets** — desktop requires the OS keychain and reports backend failures; browser secrets remain local workspace values

---

## Installation

Cognate is available for Windows, macOS, and Linux.

> [!NOTE]
> Cognate is currently an open-source project. The Windows executable is not yet code-signed, and the macOS application is not yet notarized. Your operating system may display security warnings during installation. This does not necessarily indicate that the application is malicious.

### Windows
**SmartScreen warning**

When opening Cognate for the first time, Windows Defender SmartScreen may display:
> Windows protected your PC

This happens because Cognate is currently unsigned.
To continue:
1. Click **More info**
2. Click **Run anyway**

You only need to do this once.

### macOS
**"Cognate is damaged and can't be opened"**

macOS Gatekeeper may prevent Cognate from opening because the application is not yet notarized.

**Option 1 (recommended)**
1. Right-click `Cognate.app`
2. Select **Open**
3. Click **Open** again.

**Option 2**
Remove the quarantine attribute via terminal:
```bash
xattr -dr com.apple.quarantine /Applications/Cognate.app
```
*(or if running from Downloads: `xattr -dr com.apple.quarantine ~/Downloads/Cognate.app`)*
Then launch Cognate normally.

### Linux
No additional installation steps are required.
If the AppImage is not executable:
```bash
chmod +x Cognate.AppImage
./Cognate.AppImage
```

### Verify Download
Checksum generation is not enforced by the current release workflow. If a release provides a checksum, compare it with your downloaded artifact. Example:
```bash
sha256sum Cognate_0.1.0_x64_en-US.msi
```
Use the exact artifact filename and independently verify the checksum source; signed artifact verification remains production roadmap work.

### Frequently Asked Questions

**Is Cognate safe?**
Cognate is under production stabilization. Source and release workflows are available for review, but open source and passing tests do not establish artifact safety. Installed-app behavior, signatures, recovery, and sync integrity still need validation.

**Why isn't the app signed?**
Code signing certificates require paid developer accounts. As an independent open-source project, Cognate currently distributes unsigned builds while development is ongoing. Signing and notarization are planned for a future release.

**The app won't start**
Please include the following when opening an issue:
- Operating system and version
- Cognate version
- Installation method
- Screenshots of any error messages
- Log files (if available)

### Reporting Issues
Please report installation issues on GitHub and include: OS version, CPU architecture (x64 / ARM64), Cognate version, steps to reproduce, and screenshots.

---

## How It Works

Capture creates a local task. Auto-plan reads the task cache and calendar rows, solves locally, then persists schedule blocks. Placement explanations are heuristic labels.

Task/project commands commit SQLite/IndexedDB rows and operation history together. Optional sync encrypts signed incremental batches for the v2 relay, with durable acknowledgements and saved cursors. Shared-project clients additionally verify context, roles, scoped entities and epoch markers. Reconciliation rejects unlogged local gaps and stale snapshots before atomically committing the admitted projection. It is not a complete device recovery mechanism.

See [**Architecture**](docs/ARCHITECTURE.md) for the full design.

---

## Quick Start

### Prerequisites
- Rust ([rustup.rs](https://rustup.rs))
- Node.js LTS
- Linux: `libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
- Windows: "Desktop development with C++" + WebView2 runtime

### Run

```bash
git clone https://github.com/adityatawde9699/Cognate
cd Cognate
npm install

npm run tauri dev     # Desktop app
# or
npm run dev           # Browser / PWA only
```

Open http://localhost:1420 (or see terminal for port).

### Build

```bash
npm run tauri build   # Desktop bundles → src-tauri/target/release/bundle/
npm run build         # PWA → dist/
```

---

## Usage

| Action | How |
|---|---|
| **Plan your day** | Open Plan → click Auto-plan. Drag a block to pin. |
| **Quick-add a task** | Press `⌘K` → type naturally ("ship deck friday 90m #work") → Enter |
| **Sync across devices** | Settings → Live sync → enter relay URL + passphrase on each device |
| **Share a project** | Settings → Shared projects → share → copy invite → teammate joins |
| **Use local AI** | Settings → AI → Go fully private (Ollama) → configure a local endpoint |
| **Keyboard shortcuts** | `⌘K` palette · `N` new · `/` search · `1/2/3` filters · `T` theme · `Esc` close · `Ctrl/⌘+Z` undo |

### Desktop reminders while the window is closed

Closing Cognate's desktop window now hides it to the system tray. While the app process is running, a native check reads the local SQLite database about once a minute. It alerts when a saved planned work block starts, once per scheduled start, and reminds you about due-today or overdue tasks once per task per local day. Block alerts are skipped if their start is already more than three minutes past. Enable **Desktop notifications** in Settings and allow notifications in your operating system. Use **Show Cognate** in the tray to reopen the window, or **Quit** to stop the app and its reminders. Reminders cannot fire while the laptop is asleep or the app has been quit. Day re-planning is not yet a native background service.

---

## Roadmap

The [production roadmap](docs/PRODUCTION_ROADMAP.md) is the implementation priority list. Initial stabilization protects task data, establishes atomic mutations and recovery, and validates planner constraints. Production release also requires transactional browser storage, authenticated sync, scoped collaboration, live calendar validation, and installed OS/release checks. Native mobile is a later evidence-driven decision.

## Performance

There is no reproducible benchmark harness in this checkout. Previously published exact timings and load figures are withdrawn. See [performance validation](docs/BENCHMARKS.md) for the measurements required before making claims.

## Testing

```bash
npm run typecheck
npm test
npm run build
npm run verify:build
npm run test:e2e
(cd src-tauri && cargo test)
(cd server && cargo test)
```

CI also runs Clippy on both Rust crates. Browser E2E covers IndexedDB workflows and sync-bundle exchange. SQLite tests cover WAL backup/restore and mutation rollback; a production preview test checks offline startup. Production PWA update/rollback tests pass in Chromium. Installed native runtime, live relay/OAuth and signed release installation remain unverified. See [Testing](docs/TESTING.md).

---

## Documentation

| Doc | What |
|---|---|
| [**ARCHITECTURE**](docs/ARCHITECTURE.md) | Tech stack, design decisions, system diagram, data flow |
| [**RELAY**](docs/RELAY.md) | Sync relay architecture, deployment, security model |
| [**TESTING**](docs/TESTING.md) | Test pyramid, CI coverage, test organization |
| [**PROJECT_STRUCTURE**](docs/PROJECT_STRUCTURE.md) | Folder layout, module guide, abstractions |
| [**BENCHMARKS**](docs/BENCHMARKS.md) | Measurement status and future validation |
| [**PRODUCTION ROADMAP**](docs/PRODUCTION_ROADMAP.md) | Audit, implementation priorities, acceptance criteria |

---

## Status & Honest Limitations

Task views, local planning, AI helpers, undo/redo, Trash, shared-project code, backup commands, and translations exist with varying test depth. This is not a production-ready release.

- Startup preserves matching tasks. Settings → Housekeeping reports suspected duplicates without deleting them; review unwanted copies in Tasks and move them to Trash individually.
- SQLite/IndexedDB is the operational store. Current task/project commands record history atomically; legacy row/history gaps require explicit audit/repair before reconciliation.
- Backup/restore, PWA offline startup/updates, OS integrations, and signed release artifacts require lifecycle validation.
- Google/Microsoft OAuth requires provider configuration; a live handshake is not covered by the current tests.
- Shared read-key revocation and plaintext secret fallback remain open.
- The relay is self-hosted; production durability and resource bounds are outstanding.

See [PRODUCTION_ROADMAP.md](docs/PRODUCTION_ROADMAP.md) for the full audit and current progress.

---

## Ecosystem

**Cognate is part of an interconnected suite:**

| Project | Role |
|---|---|
| **Cognate** | End-user productivity app (this repo) |
| **Amadeus AI** | Autonomous AI execution layer (coming soon) |
| **Amadeus Chat** | CLI companion for scripting |

Cognate is the best entry point for users solving a universal problem—planning work effectively—rather than appealing only to AI infrastructure enthusiasts. The CRDT and E2E encryption patterns can be reused across the ecosystem.

---

## Contributing & Support

- **Bug reports**: [GitHub Issues](https://github.com/adityatawde9699/Cognate/issues)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security**: See [SECURITY.md](SECURITY.md)
- **Code signing**: See [SIGNING.md](SIGNING.md)

---

## License

[LICENSE.txt](LICENSE.txt) — see file for details.
