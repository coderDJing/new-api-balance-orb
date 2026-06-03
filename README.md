# AI Balance Orb

AI Balance Orb is a frameless Windows Tauri desktop widget for checking a New API
style account balance endpoint. It polls once per minute, shows only the numeric
remaining balance, and keeps tray commands for showing the widget, opening
settings, and exiting.

## Credentials

Credentials and provider endpoints are not stored in this repository.

Open Settings from the tray menu or the widget title bar, then enter:

- API endpoint, for example a `GET /api/user/self` compatible endpoint
- Access Token from the provider security settings
- User ID from the provider account

The app saves those values in the local Tauri app config directory on this
machine.

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

## Verification

```bash
pnpm build
pnpm check:desktop
```
