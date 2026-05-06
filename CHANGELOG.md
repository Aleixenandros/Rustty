# Changelog

Todas las novedades reseñables del proyecto Rustty.

## [0.6.0] - 2026-05-06

### Añadido

- **Sincronización opcional de contraseñas guardadas**: la pestaña
  **Copias de seguridad** permite incluir contraseñas y passphrases del
  keyring en el `SyncState`. Viajan como items `secret:*` dentro del blob
  cifrado E2E con `age` y se restauran en el keyring local de otros equipos.
- **Exports con secretos bajo confirmación**: los exports JSON de conexiones,
  carpetas y workspaces preguntan antes de incluir contraseñas/passphrases.
  Al importar un JSON con `secrets`, Rustty pregunta si debe guardarlos en el
  keyring local.
- **Backups cifrados con secretos opcionales**: el export `.rustty-sync.bin`
  también pregunta si debe incluir credenciales guardadas.
- **Wake On LAN parcial por perfil**: campos MAC/broadcast/puerto, acción
  "Despertar equipo" desde el menú contextual y toasts con conectar/reintentar.
- **Validación de KeePass en el formulario**: el selector avisa si la base está
  bloqueada, si la entrada existe, qué usuario/título se usará y si contiene
  contraseña usable.

### Cambiado

- El formulario de conexión coloca **usuario y contraseña juntos** para reducir
  saltos visuales al crear perfiles SSH/RDP.
- Los checks de guardar contraseña/passphrase quedan marcados por defecto; el
  usuario puede desmarcarlos en cada caso.
- Los toasts de error genéricos incluyen la acción **Copiar error**; los casos
  específicos conservan acciones como "Ver log", "Reintentar" o "Conectar".
- SFTP gana cola visible, políticas de conflictos, logs de actividad, drag &
  drop local/remoto y verificación opcional de tamaño al terminar.
- Los atajos incorporan import/export, selección de pane, limpiar terminal y
  acciones configurables para abrir/cerrar SFTP, seguir CWD y alternar sudo.

## [0.4.5] - 2026-05-06

### Añadido

- **Túneles SSH globales**: nuevo acceso rápido `⇄` en el rail para crear,
  arrancar, detener y borrar túneles guardados sin tener que abrir primero el
  panel de túneles de una pestaña concreta. Si ya existe una sesión SSH activa
  del perfil, se reutiliza; si no, Rustty abre la conexión y arranca el túnel
  tras conectar.
- **Sincronización visual sidebar ↔ pestaña activa**: al cambiar de pestaña,
  la barra lateral selecciona automáticamente la conexión asociada, abre su
  carpeta y cambia al workspace correspondiente cuando hace falta.

### Cambiado

- **Acciones SFTP integradas con el tema**: crear carpeta, renombrar y borrar
  usan ahora el modal propio de Rustty en lugar de `prompt`/`confirm` nativos.
- **RDP en "Guardar y conectar"**: las conexiones RDP usan el flujo RDP real
  y reutilizan la contraseña escrita en el formulario aunque no se guarde en
  el keyring.

### Corregido

- **RDP externo**: en Windows se elimina el fichero `.rdp` temporal al cerrar
  o fallar la sesión, y en Linux el fallback `rdesktop` usa ahora argumentos
  compatibles con `rdesktop` en vez de opciones de FreeRDP.

## [0.4.2] – 2026-05-05

### Corregido

- **Credenciales bajo demanda**: los diálogos de contraseña y passphrase para
  SSH, RDP y SFTP usan ahora un modal propio integrado con el tema, eliminando
  el emergente nativo con título `JavaScript - tauri://localhost`.
- **Barra de estado de sesión**: al cerrar una pestaña se limpian el destino,
  la latencia y el indicador de estado si no queda una sesión SSH activa.

## [0.4.1] – 2026-05-05

### Corregido

- **Cierre de ventana en controles CSD**: el botón de cerrar ya no puede
  quedarse bloqueado esperando al guardado del estado de ventana. Ahora usa
  un timeout corto y un cierre backend de respaldo que limpia sesiones SSH,
  SFTP, shell local y RDP antes de salir.

## [0.4.0] – 2026-05-05

### Añadido

- **Túneles SSH con redirección de puertos** sobre sesiones activas:
  locales (`-L`), remotos (`-R`) y dinámicos / SOCKS (`-D`). Incluye panel
  por sesión con estado, tráfico y cierre individual, botón `⇄` en pestañas
  SSH, acción contextual "Nuevo túnel…" en perfiles, persistencia por perfil
  y autoconexión opcional.
- **Formato de temas v2**: los temas personalizados usan `formatVersion: 2`
  con tokens separados para UI y terminal. Se añadió exportación de plantilla
  desde Preferencias → Apariencia y documentación en `docs/themes.md`.
- **Botón de ver / ocultar contraseña** en el modal de crear o editar
  conexión.
- **Portapapeles nativo de Tauri** para copiar/pegar texto del terminal,
  evitando limitaciones del WebView al pegar con clic derecho contenido
  copiado fuera de Rustty.

### Cambiado

- El modal de conexión ahora es **redimensionable** y recuerda su tamaño,
  pensado para rutas KeePass largas o formularios con muchas opciones.
- Los temas personalizados antiguos se sustituyen por el formato v2 sin capa
  de compatibilidad.

### Corregido

- **Restauración de tamaño y posición de ventana** al arrancar: el estado
  guardado por `tauri-plugin-window-state` se aplica explícitamente al abrir
  la ventana principal.
- **Pegar con botón derecho** funciona también con texto copiado desde fuera
  de Rustty.

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
