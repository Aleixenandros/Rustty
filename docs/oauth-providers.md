# OAuth apps for cloud sync

Rustty supports direct encrypted sync through Google Drive, OneDrive and Dropbox.
The sync payload is still encrypted locally with the user's master passphrase
before any cloud API sees it.

## Build-time credentials

Official/distributed builds should embed the app credentials at build time:

```bash
export RUSTTY_GOOGLE_DRIVE_CLIENT_ID="..."
export RUSTTY_GOOGLE_DRIVE_CLIENT_SECRET="..." # optional for installed apps
export RUSTTY_ONEDRIVE_CLIENT_ID="..."
export RUSTTY_ONEDRIVE_TENANT="common"
export RUSTTY_DROPBOX_CLIENT_ID="..."
npm run tauri build
```

Development or self-hosted builds can also enter these values in:

Preferences -> Backups -> Cloud sync -> Application credentials

## Redirect URI

Register this exact redirect URI for every provider that asks for one:

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

## OneDrive

Create an app registration in Microsoft Entra / Azure Portal.

1. Register a public/native client app.
2. Add a localhost/native redirect URI for Rustty.
3. Enable public client flows if the portal requires it for native apps.
4. Use the Application (client) ID as `RUSTTY_ONEDRIVE_CLIENT_ID`.
5. Leave `RUSTTY_ONEDRIVE_TENANT=common` unless the build is organization-only.

Rustty requests these scopes:

```text
offline_access Files.ReadWrite.AppFolder
```

Rustty uploads `rustty-sync.bin` into the app folder via Microsoft Graph.

## Dropbox

Create a Dropbox Platform app.

1. Choose Scoped access.
2. Choose App folder access.
3. Add the redirect URI above.
4. Allow public clients / PKCE if the console exposes that switch.
5. Use the App key as `RUSTTY_DROPBOX_CLIENT_ID`.

Rustty uses OAuth code flow with PKCE and `token_access_type=offline`, then
uploads `/rustty-sync.bin` into the app folder.

## Release checklist

- Verify each provider with a fresh user account.
- Remove local per-user overrides from `sync_config.json` before release tests.
- Confirm refresh-token reuse after app restart.
- Confirm "Disconnect" deletes the provider refresh token from the OS keyring.
- Confirm wrong/lost master passphrase fails before applying remote state.
