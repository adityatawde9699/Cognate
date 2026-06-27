# Cognate

![License](https://img.shields.io/github/license/adityatawde9699/Cognate)
![Tests](https://github.com/adityatawde9699/Cognate/actions/workflows/test.yml/badge.svg)
![Release](https://github.com/adityatawde9699/Cognate/actions/workflows/release.yml/badge.svg)
![Platforms](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux%20%7C%20web-blue)

**Cognate is the planner that plans your day — privately.**

It isn't another to-do list. A deterministic Rust scheduler lays out your day as
calendar- and energy-aware **time blocks**, re-planning itself when a meeting
lands or work slips, and explaining each placement in plain English. The AI that
helps can run on **your own machine** (local Ollama / llama.cpp). Your data lives
**on your device**, syncs **end-to-end encrypted** to every other device through a
dumb relay that can't read it, and — because that sync spine is a CRDT — sharing a
project turns it into a **real-time, role-based team workspace** almost for free.


---

## Table of Contents
- [What makes it different](#what-makes-it-different)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [The sync relay](#the-sync-relay)
- [Setup & Installation](#setup--installation)
- [Usage](#usage)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Status & honest limitations](#status--honest-limitations)
- [License · Contributing · Security](#license--contributing--security)

---

## What makes it different

**Auto-planning × privacy × bring-your-own-model × offline** — a combination no
incumbent ships:

- **Motion** auto-plans, but cloud-only, no privacy, no offline.
- **Todoist / Notion / TickTick** don't auto-plan at all.
- **Cognate** does all of it: open the app and your day is already laid out,
  re-flowing on disruption, on a model and machine you control, working on a plane.

The scheduler is **deterministic Rust** (fast, offline, explainable). **AI is an
advisor, not the decider** — it estimates durations, infers energy, writes the
rationale, and enriches natural-language capture, so planning still works with no
API key and no network.

---

## Features

### The Planner (the wedge)
- **Auto-plan your day/week** — a deterministic scheduler (`planner.rs`, mirrored
  in TS) places tasks against your real calendar, respecting deadlines, priority,
  estimated duration, an energy curve, working hours, and meetings.
- **"Today / Plan" hero view** — the default landing: your day as time blocks over
  the calendar, with an inline rationale for each ("Report → 2pm because the client
  call owns your morning"). Drag a block → it pins and the rest re-solves.
- **Auto-reflow** — a slipped block or a new meeting triggers a re-plan + notify.
- **Closed-loop energy model** — Cognate learns *when you actually focus* from your
  completed, focused history (Pomodoro outcomes at their scheduled hour) and feeds
  that personal energy curve back into the planner. The more you use it, the better
  it plans.
- **Calendar busy-time** — subscribe to an `.ics` URL or paste `.ics` text; or
  connect **Google / Outlook free-busy** over OAuth 2.0 + PKCE (read-only).

### Capture
- **Natural-language quick-add** — `⌘K` → "call Sam tmrw 5pm 30m #work !!" becomes a
  fully-scheduled, pinned task. A pure, offline parser extracts the date, time,
  duration, tags, and priority; an optional "Smart quick-add" AI pass fills any gaps.
- **Rich task model** — title, description, tags, deadline, importance/effort,
  projects, milestones, subtasks, recurring tasks, custom fields, 5 views
  (Board / List / Table / Calendar / Timeline), Pomodoro & Focus mode.

### Sync & privacy
- **Local-first CRDT op-log** — every mutation appends an immutable, causally-ordered
  operation (Hybrid Logical Clock + LWW); SQLite is a projection of it.
- **End-to-end-encrypted sync** — a passphrase derives an AES-GCM key and an opaque
  room id; the relay stores only ciphertext and **cannot read or merge your data**.
- **PWA companion** — the web build is installable on a phone and works offline,
  sharing the exact same core and syncing through the relay.
- **Encrypted recovery kit** — export all your sync/share secrets sealed under a
  recovery passphrase; restore on a new device.

### Teams (multiplayer falls out of the sync spine)
- **Share a project** = share a CRDT doc key. Each share gets its **own** key + relay
  room, isolated from the rest of your workspace.
- **Roles & RBAC** — viewer / commenter / editor / owner, enforced **cryptographically**:
  every op is ECDSA-signed and admitted only if its signer's role permits it. A
  compromised relay can't forge or tamper with edits.
- **Comments, assignees, presence, activity feed**, and **near-real-time** updates
  (relay long-poll → edits land in ~a second).
- **Team auto-planning** — balance a project's open work across the roster by capacity,
  then schedule each member's day. The planner moat becomes a team moat.

### AI (own your model)
- Multi-provider via one backend command: **Claude, OpenAI-compatible, OpenRouter,
  Groq, xAI, Gemini, and local Ollama / llama.cpp / self-hosted**.
- **One-click "Go fully private"** points planning, advice, and quick-add at a local
  model — nothing leaves your device.
- Helpers: improve a description, break into subtasks, suggest priority/tags, estimate
  scheduling, advise the plan, weekly report.

### Trust & polish (Act 0 + Act 5)
- **Undo/redo + Trash** (soft-delete + restore), automatic timestamped **backups** +
  one-click restore, boot-time integrity check.
- **Signed auto-update** for real distribution; secrets in the **OS keychain** (never
  plaintext).
- **Proactive chief-of-staff** — a morning brief and an overcommitment nudge ("move X")
  on the Plan, plus a once-a-day brief notification.
- **60-second first-run** — paste a calendar, get a planned day immediately.
- **i18n** (English, Español, Deutsch, Français) with browser auto-detection.
- **A11y + performance** — focus traps, keyboard nav, code-split heavy views.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Shell | **Tauri 2** (Rust backend + WebView), also a **PWA** in the browser |
| Frontend | **React 19**, **Vite 7**, **Zustand 5**, Chart.js (lazy) |
| Fonts | Space Grotesk (display), Geist + Geist Mono (body/data) |
| Backend | Rust 2021 — Tauri commands, `tauri-plugin-sql` (SQLite), `-notification`, `-shell`, `-oauth`, `-updater`; `reqwest`, `tokio`, `serde` |
| Crypto | WebCrypto — PBKDF2 → AES-GCM (E2E), ECDSA P-256 (op signing) |
| Storage | SQLite (`tauri-plugin-sql`, migrations `001`–`006`); `localStorage` fallback in the browser |
| Sync relay | a separate, dependency-light Rust crate (`server/`) — `tiny_http` + `serde_json` |
| Tests | Vitest (unit/integration + property), Playwright (e2e), `cargo test` (both crates), clippy `-D warnings` |

---

## Architecture

Four load-bearing decisions (see [`plan.md`](plan.md) → *Architecture decisions*):

1. **Scheduler in Rust, deterministic; AI is advisor.** Speed, offline, trust — AI
   failures degrade to a still-useful plan.
2. **CRDT op-log is the source of truth; SQLite is a projection; the relay is a dumb
   E2E relay.** One engine yields offline + multi-device + multiplayer; privacy is
   structural, not a setting.
3. **One platform-agnostic TS core** (`store` + `services`); only the storage/IO
   adapter (`db.js`) differs per platform → desktop / web / PWA share the logic.
4. **Test pyramid is non-negotiable** — e2e + integration + units gate CI.

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

---

## The sync relay

`server/` is a **separate, tiny Rust crate** — *not* part of the app build. It's a
dumb end-to-end-encrypted store-and-forward service: it buckets sealed blobs by an
opaque room id and a device id, exposes a version counter + long-poll for
near-real-time fan-out, and **never holds keys or sees plaintext**. It supports an
optional bearer token, per-IP rate limiting, and write-through disk persistence.

```bash
cd server
cargo run            # listens on 127.0.0.1:8787 by default
cargo test           # unit tests (routing, auth, rate limit, durability, long-poll)
```

Configure it in the app under **Settings → Live sync** (relay URL + a strong
passphrase; the passphrase never leaves your device). See [`server/README.md`](server/README.md).

---

## Setup & Installation

### Prerequisites

| Requirement | Notes |
|---|---|
| Rust toolchain | [rustup.rs](https://rustup.rs), ≥ 1.77.2 |
| Node.js | LTS recommended; `npm install` |
| Linux deps | `libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` |
| Windows | "Desktop development with C++" (for `link.exe`) + WebView2 runtime |

### Run

```bash
git clone https://github.com/adityatawde9699/Cognate
cd Cognate
npm install

npm run tauri dev     # desktop app (Vite on :1420 + Cargo)
# or
npm run dev           # browser / PWA only (localStorage fallback)
```

### Build

```bash
npm run tauri build   # desktop bundles → src-tauri/target/release/bundle/
npm run build         # static web/PWA build → dist/ (installable, offline-capable)
```

### Optional environment

OAuth calendar connect is desktop-only and needs **your own** provider client id
(read-only free/busy). Provider app verification is an external step.

| Variable | For |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Calendar free/busy |
| `MICROSOFT_CLIENT_ID` | Outlook / Microsoft 365 free/busy |

The relay reads `RELAY_ADDR`, `RELAY_DATA`, `RELAY_TOKEN`, `RELAY_RATE_LIMIT`,
`RELAY_RATE_WINDOW`, `RELAY_WORKERS`.

---

## Usage

- **Plan** — open the app (lands on **Plan**) → **Auto-plan** lays out your day; drag
  a block to pin + re-solve. Connect a calendar in **Settings → Calendar**.
- **Capture** — `⌘K`, type naturally ("ship deck friday 90m #work"), Enter.
- **Sync** — **Settings → Live sync**: run the relay, enter its URL + a shared
  passphrase on each device. Edits converge conflict-free, ciphertext-only.
- **Share** — **Settings → Shared projects**: share a project → copy the invite; a
  teammate joins, you grant a role, and you assign/comment in near-real-time.
- **Go private** — **Settings → AI → Go fully private (Ollama)**: all AI runs locally.

### Keyboard shortcuts
`⌘K` command palette / NL quick-add · `N` new task · `/` search · `1/2/3` filters ·
`T` theme · `Esc` close · `Ctrl/⌘+Z` undo.

---

## Testing

```bash
npm test                       # Vitest: unit + integration + property tests
npm run test:e2e               # Playwright: drives the app in a real browser
(cd src-tauri && cargo test)   # Rust: planner, priority, team plan, integrations
(cd server   && cargo test)    # Rust: relay routing, auth, rate limit, long-poll
```

CI (`.github/workflows/test.yml`) runs all four plus clippy `-D warnings` on both
crates. Current suite: **~200 Vitest · 17 Playwright e2e · 13 + 10 Rust**, all green.
The CRDT merge, RBAC admission, crypto, scheduler, energy model, and NL parser are
property-/unit-tested; cross-device sync and the first-run flow are covered e2e.

---

## Project Structure

```
Cognate/
├── plan.md                     # the product thesis + roadmap (Acts 0–5)
├── index.html · vite.config.js · vitest.config.js · playwright.config.ts
├── public/                     # PWA manifest + service worker + icons
├── e2e/                        # Playwright specs (smoke, plan, sync, onboarding…)
│
├── src/                        # platform-agnostic core + React UI
│   ├── App.tsx · main.tsx · store.ts · i18n.ts
│   ├── db.js / db.d.ts         # SQLite (Tauri) / localStorage (web) adapter
│   ├── components/             # PlanView, Board, SharedProjects, ChiefOfStaff,
│   │   │                       #   Onboarding, CommandPalette, Settings/*, Modals/*
│   ├── hooks/                  # useAutoReflow, useAutoSync, useAutoShareSync,
│   │   │                       #   useMorningBrief, usePomodoroConfig, …
│   ├── services/               # the engine (see Architecture)
│   │   ├── planService · energyModel · chiefOfStaff · teamPlanService
│   │   ├── oplog · oplogStore · projector · syncService
│   │   ├── crypto · identity · collab · collabProjection · shareService
│   │   ├── relayService · relayTransport · presenceService · activity
│   │   ├── recoveryService · oauthCalendarService · calendarSyncService
│   │   └── aiService · nlQuickAdd · quickAddService · privateAi · onboardingService
│   └── utils/                  # secrets (keychain), pwa, notify, export, toast
│
├── src-tauri/                  # Rust backend
│   ├── migrations/             # 001_init … 006_oplog
│   └── src/                    # lib.rs, planner.rs, ai.rs, integrations.rs,
│                               #   secrets.rs, backup.rs, planner.rs
│
└── server/                     # the E2E sync relay (separate Rust crate)
```

---

## Status & honest limitations

Acts 0–5 of [`plan.md`](plan.md) are substantially built and tested. The residuals
are deliberate or external, not unwritten features:

- **Calendar OAuth needs your own client id** + provider app verification (external);
  the PKCE flow, token refresh, and free/busy mapping are code-complete and tested.
- **Mobile is a PWA**, not a native app (installable + offline; the plan's stated
  "(or PWA)" route).
- **Collaboration is near-real-time** (relay long-poll, ~1s), not a persistent
  websocket.
- **SQLite is a synced projection of the op-log**, not a full read-cutover (a
  re-architecture would require op-log-ifying every entity type).
- The hosted relay/AI are **not a paid tier** — you bring your own API key (or run a
  local model) and self-host or run the relay yourself.

---

## License · Contributing · Security

- License: see [LICENSE.txt](LICENSE.txt).
- Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).
- Security policy & reporting: see [SECURITY.md](SECURITY.md). Code signing &
  release setup: see [SIGNING.md](SIGNING.md).
