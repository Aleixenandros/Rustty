# Rustty - Cliente SSH Multiplataforma🦀⚡

> ⚠️ **Aviso**: este repositorio contiene código y documentación generados en prte con agentes de IA.
> Las contribuciones y/o críticas son bienvenidas.

**Rustty** es un cliente de terminal y gestor de conexiones multiplataforma, moderno y ligero, diseñado para ofrecer una experiencia fluida en la administración de servidores remotos. Construido con **Rust** y **Tauri**, combina la potencia de las herramientas de bajo nivel con una interfaz web moderna y ágil.

> 🚧 **Estado**: proyecto en desarrollo activo, aún sin release estable. La API interna, el formato de perfiles y las rutas de datos pueden cambiar sin previo aviso.

## Características principales

- **Multi-protocolo**: conexiones SSH, SFTP y RDP (este último mediante `xfreerdp` / `mstsc` externos).
- **Terminal moderno**: xterm.js con temas, cursor configurable, scrollback y soporte de OSC 7 (seguimiento del `cwd` remoto).
- **Panel SFTP integrado**: explorador de ficheros con subida / descarga, drag & drop, sigue automáticamente el directorio del terminal y permite elevar la sesión a **sudo** cuando el servidor lo permita.
- **Multi-pestaña y vistas divididas**: trabaja con varias sesiones simultáneas, distribúyelas en *split* horizontal / vertical / grid y activa el *broadcast* para teclear en varias a la vez.
- **Seguridad**:
  - Integración nativa con el keyring del sistema (KWallet, GNOME Keyring, macOS Keychain, Windows Credential Store).
  - Soporte para bases de datos **KeePass** (`.kdbx`) como fuente de contraseñas.
  - Atajo `Ctrl+Alt+P` para pegar la contraseña del perfil activo sin exponerla en pantalla.
- **Organización**: agrupa perfiles en carpetas y gestiona conexiones desde la barra lateral colapsable.
- **Personalización**: 11 temas base integrados (Catppuccin Mocha / Latte, Dracula, Nord, xterm, VS Code Dark+, Tango, Solarized Dark / Light, Gruvbox Dark, Tokyo Night, Monokai) y ajustes de cursor, scrollback y *bell*.
- **Internacionalización**: interfaz traducida a español, inglés, francés y portugués.

## Tecnologías utilizadas

- **Backend**: [Rust](https://www.rust-lang.org/) — 100% puro para SSH y SFTP (sin dependencia de `libssh2`).
- **Framework de App**: [Tauri v2](https://tauri.app/)
- **Frontend**: [Vite](https://vitejs.dev/) + Vanilla JavaScript / CSS
- **Terminal**: [xterm.js](https://xtermjs.org/)
- **Protocolos**: [russh](https://github.com/warp-tech/russh) (SSH), [russh-sftp](https://github.com/warp-tech/russh-sftp) (SFTP)
- **Seguridad**: [keyring-rs](https://github.com/hwchen/keyring-rs), [keepass-rs](https://github.com/sseemayer/keepass-rs)

## Desarrollo y Construcción

Si deseas compilar el proyecto desde el código fuente, sigue estos pasos:

### Requisitos previos

1. **Rust**: [Instalar Rust](https://www.rust-lang.org/tools/install)
2. **Node.js**: v18 o superior.
3. **Dependencias de sistema**:

    #### Linux

    **Ubuntu / Debian**:

    ```bash
    sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config
    ```

    **Fedora**:

    ```bash
    sudo dnf install webkit2gtk4.1-devel libayatana-appindicator-devel librsvg2-devel openssl-devel
    ```

    **Arch Linux**:

    ```bash
    sudo pacman -S webkit2gtk-4.1 libayatana-appindicator librsvg openssl
    ```

    **openSUSE**:

    ```bash
    sudo zypper install webkit2gtk3-devel libayatana-appindicator3-devel librsvg-devel libopenssl-devel
    ```

    #### macOS

    Es necesario tener instaladas las **Xcode Command Line Tools** y [Homebrew](https://brew.sh/).

    ```bash
    brew install openssl pkg-config
    ```

    #### Windows

    Es necesario instalar las [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) y tener instalado el **WebView2 Runtime** (incluido por defecto en Windows 10 y 11).

### Pasos para ejecutar en desarrollo

1. Clona el repositorio:

    ```bash
    git clone https://github.com/Aleixenandros/Rustty.git
    cd Rustty
    ```

2. Instala las dependencias de Node.js:

    ```bash
    npm install
    ```

3. Ejecuta la aplicación en modo desarrollo:

    ```bash
    npm run tauri dev
    ```

### Construcción para producción

Para generar el ejecutable optimizado para tu sistema operativo:

```bash
npm run tauri build
```

El binario y los paquetes (`.deb`, `.rpm`, `.AppImage`, `.msi`, `.dmg`, según plataforma) quedan en `src-tauri/target/release/bundle/`.

### Release automático

El workflow de GitHub Actions (`.github/workflows/build.yml`) compila binarios para Linux, Windows y macOS (Apple Silicon) al empujar un tag `v*`:

```bash
git tag v0.1.0
git push --tags
```

Los artefactos quedan en un release de GitHub en modo borrador.

## Atajos de teclado

| Atajo          | Acción                                              |
|----------------|-----------------------------------------------------|
| `Ctrl+Alt+P`   | Pegar la contraseña del perfil activo en el shell   |
| `Ctrl+Shift+C` | Copiar selección del terminal                       |
| `Ctrl+Shift+V` | Pegar en el terminal                                |

## Rutas de datos

- **Linux**: `~/.local/share/rustty/` (perfiles, configuración)
- **macOS**: `~/Library/Application Support/com.rustty.app/`
- **Windows**: `%APPDATA%\com.rustty.app\`

Las contraseñas no se guardan en estos ficheros: viven en el keyring del sistema con el servicio `rustty`, o se resuelven desde una base KeePass referenciada por UUID.

---

## 📄 Licencia

Pendiente de definir. Se publicará bajo una licencia permisiva (MIT o Apache-2.0) antes del primer release estable.

---
Desarrollado con ❤️ usando Rust y Tauri, con asistencia de IA.
