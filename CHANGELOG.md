# Changelog

Todas las novedades reseñables del proyecto Rustty.

## [0.3.0] – 2026-05-03

### Añadido
- **Barra lateral vertical de iconos** (`#rail`): franja izquierda fija de
  44 px con dos secciones — arriba 📁 Perfiles, ★ Favoritos, ⇅
  Sincronización y ⚙ Preferencias; abajo $_ Consola local y ＋ Nueva
  conexión. El icono activo refleja `prefs.sidebarViewMode`.
- **Drag & drop en la sidebar**: las conexiones y carpetas se pueden
  arrastrar entre carpetas, hacia la cabecera de un workspace o a la zona
  vacía (raíz). Bloquea destinos inválidos (carpeta dentro de sí misma o
  de un descendiente) y persiste en `profile.group` /
  `prefs.userFoldersByWorkspace`. Feedback visual con resaltado del
  `folder-header` y borde azul en la raíz.
- **Colores por carpeta**: paleta de 8 colores predefinidos + "Quitar
  color" en el menú contextual de la carpeta. Persistido en
  `prefs.folderColors[path]`, pintado como franja izquierda de 3 px en el
  `folder-header` (`--folder-tint`) y sincronizado como parte del bundle
  de prefs.
- **Exportar conexiones de una carpeta**: nueva opción
  "Exportar conexiones…" en el menú contextual de carpeta. Vuelca a JSON
  los perfiles de la carpeta y sus subcarpetas, sin contraseñas en claro.
- **Exportar conexiones de un workspace**: misma acción desde el menú
  contextual del nodo de workspace en la vista "Todos los perfiles".
- **Reconexión automática SSH**: campo `auto_reconnect` por perfil
  (0 – 20 reintentos). El backend reintenta con backoff exponencial
  (2s, 4s, 8s, …, 60s máx) y emite `ssh-reconnecting-{id}` con el número
  de intento. Se interrumpe si el usuario pulsa Disconnect durante el
  backoff.
- **Grabación de sesión**: toggle `session_log` por perfil. Vuelca toda
  la salida del shell SSH a `<data_dir>/session_logs/<perfil>-<timestamp>.log`
  (o a `session_log_dir` si se indica).

### Cambiado
- **Cabecera de la sidebar simplificada**: los botones ⚙, $_ y ＋ se
  mueven al rail vertical. La cabecera queda con logo + ≡ (popover de
  filtros y switcher de workspaces).
- **Icono "Filtrar / cambiar de perfil"**: ahora tiene el mismo tamaño
  que el resto de iconos del header (26×26).
- **Popover ≡ anclado bajo el botón**: antes se abría con `right: 8px`,
  fuera de eje respecto al trigger; ahora se posiciona dinámicamente bajo
  el botón con flip horizontal/vertical si no cabe en el viewport.

### Corregido
- **Detección de host key cambiada**: ya estaba cubierta por la
  verificación TOFU + `known_hosts` real introducida en versiones
  anteriores. Marcado como completado en `tareas.md`.

## [0.2.7] – 2026-05-02

### Añadido
- **Conexiones favoritas**: cada conexión puede marcarse como favorita con
  el botón estrella (☆/★) o desde el menú contextual, y se sincronizan en
  la nube con el resto de preferencias.
- **Vistas de la sidebar**: nuevo selector con los modos *Workspace actual*,
  *Todos los perfiles* (árbol agrupado por workspace) y *Favoritos*. Al
  cambiar de modo, la cabecera muestra el contexto activo en una barra fina.
- **Menú contextual sobre el nodo de un workspace** (en la vista *Todos los
  perfiles*): renombrar y eliminar el workspace sin tener que activarlo
  antes.

### Cambiado
- **Cabecera de la sidebar unificada**: el switcher de workspaces se
  sustituye por un único botón **≡** que abre un popover compacto con la
  vista activa, el switcher de workspaces y la búsqueda. La cabecera ya no
  ocupa dos filas.
- **Carpetas manuales por workspace**: cada workspace mantiene su propio
  conjunto de carpetas, en lugar de compartir una lista global. Las
  carpetas existentes se migran automáticamente al workspace activo en el
  primer arranque tras la actualización.
- **Sincronización en la nube**: el bundle de preferencias incluye ahora
  `userFoldersByWorkspace`, `workspaces`, `activeWorkspaceId`, `favorites`
  y `sidebarViewMode` para que el modo de vista, el workspace activo, las
  favoritas y el árbol por workspace viajen entre equipos.

## [0.2.6] – 2026-05-02

### Añadido
- **Perfiles-contenedor (workspaces)**: cada conexión guarda su `workspace_id`.
  El sidebar incluye un selector con las acciones Nuevo / Renombrar /
  Eliminar; la lista de perfiles, el dashboard y la búsqueda se filtran
  por el workspace activo, y el formulario de conexión muestra un selector
  de workspace cuando hay más de uno. Los workspaces viajan con la
  sincronización en la nube como parte del bundle de preferencias.

### Cambiado
- **Panel SFTP**: el panel remoto pasa a la izquierda y el local a la
  derecha; las flechas centrales se reordenan para apuntar visualmente al
  destino.
- **Formulario de conexión**: eliminado el checkbox "Seguir CWD del terminal
  en el panel SFTP" — el toggle está disponible en el propio panel SFTP
  mediante el botón "CWD".
- **Pantalla principal**: eliminadas las sombras de la barra de búsqueda
  y de las tarjetas para una apariencia más plana.

### Corregido
- **Doble clic en la topbar**: ya no se maximiza y restaura en cascada. Se
  delega completamente en el comportamiento nativo de
  `data-tauri-drag-region`, que ahora maximiza/restaura una sola vez.

### Traducciones
- Añadidas las cadenas del switcher de workspaces en español, inglés,
  francés y portugués.
- Completadas en francés y portugués las cadenas `search_placeholder` y
  `search_no_results` de la sidebar, que caían al fallback en español.

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
