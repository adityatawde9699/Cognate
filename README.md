# Cognote — Native App 🧠

> Cross-platform Smart Task Manager built with **Tauri 2.0**  
> Runs natively on **Windows · macOS · Linux · Android · iOS**

---

## 🚀 Quick Start

### Prerequisites

| Tool | Install |
|---|---|
| **Rust** (not yet installed) | `winget install Rustlang.Rustup` → restart terminal → `rustup default stable` |
| **Node.js** | Already installed ✅ |

### 1. Install dependencies

```powershell
cd "C:\Users\ASUS\Downloads\nano-banana"
npm install
```

### 2. Run in dev mode (opens a native window)

```powershell
npm run tauri dev
```

### 3. Build a production installer

```powershell
npm run tauri build
# Output: src-tauri/target/release/bundle/
# → Windows:  .msi installer
# → macOS:    .dmg
# → Linux:    .deb / .AppImage
```

### 4. Android (requires Android Studio + NDK)

```powershell
npm run tauri android init
npm run tauri android dev
```

### 5. iOS (requires macOS + Xcode)

```bash
npm run tauri ios init
npm run tauri ios dev
```

---

## 📁 Project Structure

```
cognote/
├── index.html                    ← App shell (Vite entry)
├── src/
│   ├── main.js                   ← Vite entry point
│   ├── style.css                 ← Glassmorphism design system
│   ├── db.js                     ← SQLite + localStorage abstraction
│   └── app.js                    ← All UI logic
├── src-tauri/
│   ├── Cargo.toml                ← Rust dependencies (Tauri 2.0)
│   ├── tauri.conf.json           ← Window + bundle config
│   ├── capabilities/default.json ← Permission manifest
│   ├── migrations/001_init.sql   ← SQLite schema
│   └── src/
│       ├── main.rs               ← App entry (suppresses Win console)
│       └── lib.rs                ← Plugin registration + migrations
├── package.json
└── vite.config.js
```

---

## ⚙️ Icons (one-time setup)

Tauri needs icon files in `src-tauri/icons/`. Generate them automatically:

```powershell
# Place a 1024×1024 PNG named app-icon.png in the project root, then:
npm run tauri icon app-icon.png
```

---

## 🗒️ Notes

- **Data persistence**: SQLite database stored at `%APPDATA%\com.cognote.app\` (Windows)
- **Browser testing**: Works in browser too; falls back to localStorage automatically
- **No server needed**: Fully offline-capable
