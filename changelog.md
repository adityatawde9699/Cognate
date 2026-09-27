# Changelog

## Unreleased

### Added

- Background desktop reminders for scheduled block starts, due-today tasks, and overdue tasks while Cognate is closed to the tray.
- Native desktop title-bar dragging, double-click maximize/restore, and window controls for the frameless Tauri window.
- Production roadmap covering data safety, synchronization, security, recovery, cross-platform support, and release engineering.

### Improved

- AI estimation now reports actionable provider errors instead of a generic failure message.
- Selecting an AI provider automatically fills its default model and endpoint settings.
- Existing profiles with an empty AI model use safe provider defaults.
- Generate Tasks supports up to 30 tasks and preserves explicitly numbered requirements.
- Generate Tasks detects project names from natural-language instructions and assigns generated tasks to that project.
- Desktop settings explain tray behavior and the available notification types.

### Validation

- Web production build passes.
- 206 Vitest tests pass.
- Desktop Rust tests and packaging were validated during this release work.
