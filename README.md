# New API Balance Orb

<p align="center">
  <a href="./README.zh_CN.md">简体中文</a> |
  <strong>English</strong>
</p>

New API Balance Orb is a frameless Windows Tauri desktop widget for tracking
multiple New API compatible account balances in one compact window.

<p align="center">
  <img src="./docs/assets/balance-window.gif" alt="New API Balance Orb balance window demo" width="280">
</p>

## About New API

[New API](https://github.com/QuantumNous/new-api) is a next-generation LLM
gateway and AI asset management system. It provides a unified OpenAI-compatible
API for multiple AI models, with features like channel routing, usage analytics,
cost accounting, and organization-level access control.

This widget is designed to work with New API deployments. To use it, you need a
running New API instance with a valid account.

## Multi-site Balances

Credentials and provider endpoints are not stored in this repository.

Configure one or more New API compatible sites. Each site can have its own:

- Display name, or leave it empty to use the endpoint domain prefix
- API endpoint, for example a `GET /api/user/self` compatible endpoint
- Access Token from the provider security settings
- User ID from the provider account
- Refresh interval in seconds

<p align="center">
  <img src="./docs/assets/form-guide.png" alt="New API form guide" width="720">
</p>

The app saves those values in the local Tauri app config directory on this
machine. Older single-site config files are migrated into the current multi-site
format automatically.

## Auto Update

Release builds use Tauri signed updater through GitHub Releases:

```text
https://github.com/coderDJing/new-api-balance-orb/releases/latest/download/latest.json
```

The updater public key is stored in `src-tauri/tauri.conf.json`. The matching
private key is local-only:

```text
C:\Users\coder\.tauri\ai-balance-orb.key
```

Do not commit the private key or paste it into issue/release text. GitHub
Actions needs these repository secrets for signed updater artifacts:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The current key has no password, so the password secret may be empty or omitted.

## Development

```bash
pnpm install
pnpm tauri:dev
```

## Desktop Builds

Build on the target platform:

```bash
pnpm tauri:build
```

The repository includes GitHub Actions for Windows builds.

## Release

Release versions must stay synchronized in `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.

Run the release script from the repository root:

```powershell
.\scripts\release.ps1 0.1.1
```

The script validates a clean `master` branch, updates the three version files,
runs `pnpm build`, `pnpm check:desktop`, and a local signed debug NSIS updater
build, commits the version bump, creates the `v0.1.1` tag, and pushes `master`
plus the tag. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which
builds and publishes the Windows GitHub Release with installer, signature, and
`latest.json`.

The release workflow keeps:

- `releaseDraft: false`
- `prerelease: false`
- `updaterJsonPreferNsis: true`
- `args: --ci`

## Verification

```bash
pnpm build
pnpm check:desktop
```

Signed updater artifact smoke check:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "C:/Users/coder/.tauri/ai-balance-orb.key"
pnpm tauri build --debug --bundles nsis --ci
```

Expected debug bundle outputs:

```text
src-tauri/target/debug/bundle/nsis/*.exe
src-tauri/target/debug/bundle/nsis/*.exe.sig
```
