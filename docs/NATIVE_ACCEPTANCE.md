# Native desktop acceptance

The Linux smoke runner uses Tauri WebDriver against a dedicated build with application identifier `com.cognate.smoke` and temporary config/data/cache roots. It refuses any other application identifier. Never point it at an installed Cognate profile. Run it on Linux with Xvfb, WebKitWebDriver, a Secret Service session, and `tauri-driver` installed:

```sh
npm run tauri build -- --no-bundle --config src-tauri/tauri.smoke.conf.json -- --bin cognate
xvfb-run -a npm run test:native
```

The runner checks the real Tauri webview, window/tray/keychain/cache probes, creates a task through the UI and checks its SQLite projection, restores a coherent backup, verifies close-to-tray and second-launch focus, then kills the isolated process and confirms an acknowledged task survives restart. CI runs the same gate with an isolated DBus/Secret Service session. Its JSON evidence is uploaded with the workflow.

The smoke profile and temporary OS roots isolate credentials and data. The currently installed production app is not a test target. The Linux test validates window close/reopen and tray registration; it does not synthesize a click in every desktop shell or confirm the notification center's delivery/action behavior.

| Platform | Automated coverage | Still required on a real installed build |
| --- | --- | --- |
| Linux | WebView, tray registration, Secret Service roundtrip, cache write/fsync/read/delete, SQLite task/backup/restore, close/relaunch/single-instance, hard kill/reopen | GNOME/KDE tray interaction, notification delivery and click behavior, locked keyring, upgrade from published release, restricted disk/low-space behavior |
| Windows | CI native Rust storage/AI tests and Clippy; packaged artifacts built by release workflow | Installed WebView2 smoke, tray/minimize/notification actions, Credential Manager, signed update/rollback and data restore |
| macOS | CI native Rust storage/AI tests and Clippy; packaged artifacts built by release workflow | Installed WebKit smoke, menu-bar/tray and notification actions, Keychain, signed/notarized update/rollback and data restore |

The macOS and Windows installed-app rows remain open. Platform packaging and cross-platform compilation do not count as installed-app acceptance. Do not mark R24 or the native portion of R26 complete until these runs have retained evidence.
