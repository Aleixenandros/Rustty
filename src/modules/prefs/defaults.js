// @ts-check
import { defaultHighlightRules } from "../terminal/highlight.js";

export const DEFAULT_PREFS = {
  // Monitor de recursos por sesión SSH (opt-in). Cuando está activo, la sesión
  // muestrea el servidor cada `metricsSecs` segundos y pinta CPU/RAM/disco en la
  // barra inferior. Solo Linux de momento (degrada a nada en otros SO).
  metricsEnabled:  false,
  metricsSecs:     3,
  metricsPanelVertical: false,
  // Umbrales de alerta del monitor (opt-in): aviso al cruzar el % configurado,
  // con histéresis para no repetir. 0 = métrica sin alerta.
  metricsAlerts:   false,
  metricsAlertCpu:  90,
  metricsAlertMem:  90,
  metricsAlertDisk: 90,
  theme:           "dark",    // "dark" | "light" | "system"
  // Tema del terminal independiente del de UI.
  // null / "inherit" = seguir a `theme`; cualquier otro id válido = tema fijo para el terminal.
  terminalTheme:   null,
  copyOnSelect:    false,
  rightClickPaste: false,
  // Si está activo, los pegados peligrosos en el terminal (multilínea, muy
  // largos o con caracteres de control) muestran una previsualización
  // tematizada que el usuario debe confirmar antes de enviarse a la sesión.
  confirmRiskyPaste: true,
  // Primera conexión SSH: si está activo (default), se muestra la huella de la
  // host key desconocida y se pide confirmación antes de guardarla. Al
  // desactivarlo se vuelve al TOFU automático clásico (la primera clave se
  // aprende en silencio), que es cómodo pero no detecta un intermediario
  // presente ya en esa primera conexión. La política vive en el backend
  // (`host_keys`): esta pref solo la fija con `set_host_key_policy`.
  strictHostKey:   true,
  // Host key CAMBIADA: activo (default) pregunta con un diálogo de peligro y,
  // si el usuario acepta, reemplaza la entrada de known_hosts y la conexión
  // continúa; desactivado, rechazo clásico con instrucciones manuales. La
  // política vive en el backend: se fija con `set_host_key_change_policy`.
  hostKeyChangePrompt: true,
  // Primera conexión FTPS: igual que `strictHostKey` pero para el certificado
  // TLS del servidor (TOFU por huella). Activo (default) pide confirmar la huella
  // de un certificado nuevo; desactivado la aprende en silencio. La política vive
  // en el backend (`ftps_certs`); esta pref la fija con `set_ftps_cert_policy`.
  strictFtpsCert:  true,
  // Certificado RDP CAMBIADO: el TOFU lo hace el cliente externo (xfreerdp con
  // `/cert:tofu`), que ante un cambio aborta sin preguntar —no tiene terminal
  // donde hacerlo—. Activo (default), Rustty enseña las dos huellas y, si el
  // usuario acepta, olvida el certificado guardado (`rdp_forget_cert`) y
  // reconecta, igual que con una host key SSH cambiada. Desactivado, el aviso
  // clásico con las instrucciones para borrarlo a mano.
  rdpCertChangePrompt: true,
  // Cómo abre la ventana el cliente RDP por defecto: "window" (redimensionable,
  // la resolución sigue al tamaño), "fullscreen", "workarea" o "fixed" (el
  // tamaño clavado de siempre, para servidores sin Display Control). Cada perfil
  // puede llevar su propio `rdp_display` y entonces manda el del perfil.
  rdpDisplay:      "window",
  // Captura la pantalla de cada sesión SSH (no privada) en disco para poder
  // restaurarla luego con «Conectar y restaurar pantalla anterior». Solo es la
  // salida visual; puede contener datos sensibles. Excluido de sync.
  captureScreen:   true,
  // Pegado de contraseña (Ctrl+P) cuando el modo broadcast replica la entrada en
  // varias panes. Filosofía: nunca bloquear; el usuario elige.
  //   "all"    → difundir la contraseña a todas las panes del broadcast
  //   "active" → pegarla solo en la pane enfocada
  //   "ask"    → preguntar en cada pegado
  pastePasswordBroadcast: "all", // "all" | "active" | "ask"
  sftpConflictPolicy: "ask",   // "ask" | "overwrite" | "skip" | "rename"
  // Aviso de fin de transferencia SFTP por el router de notificaciones.
  // On por defecto (era el comportamiento existente); ahora desactivable y
  // con umbral de duración configurable (los errores avisan siempre).
  transferDoneNotify:     true,
  transferDoneNotifySecs: 5,
  sftpVerifySize:  false,
  // Máximo de peticiones SFTP simultáneas (handles en vuelo) por transferencia
  // en cada sesión. Conservador por defecto: servidores como Hetzner Storage Box
  // limitan los handles abiertos y un valor alto provoca "Handle limit reached".
  sftpMaxConcurrent: 4,        // 1–64

  // Techos de velocidad de las transferencias, en KiB/s. `0` = sin límite, que
  // es lo de siempre. Servir para dejar una descarga larga de fondo sin que el
  // resto de la red se resienta. El límite es del enlace, no de cada
  // transferencia: dos descargas a la vez se reparten el mismo techo.
  transferLimitUpKib:   0,
  transferLimitDownKib: 0,

  // Techo de transferencias **simultáneas** de toda la aplicación (0 = sin
  // techo, lo de siempre). No confundir con `sftpMaxConcurrent`, que son
  // peticiones en vuelo dentro de una misma transferencia.
  transferMaxConcurrent: 0,    // 0–32
  // Conservar el trozo ya bajado de una descarga interrumpida para continuarla
  // después, en vez de empezar de cero. Apagado por defecto: reanudar exige
  // dejar el temporal en disco cuando algo falla.
  transferResume:  false,

  // Disposición del panel SFTP: lado donde se muestra el panel remoto.
  sftpRemoteSide:  "left",     // "left" | "right"
  fontSize:        14,
  // Tipografía fina del terminal
  fontFamily:      "",        // "" = usar cadena por defecto con fallback monospace
  lineHeight:      1.0,       // 1.0 = normal; xterm.js admite >0
  letterSpacing:   0,         // píxeles; positivo separa, negativo junta
  // Ligaduras tipográficas en el terminal (==, =>, ->, !=, ===, etc.).
  // Requiere fuente con soporte (FiraCode, JetBrains Mono, Cascadia Code, …).
  // Solo se aplica a sesiones nuevas: cambiar el toggle no afecta a las ya abiertas.
  terminalLigatures: false,
  cursorStyle:     "block",   // "block" | "bar" | "underline"
  cursorBlink:     true,
  // Aviso de fin de comando largo (OSC 133 C→D). Opt-in: sin marcas OSC 133
  // del shell no hace nada. El umbral es la duración mínima para avisar.
  cmdDoneNotify:      false,
  cmdDoneNotifySecs:  15,
  scrollback:      5000,
  // Directorio inicial de las consolas locales nuevas. "" = $HOME (o el dir del
  // usuario). Una ruta válida se usa como cwd al abrir/reabrir la consola; si no
  // existe, el backend cae a $HOME.
  localShellCwd:   "",
  // Integración de shell en la consola local (bash/zsh/fish/PowerShell): marcas OSC 133
  // (bloques de comando, aviso de fin de comando largo) y OSC 7 (carpeta
  // actual) sin tocar los dotfiles del usuario. Opt-in: cambia cómo arranca
  // el shell, así que solo se aplica a consolas nuevas.
  localShellIntegration: false,
  // Comandos locales del catálogo: plazo máximo de ejecución en segundos
  // (0 = sin límite, opción explícita del usuario) y tope de salida capturada
  // por flujo en KiB. Al agotarse el plazo se termina el árbol de procesos.
  localCmdTimeoutSecs: 30,     // 0 | 10 | 30 | 60 | 300 | 900
  localCmdMaxOutputKb: 512,    // 64 | 512 | 2048 | 8192
  bell:            "none",    // "none" | "visual" | "sound"
  // Contraste mínimo del texto del terminal (xterm `minimumContrastRatio`).
  // Adapta dinámicamente los colores ANSI poco legibles contra el fondo de su
  // celda. "off" = sin ajuste (1:1); "aa" = 4.5:1; "aaa" = 7:1.
  terminalMinContrast: "off", // "off" | "aa" | "aaa"
  // Cursor del terminal más visible: tinta de alto contraste (blanco/negro
  // según el fondo) en cualquier estilo de cursor + caret más grueso cuando el
  // estilo es «bar». No cambia el estilo elegido en `cursorStyle`.
  terminalCursorHighVis: false,
  // KeePass: rutas persistentes (sin contraseña maestra)
  keepassPath:     "",
  keepassKeyfile:  "",
  // Qué hacer con las sesiones al volver de una suspensión o al recuperar la red:
  //   "nothing"   → no tocar nada (el usuario decide)
  //   "check"     → avisar y comprobar cuáles siguen vivas (default)
  //   "reconnect" → además, reenganchar las caídas de forma escalonada
  onWakeAction:    "check",
  // Autobloqueo de la base KeePass, en minutos de inactividad (0 = nunca).
  // El contador solo lo reinicia el uso REAL de la base (ver `touchKeepass`).
  keepassAutoLockMinutes: 0,
  // Bloquear la base si el equipo se suspende (se detecta por el salto de reloj).
  keepassLockOnSuspend: true,
  // Idioma de la interfaz: "es" | "en" | "fr" | "pt"
  lang:            null, // null → usar detectLanguage() en loadPrefs
  // Overrides de atajos: { [actionId]: accelerator | null }
  // Solo se almacenan los atajos que el usuario ha modificado respecto al default.
  shortcuts:       {},
  checkUpdatesOnStartup: true,
  // [legacy] Carpetas manuales globales. Se mantiene por compatibilidad para
  // migrar a userFoldersByWorkspace en el primer arranque tras la 0.2.6.
  userFolders:     [],
  // Carpetas manuales por workspace. Mapa { workspaceId: ["A", "A/B", ...] }.
  userFoldersByWorkspace: {},
  // Perfiles-contenedor (workspaces). Cada perfil agrupa su propio árbol de
  // carpetas y conexiones. Por defecto solo existe "default".
  workspaces:      [{ id: "default", name: "Default" }],
  activeWorkspaceId: "default",
  // IDs de conexiones marcadas como favoritas.
  favorites:       [],
  // IDs de conexiones ancladas en el dashboard como tiles grandes.
  pinnedProfiles:  [],
  // Modo de la vista de la sidebar: "current" | "all" | "favorites".
  sidebarViewMode: "current",
  // Si está activo, las búsquedas de conexiones recorren todos los workspaces.
  // Si se desactiva, solo consultan el workspace activo.
  searchAllWorkspaces: true,
  // Resultados de búsqueda agrupados por relevancia: conexiones directas,
  // carpetas coincidentes (una entrada con recuento) y coincidencias en notas.
  // Desactivado, vuelve la lista plana alfabética clásica.
  searchGroupedResults: true,
  // Densidad compacta para listas largas de conexiones en la sidebar.
  sidebarCompact:  false,
  // Zoom de la UI (rail, sidebar, tabs, status, modales) sin afectar al
  // buffer xterm. Rango clampeado en `adjustUiZoom`. Atajos Ctrl+Alt +/-/0.
  uiZoom:          1.0,
  // Orden de las conexiones en la sidebar: "alpha" (alfabético, por defecto)
  // o "manual" (subir/bajar con flechas, persistido en `connectionOrder`).
  connectionSortMode: "alpha",
  // Orden manual de conexiones por contenedor. Clave = `${workspaceId}|${group}`,
  // valor = array de profileId en el orden deseado. Las conexiones no listadas
  // se añaden al final ordenadas alfabéticamente. Solo se usa con
  // `connectionSortMode === "manual"`.
  connectionOrder: {},
  // Orden manual de carpetas por contenedor padre. Clave = `${workspaceId}|${parentPath}`
  // (parentPath = "" para las carpetas de primer nivel), valor = array de
  // nombres de carpeta hija en el orden deseado. Las no listadas se añaden al
  // final alfabéticamente. Solo se usa con `connectionSortMode === "manual"`.
  folderOrder: {},
  // Si está activo, las carpetas se renderizan antes que las conexiones dentro
  // de cada nodo del árbol de la sidebar, respetando luego el modo de orden.
  foldersFirst: true,
  // Color por carpeta. Mapa { `${workspaceId}|${folderPath}`: colorId } donde
  // colorId es uno de los presets en FOLDER_COLOR_PRESETS o null para "sin color".
  folderColors:    {},
  // Color del icono de la carpeta raíz de cada perfil-contenedor.
  // Mapa { workspaceId: colorId }.
  workspaceColors: {},
  // Reglas de resaltado por regex aplicadas a la salida del terminal.
  // Cada regla: { pattern: string, color: "red"|"yellow"|"green"|"blue"|"magenta"|"cyan"|"white", bold: bool }.
  // Se aplican en orden — la primera coincidencia gana.
  highlightRules:  defaultHighlightRules(),
  _highlightRulesSeeded: true,
  // Densidad de la interfaz: "comfortable" (por defecto) o "compact".
  // Reduce padding/altura en sidebar, tabs y modales sin tocar xterm.
  uiDensity:       "comfortable",
  uiTextSize:      "normal",
  trashRetentionDays: 30,
  terminalBgOpacity: 0.25,
  terminalBgBlur: 0,
  restoreWorkTabs: false,
  tmuxScrollbackLines: 2000,
  // Modo daltónico: dots de estado se diferencian también por forma
  // (círculo / cuadrado / diamante) además de por color.
  colorBlindSafe:  false,
  // ─── Accesibilidad ───────────────────────────────────────────
  // Nivel de contraste de la interfaz, independiente del tema. En "high"/"max"
  // los tokens de texto/overlay más tenues se acercan a --text (reforzando con
  // ellos bordes, foco y selección) sin obligar a cambiar de tema. "normal" no
  // toca nada.
  uiContrast:      "normal", // "normal" | "high" | "max"
  // Reduce o elimina animaciones y transiciones de la interfaz aunque el sistema
  // operativo no anuncie `prefers-reduced-motion`.
  reduceMotion:    false,
  // Refuerza el anillo de foco (grosor y contraste) en la navegación por teclado.
  strongFocus:     false,
  // Fundido corto al pasar del panel de inicio al terminal (y a la inversa).
  // «Reducir movimiento» (arriba) también lo anula.
  viewFade:        true,
  // Pantalla de carga al arrancar: logotipo e «Iniciando…» en cuanto se abre la
  // ventana, mientras init() termina. Off = la ventana no aparece hasta que la
  // interfaz está montada. La lee también `public/boot.js`, antes del bundle.
  bootScreen:      true,
  // Barras de desplazamiento superpuestas: el pulgar flota sobre el contenido,
  // fino en reposo y más ancho al pasar el ratón. Off = las finas normales.
  overlayScrollbars: false,
  // Barras nativas del sistema (anchas, siempre visibles). Accesibilidad: hay
  // quien las necesita. Gana sobre `overlayScrollbars` y desmonta TODO el
  // estilizado propio; en WebKit basta una regla custom para perder la nativa.
  nativeScrollbars: false,
  // Renderer del terminal. "auto" intenta WebGL y cae a DOM si la GPU no está
  // disponible o pierde el contexto; "dom" fuerza el backend DOM (útil en
  // máquinas virtuales o drivers con parpadeos). El default sigue siendo auto:
  // el WebGL es lo que evita que un `cat` de un log grande cuelgue la UI.
  terminalRenderer: "auto",
  // UUIDs de las últimas entradas KeePass seleccionadas (más reciente primero,
  // máx 8). Usado por el selector avanzado para sugerir entradas habituales.
  recentKeepassEntries: [],
  // Retención de logs de sesión. null = sin límite.
  // sessionLogMaxAgeDays: borra logs más antiguos que N días.
  // sessionLogMaxTotalMb: si el total supera N MB, borra los más antiguos.
  sessionLogMaxAgeDays: null,
  sessionLogMaxTotalMb: null,
  // Arranque automático con el sistema (opt-in, desactivado por defecto).
  // `autostart`: registra la app en el arranque del SO.
  // `autostartMinimized`: si está activo, la ventana no se muestra al frente;
  //   la app arranca oculta al tray.
  autostart:          false,
  autostartMinimized: false,
  // Borradores del editor multilínea (Ctrl+Shift+E), por profileId / "local".
  commandDrafts:      {},
  // Historial de comandos compartido entre pestañas (opt-in). El contenido del
  // historial vive en localStorage (clave `rustty-command-history`), no en
  // prefs, para no entrar en la sincronización en la nube.
  shareCommandHistory: false,
};

/** Cada carga recibe sus propios mapas y listas, sin compartir los defaults. */
export function createDefaultPrefs() {
  return structuredClone(DEFAULT_PREFS);
}
