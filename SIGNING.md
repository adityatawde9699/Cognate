# Signing & auto-update

Cognate ships signed, auto-updating desktop builds. Two independent layers:

1. **Updater signing (required for auto-update)** — a minisign keypair. The
   public key is committed in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`);
   the private key signs each release so the in-app updater can verify it.
2. **OS code signing (optional but recommended)** — Apple Developer cert +
   notarization on macOS, Authenticode on Windows. Needed to avoid Gatekeeper /
   SmartScreen warnings. Requires paid certificates.

## 1. Updater signing key (one-time)

```bash
npm run tauri signer generate -- -w src-tauri/.tauri/cognote-updater.key
```

This prints/saves a **private** key (`src-tauri/.tauri/` is gitignored — never
commit it) and a public key. Put the public key in `tauri.conf.json` under
`plugins.updater.pubkey` (a key is already configured for this repo).

Then add GitHub repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you set (empty if none) |

> ⚠️ If you lose the private key or password you can't ship verifiable updates —
> existing installs would have to be reinstalled manually. Back it up securely.

**Current key (as of 2026-07-07):** the keypair was regenerated with no
password after the original private key's password was lost. The private key
lives at `src-tauri/.tauri/cognote-updater.key` (gitignored) with a matching
empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret already set on the repo. The
old, password-protected key is kept as `cognote-updater.key.bak-passworded`
for reference only — it no longer matches the pubkey in `tauri.conf.json` and
cannot sign releases. v3.0.2 was the first release built and published with
the new key; every asset's `.sig` was verified against the new pubkey.

## 2. macOS / Windows OS code signing (optional, currently unconfigured)

The `APPLE_*` env vars are **not** currently set in `.github/workflows/release.yml` —
they were removed on purpose. Tauri's bundler treats an empty-but-present
`APPLE_CERTIFICATE` as "sign this" and fails importing it, so the vars must be
absent entirely rather than set to empty strings. Builds ship unsigned for OS
(but still updater-signed); macOS users see a Gatekeeper "unidentified
developer" warning on first launch (right-click → Open).

To enable it once you have a paid Apple Developer account, re-add these lines
to the `env:` block in `release.yml` and set the matching repo secrets:

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: configure a code-signing certificate per the Tauri Windows signing
  guide and wire it into the bundle config.

## Releasing

Push a tag and the release workflow builds every platform, signs the updater
artifacts, and publishes a draft GitHub Release including `latest.json`:

```bash
npm version patch        # bumps package.json + tags
# keep src-tauri/tauri.conf.json "version" in sync, then:
git push --follow-tags
```

Publish the drafted release. The in-app updater polls
`releases/latest/download/latest.json`; on next launch users are offered the
update (verified against the public key) and can install + relaunch from
**Settings → Updates**.
