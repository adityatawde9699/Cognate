# Cognate

![License](https://img.shields.io/github/license/adityatawde9699/Cognate)
![Tests](https://github.com/adityatawde9699/Cognate/actions/workflows/test.yml/badge.svg)
![Release](https://github.com/adityatawde9699/Cognate/actions/workflows/release.yml/badge.svg)
![Platforms](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux%20%7C%20web-blue)

**Cognate is the planner that plans your day — privately.**

Never manually rearrange your calendar again. Open Cognate and your entire day is already scheduled — as time blocks across your calendar, color-coded by energy level and aligned with your real meetings. A task lands late? A meeting gets added? Your schedule re-flows instantly with a new rationale.

The AI advises but doesn't decide. All planning runs **offline in deterministic Rust** on your machine. Your data stays **on your device**, syncs **end-to-end encrypted** to every other device, and — thanks to a CRDT sync spine — becomes a **real-time team workspace** the moment you share.

---

## Jump To

- [Why Cognate?](#why-cognate) — How it compares
- [Features](#features) — What you get
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Status & Roadmap](#status--roadmap)
- [Docs](#documentation)
- [License](#license)

---

## Why Cognate?

| Problem | Your Current Setup | Cognate |
|---|---|---|
| Dragging tasks around all day | Manual (or no scheduling) | **Auto-planned** as time blocks |
| Cloud vendor lock-in | Everything in the cloud | **Local-first** + optional sync |
| AI requires cloud API | Dependent on OpenAI/Claude | **Local Ollama** or your own key |
| Losing data offline | Must stay connected | **Works offline**, syncs on reconnect |
| Server reading your data | Trust the corporation | **E2E encrypted**, server can't read it |
| Meetings trash your plan | Stale schedule, manual fix | **Auto-reflow** when schedule changes |
| Can't work as a team | Lone wolf or group chats | **Real-time shared workspace** |
| "Smart" planning is fragile | Single point of failure | **Deterministic scheduler** you can audit |

**The combination**: open the app and your day is already laid out, re-flowing on disruption, on a model and machine you control, working on a plane.

---

## Features

**Planning & Scheduling**
- 🕐 **Auto-plan your day** — tasks scheduled as time blocks across your real calendar, respecting deadlines, priority, duration, energy, and meetings
- 🔄 **Auto-reflow** — when a meeting lands or work slips, your entire day re-solves with a new rationale
- ⚡ **Energy-aware** — learns when you focus from completed Pomodoro sessions; uses your personal energy curve for better scheduling
- 📅 **Calendar sync** — connect Google Calendar, Outlook, or paste `.ics` URL for free-busy integration

**Capture & Workspace**
- ⌘K **Natural-language quick-add** — type "call Sam tomorrow 5pm 30m #work" → fully scheduled and pinned
- 📋 **5 views** — Plan (hero), Board (Kanban), List, Table, Calendar, Timeline (switch by keystroke)
- 🔖 **Rich tasks** — title, description, tags, deadlines, priority/effort, projects, milestones, subtasks, custom fields
- 🍅 **Pomodoro + Focus mode** — built-in timers and distraction-free working

**Privacy & Sync**
- 🔒 **End-to-end encrypted** — your server/relay *cannot* read your data, even if compromised
- 📱 **Offline-first** — works on airplane mode; syncs when reconnected
- 🔄 **CRDT sync** — edit tasks on laptop and phone simultaneously; changes merge automatically, no conflicts
- 🌐 **PWA companion** — installable on mobile, works offline, syncs through your relay

**Team Collaboration** *(falls out of the CRDT spine)*
- 👥 **Share projects** — one passphrase share = everyone gets real-time updates (~1 second)
- 🎯 **Roles & RBAC** — viewer / commenter / editor / owner, **cryptographically enforced** (relay can't forge ops)
- 💬 **Comments & presence** — see who's online and thread discussions per task
- ⚖️ **Team auto-plan** — balance work across your roster by capacity; schedule each person's day

**AI (Your Model, Your Choice)**
- 🧠 **Multi-provider** — Claude, OpenAI, OpenRouter, Groq, Gemini, xAI, **local Ollama**
- 🚫 **Go private (1-click)** — all AI runs locally on your machine; nothing leaves your device
- 🔮 **AI advisors** — improve descriptions, break into subtasks, estimate duration, suggest tags, advise on overcommitment

**Trust & Reliability**
- ↩️ **Undo/redo + Trash** — soft-delete with restore
- 💾 **Timestamped backups** — auto-backup with one-click restore
- 🎯 **Chief of Staff** — morning brief + overcommitment nudge
- 🛡️ **Secure secrets** — passphrases stored in OS keychain, never plaintext

---

## How It Works

**At its core, Cognate is a deterministic scheduler written in Rust.**

1. **Capture** → You type "call Sam tomorrow 5pm" (or click → add task)
2. **Optimize** → The scheduler places it in your day, respecting your calendar, deadlines, priority, and energy
3. **Present** → You see it as a time block with a reason ("2pm because the client call owns your morning")
4. **Interrupt** → A meeting arrives; the entire day re-solves in ~7 ms
5. **Sync** → Edits encrypt, sign, and flow to your relay (or stay local if offline)
6. **Merge** → Other devices decrypt, verify, and merge (no conflicts, ever)

**Why Rust?** Speed, offline capability, determinism. You can audit why tasks are placed.

**Why CRDT?** One sync engine unlocks offline, multi-device, and multiplayer *simultaneously*. Sharing a project is just sharing a key.

**Why E2E?** The relay can't read your tasks (only ciphertext), forge edits (ops are ECDSA-signed), or go down and lose your data (everything is local first).

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
| **Plan your day** | Open the app (lands on Plan view) → auto-plan lays it out. Drag a block to pin. |
| **Quick-add a task** | Press `⌘K` → type naturally ("ship deck friday 90m #work") → Enter |
| **Sync across devices** | Settings → Live sync → enter relay URL + passphrase on each device |
| **Share a project** | Settings → Shared projects → share → copy invite → teammate joins |
| **Use local AI** | Settings → AI → Go fully private (Ollama) → all AI runs on your machine |
| **Keyboard shortcuts** | `⌘K` palette · `N` new · `/` search · `1/2/3` filters · `T` theme · `Esc` close · `Ctrl/⌘+Z` undo |

---

## Roadmap

| Phase | Status | What |
|---|---|---|
| **Core Planner** | ✅ | Auto-planning, energy model, calendar sync |
| **Offline + Sync** | ✅ | CRDT op-log, E2E encryption, relay |
| **Teams** | ✅ | Shared projects, RBAC, comments, presence |
| **AI** | ✅ | Multi-provider, local Ollama, advisors |
| **Polish** | ✅ | Undo/redo, backups, Chief of Staff, i18n |
| **Public Relay** | 🔜 | Hosted relay (self-host or bring your own) |
| **Native Mobile** | 🔜 | iOS app (today: PWA) |
| **Marketplace** | 🔜 | Custom integrations, workflows, plugins |


---

## Performance

Cognate is built for speed:

| Operation | Latency |
|---|---|
| Auto-plan 100 tasks | **14 ms** |
| Re-plan (on interrupt) | **7 ms** |
| App startup | **180 ms** |
| Sync round-trip | **~1 s** (long-poll) |
| Encrypt/decrypt | **<1 ms** per op |

See [**Benchmarks**](docs/BENCHMARKS.md) for detailed performance data.

---

## Testing

A comprehensive test pyramid ensures reliability:

```bash
npm test                       # ~200 Vitest (unit + integration + property)
npm run test:e2e               # 17 Playwright e2e scenarios
(cd src-tauri && cargo test)   # Rust: scheduler, priority, team plan
(cd server && cargo test)      # Rust: relay routing, auth, rate limit
```

**Coverage**: CRDT merge, RBAC admission, crypto, scheduler, energy model, NL parser (all unit/property tested). Cross-device sync and first-run flow covered e2e. See [**Testing**](docs/TESTING.md).

---

## Documentation

| Doc | What |
|---|---|
| [**ARCHITECTURE**](docs/ARCHITECTURE.md) | Tech stack, design decisions, system diagram, data flow |
| [**RELAY**](docs/RELAY.md) | Sync relay architecture, deployment, security model |
| [**TESTING**](docs/TESTING.md) | Test pyramid, CI coverage, test organization |
| [**PROJECT_STRUCTURE**](docs/PROJECT_STRUCTURE.md) | Folder layout, module guide, abstractions |
| [**BENCHMARKS**](docs/BENCHMARKS.md) | Performance profiling, comparisons with incumbents |
| [**PLAN**](plan.md) | Product vision, roadmap (Acts 0–5), feature breakdown |

---

## Status & Honest Limitations

**Built & tested**: Core planner, offline sync, teams, AI, undo/redo, backups, i18n (EN, ES, DE, FR).

**Deliberate choices**:
- **Mobile**: PWA (installable, offline, full sync) not native app
- **Sync latency**: ~1 second (long-poll) not persistent websocket
- **Calendar OAuth**: Requires your own provider client ID (PKCE flow tested end-to-end)
- **SQLite projection**: Synced from op-log, not a full read-cutover
- **No hosted tier**: You bring your own API key (or local model) and self-host the relay

See [plan.md](plan.md#status--honest-limitations) for the full breakdown.

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
