# Changelog

Todas las novedades reseñables del proyecto Rustty.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
el versionado se ajusta a [Semantic Versioning](https://semver.org/lang/es/).

## [0.2.5] – 2026-05-02

### Añadido
- **Opciones avanzadas por perfil SSH**: keep-alive configurable, agent
  forwarding, X11 forwarding y opción para permitir cifrados / kex / MAC
  legacy (aes-cbc, dh-sha1, hmac-sha1, ssh-rsa) al conectar con servidores
  antiguos.
- **Panel SFTP con vista dividida local / remoto**, con toolbars
  independientes (path, ↑ up, ⌂ home, ⟳ refresh, ＋ mkdir), botones centrales
  de subir / descargar y transferencia recursiva de carpetas en ambos
  sentidos.
- **Búsqueda dentro del buffer del terminal** (Ctrl+F) con barra flotante,
  next/prev y toggle case-sensitive sobre `@xterm/addon-search`.
- **Búsqueda rápida en la lista de perfiles** desde la cabecera de la
  sidebar, filtrando por nombre, host, usuario y grupo.
- **Restauración de copias de seguridad** desde la pestaña Sincronización:
  desplegable con los snapshots disponibles en Carpeta local / NAS, WebDAV y
  Google Drive, descifrado y aplicación local con la misma rutina que
  `importFromFile`.

### Cambiado
- **Auto-sync sin temporizador**: la sincronización en la nube se dispara al
  iniciar y al detectar cambios locales (debounce 1.2 s); se elimina el
  intervalo periódico y la opción "Auto-sync Sí/No" de la UI.
- Mensajes de Preferencias actualizados para reflejar la nueva lógica de
  sincronización y de copias históricas.

### Seguridad
- Las opciones de algoritmos legacy y de forwarding son **opt-in por perfil**
  con avisos explícitos en la UI.
- El identificador de snapshot se valida contra el directorio histórico para
  evitar lecturas fuera de él (Local y WebDAV).

## [0.2.4] – 2026-05-01

- Preparación de release y ajustes menores antes del corte.

## [0.2.3] – 2026-05-01

- Mejoras de seguridad y de sincronización en la nube.

## [0.2.2] – 2026-04-29

- Rediseño de la pantalla principal y corrección de bugs.

## [0.2.0] – [0.2.1] – 2026-04-27

- Catálogo completo de 11 temas base (Catppuccin Mocha / Latte, Dracula,
  Nord, xterm clásico, VS Code Dark+, Tango, Solarized Dark / Light,
  Gruvbox Dark, Tokyo Night, Monokai).
- Editor de atajos en Preferencias y atajos globales configurables.
- Duplicar conexiones y duplicar sesiones activas desde el menú contextual.
- Drag handle para redimensionar la sidebar.

## [0.1.5] – [0.1.9] – 2026-04-26 / 2026-04-27

- Sincronización en la nube v1: Google Drive, iCloud Drive, Carpeta local /
  NAS y WebDAV con cifrado E2E (`age`).
- Empaquetado para Arch Linux (`pacman .pkg.tar.zst`) además de AppImage,
  `.deb` y `.rpm`.
- Toggle de la barra lateral con persistencia.

## [0.1.0] – [0.1.4] – 2026-04-19 / 2026-04-25

- Primer scaffolding Tauri 2 + Vite + Vanilla JS + Xterm.js 6.
- Gestor SSH interactivo, shell local con PTY y gestor RDP externo.
- Perfiles en JSON, credenciales en keyring del SO y soporte de KeePass.
- Migración del backend SSH/SFTP a `russh` + `russh-sftp` puro Rust.
- Modo portable real en Windows.
