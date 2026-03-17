# Contributing to Cognote

Thank you for your interest in contributing to Cognote! We aim to build the most aesthetic, high-performance task manager across platforms.

## Development Setup

1. **Prerequisites:** You need Node.js (v22+) and the Rust toolchain installed.
2. **Install dependencies:** `npm install`
3. **Run in development:** `npm run tauri dev`

## Pull Request Process

1. Fork the repo and create your branch from `main`.
2. Ensure you've styled your JavaScript and CSS cleanly.
3. If you've modified Rust code, ensure `cargo clippy` passes.
4. Issue a PR!

## Architecture Note

Cognote is designed to be lightweight. We use **Vanilla JavaScript** natively. Please do not introduce large frontend frameworks (React/Vue) or heavy CSS libraries (Tailwind) without prior discussion as this impacts our core directive of low memory utilization.
