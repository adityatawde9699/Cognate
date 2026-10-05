# Versioned releases

Keep application versions identical in `package.json`, both root version fields in `package-lock.json`, `src-tauri/Cargo.toml`, the Cognate package in `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. For a named prerelease such as `3.1.0-rc.5`, configure `bundle.windows.wix.version` as numeric `3.1.0.5`; MSI does not accept named prerelease identifiers. Update the MSI mapping with subsequent candidates.

Write `releases/<version>.md` with changes, migration instructions, verification evidence and remaining acceptance limitations. Commit implementation, documentation and version changes separately when practical. Check release metadata and regressions:

```sh
node scripts/verify-release.mjs
node scripts/verify-release.test.mjs
npm run typecheck
npm test
npm run build
npm run verify:build
```

Create an annotated `v<version>` tag and push it with the branch using an atomic push. Preserve published and failed candidate tags; corrections receive a new version.

The tagged release workflow first calls the blocking test workflow, then packages Linux amd64, macOS arm64 and Windows x64 on the configured GitHub runners. These are build targets; installed-platform acceptance remains separate. Secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` sign updater artifacts. OS code signing/notarization is not configured.

Pre-create a draft immediately after pushing the tag through an authenticated maintainer session. The Actions token had `contents: write` but GitHub denied draft creation during candidate builds; pre-creating the draft lets packaging jobs attach assets without requiring a personal token in CI:

```sh
gh release create v<VERSION> --verify-tag --draft --prerelease --latest=false \
  --title 'Cognate v<VERSION>' --notes-file releases/<VERSION>.md
```

Keep stabilization candidates marked prerelease and leave the stable automatic-update release unchanged. Wait for every tagged workflow job to succeed. Download every asset, validate the updater manifest version, platform entries, signatures and URLs, generate `SHA256SUMS`, and upload the checksum file. Publish only after these checks. Release candidates are evaluated by explicit installation; this procedure does not establish installed OS or production acceptance.

```sh
gh release edit v<VERSION> --draft=false --prerelease --latest=false
```

Do not promote a candidate to stable until the outstanding production roadmap acceptance evidence has been obtained. Do not publish incomplete candidate drafts.

## Published candidate — 2026-10-06

[v3.1.0-rc.5](https://github.com/adityatawde9699/Cognate/releases/tag/v3.1.0-rc.5), tag commit `55a2186`, is published as a prerelease. The [tagged workflow](https://github.com/adityatawde9699/Cognate/actions/runs/37378212787) passed all checks and Linux amd64, macOS arm64 and Windows x64 packaging. Six updater signatures were independently verified against the embedded public key, all nine updater manifest entries matched the uploaded assets, and `SHA256SUMS` covers the 14 original assets. The release has 15 assets including checksums. Stable v3.0.3 remains the latest automatic-update release.

Candidates rc.1–rc.4 were superseded without publication. CI exposed an initialization race and a Rust deprecation; packaging exposed Windows line-ending validation and required a numeric MSI mapping. Draft creation through the Actions integration was denied, so the published candidate draft was created through the maintainer session before packaging. Production acceptance remains incomplete; consult the roadmap before stable promotion.
