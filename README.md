# Rustty 🦀⚡

**Rustty** es un cliente de terminal y gestor de conexiones multiplataforma, moderno y ligero, diseñado para ofrecer una experiencia fluida en la administración de servidores remotos. Construido con **Rust** y **Tauri**, combina la potencia de las herramientas de bajo nivel con una interfaz web moderna y ágil.

## Características principales

- **Gestión Multi-protocolo**: Soporte para conexiones SSH, SFTP y RDP.
- **Terminal Moderna**: Basada en xterm.js con soporte completo de colores, temas y fuentes personalizables.
- **Seguridad Robusta**: 
  - Integración nativa con el Keyring del sistema (KWallet, GNOME Keyring, macOS Keychain, Windows Credential Store).
  - Soporte para bases de datos **KeePass** (`.kdbx`) para gestionar contraseñas de forma segura.
- **Organización Inteligente**: Agrupa tus conexiones en carpetas y gestiona perfiles con facilidad.
- **Interfaz Multi-pestaña**: Navega entre múltiples sesiones simultáneas con un sistema de pestañas y vistas divididas.
- **Personalización**: Temas visuales integrados (Catppuccin, Nord, Dracula, etc.) y configuración flexible del cursor y comportamiento del terminal.

## Tecnologías utilizadas

- **Backend**: [Rust](https://www.rust-lang.org/)
- **Framework de App**: [Tauri v2](https://tauri.app/)
- **Frontend**: [Vite](https://vitejs.dev/) + Vanilla JavaScript / CSS
- **Terminal**: [xterm.js](https://xtermjs.org/)
- **Protocolos**: [russh](https://github.com/warp-tech/russh) (SSH), [russh-sftp](https://github.com/warp-tech/russh-sftp) (SFTP)

## Desarrollo y Construcción

Si deseas compilar el proyecto desde el código fuente, sigue estos pasos:

### Requisitos previos

1.  **Rust**: [Instalar Rust](https://www.rust-lang.org/tools/install)
2.  **Node.js**: v18 o superior.
3.  **Dependencias de sistema** (solo Linux):

    **Ubuntu / Debian**:
    ```bash
    sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config libssh2-1-dev
    ```

    **Fedora**:
    ```bash
    sudo dnf install webkit2gtk4.1-devel libayatana-appindicator-devel librsvg2-devel openssl-devel libssh2-devel
    ```

    **Arch Linux**:
    ```bash
    sudo pacman -S webkit2gtk-4.1 libayatana-appindicator librsvg openssl libssh2
    ```

### Pasos para ejecutar en desarrollo

1.  Clona el repositorio:
    ```bash
    git clone https://github.com/Aleixenandros/Rustty.git
    cd Rustty
    ```
2.  Instala las dependencias de Node.js:
    ```bash
    npm install
    ```
3.  Ejecuta la aplicación en modo desarrollo:
    ```bash
    npm run tauri dev
    ```

### Construcción para producción

Para generar el ejecutable optimizado para tu sistema operativo:
```bash
npm run tauri build
```

---

## 📄 Licencia

Este proyecto se distribuye bajo la licencia MIT. Consulta el archivo `LICENSE` para más detalles.

---
Desarrollado con ❤️ usando Rust y Tauri.
