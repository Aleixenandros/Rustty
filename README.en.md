# Rustty - Cross-Platform SSH Client🦀⚡

> 🌐 Versión en español: [README.md](README.md)

> ⚠️ **Notice**: this repository contains code and documentation generated in part with AI agents.
> Contributions and/or criticism are welcome.

**Rustty** is a cross-platform, modern and lightweight terminal client and connection manager, designed to deliver a smooth experience for administering remote servers. Built with **Rust** and **Tauri**, it combines the power of low-level tooling with a modern, agile web interface.

## Key features

- **Multi-protocol**: SSH, SFTP, FTP, FTPS and RDP connections (the latter via external `xfreerdp` / `mstsc`).
- **Modern terminal**: xterm.js with themes, configurable cursor, scrollback, **in-buffer search** (Ctrl+F), a bottom bar with status/latency/diagnostics, OSC 7 support (tracking the remote `cwd`) and a **multi-line command editor** (Ctrl+Shift+E) to compose long commands, with a per-profile draft.
- **Markdown notes per connection (runbooks)**: right-click a connection to **add or edit a Markdown note**, with a live-preview editor, formatting toolbar, title and tags. Each note is stored as a self-contained `.md` file (syncable, opt-in in Backups), resolves `${host}/${user}/…` variables in the preview and can be shown as a **runbook panel** next to the session with interactive task checkboxes. Shortcut `Ctrl+Shift+M`.
- **Integrated file panel**: SFTP/FTP/FTPS explorer with a **split remote / local view** (remote on the left or right, configurable in Preferences → Aesthetics), recursive folder transfers, drag & drop, configurable conflicts, transfer queue, resizable tabbed logs, context menus, **path autocompletion** (`Tab` and a suggestions dropdown), **file search** by name in the current directory or recursively, creation of folders and empty files on both sides, optional tracking of the terminal directory over SSH, and elevation to **sudo** when the server allows it. SFTP transfers use **pipelining** (simultaneous in-flight requests of 256 KiB, configurable in Preferences) and saturate the connection's actual bandwidth instead of being limited by RTT; the number of parallel requests can be lowered for servers with a handle limit (e.g. Hetzner Storage Box).
- **SSH CLI**: list saved connections with `rustty -l`, connect directly with `rustty -c <name|id|ip|host>` and run remote commands with `--exec`, `--` or the alias `rustty -c <profile> "cmd"`, without opening the graphical interface.
- **Integrated SSH tunnels**: **local** (`-L`), **remote** (`-R`) and **dynamic / SOCKS** (`-D`) port forwarding over an active session or from the global quick access, with a status panel, traffic, saved tunnels and optional per-profile auto-connect.
- **Advanced per-profile SSH options**: configurable keep-alive, **automatic reconnection with backoff** on drops, **session recording** to file, bastion / ProxyJump, agent forwarding, X11 forwarding and an option to allow legacy ciphers / kex / MACs (aes-cbc, dh-sha1, hmac-sha1, ssh-rsa) on old servers.
- **Multiple users per connection**: add extra identities to a profile (each with its own authentication: password, master credential, SSH key or agent). Connecting uses the primary one; right-click → **“Connect as another user”** picks an alternative identity, and `Ctrl+P` pastes the password of the user that session logged in with. Available for SSH, RDP and SFTP/FTP.
- **Restore previous screen**: right-click → **“Connect and restore previous screen”** reconnects, repainting what was shown in the last session (a *visual* scrollback restore, not the remote process). The capture is stored on disk per profile and can be turned off in Preferences → Terminal; it is never synced.
- **Multi-tab and split views**: work with multiple simultaneous sessions, arrange them in horizontal / vertical / grid *splits* and enable *broadcast* to type into several at once.
- **Polished sidebar**: a vertical rail of icons (Profiles, Favorites, Tunnels, Activity, Sync, Preferences and quick actions), **drag & drop** between folders and workspaces, per-folder colors, remembering of the expanded tree and automatic selection of the connection associated with the active tab.
- **Diagnostics and activity**: a **Test** button in the connection modal without saving the profile, staged SSH logs, TCP checks for RDP/FTP/FTPS and a persistent global activity center with transfers, sync, errors and updates grouped by day.
- **System tray / quick launcher**: quick access to favorites, recents, workspaces, local console, **Wake On LAN** for profiles with a MAC address and show/hide window from the tray icon. Optionally **start Rustty with the system** and **start minimized** to the tray (opt-in, under Preferences → System).
- **Granular export**: export all profiles, those of a folder or those of a workspace to JSON from the context menu, asking first whether saved passwords/passphrases should be included.
- **Import from other tools**: import your `~/.ssh/config` or, via a **step-by-step wizard**, connections from **mRemoteNG** (`.xml`) or **Ásbrú Connection Manager** (`.yml`) — it rebuilds the folder tree into a new workspace, lets you choose what to import, shows progress and optionally decrypts the saved passwords (all locally).
- **Security**:
  - Native integration with the system keyring (Secret Service/KWallet on Linux, macOS Keychain, Windows Credential Store).
  - Support for **KeePass** databases (`.kdbx`) as a password source.
  - Reusable **master credentials**: define a password once and reference it from several profiles with `${master:name}`; the value lives only in the keyring and rotating it updates every profile that uses it. It is part of a **variable engine** (`${host}`, `${env:…}`, `${var:…}`, `${ask:…}`) resolved at connection time, including fields such as the host or the user.
  - `Ctrl+P` shortcut to paste the active profile's password (the one of the **user the session logged in with**, if an additional user was used) without exposing it on screen; it is only sent to the connected, focused SSH session and is blocked while *broadcast* is active so the secret is never fanned out.
  - **Private / ephemeral session** ("Open in private" from the profile menu): leaves no trace in recents, the activity center, drafts or session recording, and the tab is marked as private.
  - `known_hosts` verification with TOFU and a warning on fingerprint changes, plus a **visual `known_hosts` manager** in Preferences to review fingerprints and remove conflicting entries.
  - Warning and confirmation when **enabling agent forwarding**, so you don't share the SSH agent with untrusted hosts by mistake.
  - **Configurable retention of session logs** (by age and size) with manual cleanup and a sensitive-content warning.
- **E2E backups and synchronization**: profiles, preferences, themes, shortcuts, connection notes and, if you enable it, saved passwords can be synchronized with Google Drive, iCloud Drive, a local folder / NAS or WebDAV. The remote blob is encrypted locally with `age` and a master passphrase. **Event-based** synchronization (it checks at startup and syncs if there are local/remote changes) and **restoration of historical snapshots** from the Backups tab.
- **Organization**: group connections into independent **container profiles (workspaces)**, in folders within each workspace, **favorite connections** and sidebar views (current workspace, all profiles, favorites), quick search and duplication of connections / sessions from the context menu.
- **Customization**: 12 built-in base themes and an extended library of 221 preloaded Rustty v2 themes for the interface and terminal, plus cursor, scrollback and *bell* settings. Ability to import custom themes in JSON v2 format with UI and terminal tokens.
- **Internationalization**: interface translated into Spanish, English, French, Portuguese and German. (Translations done with AI)

## Screenshots

Welcome screen with the system light theme:

![Welcome screen](images/Captura1.png)

Several sessions open in tabs and the connection panel context menu (dark theme):

![Tabs and context menu](images/Captura2.png)

Grid split view: four panels in the same tab with the *layout* selector in the top-right corner:

![Grid split view](images/Captura5.png)

Preferences → **Appearance**: global interface theme and an independent terminal theme (with the "Same as interface" *swatch* for inheritance):

![Theme selector](images/Captura4.png)

Preferences → **Language**: interface available in Spanish, English, French and Portuguese:

![Language selector](images/Captura3.png)

## Keyboard shortcuts

Rustty includes a **shortcut editor** in Preferences → *Shortcuts* that lets you reassign any action with live capture (press "Edit" and the new combination). The default shortcuts are:

| Shortcut                       | Action                                                 |
|--------------------------------|--------------------------------------------------------|
| `Ctrl+Shift+N`                 | New connection                                         |
| `Ctrl+Shift+T`                 | New local console                                      |
| `Ctrl+W`                       | Close active tab                                       |
| `Ctrl+Tab`                     | Next tab                                               |
| `Ctrl+Shift+Tab`               | Previous tab                                           |
| `Ctrl+,`                       | Open preferences                                       |
| `Ctrl+Alt+C`                   | Copy terminal selection                                |
| `Ctrl+Alt+V`                   | Paste into the terminal                                |
| `Ctrl+P`                       | Paste the active profile's password into the shell    |
| `Ctrl+Shift+E`                 | Open the multi-line command editor                     |
| `Ctrl+K`                       | Search connections from any view                       |
| `Ctrl+F`                       | Search within the terminal buffer                      |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Increase / decrease / reset the font size              |

## SSH CLI

Rustty can also be used from the terminal to work with saved SSH connections:

```bash
rustty -l
rustty --list
rustty -l --json
rustty -c <nombre|id|ip|host>
rustty --connect <nombre|id|ip|host>
rustty -c <nombre|id|ip|host> --exec "uptime"
rustty -c <nombre|id|ip|host> -- hostname
rustty -c <nombre|id|ip|host> "hostname"
rustty -c <nombre|id|ip|host> --tty -- sudo systemctl status nginx
```

`-c` reuses the profile data, the system keyring, `known_hosts`, ProxyJump, keepalive, agent forwarding and the legacy compatibility configured on the connection. If a password or passphrase is not stored in the keyring, it will prompt for it in the terminal without showing it.

When a remote command is added, Rustty opens an SSH `exec` channel, writes `stdout`/`stderr` to the local terminal and exits with the remote exit code. `--exec` is the recommended form for commands with quotes or pipes; `--` accepts a short form similar to `ssh`, and extra text after the profile is left as a convenient alias. `--tty` requests a pseudo-terminal for commands that need it, such as some uses of `sudo`.

## Installation

Each GitHub release provides precompiled binaries for Linux, Windows and macOS. You can download them from the [Releases](https://github.com/Aleixenandros/Rustty/releases) page or from the project website: [rustty.es/descargas](https://rustty.es/descargas).

### Quick install with a script

On Linux and macOS you can install Rustty with the official script:

```bash
curl -sSf https://rustty.es/install.sh | sh
```

The script queries the latest published release, detects your system and downloads the appropriate artifact. Internally it invokes `sudo` only when the package manager needs it; do **not** run `sudo sh` over the whole script.

If you prefer to review it first:

```bash
curl -sSf https://rustty.es/install.sh -o install.sh
less install.sh
sh install.sh
```

| Detected system | Artifact used | Installation |
| --- | --- | --- |
| Arch / Manjaro / EndeavourOS | `.pkg.tar.zst` | `sudo pacman -U` |
| Debian / Ubuntu / Mint | `.deb` | `sudo apt-get install` |
| Fedora / RHEL / CentOS / Rocky / AlmaLinux | `.rpm` | `sudo dnf install` |
| openSUSE / SUSE | `.rpm` | `sudo zypper install` |
| Other Linux distributions | `AppImage` | copied to `~/.local/bin/rustty` |
| macOS Apple Silicon | `.app.tar.gz` | extracted to `~/Applications/Rustty.app` |

To update to a new version, run the same command again. On Linux it will replace the package via the corresponding package manager; on macOS it will replace `~/Applications/Rustty.app`.

> The automatic installer is not available for Windows. Use the MSI, NSIS or portable from the release.

### Linux

Rustty requires **WebKitGTK 4.1** and **libayatana-appindicator** at runtime (on most distributions they are already installed or are resolved as a dependency when installing the package).

- **AppImage (`Rustty_<version>_amd64.AppImage`)** — portable, requires no installation:

  ```bash
  chmod +x Rustty_*_amd64.AppImage
  ./Rustty_*_amd64.AppImage
  ```

- **.deb (Debian / Ubuntu / Mint / ...)**:

  ```bash
  sudo apt install ./Rustty_*_amd64.deb
  ```

- **.rpm (Fedora / openSUSE / RHEL / ...)**:

  ```bash
  sudo dnf install ./Rustty-*-1.x86_64.rpm        # Fedora
  sudo zypper install ./Rustty-*-1.x86_64.rpm     # openSUSE
  ```

- **.pkg.tar.zst (Arch / Manjaro / EndeavourOS / ...)**:

  ```bash
  sudo pacman -U Rustty-*-1-x86_64.pkg.tar.zst
  ```

- **Flatpak (`Rustty-<version>-x86_64.flatpak`)** — self-contained bundle, no remotes needed:

  ```bash
  flatpak install ./Rustty-*-x86_64.flatpak
  flatpak run es.rustty.Rustty
  ```

  Requires the `org.freedesktop.Platform 24.08` runtime (Flatpak downloads it on first install).

  If your distribution does not include WebKitGTK 4.1 by default, install it first (see "Prerequisites" below).

### Windows

- **MSI (`Rustty_<version>_x64.msi`)** — traditional installer. Double-click and follow the wizard.
- **NSIS (`Rustty_<version>_x64-setup.exe`)** — alternative, lighter installer.
- **Portable (`Rustty_<version>_x64-portable.exe`)** — single executable without installation, ideal for USB drives or locked-down machines.

In all cases the **Microsoft Edge WebView2 Runtime** is required (already included in Windows 10 22H2 and Windows 11). If your system does not have it, the MSI/NSIS installer will download it automatically; for the portable build, install it manually from [here](https://developer.microsoft.com/microsoft-edge/webview2/).

#### True portable mode

When Rustty runs as `Rustty_<version>_x64-portable.exe` (filename with the `-portable.exe` suffix), it does **not** use `%APPDATA%`. It stores all configuration in a `.conf\com.rustty.app\` folder created automatically **next to the executable itself**. This includes `profiles.json` and other app data, so the USB drive remains *self-contained*: copy it to another machine and the configuration travels with it.

Caveats:

- The **Windows keyring** (Credential Manager) still belongs to the user running the binary, not to the USB drive. To move credentials between machines you can use a **KeePass `.kdbx`** database next to the portable build or enable E2E synchronization of saved passwords in **Preferences → Backups**.
- The window state (size, position) is saved in the user profile (`tauri-plugin-window-state` plugin); the visual session of the USB drive is not 100% portable.
- If you rename the `.exe` and remove the `-portable.exe` suffix, it returns to normal mode and reads `%APPDATA%\com.rustty.app\`.

### macOS (Apple Silicon)

The builds are signed with a **Developer ID Application** and notarized with Apple's service, so Gatekeeper shows no warnings on a clean installation.

- **DMG (`Rustty_<version>_aarch64.dmg`)**: open the `.dmg` and drag `Rustty.app` to `Applications`.
- **App bundle (`Rustty_aarch64.app.tar.gz`)**: extract and run `Rustty.app`.

> Builds are only generated for **aarch64** (Apple Silicon). For Intel Macs you would need to compile from source.

### Integrity verification

Alongside each artifact its `.sig` (Tauri updater signature) is published, and the release page includes the `sha256` of each file. To verify:

```bash
sha256sum Rustty_*_amd64.deb
# compare with the hash listed in the release
```

## Technologies used

- **Backend**: [Rust](https://www.rust-lang.org/) — 100% pure for SSH/SFTP and FTPS over `rustls` (no dependency on `libssh2`).
- **App framework**: [Tauri v2](https://tauri.app/)
- **Frontend**: [Vite](https://vitejs.dev/) + Vanilla JavaScript / CSS
- **Terminal**: [xterm.js](https://xtermjs.org/)
- **Protocols**: [russh](https://github.com/warp-tech/russh) (SSH), [russh-sftp](https://github.com/warp-tech/russh-sftp) (SFTP), [`suppaftp`](https://github.com/veeso/suppaftp) (FTP/FTPS)
- **Security**: [keyring-rs](https://github.com/hwchen/keyring-rs), [keepass-rs](https://github.com/sseemayer/keepass-rs)

## Backups and synchronization

Rustty includes a **Preferences → Backups** tab with three flows:

- **Cloud synchronization**: Google Drive, iCloud Drive, local folder / NAS or WebDAV.
- **Encrypted backup**: export/import a `.rustty-sync.bin` encrypted with your passphrase, independent of any backend.
- **Local data**: JSON export/import of profiles for interoperability and simple copies.

Synchronization is opt-in and encrypts the state before uploading it. Profiles, preferences, custom themes, shortcuts, connection notes and snippets are synchronized. The **saved passwords/passphrases** have their own checkbox: if you enable it, Rustty reads the `password:<profile_id>` / `passphrase:<profile_id>` secrets from the local keyring, places them in the E2E-encrypted blob and restores them in the keyring of other machines. The unlocked KeePass database and local paths such as `keepassPath` or `keepassKeyfile` are never synchronized.

The local JSON exports of connections/folders/workspaces ask before including secrets. If you choose to include them, the JSON contains readable credentials; prefer the encrypted `.rustty-sync.bin` backup to transport passwords.

Synchronization checks the state when the app starts and is triggered when it detects local changes (1-minute debounce). If the local and remote logical content already match, it does not rewrite the remote blob nor create a new snapshot. Before overwriting a different remote blob, an encrypted snapshot is saved; from the **Restore backup** dropdown you can revert to any previous snapshot available in the backend.

Backends:

- **Google Drive**: OAuth in the browser with a local callback; Rustty uses the `appDataFolder` space and stores the refresh token in the keyring.
- **iCloud Drive**: writes to the local iCloud Drive folder on macOS and lets the system synchronize.
- **Local folder / NAS**: useful for Syncthing, shared folders or external cloud clients.
- **WebDAV**: compatible with Nextcloud, ownCloud and generic WebDAV servers.

## Development and Building

If you want to compile the project from source, follow these steps:

### Prerequisites

1. **Rust**: [Install Rust](https://www.rust-lang.org/tools/install)
2. **Node.js**: v24 recommended to match the CI workflow.
3. **System dependencies**:

   #### Linux (compilation)

    **Ubuntu / Debian**:

    ```bash
    sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libdbus-1-dev libssl-dev pkg-config
    ```

    **Fedora**:

    ```bash
    sudo dnf install webkit2gtk4.1-devel libayatana-appindicator-devel librsvg2-devel dbus-devel openssl-devel
    ```

    **Arch Linux**:

    ```bash
    sudo pacman -S webkit2gtk-4.1 libayatana-appindicator librsvg dbus openssl
    ```

    **openSUSE**:

    ```bash
    sudo zypper install webkit2gtk3-devel libayatana-appindicator3-devel librsvg-devel dbus-1-devel libopenssl-devel
    ```

   #### macOS (compilation)

    You need to have the **Xcode Command Line Tools** and [Homebrew](https://brew.sh/) installed.

    ```bash
    brew install openssl pkg-config
    ```

   #### Windows (compilation)

    You need to install the [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and have the **WebView2 Runtime** installed (included by default in Windows 10 and 11).

### Steps to run in development

1. Clone the repository:

    ```bash
    git clone https://github.com/Aleixenandros/Rustty.git
    cd Rustty
    ```

2. Install the Node.js dependencies:

    ```bash
    npm install
    ```

3. Run the application in development mode:

    ```bash
    npm run tauri dev
    ```

### Building for production

To generate the optimized executable for your operating system:

```bash
npm run tauri build
```

The binary and the packages (`.deb`, `.rpm`, `.AppImage`, `.msi`, `.dmg`, depending on the platform) are placed in `src-tauri/target/release/bundle/`.

### Automatic release

The GitHub Actions workflow (`.github/workflows/build.yml`) compiles binaries for Linux, Windows and macOS (Apple Silicon) when a `v*` tag is pushed:

The single source of version truth is `package.json`. To prepare a release, change only the `version` field there and run:

```bash
npm run sync-version
```

That command synchronizes `Cargo.toml`, `Cargo.lock` and `package-lock.json`. The public website resolves its version from the latest GitHub release, not from `package.json`. `npm run build`, `npm run tauri dev` and `npm run tauri build` also run the synchronization automatically.

```bash
git tag v1.0.0
git push --tags
```

The artifacts end up in a GitHub release in draft mode.

For the official builds to include Google Drive, define these secrets in GitHub Actions:

```text
RUSTTY_GOOGLE_DRIVE_CLIENT_ID
RUSTTY_GOOGLE_DRIVE_CLIENT_SECRET
```

## Data paths

- **Linux**: `~/.local/share/com.rustty.app/` (profiles, configuration)
- **macOS**: `~/Library/Application Support/com.rustty.app/`
- **Windows**: `%APPDATA%\com.rustty.app\`

Passwords are not stored in these files: they live in the system keyring under the `rustty` service, or are resolved from a KeePass database referenced by UUID. If you enable password sync, they only travel inside the E2E-encrypted blob and are rehydrated into the local keyring again.

The synchronization configuration lives in `sync_config.json` and the last local snapshot in `sync_state.json`. The sync secrets (master passphrase, WebDAV password and Google Drive OAuth token) are stored in the system keyring.

---

## 📄 License

Rustty is distributed under the [Apache License, Version 2.0](LICENSE).

```text
Copyright 2026 Alejandro Soriano

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

See the [NOTICE](NOTICE) file for the attributions required when redistributing.

---
