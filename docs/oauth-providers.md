# OAuth apps for cloud sync

Rustty supports direct encrypted sync through Google Drive.
The sync payload is still encrypted locally with the user's master passphrase
before any cloud API sees it.

## Build-time credentials

Official/distributed builds should embed the app credentials at build time:

```bash
export RUSTTY_GOOGLE_DRIVE_CLIENT_ID="..."
export RUSTTY_GOOGLE_DRIVE_CLIENT_SECRET="..." # optional for installed apps
npm run tauri build
```

Development builds must set the same environment variables before launching
`npm run tauri dev`.

These credentials are intentionally not exposed as settings in the app UI.
Users only see "Connect Google Drive"; Rustty opens the browser, receives the
OAuth callback locally and stores the resulting refresh token in the OS keyring.

## Redirect URI

Register this exact redirect URI for the Google OAuth client:

```text
http://127.0.0.1:53682/oauth/callback
```

## Google Drive

Create a Google Cloud project for Rustty.

1. Enable Google Drive API.
2. Configure the OAuth consent screen.
3. Create an OAuth client for a desktop/native app.
4. Use the client id as `RUSTTY_GOOGLE_DRIVE_CLIENT_ID`.
5. If Google provides/requires a client secret for the desktop client, use it as
   `RUSTTY_GOOGLE_DRIVE_CLIENT_SECRET`.

Rustty requests this scope:

```text
https://www.googleapis.com/auth/drive.appdata
```

Rustty stores `rustty-sync.bin` in Drive `appDataFolder`, so the app does not
need broad access to the user's visible Drive files.

## Release checklist

- Verify Google Drive with a fresh user account.
- Remove local per-user overrides from `sync_config.json` before release tests.
- Confirm refresh-token reuse after app restart.
- Confirm "Disconnect" deletes the provider refresh token from the OS keyring.
- Confirm wrong/lost master passphrase fails before applying remote state.
