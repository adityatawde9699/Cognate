# Cognote

## Project Overview
Cognote is a cross-platform smart task manager built to organize personal workflows with integrated time management. It provides a local-first architecture for task tracking, utilizing a kanban-style board and an embedded Pomodoro timer for focused work sessions, prioritizing tasks dynamically based on effort, importance, and deadlines.

## Features
- **Local Storage**: Native SQLite integration with a browser-based `localStorage` fallback.
- **Priority Engine**: Automated priority calculation (Low, Medium, High) derived from task effort, importance, and deadline proximity.
- **Kanban Board**: Drag-and-drop task organization with visual indicators for overdues and Pomodoro counts.
- **Pomodoro Timer**: Integrated focus timer (25m work, 5m short break, 15m long break) with OS-level notifications and automatic transition options.
- **Analytics Dashboard**: Visual tracking of completed tasks, focus hours, current streaks, and a priority breakdown using Chart.js.
- **Data Export**: Functionality to export task data in JSON or CSV formats.
- **Task Tagging**: Custom tagging system for task categorization and filtering.
- **Webhook Integrations**: Configurable Discord and Slack webhook URLs for external notifications.
- **Telegram Bot Integration**: Optional setup with Telegram Bot Token and Chat ID.
- **Experimental API**: OAuth calendar integrations (Google, Outlook) — UI elements exist, but the Rust backend implementation is mocked and incomplete.

## Tech Stack

**Runtime**
- Tauri
**Languages**
- Rust
- JavaScript
- HTML/CSS
**Frameworks**
- Vite
**Databases**
- SQLite (via `tauri-plugin-sql`)
**APIs / Services**
- Chart.js (Frontend visualizations)
- Telegram Bot API (Optional integrations)

**Development**
- **Testing tools**: Vitest (configured via `vitest.config.js`)
- **Build tools**: Vite, Tauri CLI
- **Linters / Formatters**: None officially configured.

## Architecture / Design
Cognote follows a classic Tauri architecture, cleanly separating the web frontend from the native systems backend. The frontend handles state management, UI rendering, and user interactions, while delegating persistent storage, operating system notifications, and complex math (priority calculations) to the Rust backend to avoid UI thread blocking.

```text
Frontend (JS/HTML/CSS) ← IPC → Tauri Core (Rust) ↔ SQLite Database
        ↓                              ↓
 Browser Storage (Fallback)       OS Notifications
```

## Setup & Installation

### Prerequisites
- Node.js (v20.19+ or v22.12+)
- Rust (v1.77.2+)
- Tauri CLI prerequisites (C++ Build Tools for Windows, WebKit for macOS/Linux)

### Dependency installation
```bash
npm install
```

### Environment variables
- `TAURI_DEV_HOST`: Can be set to configure the development server host bindings.

### Database setup
Database setup is handled automatically on startup via `tauri-plugin-sql` migrations (`001_init.sql`).

### Running the project locally
```bash
npm run tauri dev
```

### Building for production
```bash
npm run build
npm run tauri build
```

## Usage
Run the application locally to access the dashboard.
Examples:
- **Create a Task**: Click "New Task" or use the `N` keyboard shortcut. Set effort and importance to let the engine determine priority.
- **Focus Mode**: Click the stopwatch icon on any task to bind it to the Pomodoro timer, then click play to start a session.
- **Search**: Press `/` to focus the search bar to filter by title, description, or tags.

## Project Structure
- `/src-tauri/` - Rust backend, maintaining Tauri configuration (`tauri.conf.json`), IPC commands (`src/main.rs`, `src/lib.rs`), mock external integrations (`src/integrations.rs`), and SQLite migrations (`migrations/`).
- `/src/` - Frontend codebase containing the core application logic (`app.js`, `db.js`, `state.js`, `main.js`).
- `/src/ui/` - Segmented UI components (board, pomodoro, analytics, settings, modal, tags).
- `/src/utils/` - UI helper functions (`format.js`, `toast.js`).

## Known Limitations
- **Incomplete modules**: The OAuth Calendar integration (`src-tauri/src/integrations.rs`) utilizes hardcoded mock URLs.
- **Missing tests**: While Vitest is configured, there are no existing test suites verifying logic.
- **Lack of scalability**: Heavy reliance on procedural Vanilla JS DOM manipulation limits scalability across larger teams.
- **Security limitations**: Calendar OAuth scopes and external webhooks do not have strict secret management outside of SQLite/LocalStorage.

## Future Improvements
- Implemented OAuth authentication flows for Google and Outlook calendar synchronizations.
- Expand unit and integration test coverage across both Rust and JavaScript tiers.
- Modularize the frontend using a reactive framework (e.g., React/Vue) for improved state handling.
- Set up a CI/CD pipeline via GitHub Actions for automated testing and release builds.

## Screenshots / Demo
*(Add demo links or screenshots here to showcase the kanban board and analytics panel)*
