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

## 2. macOS / Windows OS code signing (optional)

Add the relevant secrets the release workflow already references:

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: configure a code-signing certificate per the Tauri Windows signing
  guide and wire it into the bundle config.

Leave them unset to ship unsigned-for-OS (but updater-signed) builds.

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
