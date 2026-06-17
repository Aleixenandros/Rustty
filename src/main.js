/**
 * Rustty – Frontend principal
 * Stack: Vite + Vanilla JS + Xterm.js + Tauri 2 API
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
// Solo los selectores de fichero siguen siendo nativos (no hay alternativa
// web); las confirmaciones usan confirmThemed para respetar el tema de la app.
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import * as sync from "./sync.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import {
  SUPPORTED_LANGS,
  t,
  setLanguage,
  getLanguage,
  detectLanguage,
  applyTranslations,
} from "./i18n.js";
import { renderMarkdownMinimal, toggleTaskInBody } from "./modules/markdown.js";
import { substitutePreview, substituteWith } from "./modules/subst.js";
import { EVENT, eventName } from "./modules/ipc/events.js";
/** @typedef {import("./modules/ipc/events.js").SshLogEvent} SshLogEvent */
/** @typedef {import("./modules/ipc/events.js").SftpLogEvent} SftpLogEvent */
/** @typedef {import("./modules/ipc/events.js").SftpProgressEvent} SftpProgressEvent */
/** @typedef {import("./modules/ipc/events.js").SshTunnelTrafficEvent} SshTunnelTrafficEvent */
/** @typedef {import("./modules/ipc/events.js").SshReconnectingEvent} SshReconnectingEvent */
/** @typedef {import("./modules/ipc/events.js").TrayAction} TrayAction */

// ═══════════════════════════════════════════════════════════════
// ESTADO DE LA APLICACIÓN
// ═══════════════════════════════════════════════════════════════

/** Perfiles cargados del backend */
let profiles = [];

/**
 * Carpetas creadas manualmente por el usuario (vacías o no).
 * Se persisten en localStorage para sobrevivir reinicios de la app.
 */
let userFolders = new Set(
  JSON.parse(localStorage.getItem("rustty-folders") || "[]")
);

/** Qué carpetas están expandidas en el árbol (en memoria) */
const SIDEBAR_OPEN_FOLDERS_STORAGE_KEY = "rustty-sidebar-open-folders";
const openFolders = new Set((() => {
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_OPEN_FOLDERS_STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((item) => typeof item === "string" && item) : [];
  } catch {
    return [];
  }
})());

/** Contexto del menú contextual activo */
let ctxTarget = { type: null, id: null, folderPath: null, workspaceId: null };

/** Selección múltiple de conexiones en la sidebar */
const sidebarSelectedConnectionIds = new Set();
let sidebarLastSelectedConnectionId = null;

/**
 * Sesiones SSH activas.
 * @type {Map<string, {profileId, terminal, fitAddon, unlisteners, status}>}
 */
const sessions = new Map();

/**
 * Vista actual: lista ordenada de sessionIds que se muestran simultáneamente.
 * - [] → pantalla de bienvenida
 * - [X] → un solo panel
 * - [X, Y, …] → panels lado a lado con divisores
 * Se cambia con `selectSession(sid, additive)`.
 */
let viewSelection = [];
// Proporciones persistentes para las vistas multi-pane (clave = selection.join("|"))
const viewRatios = new Map();
// Layout por vista: "columns" | "rows" | "grid" (clave = selection.join("|"))
const viewLayouts = new Map();
// Broadcast input: si está activo, lo que se escribe en una pane se replica en todas
// las demás panes de la vista (excluye RDP). Clave = selection.join("|").
const broadcastViews = new Map();

let activeSessionId = null;
let editingProfileId = null;
let _connectionTestUnlisten = null;
let _activityFilter = "all";
const ACTIVITY_MAX_ITEMS = 250;
const ACTIVITY_HISTORY_STORAGE_KEY = "rustty-activity-history-v1";
const activityItems = loadActivityHistory();

const KEYRING_SERVICE = "rustty";
const RECENT_CONNECTIONS_STORAGE_KEY = "rustty-recent-connections";

const DEFAULT_HIGHLIGHT_RULES = [
  { pattern: "ERROR|ERR|FATAL|FAIL|FAILED|EXCEPTION", color: "red", bold: true },
  { pattern: "WARN|WARNING|DEPRECATED", color: "yellow", bold: true },
  { pattern: "INFO|NOTICE", color: "cyan", bold: false },
  { pattern: "SUCCESS|OK|DONE", color: "green", bold: false },
  { pattern: "DEBUG|TRACE", color: "magenta", bold: false },
];

function defaultHighlightRules() {
  return DEFAULT_HIGHLIGHT_RULES.map((rule) => ({ ...rule }));
}
// Salida de terminal: xterm procesa `write()` de forma asíncrona, pero si le
// empujamos cientos de chunks seguidos (p. ej. `cat` sobre logs grandes) la
// WebView puede quedar ocupada durante segundos. Esta cola deja respirar al
// hilo de UI y acota la memoria pendiente por sesión.
const TERMINAL_OUTPUT_CHUNK_CHARS = 64 * 1024;
const TERMINAL_OUTPUT_QUEUE_LIMIT_CHARS = 16 * 1024 * 1024;
let _trayQuickLauncherTimer = null;
const RELEASES_API_URL = "https://api.github.com/repos/Aleixenandros/Rustty/releases/latest";
const RELEASES_PAGE_URL = "https://github.com/Aleixenandros/Rustty/releases/latest";
const DEFAULT_SYNC_HISTORY_KEEP = 30;
const WINDOW_STATE_FLAGS_SIZE_POSITION_MAXIMIZED = 1 | 2 | 4;
const WINDOW_CLOSE_FALLBACK_MS = 700;
const WINDOW_STATE_CLOSE_SAVE_TIMEOUT_MS = 250;
const SFTP_PANEL_HEIGHT_STORAGE_KEY = "rustty-sftp-panel-height-percent";
const SFTP_LOG_HEIGHT_STORAGE_KEY = "rustty-sftp-log-height-px";
const SFTP_PANEL_DEFAULT_HEIGHT_PERCENT = 42;
const SFTP_PANEL_MIN_HEIGHT = 160;
const SFTP_PANEL_MIN_TERMINAL_HEIGHT = 140;
const SFTP_LOG_DEFAULT_HEIGHT = 190;
const SFTP_LOG_MIN_HEIGHT = 110;
const SFTP_LOG_MIN_FILE_AREA_HEIGHT = 160;

let bellAudioContext = null;
let sftpCtxTarget = null;

// ═══════════════════════════════════════════════════════════════
// TEMAS XTERM.JS
//
// Catálogo de paletas para el terminal. Las variables de UI viven en
// styles.css bajo `html.theme-<id>`; aquí solo definimos lo que xterm.js
// no puede leer de CSS. `dark` corresponde al valor por defecto en :root.
// ═══════════════════════════════════════════════════════════════

const TERMINAL_THEMES = {
  // Catppuccin Mocha
  dark: {
    background:          "#1e1e2e",
    foreground:          "#cdd6f4",
    cursor:              "#f5e0dc",
    cursorAccent:        "#1e1e2e",
    selectionBackground: "rgba(137,180,250,0.3)",
    black:   "#45475a", red:     "#f38ba8", green:   "#a6e3a1", yellow:  "#f9e2af",
    blue:    "#89b4fa", magenta: "#cba6f7", cyan:    "#94e2d5", white:   "#bac2de",
    brightBlack:   "#585b70", brightRed:   "#f38ba8",
    brightGreen:   "#a6e3a1", brightYellow:"#f9e2af",
    brightBlue:    "#89b4fa", brightMagenta:"#cba6f7",
    brightCyan:    "#94e2d5", brightWhite: "#a6adc8",
  },
  // Catppuccin Latte
  light: {
    background:          "#eff1f5",
    foreground:          "#4c4f69",
    cursor:              "#dc8a78",
    cursorAccent:        "#eff1f5",
    selectionBackground: "rgba(30,102,245,0.2)",
    black:   "#5c5f77", red:     "#d20f39", green:   "#40a02b", yellow:  "#df8e1d",
    blue:    "#1e66f5", magenta: "#8839ef", cyan:    "#179299", white:   "#acb0be",
    brightBlack:   "#6c6f85", brightRed:   "#d20f39",
    brightGreen:   "#40a02b", brightYellow:"#df8e1d",
    brightBlue:    "#1e66f5", brightMagenta:"#8839ef",
    brightCyan:    "#179299", brightWhite: "#bcc0cc",
  },
  // Dracula (https://draculatheme.com)
  dracula: {
    background:          "#282a36",
    foreground:          "#f8f8f2",
    cursor:              "#f8f8f2",
    cursorAccent:        "#282a36",
    selectionBackground: "rgba(68,71,90,0.6)",
    black:   "#21222c", red:     "#ff5555", green:   "#50fa7b", yellow:  "#f1fa8c",
    blue:    "#bd93f9", magenta: "#ff79c6", cyan:    "#8be9fd", white:   "#f8f8f2",
    brightBlack:   "#6272a4", brightRed:   "#ff6e6e",
    brightGreen:   "#69ff94", brightYellow:"#ffffa5",
    brightBlue:    "#d6acff", brightMagenta:"#ff92df",
    brightCyan:    "#a4ffff", brightWhite: "#ffffff",
  },
  // Nord (https://www.nordtheme.com)
  nord: {
    background:          "#2e3440",
    foreground:          "#d8dee9",
    cursor:              "#d8dee9",
    cursorAccent:        "#2e3440",
    selectionBackground: "rgba(67,76,94,0.6)",
    black:   "#3b4252", red:     "#bf616a", green:   "#a3be8c", yellow:  "#ebcb8b",
    blue:    "#81a1c1", magenta: "#b48ead", cyan:    "#88c0d0", white:   "#e5e9f0",
    brightBlack:   "#4c566a", brightRed:   "#bf616a",
    brightGreen:   "#a3be8c", brightYellow:"#ebcb8b",
    brightBlue:    "#81a1c1", brightMagenta:"#b48ead",
    brightCyan:    "#8fbcbb", brightWhite: "#eceff4",
  },
  // xterm clásico (paleta por defecto histórica)
  xterm: {
    background:          "#000000",
    foreground:          "#ffffff",
    cursor:              "#ffffff",
    cursorAccent:        "#000000",
    selectionBackground: "rgba(255,255,255,0.3)",
    black:   "#000000", red:     "#cd0000", green:   "#00cd00", yellow:  "#cdcd00",
    blue:    "#0000ee", magenta: "#cd00cd", cyan:    "#00cdcd", white:   "#e5e5e5",
    brightBlack:   "#7f7f7f", brightRed:   "#ff0000",
    brightGreen:   "#00ff00", brightYellow:"#ffff00",
    brightBlue:    "#5c5cff", brightMagenta:"#ff00ff",
    brightCyan:    "#00ffff", brightWhite: "#ffffff",
  },
  // VS Code Dark+ (paleta oficial del integrated terminal)
  "vscode-dark": {
    background:          "#1e1e1e",
    foreground:          "#cccccc",
    cursor:              "#aeafad",
    cursorAccent:        "#1e1e1e",
    selectionBackground: "rgba(58,61,65,0.6)",
    black:   "#000000", red:     "#cd3131", green:   "#0dbc79", yellow:  "#e5e510",
    blue:    "#2472c8", magenta: "#bc3fbc", cyan:    "#11a8cd", white:   "#e5e5e5",
    brightBlack:   "#666666", brightRed:   "#f14c4c",
    brightGreen:   "#23d18b", brightYellow:"#f5f543",
    brightBlue:    "#3b8eea", brightMagenta:"#d670d6",
    brightCyan:    "#29b8db", brightWhite: "#e5e5e5",
  },
  // Tango (GNOME Terminal) – variante oscura
  tango: {
    background:          "#2e3436",
    foreground:          "#eeeeec",
    cursor:              "#eeeeec",
    cursorAccent:        "#2e3436",
    selectionBackground: "rgba(85,87,83,0.6)",
    black:   "#2e3436", red:     "#cc0000", green:   "#4e9a06", yellow:  "#c4a000",
    blue:    "#3465a4", magenta: "#75507b", cyan:    "#06989a", white:   "#d3d7cf",
    brightBlack:   "#555753", brightRed:   "#ef2929",
    brightGreen:   "#8ae234", brightYellow:"#fce94f",
    brightBlue:    "#729fcf", brightMagenta:"#ad7fa8",
    brightCyan:    "#34e2e2", brightWhite: "#eeeeec",
  },
  // Solarized Dark (https://ethanschoonover.com/solarized)
  "solarized-dark": {
    background:          "#002b36",
    foreground:          "#839496",
    cursor:              "#93a1a1",
    cursorAccent:        "#002b36",
    selectionBackground: "rgba(7,54,66,0.8)",
    black:   "#073642", red:     "#dc322f", green:   "#859900", yellow:  "#b58900",
    blue:    "#268bd2", magenta: "#d33682", cyan:    "#2aa198", white:   "#eee8d5",
    brightBlack:   "#586e75", brightRed:   "#cb4b16",
    brightGreen:   "#93a1a1", brightYellow:"#657b83",
    brightBlue:    "#839496", brightMagenta:"#6c71c4",
    brightCyan:    "#93a1a1", brightWhite: "#fdf6e3",
  },
  // Solarized Light (variante clara del mismo set)
  "solarized-light": {
    background:          "#fdf6e3",
    foreground:          "#657b83",
    cursor:              "#586e75",
    cursorAccent:        "#fdf6e3",
    selectionBackground: "rgba(238,232,213,0.8)",
    black:   "#073642", red:     "#dc322f", green:   "#859900", yellow:  "#b58900",
    blue:    "#268bd2", magenta: "#d33682", cyan:    "#2aa198", white:   "#eee8d5",
    brightBlack:   "#002b36", brightRed:   "#cb4b16",
    brightGreen:   "#586e75", brightYellow:"#657b83",
    brightBlue:    "#839496", brightMagenta:"#6c71c4",
    brightCyan:    "#93a1a1", brightWhite: "#fdf6e3",
  },
  // Gruvbox Dark (https://github.com/morhetz/gruvbox)
  "gruvbox-dark": {
    background:          "#282828",
    foreground:          "#ebdbb2",
    cursor:              "#ebdbb2",
    cursorAccent:        "#282828",
    selectionBackground: "rgba(80,73,69,0.7)",
    black:   "#282828", red:     "#cc241d", green:   "#98971a", yellow:  "#d79921",
    blue:    "#458588", magenta: "#b16286", cyan:    "#689d6a", white:   "#a89984",
    brightBlack:   "#928374", brightRed:   "#fb4934",
    brightGreen:   "#b8bb26", brightYellow:"#fabd2f",
    brightBlue:    "#83a598", brightMagenta:"#d3869b",
    brightCyan:    "#8ec07c", brightWhite: "#ebdbb2",
  },
  // Tokyo Night (https://github.com/enkia/tokyo-night-vscode-theme)
  "tokyo-night": {
    background:          "#1a1b26",
    foreground:          "#c0caf5",
    cursor:              "#c0caf5",
    cursorAccent:        "#1a1b26",
    selectionBackground: "rgba(41,46,66,0.7)",
    black:   "#15161e", red:     "#f7768e", green:   "#9ece6a", yellow:  "#e0af68",
    blue:    "#7aa2f7", magenta: "#bb9af7", cyan:    "#7dcfff", white:   "#a9b1d6",
    brightBlack:   "#414868", brightRed:   "#f7768e",
    brightGreen:   "#9ece6a", brightYellow:"#e0af68",
    brightBlue:    "#7aa2f7", brightMagenta:"#bb9af7",
    brightCyan:    "#7dcfff", brightWhite: "#c0caf5",
  },
  // Monokai clásico (Sublime Text / TextMate)
  monokai: {
    background:          "#272822",
    foreground:          "#f8f8f2",
    cursor:              "#f8f8f0",
    cursorAccent:        "#272822",
    selectionBackground: "rgba(73,72,62,0.7)",
    black:   "#272822", red:     "#f92672", green:   "#a6e22e", yellow:  "#f4bf75",
    blue:    "#66d9ef", magenta: "#ae81ff", cyan:    "#a1efe4", white:   "#f8f8f2",
    brightBlack:   "#75715e", brightRed:   "#f92672",
    brightGreen:   "#a6e22e", brightYellow:"#f4bf75",
    brightBlue:    "#66d9ef", brightMagenta:"#ae81ff",
    brightCyan:    "#a1efe4", brightWhite: "#f9f8f5",
  },
};

/** IDs de tema que tienen una clase CSS distinta aplicada a <html>. */
const THEME_CLASSES = [
  "theme-light",
  "theme-dracula",
  "theme-nord",
  "theme-xterm",
  "theme-vscode-dark",
  "theme-tango",
  "theme-solarized-dark",
  "theme-solarized-light",
  "theme-gruvbox-dark",
  "theme-tokyo-night",
  "theme-monokai",
];

// ═══════════════════════════════════════════════════════════════
// PREFERENCIAS
// ═══════════════════════════════════════════════════════════════

const DEFAULT_PREFS = {
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
  // Captura la pantalla de cada sesión SSH (no privada) en disco para poder
  // restaurarla luego con «Conectar y restaurar pantalla anterior». Solo es la
  // salida visual; puede contener datos sensibles. Excluido de sync.
  captureScreen:   true,
  sftpConflictPolicy: "ask",   // "ask" | "overwrite" | "skip" | "rename"
  sftpVerifySize:  false,
  // Máximo de peticiones SFTP simultáneas (handles en vuelo) por transferencia
  // en cada sesión. Conservador por defecto: servidores como Hetzner Storage Box
  // limitan los handles abiertos y un valor alto provoca "Handle limit reached".
  sftpMaxConcurrent: 4,        // 1–64

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
  scrollback:      5000,
  bell:            "none",    // "none" | "visual" | "sound"
  // KeePass: rutas persistentes (sin contraseña maestra)
  keepassPath:     "",
  keepassKeyfile:  "",
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
  // Modo daltónico: dots de estado se diferencian también por forma
  // (círculo / cuadrado / diamante) además de por color.
  colorBlindSafe:  false,
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

// Paleta de colores predefinidos para las carpetas. Cada entrada es el id que
// se persiste en prefs.folderColors[workspaceId|path] y el color (var CSS) que se usa
// para pintar el icono SVG y la franja izquierda del folder-header (--folder-tint).
const FOLDER_COLOR_PRESETS = [
  { id: "red",     color: "var(--red)" },
  { id: "peach",   color: "var(--peach)" },
  { id: "yellow",  color: "var(--yellow)" },
  { id: "green",   color: "var(--green)" },
  { id: "teal",    color: "var(--teal)" },
  { id: "blue",    color: "var(--blue)" },
  { id: "mauve",   color: "var(--mauve)" },
  { id: "pink",    color: "var(--pink)" },
];

function folderIconSvg() {
  return `<svg class="folder-icon-svg" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2.5 4.8A1.8 1.8 0 0 1 4.3 3h2.8l1.6 1.8h5A1.8 1.8 0 0 1 15.5 6.6v5.6a1.8 1.8 0 0 1-1.8 1.8H4.3a1.8 1.8 0 0 1-1.8-1.8z"/>
  </svg>`;
}

let prefs = { ...DEFAULT_PREFS };

function folderColorKey(path, workspaceId = getActiveWorkspaceId()) {
  return `${workspaceId || "default"}|${path}`;
}

function migrateLegacyFolderColors() {
  if (!prefs.folderColors || typeof prefs.folderColors !== "object" || Array.isArray(prefs.folderColors)) {
    // Inicialización de un default vacío: NO es una edición del usuario, así que
    // NO debe tocar `_prefsUpdatedAt`. Si lo hiciera, una instalación nueva
    // marcaría su bundle de prefs con fecha "ahora" y ganaría el LWW del primer
    // sync, descartando los workspaces/carpetas/favoritos remotos (los perfiles
    // sí bajan y quedan colgando de "default").
    prefs.folderColors = {};
    return false;
  }
  const migrated = {};
  let mutated = false;
  for (const [key, color] of Object.entries(prefs.folderColors)) {
    if (key.includes("|")) migrated[key] = color;
  }
  for (const [key, color] of Object.entries(prefs.folderColors)) {
    if (key.includes("|")) continue;
    mutated = true;
    const scopedKey = folderColorKey(key);
    if (!(scopedKey in migrated)) migrated[scopedKey] = color;
  }
  if (!mutated) return false;
  prefs.folderColors = migrated;
  prefs._prefsUpdatedAt = new Date().toISOString();
  return true;
}

function normalizeWorkspaceColors() {
  if (!prefs.workspaceColors || typeof prefs.workspaceColors !== "object" || Array.isArray(prefs.workspaceColors)) {
    prefs.workspaceColors = {};
  }
}

function loadPrefs() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem("rustty-prefs") || "null");
    if (stored) prefs = { ...DEFAULT_PREFS, ...stored };
  } catch {}
  if (!Array.isArray(prefs.workspaces) || prefs.workspaces.length === 0) {
    prefs.workspaces = [{ id: "default", name: "Default" }];
  }
  if (!prefs.workspaces.some((w) => w.id === prefs.activeWorkspaceId)) {
    prefs.activeWorkspaceId = prefs.workspaces[0].id;
  }
  migrateLegacyFolderColors();
  normalizeWorkspaceColors();
  // Migración de carpetas globales → por workspace
  if (!prefs.userFoldersByWorkspace || typeof prefs.userFoldersByWorkspace !== "object") {
    prefs.userFoldersByWorkspace = {};
  }
  const legacy = stored && Array.isArray(stored.userFolders)
    ? stored.userFolders.filter((f) => typeof f === "string" && f.trim())
    : [];
  if (legacy.length && !prefs.userFoldersByWorkspace[prefs.activeWorkspaceId]) {
    prefs.userFoldersByWorkspace[prefs.activeWorkspaceId] = [...legacy];
  }
  prefs.userFolders = []; // legacy vacío tras migración
  for (const w of prefs.workspaces) {
    if (!Array.isArray(prefs.userFoldersByWorkspace[w.id])) {
      prefs.userFoldersByWorkspace[w.id] = [];
    }
  }
  userFolders = new Set(prefs.userFoldersByWorkspace[prefs.activeWorkspaceId] || []);
  if (!Array.isArray(prefs.favorites)) prefs.favorites = [];
  if (!["current", "all", "favorites"].includes(prefs.sidebarViewMode)) {
    prefs.sidebarViewMode = "current";
  }
  prefs.searchAllWorkspaces = prefs.searchAllWorkspaces !== false;
  prefs.sidebarCompact = Boolean(prefs.sidebarCompact);
  if (typeof prefs.foldersFirst !== "boolean") prefs.foldersFirst = true;
  if (!Array.isArray(prefs.highlightRules)) {
    prefs.highlightRules = defaultHighlightRules();
  }
  if (stored && !stored._highlightRulesSeeded && prefs.highlightRules.length === 0) {
    prefs.highlightRules = defaultHighlightRules();
  }
  prefs._highlightRulesSeeded = true;
  if (!prefs.lang || !SUPPORTED_LANGS.includes(prefs.lang)) {
    prefs.lang = detectLanguage();
  }
  setLanguage(prefs.lang);
  applyTranslations();
  registerAllCustomThemes();
  applyTheme(prefs.theme);
  applyUiDensity(prefs.uiDensity);
  applyUiZoom(prefs.uiZoom);
  applyColorBlindSafe(prefs.colorBlindSafe);
  if (loadZenMode()) applyZenMode(true);
}

function getActiveWorkspaceId() {
  return prefs.activeWorkspaceId || "default";
}

function profileBelongsToActiveWorkspace(p) {
  return profileWorkspaceId(p) === getActiveWorkspaceId();
}

function profileWorkspaceId(p) {
  return p?.workspace_id || "default";
}

/**
 * Garantiza que todo `workspace_id` referenciado por algún perfil exista en
 * `prefs.workspaces`. Si un perfil apunta a un workspace ausente (p. ej. tras un
 * merge de sync que trajo los perfiles pero no el bundle de prefs con la lista
 * de workspaces), se crea una entrada de respaldo para que la conexión NO quede
 * colgando de "default". NO toca `_prefsUpdatedAt`: es una reconstrucción
 * defensiva, no una edición; si más tarde llega el bundle real por sync (con los
 * nombres correctos), reemplaza la lista entera y los nombres se restauran.
 * @returns {boolean} true si añadió alguna entrada.
 */
function ensureWorkspacesForProfiles() {
  if (!Array.isArray(prefs.workspaces) || prefs.workspaces.length === 0) {
    prefs.workspaces = [{ id: "default", name: "Default" }];
  }
  const known = new Set(prefs.workspaces.map((w) => w.id));
  let added = false;
  for (const p of profiles) {
    const wsId = p?.workspace_id || "default";
    if (known.has(wsId)) continue;
    known.add(wsId);
    // Nombre de respaldo: legible aunque el real (del bundle remoto) aún no haya
    // llegado. El usuario puede renombrarlo; un sync posterior lo sobrescribe.
    prefs.workspaces.push({ id: wsId, name: `Workspace ${prefs.workspaces.length}` });
    prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
    if (!Array.isArray(prefs.userFoldersByWorkspace[wsId])) {
      prefs.userFoldersByWorkspace[wsId] = [];
    }
    added = true;
  }
  if (added) savePrefs();
  return added;
}

function getWorkspaceFolders(wsId) {
  const list = prefs.userFoldersByWorkspace?.[wsId];
  return Array.isArray(list) ? list : [];
}

function setActiveWorkspaceFolders(folders) {
  const wsId = getActiveWorkspaceId();
  prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
  prefs.userFoldersByWorkspace[wsId] = [...new Set(folders.filter(Boolean))].sort();
  userFolders = new Set(prefs.userFoldersByWorkspace[wsId]);
}

function isFavoriteProfile(id) {
  return Array.isArray(prefs.favorites) && prefs.favorites.includes(id);
}

function toggleFavoriteProfile(id) {
  if (!Array.isArray(prefs.favorites)) prefs.favorites = [];
  const idx = prefs.favorites.indexOf(id);
  if (idx >= 0) prefs.favorites.splice(idx, 1);
  else prefs.favorites.push(id);
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
}

function savePrefs() {
  localStorage.setItem("rustty-prefs", JSON.stringify(prefs));
  scheduleTrayQuickLauncherUpdate();
}

function persistSidebarOpenFolders() {
  localStorage.setItem(
    SIDEBAR_OPEN_FOLDERS_STORAGE_KEY,
    JSON.stringify([...openFolders].filter(Boolean))
  );
}

/** Resuelve un tema efectivo (`system` → `dark` | `light` según el SO). */
function resolveEffectiveTheme(theme) {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

/** Devuelve el tema xterm.js correcto según la preferencia activa.
 *  Si `prefs.terminalTheme` está definido y no es "inherit", se usa ese;
 *  en caso contrario el terminal hereda el tema de UI. */
function getTerminalTheme() {
  const override = prefs.terminalTheme;
  const base = (override && override !== "inherit") ? override : (uiThemePreview || prefs.theme);
  const effective = resolveEffectiveTheme(base);
  return TERMINAL_THEMES[effective] || TERMINAL_THEMES.dark;
}

/**
 * Aplica el tema al elemento <html> y actualiza los colores de todos
 * los terminales abiertos. `dark` es el tema por defecto (sin clase).
 */
function applyTheme(theme) {
  const effective = resolveEffectiveTheme(theme);
  const root = document.documentElement;
  THEME_CLASSES.forEach((cls) => root.classList.remove(cls));
  if (effective !== "dark") {
    root.classList.add(`theme-${effective}`);
  }
  applyPrefsToAllTerminals();
}

/**
 * Aplica la densidad de UI configurada (cómoda / compacta) al <body>.
 * Solo afecta al chrome: sidebar, tabs y modales. No toca el terminal.
 */
function applyUiDensity(density) {
  const d = density === "compact" ? "compact" : "comfortable";
  document.body.classList.toggle("density-compact", d === "compact");
  document.body.classList.toggle("density-comfortable", d === "comfortable");
}

/**
 * Aplica el zoom del chrome (rail/sidebar/tabs/status) sin tocar xterm.
 * Se escribe como CSS var `--ui-zoom` que consumen las reglas de estos
 * contenedores; el rango se clampa a [0.6, 1.6]. El default 1.0 deja
 * exactamente el render de siempre.
 */
function applyUiZoom(zoom) {
  const z = clampUiZoom(Number(zoom));
  document.documentElement.style.setProperty("--ui-zoom", String(z));
}

function clampUiZoom(z) {
  if (!Number.isFinite(z)) return 1;
  return Math.min(1.6, Math.max(0.6, Math.round(z * 100) / 100));
}

function adjustUiZoom(delta) {
  const current = clampUiZoom(prefs.uiZoom ?? 1);
  let next;
  if (delta === "reset") next = 1;
  else next = clampUiZoom(current + (Number(delta) || 0) * 0.1);
  if (next === current) { syncUiZoomControl(); return; }
  prefs.uiZoom = next;
  applyUiZoom(next);
  syncUiZoomControl();
  savePrefs();
}

/** Refleja el zoom actual en la etiqueta del control de Preferencias. */
function syncUiZoomControl() {
  const label = document.getElementById("pref-ui-zoom-value");
  if (label) label.textContent = `${Math.round(clampUiZoom(prefs.uiZoom ?? 1) * 100)}%`;
}

/** Cablea los botones del control de tamaño de la interfaz (Preferencias). */
function initUiZoomControl() {
  document.getElementById("pref-ui-zoom-out")?.addEventListener("click", () => adjustUiZoom(-1));
  document.getElementById("pref-ui-zoom-in")?.addEventListener("click", () => adjustUiZoom(+1));
  document.getElementById("pref-ui-zoom-reset")?.addEventListener("click", () => adjustUiZoom("reset"));
  syncUiZoomControl();
}

/**
 * Activa el modo daltónico: los dots de estado se diferencian también
 * por forma (círculo conectado / cuadrado error / diamante reconectando)
 * además de por color.
 */
function applyColorBlindSafe(enabled) {
  document.body.classList.toggle("color-blind-safe", !!enabled);
}

// ─── Export / Import de temas ─────────────────────────────────
//
// Formato:
//   {
//     formatVersion: 2,
//     id: "tokyo-night-fork",
//     name: "Tokyo Night (fork)",
//     terminal: { background, foreground, cursor, ..., 16 colores ANSI },
//     ui: { base: "#...", text: "#...", blue: "#...", ... }
//   }

const THEME_FORMAT_VERSION = 2;
const BASE_THEME_IDS = new Set(Object.keys(TERMINAL_THEMES));
const BUNDLED_THEME_PACKS = [
  "/themes/bundled-themes.json",
];
const BUNDLED_THEME_IDS = new Set();
let uiThemePreview = null;

const UI_THEME_TOKENS = [
  "base", "mantle", "crust",
  "surface0", "surface1", "surface2",
  "overlay0", "overlay1",
  "text", "subtext0", "subtext1",
  "blue", "red", "green", "yellow",
  "mauve", "peach", "teal", "sky", "lavender",
];

const TERMINAL_THEME_TOKENS = [
  "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

function baseSlugifyThemeId(name) {
  return (name || "custom").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40) || "custom";
}

function slugifyThemeId(name) {
  const slug = baseSlugifyThemeId(name);
  return uniqueThemeId(slug);
}

function uniqueThemeId(baseId) {
  const slug = baseSlugifyThemeId(baseId);
  // Garantiza unicidad frente a temas base y otros custom
  const existing = new Set([
    ...Object.keys(TERMINAL_THEMES),
    ...(prefs.customThemes || []).map((t) => t.id),
  ]);
  if (!existing.has(slug)) return slug;
  let i = 2;
  while (existing.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

function pickThemeTokens(source, keys) {
  if (!source || typeof source !== "object") return {};
  const out = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function gatherActiveUiTokens() {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    UI_THEME_TOKENS.map((token) => [token, cs.getPropertyValue(`--${token}`).trim()])
      .filter(([, val]) => val !== "")
  );
}

function normalizeThemeDocument(data) {
  if (!data || data.formatVersion !== THEME_FORMAT_VERSION) {
    throw new Error("unsupported_theme_format");
  }
  const name = String(data.name || "").trim().slice(0, 60);
  if (!name) throw new Error("theme_name_required");

  const ui = pickThemeTokens(data.ui, UI_THEME_TOKENS);
  const terminal = pickThemeTokens(data.terminal, TERMINAL_THEME_TOKENS);
  if (!ui.base || !ui.text || !terminal.background || !terminal.foreground) {
    throw new Error("theme_required_tokens_missing");
  }

  return {
    formatVersion: THEME_FORMAT_VERSION,
    id: slugifyThemeId(data.id || name),
    name,
    ui,
    terminal,
    updatedAt: new Date().toISOString(),
  };
}

function buildThemeDocument({ id, name, ui, terminal }) {
  return {
    formatVersion: THEME_FORMAT_VERSION,
    id,
    name,
    ui: pickThemeTokens(ui, UI_THEME_TOKENS),
    terminal: pickThemeTokens(terminal, TERMINAL_THEME_TOKENS),
  };
}

function getRuntimeThemeStyleElement(source) {
  const id = source === "bundled"
    ? "rustty-bundled-themes-style"
    : "rustty-custom-themes-style";
  let styleEl = document.getElementById(id);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = id;
    document.head.appendChild(styleEl);
  }
  return styleEl;
}

function appendRuntimeThemeCss(theme, source) {
  const decl = UI_THEME_TOKENS
    .map((token) => theme.ui[token] ? `--${token}: ${theme.ui[token]};` : "")
    .filter(Boolean).join(" ");
  getRuntimeThemeStyleElement(source).appendChild(
    document.createTextNode(`\nhtml.theme-${theme.id} { ${decl} }\n`)
  );
}

/** Registra un tema runtime: extiende TERMINAL_THEMES, inyecta
 *  CSS vars bajo `html.theme-<id>` y añade un swatch a los pickers. */
function registerRuntimeTheme(theme, { source = "custom" } = {}) {
  TERMINAL_THEMES[theme.id] = theme.terminal;
  const cssClass = `theme-${theme.id}`;
  if (!THEME_CLASSES.includes(cssClass)) THEME_CLASSES.push(cssClass);

  appendRuntimeThemeCss(theme, source);

  // Swatches en ambos pickers (UI + terminal)
  appendCustomSwatch("ui", theme);
  appendCustomSwatch("terminal", theme);
}

function registerCustomTheme(theme) {
  registerRuntimeTheme(theme, { source: "custom" });
}

function registerBundledTheme(theme) {
  BUNDLED_THEME_IDS.add(theme.id);
  registerRuntimeTheme(theme, { source: "bundled" });
}

function appendCustomSwatch(picker, theme) {
  const root = document.querySelector(`.theme-picker[data-for="${picker}"]`);
  if (!root) return;
  let label = root.querySelector(`.theme-option[data-theme="${CSS.escape(theme.id)}"]`);
  if (!label) {
    label = document.createElement("label");
    label.className = "theme-option";
    label.dataset.theme = theme.id;
    (root.querySelector(".theme-options-list") || root).appendChild(label);
  }
  label.className = "theme-option";
  label.dataset.theme = theme.id;
  const inputName = picker === "ui" ? "pref-theme" : "pref-terminal-theme";
  label.innerHTML = `
    <input type="radio" name="${inputName}" value="${escHtml(theme.id)}" />
    ${renderThemePreviewHtml(theme)}
    <span class="theme-label">${escHtml(theme.name)}</span>`;
  const radio = label.querySelector("input");
  radio.addEventListener("change", () => {
    if (picker === "ui") selectUiTheme(theme.id);
    else selectTerminalTheme(theme.id);
  });
  filterThemePickerOptions(root);
  updateThemePickerButton(picker, picker === "ui" ? prefs.theme : (prefs.terminalTheme || "inherit"));
}

function getThemeOptionLabel(option) {
  return option?.querySelector(".theme-label")?.textContent?.trim() || option?.dataset.theme || "";
}

/**
 * Pinta un mini terminal con la paleta xterm real del tema: una línea de
 * prompt (verde), un comando (foreground) y dos líneas de salida (cyan,
 * subtext) con una "selección" simulada usando los colores `selectionForeground`
 * / `selectionBackground` del tema. Sustituye al placeholder estático que era
 * solo sidebar + main coloreado.
 */
function renderThemePreviewHtml(theme) {
  const ui = theme.ui || {};
  const term = theme.terminal || {};
  const base = escHtml(ui.base || term.background || "#222");
  const mantle = escHtml(ui.mantle || ui.base || "#1a1a1a");
  const fg = escHtml(term.foreground || ui.text || "#cdd6f4");
  const green = escHtml(term.green || "#a6e3a1");
  const blue = escHtml(term.cyan || term.blue || "#89b4fa");
  const dim = escHtml(term.brightBlack || ui.subtext0 || "#a6adc8");
  const accent = escHtml(term.yellow || term.peach || "#f9e2af");
  const selBg = escHtml(term.selectionBackground || ui.surface1 || "rgba(255,255,255,0.18)");
  const selFg = escHtml(term.selectionForeground || term.foreground || "#1e1e2e");
  return `
    <div class="theme-preview" style="background:${base}">
      <div class="theme-preview-sidebar" style="background:${mantle}"></div>
      <div class="theme-preview-main" style="background:${base}">
        <div class="theme-preview-term" style="color:${fg}">
          <span class="tp-line"><span style="color:${green}">~</span><span style="color:${dim}">$</span> <span style="color:${blue}">ls</span> <span style="background:${selBg};color:${selFg}">-la</span></span>
          <span class="tp-line" style="color:${accent}">drwx</span>
          <span class="tp-line" style="color:${dim}">total 12</span>
        </div>
      </div>
    </div>`;
}

function updateThemePickerButton(picker, value) {
  const root = document.querySelector(`.theme-picker[data-for="${picker}"]`);
  const toggle = root?.querySelector(".theme-picker-toggle");
  if (!root || !toggle) return;
  const selected = root.querySelector(`.theme-option[data-theme="${CSS.escape(value)}"]`)
    || root.querySelector(".theme-option");
  const previewHost = toggle.querySelector(".theme-picker-toggle-preview");
  const label = toggle.querySelector(".theme-picker-toggle-label");
  if (previewHost) {
    previewHost.innerHTML = "";
    const preview = selected?.querySelector(".theme-preview")?.cloneNode(true);
    if (preview) previewHost.appendChild(preview);
  }
  if (label) label.textContent = getThemeOptionLabel(selected);
}

function filterThemePickerOptions(root) {
  if (!root) return;
  const query = root.querySelector(".theme-picker-search")?.value.trim().toLowerCase() || "";
  const tone = root.dataset.themeTone || "all";
  root.querySelectorAll(".theme-option").forEach((option) => {
    if (!option.dataset.themeTone) option.dataset.themeTone = detectThemeOptionTone(option);
    const haystack = `${getThemeOptionLabel(option)} ${option.dataset.theme || ""}`.toLowerCase();
    const matchesText = !query || haystack.includes(query);
    const matchesTone = tone === "all" || option.dataset.themeTone === tone;
    option.classList.toggle("is-filtered-out", !(matchesText && matchesTone));
  });
}

/**
 * Detecta tonalidad de una option. Devuelve "light", "dark" o "hc"
 * (alto contraste). La detección de alto contraste se basa en el id/nombre
 * porque depende de la intención del autor del tema, no de un umbral
 * automático de luminancia.
 */
function detectThemeOptionTone(option) {
  const id = (option.dataset.theme || "").toLowerCase();
  const label = (option.querySelector(".theme-label")?.textContent || "").toLowerCase();
  if (/(^|-)hc($|-)|high[-_ ]?contrast|alto[-_ ]?contraste/.test(id + " " + label)) return "hc";
  const preview = option.querySelector(".theme-preview-main") || option.querySelector(".theme-preview");
  if (preview) {
    const bg = getComputedStyle(preview).backgroundColor;
    const lum = relativeLuminanceFromColor(bg);
    if (Number.isFinite(lum)) return lum > 0.55 ? "light" : "dark";
  }
  if (/light|day|lotus|latte|dawn|gruvbox-light|solarized-light/.test(id)) return "light";
  return "dark";
}

/**
 * Devuelve la luminancia relativa [0..1] de un color CSS `rgb(r,g,b)`.
 * Acepta rgb / rgba. Si no se puede parsear, devuelve NaN.
 */
function relativeLuminanceFromColor(css) {
  if (!css) return NaN;
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (!m) return NaN;
  const toLin = (c) => {
    const s = +c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLin(m[1]);
  const g = toLin(m[2]);
  const b = toLin(m[3]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function setThemePickerOpen(root, open) {
  if (!root) return;
  root.classList.toggle("open", open);
  root.querySelector(".theme-picker-panel")?.classList.toggle("hidden", !open);
  root.querySelector(".theme-picker-toggle")?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    const search = root.querySelector(".theme-picker-search");
    if (search) {
      search.value = "";
      filterThemePickerOptions(root);
      search.focus();
    }
  }
}

function enhanceThemePickers() {
  document.querySelectorAll(".theme-picker").forEach((root) => {
    if (root.classList.contains("enhanced")) return;
    const picker = root.dataset.for || "ui";
    const options = [...root.querySelectorAll(":scope > .theme-option")];
    if (!options.length) return;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-picker-toggle";
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `
      <span class="theme-picker-toggle-preview" aria-hidden="true"></span>
      <span class="theme-picker-toggle-label"></span>
      <span class="theme-picker-chevron" aria-hidden="true">⌄</span>
    `;

    const panel = document.createElement("div");
    panel.className = "theme-picker-panel hidden";
    panel.innerHTML = `
      <input type="search" class="theme-picker-search" data-i18n-placeholder="prefs_appearance.theme_search" placeholder="${escHtml(t("prefs_appearance.theme_search"))}" />
      <div class="theme-tone-filter" role="tablist" aria-label="${escHtml(t("prefs_appearance.tone_filter"))}">
        <button type="button" class="theme-tone-chip active" data-tone="all" role="tab" aria-selected="true">${escHtml(t("prefs_appearance.tone_all"))}</button>
        <button type="button" class="theme-tone-chip" data-tone="dark" role="tab" aria-selected="false">${escHtml(t("prefs_appearance.tone_dark"))}</button>
        <button type="button" class="theme-tone-chip" data-tone="light" role="tab" aria-selected="false">${escHtml(t("prefs_appearance.tone_light"))}</button>
        <button type="button" class="theme-tone-chip" data-tone="hc" role="tab" aria-selected="false">${escHtml(t("prefs_appearance.tone_hc"))}</button>
        <button type="button" class="theme-picker-reset" data-action="reset-theme">${escHtml(t("prefs_appearance.theme_reset_system"))}</button>
      </div>
      <div class="theme-options-list" role="listbox"></div>
    `;
    const list = panel.querySelector(".theme-options-list");
    options.forEach((option) => list.appendChild(option));
    root.append(toggle, panel);
    root.classList.add("enhanced");
    root.dataset.themeTone = "all";

    toggle.addEventListener("click", () => setThemePickerOpen(root, !root.classList.contains("open")));
    panel.querySelector(".theme-picker-search")?.addEventListener("input", () => filterThemePickerOptions(root));
    panel.querySelectorAll(".theme-tone-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const tone = chip.dataset.tone || "all";
        root.dataset.themeTone = tone;
        panel.querySelectorAll(".theme-tone-chip").forEach((c) => {
          const active = c.dataset.tone === tone;
          c.classList.toggle("active", active);
          c.setAttribute("aria-selected", active ? "true" : "false");
        });
        filterThemePickerOptions(root);
      });
    });
    panel.querySelector(".theme-picker-reset")?.addEventListener("click", () => {
      const targetId = picker === "ui" ? "system" : "inherit";
      const radio = root.querySelector(`.theme-option[data-theme="${CSS.escape(targetId)}"] input[type="radio"]`);
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
      }
      setThemePickerOpen(root, false);
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        setThemePickerOpen(root, false);
        toggle.focus();
      }
    });
    root.addEventListener("change", (e) => {
      const radio = e.target.closest('input[type="radio"]');
      if (!radio) return;
      updateThemePickerButton(picker, radio.value);
      setThemePickerOpen(root, false);
    });
  });

  if (!enhanceThemePickers._wiredOutsideClick) {
    document.addEventListener("click", (e) => {
      document.querySelectorAll(".theme-picker.open").forEach((root) => {
        if (!root.contains(e.target)) setThemePickerOpen(root, false);
      });
    });
    enhanceThemePickers._wiredOutsideClick = true;
  }

  updateThemePickerButton("ui", prefs.theme);
  updateThemePickerButton("terminal", prefs.terminalTheme || "inherit");
}

/** Registra todos los temas custom al arranque (tras loadPrefs). */
function registerAllCustomThemes() {
  let styleEl = document.getElementById("rustty-custom-themes-style");
  if (styleEl) styleEl.textContent = "";
  document.querySelectorAll(".theme-picker .theme-option").forEach((opt) => {
    const id = opt.dataset.theme;
    if (id && id !== "system" && id !== "inherit" && !BASE_THEME_IDS.has(id) && !BUNDLED_THEME_IDS.has(id)) opt.remove();
  });

  const validThemes = [];
  for (const t of (prefs.customThemes || [])) {
    try {
      if (t?.formatVersion !== THEME_FORMAT_VERSION) continue;
      const theme = {
        formatVersion: THEME_FORMAT_VERSION,
        id: baseSlugifyThemeId(t.id || t.name),
        name: String(t.name || "").trim().slice(0, 60),
        ui: pickThemeTokens(t.ui, UI_THEME_TOKENS),
        terminal: pickThemeTokens(t.terminal, TERMINAL_THEME_TOKENS),
        updatedAt: t.updatedAt,
      };
      if (!theme.id || !theme.name || !theme.ui.base || !theme.ui.text) continue;
      if (!theme.terminal.background || !theme.terminal.foreground) continue;
      if (BASE_THEME_IDS.has(theme.id) || BUNDLED_THEME_IDS.has(theme.id)) continue;
      validThemes.push(theme);
      registerCustomTheme(theme);
    } catch (err) {
      console.warn("[theme] invalid custom theme skipped", err);
    }
  }
  prefs.customThemes = validThemes;
}

async function registerBundledThemePacks() {
  const styleEl = document.getElementById("rustty-bundled-themes-style");
  if (styleEl) styleEl.textContent = "";
  for (const packPath of BUNDLED_THEME_PACKS) {
    try {
      const response = await fetch(packPath);
      if (!response.ok) throw new Error(`${response.status} ${packPath}`);
      const pack = await response.json();
      for (const doc of (Array.isArray(pack?.themes) ? pack.themes : [])) {
        try {
          if (BASE_THEME_IDS.has(doc?.id)) continue;
          const theme = {
            formatVersion: THEME_FORMAT_VERSION,
            id: baseSlugifyThemeId(doc.id || doc.name),
            name: String(doc.name || "").trim().slice(0, 60),
            ui: pickThemeTokens(doc.ui, UI_THEME_TOKENS),
            terminal: pickThemeTokens(doc.terminal, TERMINAL_THEME_TOKENS),
          };
          if (!theme.id || !theme.name || !theme.ui.base || !theme.ui.text) continue;
          if (!theme.terminal.background || !theme.terminal.foreground) continue;
          registerBundledTheme(theme);
        } catch (err) {
          console.warn("[theme] invalid bundled theme skipped", err);
        }
      }
    } catch (err) {
      console.warn("[theme] bundled pack not loaded", err);
    }
  }
  applyTheme(prefs.theme);
  selectUiTheme(prefs.theme);
  selectTerminalTheme(prefs.terminalTheme || "inherit");
}

async function exportCurrentTheme() {
  // Resolvemos el tema de UI activo (si es "system", lo traducimos a dark/light).
  const uiId = resolveEffectiveTheme(prefs.theme);
  const termId = (prefs.terminalTheme && prefs.terminalTheme !== "inherit")
    ? prefs.terminalTheme : uiId;
  const palette = TERMINAL_THEMES[termId] || TERMINAL_THEMES.dark;
  const ui = gatherActiveUiTokens();
  const baseName = (() => {
    const custom = (prefs.customThemes || []).find((t) => t.id === uiId);
    return custom?.name || uiId;
  })();

  const exported = buildThemeDocument({
    id: uiId,
    name: baseName,
    terminal: palette,
    ui,
  });

  const defaultName = `rustty-theme-${uiId}.json`;
  let path;
  try {
    path = await saveDialog({
      title: t("toast.export_theme_title"),
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) { toast(`${err}`, "error"); return; }
  if (!path) return;

  try {
    await invoke("write_text_file", {
      path,
      contents: JSON.stringify(exported, null, 2),
    });
    toast(t("toast.theme_exported").replace("{name}", baseName), "success");
  } catch (err) { toast(`${err}`, "error"); }
}

async function exportThemeTemplate() {
  const template = buildThemeDocument({
    id: "mi-tema",
    name: "Mi tema",
    ui: gatherActiveUiTokens(),
    terminal: getTerminalTheme(),
  });

  let path;
  try {
    path = await saveDialog({
      title: t("toast.export_theme_title"),
      defaultPath: "rustty-theme-template.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) { toast(`${err}`, "error"); return; }
  if (!path) return;

  try {
    await invoke("write_text_file", {
      path,
      contents: JSON.stringify(template, null, 2),
    });
    toast(t("toast.theme_exported").replace("{name}", template.name), "success");
  } catch (err) { toast(`${err}`, "error"); }
}

async function importTheme() {
  let path;
  try {
    path = await openDialog({
      title: t("toast.import_theme_title"),
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) { toast(`${err}`, "error"); return; }
  if (!path) return;

  let data;
  try {
    const text = await invoke("read_text_file", { path });
    data = JSON.parse(text);
  } catch (err) { toast(t("toast.theme_import_invalid"), "error"); return; }

  const themeDocs = Array.isArray(data?.themes) ? data.themes : (Array.isArray(data) ? data : [data]);
  const importedThemes = [];

  prefs.customThemes = prefs.customThemes || [];
  for (const doc of themeDocs) {
    try {
      const theme = normalizeThemeDocument(doc);
      prefs.customThemes.push(theme);
      registerCustomTheme(theme);
      importedThemes.push(theme);
    } catch (err) {
      console.warn("[theme] invalid imported theme skipped", err);
    }
  }

  if (!importedThemes.length) {
    toast(t("toast.theme_import_invalid"), "error");
    return;
  }

  // Seleccionarlo como tema activo de UI
  const theme = importedThemes[importedThemes.length - 1];
  prefs.theme = theme.id;
  applyTheme(theme.id);
  selectUiTheme(theme.id);
  savePrefs();
  scheduleProfileAutoSync();
  const importedName = importedThemes.length === 1
    ? theme.name
    : `${data?.name || "pack"} (${importedThemes.length})`;
  toast(t("toast.theme_imported").replace("{name}", importedName), "success");
}

function selectUiTheme(theme) {
  const prefsModal = document.getElementById("modal-prefs-overlay");
  uiThemePreview = prefsModal && !prefsModal.classList.contains("hidden") ? theme : null;
  document.querySelectorAll('input[name="pref-theme"]').forEach((r) => {
    r.checked = (r.value === theme);
  });
  document.querySelectorAll('.theme-picker[data-for="ui"] .theme-option').forEach((o) =>
    o.classList.toggle("selected", o.dataset.theme === theme)
  );
  updateThemePickerButton("ui", theme);
  applyTheme(theme);
}

function selectTerminalTheme(value) {
  document.querySelectorAll('input[name="pref-terminal-theme"]').forEach((r) => {
    r.checked = (r.value === value);
  });
  document.querySelectorAll('.theme-picker[data-for="terminal"] .theme-option').forEach((o) =>
    o.classList.toggle("selected", o.dataset.theme === value)
  );
  updateThemePickerButton("terminal", value);
  prefs.terminalTheme = (value === "inherit") ? null : value;
  applyPrefsToAllTerminals();
}

/**
 * Aplica las preferencias actuales a un terminal ya abierto.
 * Los handlers de copyOnSelect y rightClickPaste se instalan en
 * createTerminalTab leyendo `prefs` dinámicamente, por lo que no
 * es necesario reinstalarlos aquí.
 */
const DEFAULT_FONT_STACK =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace';

function resolveFontFamily() {
  const f = (prefs.fontFamily || "").trim();
  return f ? `"${f.replace(/"/g, "\\\"")}", ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK;
}

function applyPrefsToTerminal(terminal) {
  terminal.options.fontFamily    = resolveFontFamily();
  terminal.options.fontSize      = prefs.fontSize;
  terminal.options.lineHeight    = prefs.lineHeight;
  terminal.options.letterSpacing = prefs.letterSpacing;
  terminal.options.cursorStyle   = prefs.cursorStyle;
  terminal.options.cursorBlink   = prefs.cursorBlink;
  terminal.options.scrollback    = prefs.scrollback;
  terminal.options.bellStyle     = prefs.bell;
  terminal.options.theme         = getTerminalTheme();
}

function applyPrefsToAllTerminals() {
  // Sincroniza el fondo del chasis del terminal (--xterm-bg) con el fondo del
  // tema de terminal activo, para que el padding del pane y la fila/columna
  // parcial sin pintar de xterm queden del mismo color que el terminal.
  const termBg = getTerminalTheme()?.background;
  if (termBg) {
    document.documentElement.style.setProperty("--xterm-bg", termBg);
  }
  for (const [sid, s] of sessions) {
    if (!s.terminal) continue;
    applyPrefsToTerminal(s.terminal);
    s.fitAddon?.fit();
    notifyResize(sid, s.terminal);
  }
}

function previewBellStyle(style) {
  const target = document.getElementById("modal-prefs") || document.body;
  triggerTerminalBell(style, target);
}

function triggerTerminalBell(style = prefs.bell, targetEl = null) {
  if (style === "visual") {
    flashBellTarget(targetEl || document.querySelector(`.terminal-pane[data-session="${activeSessionId}"]`) || document.body);
  } else if (style === "sound") {
    playBellSound();
  }
}

function flashBellTarget(targetEl) {
  if (!targetEl) return;
  targetEl.classList.remove("terminal-bell-visual");
  // Forzar reinicio de la animación si se selecciona repetidamente.
  void targetEl.offsetWidth;
  targetEl.classList.add("terminal-bell-visual");
  window.setTimeout(() => targetEl.classList.remove("terminal-bell-visual"), 260);
}

function getBellAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!bellAudioContext) bellAudioContext = new AudioCtx();
  return bellAudioContext;
}

function playBellSound() {
  const ctx = getBellAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(660, now + 0.12);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.17);
}

let prefsActiveTab = "terminal";

function switchPrefsTab(tab) {
  if (tab === "sync") tab = "data";
  prefsActiveTab = tab;
  cancelShortcutCapture();
  document.querySelectorAll(".prefs-nav-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.prefsTab === tab)
  );
  document.querySelectorAll(".prefs-panel").forEach((el) =>
    el.classList.toggle("active", el.dataset.prefsPanel === tab)
  );
  // Refrescar la lista de credenciales al entrar en su pestaña.
  if (tab === "credentials") renderCredList();
  // Refrescar snippets y comandos locales al entrar en "Comandos".
  if (tab === "commands") {
    renderSnippetList();
    renderLocalCommandList();
  }
}

function openSettingsModal() {
  // Snapshot al abrir, para poder revertir cambios en vivo al cancelar.
  _terminalThemeSnapshot = prefs.terminalTheme;
  _typographySnapshot = {
    fontFamily:    prefs.fontFamily,
    fontSize:      prefs.fontSize,
    lineHeight:    prefs.lineHeight,
    letterSpacing: prefs.letterSpacing,
  };
  document.getElementById("pref-copy-on-select").checked   = prefs.copyOnSelect;
  document.getElementById("pref-right-click-paste").checked = prefs.rightClickPaste;
  const confirmRiskyPasteEl = document.getElementById("pref-confirm-risky-paste");
  if (confirmRiskyPasteEl) confirmRiskyPasteEl.checked = prefs.confirmRiskyPaste !== false;
  const shareHistEl = document.getElementById("pref-share-command-history");
  if (shareHistEl) shareHistEl.checked = !!prefs.shareCommandHistory;
  const captureScreenEl = document.getElementById("pref-capture-screen");
  if (captureScreenEl) captureScreenEl.checked = prefs.captureScreen !== false;
  document.getElementById("pref-sftp-conflict-policy").value = normalizeSftpConflictPolicy(prefs.sftpConflictPolicy);
  document.getElementById("pref-sftp-verify-size").checked = !!prefs.sftpVerifySize;
  const maxConcEl = document.getElementById("pref-sftp-max-concurrent");
  if (maxConcEl) maxConcEl.value = sftpMaxConcurrent();
  const remoteSideEl = document.getElementById("pref-sftp-remote-side");
  if (remoteSideEl) remoteSideEl.value = prefs.sftpRemoteSide === "right" ? "right" : "left";
  populateFontFamilySelect(prefs.fontFamily || "");
  document.getElementById("pref-font-size").value           = prefs.fontSize;
  document.getElementById("pref-line-height").value         = prefs.lineHeight;
  document.getElementById("pref-letter-spacing").value      = prefs.letterSpacing;
  document.getElementById("pref-cursor-style").value        = prefs.cursorStyle;
  const _densitySel = document.getElementById("pref-ui-density");
  if (_densitySel) _densitySel.value = prefs.uiDensity === "compact" ? "compact" : "comfortable";
  syncUiZoomControl();
  const _cbSafe = document.getElementById("pref-color-blind-safe");
  if (_cbSafe) _cbSafe.checked = !!prefs.colorBlindSafe;
  const _searchAllWorkspaces = document.getElementById("pref-search-all-workspaces");
  if (_searchAllWorkspaces) _searchAllWorkspaces.checked = prefs.searchAllWorkspaces !== false;
  document.getElementById("pref-cursor-blink").checked      = prefs.cursorBlink;
  const _ligEl = document.getElementById("pref-terminal-ligatures");
  if (_ligEl) _ligEl.checked = !!prefs.terminalLigatures;
  document.getElementById("pref-scrollback").value          = prefs.scrollback;
  document.getElementById("pref-bell").value                = prefs.bell;
  renderHighlightRulesEditor();

  // Marcar el radio + .selected correspondientes al tema de UI actual
  document.querySelectorAll('input[name="pref-theme"]').forEach((r) => {
    r.checked = (r.value === prefs.theme);
  });
  document.querySelectorAll('.theme-picker[data-for="ui"] .theme-option').forEach((opt) =>
    opt.classList.toggle("selected", opt.dataset.theme === prefs.theme)
  );
  updateThemePickerButton("ui", prefs.theme);

  // Tema del terminal: si no hay override se marca "inherit"
  const termVal = prefs.terminalTheme || "inherit";
  document.querySelectorAll('input[name="pref-terminal-theme"]').forEach((r) => {
    r.checked = (r.value === termVal);
  });
  document.querySelectorAll('.theme-picker[data-for="terminal"] .theme-option').forEach((opt) =>
    opt.classList.toggle("selected", opt.dataset.theme === termVal)
  );
  updateThemePickerButton("terminal", termVal);

  // Rellenar el selector de carpetas para exportar
  const folderSel = document.getElementById("export-folder-select");
  const allPaths = getAllFolderPaths();
  folderSel.innerHTML = `<option value="">${escHtml(t("prefs_data.folder_pick"))}</option>`
    + allPaths.map((p) => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join("");

  // KeePass: rutas y estado
  document.getElementById("pref-keepass-path").value    = prefs.keepassPath || "";
  document.getElementById("pref-keepass-keyfile").value = prefs.keepassKeyfile || "";
  refreshKeepassStatus();

  // Idioma. `prefs.lang` se guarda como null cuando el usuario eligió "Sistema"
  // (auto-detect en cada arranque). El select expone esa opción como "system".
  const langSel = document.getElementById("pref-language");
  if (langSel) langSel.value = prefs.lang ? prefs.lang : "system";

  // Mantener la última pestaña activa al reabrir
  switchPrefsTab(prefsActiveTab);

  // Acerca de: versión (la resuelve una vez por sesión y cachea)
  populateAboutVersion();
  document.getElementById("pref-check-updates-startup").checked =
    prefs.checkUpdatesOnStartup !== false;

  // Sistema: autostart
  populateAutostartToggles();

  // Logs de sesión: rellenar campos de retención y refrescar el contador.
  const slAge = document.getElementById("pref-session-log-max-age");
  const slMb = document.getElementById("pref-session-log-max-mb");
  if (slAge) slAge.value = prefs.sessionLogMaxAgeDays ?? "";
  if (slMb) slMb.value = prefs.sessionLogMaxTotalMb ?? "";
  refreshSessionLogsStats();

  // Atajos: (re)render con los valores actuales
  renderShortcutsList();

  // Sincronización: cargar config + secretos
  populateSyncTab();

  // Credenciales maestras: pintar la lista actual
  renderCredList();

  document.getElementById("modal-prefs-overlay").classList.remove("hidden");
}

// ─── Sincronización: pestaña en Preferencias ────────────────────

let _syncDeviceIdCache = null;
let _syncConfigCache = null;
let _syncSidebarState = "idle";
let _syncSidebarTextKey = "prefs_sync.status_idle";
let _syncProfileAutoTimer = null;
let _syncInFlight = false;
let _syncPending = false;
const SYNC_AUTO_DEBOUNCE_MS = 60_000;
async function populateSyncTab() {
  const config = await sync.getConfig().catch(() => ({
    enabled: false, backend: "none",
    local: { folder: "" },
    webdav: { url: "", username: "" },
    selective: { profiles: true, prefs: true, themes: true, shortcuts: true, snippets: true },
    history_keep: DEFAULT_SYNC_HISTORY_KEEP,
    last_sync_at: null,
  }));
  _syncConfigCache = config;

  const allowedBackends = ["none", "local", "icloud", "webdav", "google_drive"];
  const backend = allowedBackends.includes(config.backend) ? config.backend : "none";
  document.getElementById("sync-enabled").checked = !!config.enabled;
  document.getElementById("sync-backend").value = backend;
  document.getElementById("sync-local-folder").value = config.local?.folder || "";
  document.getElementById("sync-webdav-url").value  = config.webdav?.url || "";
  document.getElementById("sync-webdav-user").value = config.webdav?.username || "";
  document.getElementById("sync-sel-profiles").checked  = config.selective?.profiles ?? true;
  document.getElementById("sync-sel-prefs").checked     = config.selective?.prefs ?? true;
  document.getElementById("sync-sel-themes").checked    = config.selective?.themes ?? true;
  document.getElementById("sync-sel-shortcuts").checked = config.selective?.shortcuts ?? true;
  document.getElementById("sync-sel-notes").checked     = config.selective?.notes ?? true;
  document.getElementById("sync-sel-secrets").checked   = config.selective?.secrets ?? false;
  document.getElementById("sync-history-keep").value =
    String(Math.max(1, parseInt(config.history_keep, 10) || DEFAULT_SYNC_HISTORY_KEEP));

  // Passphrase (no la mostramos en claro, solo placeholder distinto si ya existe)
  const passEl = document.getElementById("sync-passphrase");
  const stored = await sync.getStoredPassphrase().catch(() => null);
  if (stored) {
    passEl.value = "";
    passEl.placeholder = "•••••••• (configurada)";
  } else {
    passEl.placeholder = "••••••••";
  }
  // WebDAV password: idem
  const wpEl = document.getElementById("sync-webdav-pass");
  const wpStored = await sync.getStoredWebDavPassword().catch(() => null);
  wpEl.value = "";
  wpEl.placeholder = wpStored ? "•••••••• (configurada)" : "••••••••";

  // Mostrar/ocultar bloques según backend
  syncUpdateBackendVisibility();
  refreshSyncOAuthStatus();

  // Device ID
  if (!_syncDeviceIdCache) {
    _syncDeviceIdCache = await sync.getDeviceId().catch(() => "—");
  }
  document.getElementById("sync-device-id").textContent = _syncDeviceIdCache;
  const lastSyncAt = syncLastSyncAt();
  document.getElementById("sync-last-time").textContent =
    lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "—";
  if (config.enabled && backend !== "none" && lastSyncAt) {
    setSyncStatus("success", "prefs_sync.status_success");
  }
  updateSidebarSyncStatus();
  refreshSyncSnapshots();
}

function syncUpdateBackendVisibility() {
  const v = document.getElementById("sync-backend").value;
  document.querySelectorAll(".sync-local-only").forEach((el) =>
    el.classList.toggle("hidden", v !== "local")
  );
  document.querySelectorAll(".sync-icloud-only").forEach((el) =>
    el.classList.toggle("hidden", v !== "icloud")
  );
  document.querySelectorAll(".sync-webdav-only").forEach((el) =>
    el.classList.toggle("hidden", v !== "webdav")
  );
  document.querySelectorAll(".sync-google-drive-only").forEach((el) =>
    el.classList.toggle("hidden", v !== "google_drive")
  );
  document.querySelectorAll(".sync-oauth-only").forEach((el) =>
    el.classList.toggle("hidden", !currentOAuthProvider())
  );
  refreshSyncOAuthStatus();
}

function setSyncStatus(state, textKey) {
  const dot = document.getElementById("sync-status-dot");
  const txt = document.getElementById("sync-status-text");
  _syncSidebarState = state;
  _syncSidebarTextKey = textKey;
  if (dot && txt) {
    dot.classList.remove("idle", "busy", "success", "error");
    dot.classList.add(state);
    txt.textContent = t(textKey);
  }
  updateSidebarSyncStatus();
}

function syncBackendLabel(backend) {
  const map = {
    none: "prefs_sync.backend_none",
    local: "prefs_sync.backend_local",
    icloud: "prefs_sync.backend_icloud",
    webdav: "prefs_sync.backend_webdav",
    google_drive: "prefs_sync.backend_google_drive",
  };
  return t(map[backend] || map.none);
}

function syncLastSyncAt() {
  const values = [prefs._lastSyncAt, _syncConfigCache?.last_sync_at]
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time));
  if (!values.length) return null;
  values.sort((a, b) => b.time - a.time);
  return values[0].value;
}

function updateSidebarSyncStatus() {
  const dot = document.getElementById("sidebar-sync-dot");
  const label = document.getElementById("sidebar-sync-label");
  const meta = document.getElementById("sidebar-sync-meta");
  const enabled = !!_syncConfigCache?.enabled && _syncConfigCache.backend !== "none";
  const state = enabled ? _syncSidebarState : "idle";
  const backend = syncBackendLabel(_syncConfigCache?.backend || "none");
  const lastSyncAt = syncLastSyncAt();
  const last = lastSyncAt
    ? new Date(lastSyncAt).toLocaleString()
    : t("prefs_sync.last_never");
  if (dot && label && meta) {
    dot.classList.remove("idle", "busy", "success", "error");
    dot.classList.add(state);
    label.textContent = enabled ? t(_syncSidebarTextKey) : t("prefs_sync.status_disabled");
    meta.textContent = enabled ? `${backend} · ${last}` : backend;
  }
  renderSyncBackendCards();
  renderDashboard();
}

/**
 * Render del grid de tarjetas en Preferencias → Copias de seguridad. Cada
 * tarjeta muestra icono, nombre, dot de estado y última sync relativa; al
 * clicar selecciona el backend en el `<select>` existente y desencadena
 * `change` para que el formulario se reorganice.
 */
function renderSyncBackendCards() {
  const grid = document.getElementById("sync-backend-cards");
  if (!grid) return;
  const backends = [
    { id: "local",        icon: "📁", labelKey: "prefs_sync.backend_local" },
    { id: "icloud",       icon: "☁",  labelKey: "prefs_sync.backend_icloud" },
    { id: "webdav",       icon: "🌐", labelKey: "prefs_sync.backend_webdav" },
    { id: "google_drive", icon: "🅖", labelKey: "prefs_sync.backend_google_drive" },
  ];
  const activeBackend = _syncConfigCache?.backend || "none";
  const enabled = !!_syncConfigCache?.enabled;
  const lastSyncAt = syncLastSyncAt();
  const lastRel = lastSyncAt ? formatRelativeTimeShort(lastSyncAt) : null;
  grid.innerHTML = backends.map((b) => {
    const isActive = activeBackend === b.id;
    const state = isActive && enabled
      ? (_syncSidebarState === "error" ? "error" : _syncSidebarState === "busy" ? "busy" : "success")
      : "idle";
    const lastText = isActive
      ? (lastRel ? `${t("prefs_sync.last_at")} ${lastRel}` : t("prefs_sync.last_never"))
      : t("prefs_sync.backend_card_inactive");
    return `
      <button type="button" class="sync-backend-card${isActive ? " active" : ""}" role="listitem" data-backend="${escHtml(b.id)}">
        <span class="sync-backend-card-icon">${b.icon}</span>
        <span class="sync-backend-card-name">${escHtml(t(b.labelKey))}</span>
        <span class="sync-backend-card-status ${escHtml(state)}">
          <span class="sync-backend-card-dot"></span>
          <span>${escHtml(lastText)}</span>
        </span>
      </button>`;
  }).join("");
  grid.querySelectorAll(".sync-backend-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.backend;
      const select = document.getElementById("sync-backend");
      if (!select || !id) return;
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

/**
 * Formato relativo conciso ("ahora", "5 min", "2 h", "3 d"). Para el
 * tooltip de la topbar; usa el último timestamp de sync conocido.
 */
function formatRelativeTimeShort(iso) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("time.now");
  const min = Math.floor(diff / 60_000);
  if (min < 60) return t("time.minutes_ago", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.hours_ago", { n: h });
  const d = Math.floor(h / 24);
  return t("time.days_ago", { n: d });
}

function currentOAuthProvider() {
  const el = document.getElementById("sync-backend");
  const value = el?.value || _syncConfigCache?.backend;
  return value === "google_drive" ? value : null;
}

function setOAuthStatus(connected) {
  const dot = document.getElementById("sync-oauth-dot");
  const txt = document.getElementById("sync-oauth-text");
  if (!dot || !txt) return;
  dot.classList.remove("idle", "busy", "success", "error");
  dot.classList.add(connected ? "success" : "idle");
  txt.textContent = connected
    ? t("prefs_sync.oauth_connected")
    : t("prefs_sync.oauth_disconnected");
}

async function refreshSyncOAuthStatus() {
  const provider = currentOAuthProvider();
  if (!provider) return;
  const connected = await sync.oauthStatus(provider).catch(() => false);
  setOAuthStatus(connected);
}

async function persistSyncConfig() {
  const config = {
    enabled: document.getElementById("sync-enabled").checked,
    backend: document.getElementById("sync-backend").value,
    local:  { folder: document.getElementById("sync-local-folder").value.trim() },
    webdav: {
      url: document.getElementById("sync-webdav-url").value.trim(),
      username: document.getElementById("sync-webdav-user").value.trim(),
    },
    selective: {
      profiles:  document.getElementById("sync-sel-profiles").checked,
      prefs:     document.getElementById("sync-sel-prefs").checked,
      themes:    document.getElementById("sync-sel-themes").checked,
      shortcuts: document.getElementById("sync-sel-shortcuts").checked,
      notes:     document.getElementById("sync-sel-notes").checked,
      secrets:   document.getElementById("sync-sel-secrets").checked,
      snippets:  true,
    },
    history_keep: Math.max(
      1,
      parseInt(document.getElementById("sync-history-keep").value, 10) || DEFAULT_SYNC_HISTORY_KEEP
    ),
    last_sync_at: syncLastSyncAt(),
  };
  await sync.saveConfig(config);
  _syncConfigCache = config;
  // Passphrase + WebDAV pwd al keyring si el usuario rellenó algo nuevo
  const passVal = document.getElementById("sync-passphrase").value;
  if (passVal) await sync.setStoredPassphrase(passVal);
  const wpVal = document.getElementById("sync-webdav-pass").value;
  if (wpVal) await sync.setStoredWebDavPassword(wpVal);
  updateSidebarSyncStatus();
  return config;
}

async function syncOAuthConnectNow() {
  const provider = currentOAuthProvider();
  if (!provider) return;
  const dot = document.getElementById("sync-oauth-dot");
  const txt = document.getElementById("sync-oauth-text");
  dot?.classList.remove("idle", "success", "error");
  dot?.classList.add("busy");
  if (txt) txt.textContent = t("prefs_sync.oauth_waiting");
  try {
    await persistSyncConfig();
    await sync.oauthConnect(provider);
    setOAuthStatus(true);
    toast(t("prefs_sync.oauth_connected"), "success");
  } catch (err) {
    dot?.classList.remove("busy");
    dot?.classList.add("error");
    if (txt) txt.textContent = t("prefs_sync.status_error");
    if (String(err).includes("Client ID OAuth") || String(err).includes("Client ID de")) {
      toast(t("prefs_sync.oauth_missing_app_credentials"), "warning", 8000);
      return;
    }
    toast(`OAuth: ${err}`, "error", 8000);
  }
}

async function syncOAuthDisconnectNow() {
  const provider = currentOAuthProvider();
  if (!provider) return;
  await sync.oauthDisconnect(provider).catch((err) => toast(`OAuth: ${err}`, "error", 6000));
  setOAuthStatus(false);
}

async function syncRunNow() {
  await runSyncWithCurrentState({ persistConfig: true, announce: true });
}

function shouldAutoSyncProfiles() {
  return !!_syncConfigCache?.enabled
    && _syncConfigCache.backend !== "none"
    && (
      (_syncConfigCache.selective?.profiles ?? true)
      || (_syncConfigCache.selective?.prefs ?? true)
      || (_syncConfigCache.selective?.notes ?? true)
      || (_syncConfigCache.selective?.secrets ?? false)
    );
}

function scheduleProfileAutoSync() {
  if (!shouldAutoSyncProfiles()) return;
  clearTimeout(_syncProfileAutoTimer);
  _syncProfileAutoTimer = setTimeout(() => {
    _syncProfileAutoTimer = null;
    runSyncWithCurrentState({ persistConfig: false, announce: false })
      .catch((err) => console.error("[sync] auto", err));
  }, SYNC_AUTO_DEBOUNCE_MS);
}

async function runSyncWithCurrentState({ persistConfig = false, announce = false } = {}) {
  if (persistConfig && _syncProfileAutoTimer) {
    clearTimeout(_syncProfileAutoTimer);
    _syncProfileAutoTimer = null;
  }
  if (_syncInFlight) {
    _syncPending = true;
    return null;
  }

  _syncInFlight = true;
  setSyncStatus("busy", "prefs_sync.status_busy");
  try {
    if (persistConfig) {
      await persistSyncConfig();
    }
    if (!_syncDeviceIdCache) {
      _syncDeviceIdCache = await sync.getDeviceId().catch(() => "—");
    }
    const summary = await sync.runSync({
      profiles, prefs, deviceId: _syncDeviceIdCache,
    });
    // Capturamos el estado de la sidebar AQUÍ, tras el merge, para preservar la
    // navegación que el usuario haya hecho durante el sync (cambiar de workspace,
    // abrir/cerrar carpetas). Si capturáramos antes de lanzar el sync, al
    // restaurar revertiríamos al workspace/perfil que estaba activo al iniciarlo.
    const sidebarTreeState = captureSidebarTreeState();
    migrateLegacyFolderColors();
    normalizeWorkspaceColors();
    applySyncedUserFolders();
    registerAllCustomThemes();
    // Recargar perfiles del backend (puede haber añadidos/borrados)
    profiles = await invoke("get_profiles");
    ensureWorkspacesForProfiles();
    await refreshNotesIndex();
    restoreSidebarTreeState(sidebarTreeState);
    renderConnectionList();
    // Reaplica tema y prefs si cambiaron
    applyTheme(prefs.theme);
    applyPrefsToAllTerminals();
    const lastSyncAt = new Date().toISOString();
    prefs._lastSyncAt = lastSyncAt;
    if (_syncConfigCache) _syncConfigCache.last_sync_at = lastSyncAt;
    savePrefs();
    document.getElementById("sync-last-time").textContent =
      new Date(lastSyncAt).toLocaleString();
    setSyncStatus("success", "prefs_sync.status_success");
    if (summary.credsChanged) renderCredList().catch(() => {});
    const total = summary.addedProfiles + summary.deletedProfiles
      + summary.themesChanged + summary.shortcutsChanged
      + (summary.secretsChanged || 0)
      + (summary.credsChanged || 0)
      + (summary.prefsChanged ? 1 : 0);
    if (announce) {
      toast(t("prefs_sync.done_sync").replace("{n}", total), "success", { category: "sync" });
    }
    recordActivity({
      kind: "sync",
      status: "ok",
      title: t("prefs_sync.done_sync").replace("{n}", total),
      detail: new Date(lastSyncAt).toLocaleString(),
      actionLabel: "Abrir",
      action: () => {
        prefsActiveTab = "data";
        openSettingsModal();
      },
    });
    refreshSyncSnapshots().catch(() => {});
    return summary;
  } catch (err) {
    setSyncStatus("error", "prefs_sync.status_error");
    recordActivity({
      kind: "sync",
      status: "error",
      title: "Sincronización fallida",
      detail: String(err),
      actionLabel: "Reintentar",
      action: () => runSyncWithCurrentState({ persistConfig: false, announce: true })
        .catch((e) => console.error("[sync] retry from activity", e)),
    });
    if (String(err).includes("no_passphrase")) {
      toast(t("prefs_sync.no_passphrase"), "warning", 6000, { category: "sync" });
    } else if (announce) {
      toast(`Sync: ${err}`, "error", 6000, { category: "sync" });
    }
    throw err;
  } finally {
    _syncInFlight = false;
    if (_syncPending) {
      _syncPending = false;
      scheduleProfileAutoSync();
    }
  }
}

async function syncTestNow() {
  setSyncStatus("busy", "prefs_sync.status_busy");
  try {
    await persistSyncConfig();
    const result = await sync.testBackend();
    setSyncStatus("success", "prefs_sync.status_success");
    toast(`Backend OK (${result})`, "success");
  } catch (err) {
    setSyncStatus("error", "prefs_sync.status_error");
    toast(`Backend: ${err}`, "error", 6000);
  }
}

async function syncBrowseLocalFolder() {
  const path = await openDialog({
    title: "Carpeta local de sincronización",
    directory: true,
    multiple: false,
  }).catch(() => null);
  if (path) document.getElementById("sync-local-folder").value = path;
}

async function openPathInFileManager(path, label = "carpeta") {
  if (!path) {
    toast(`No hay ${label} configurada`, "warning");
    return;
  }
  try {
    await invoke("plugin:opener|open_path", { path });
  } catch (err) {
    toast(`No se pudo abrir la ${label}: ${err}. Ruta: ${path}`, "error", 8000);
  }
}

async function syncOpenLocalFolder() {
  await persistSyncConfig().catch((err) => console.error("[sync] save before open local", err));
  const path = document.getElementById("sync-local-folder")?.value?.trim();
  await openPathInFileManager(path, "carpeta local de sync");
}

// ─── Logs de sesión: retención y mantenimiento ────────────────────────────────

/** Lee un campo de retención del modal; vacío o inválido → null (sin límite). */
function readSessionLogLimit(inputId) {
  const raw = document.getElementById(inputId)?.value?.trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Refresca el texto con el número de logs y su tamaño total. */
async function refreshSessionLogsStats() {
  const el = document.getElementById("session-logs-stats");
  if (!el) return;
  try {
    const info = await invoke("session_logs_list");
    el.textContent = t("prefs_session_logs.stats", {
      count: info.count,
      size: formatSize(info.total_bytes),
    });
  } catch (err) {
    console.error("[session-logs] list", err);
    el.textContent = t("prefs_session_logs.stats_error");
  }
}

/** Limpia los logs de sesión aplicando los límites configurados en el modal. */
async function sessionLogsPruneNow() {
  const maxAge = readSessionLogLimit("pref-session-log-max-age");
  const maxMb = readSessionLogLimit("pref-session-log-max-mb");
  if (maxAge === null && maxMb === null) {
    toast(t("prefs_session_logs.no_limits_set"), "warning");
    return;
  }
  try {
    const res = await invoke("session_logs_prune", {
      maxAgeDays: maxAge,
      maxTotalMb: maxMb,
    });
    toast(
      t("prefs_session_logs.pruned", {
        removed: res.removed,
        size: formatSize(res.freed_bytes),
      }),
      "success",
    );
    await refreshSessionLogsStats();
  } catch (err) {
    toast(t("prefs_session_logs.prune_error", { err: String(err) }), "error", 6000);
  }
}

/** Abre la carpeta de logs de sesión en el explorador del sistema. */
async function sessionLogsOpenFolder() {
  try {
    const path = await invoke("session_logs_dir");
    await openPathInFileManager(path, "carpeta de logs de sesión");
  } catch (err) {
    toast(`No se pudo abrir la carpeta de logs: ${err}`, "error", 6000);
  }
}

async function syncOpenBackendFolder() {
  await persistSyncConfig().catch((err) => console.error("[sync] save before open backend", err));
  const path = await invoke("sync_get_backend_folder").catch((err) => {
    toast(`Sync: ${err}`, "error", 6000, { category: "sync" });
    return null;
  });
  await openPathInFileManager(path, "carpeta de sync");
}

async function syncExportFile() {
  try {
    const includeSecrets = await askExportStoredSecrets(profiles.length);
    if (includeSecrets === null) return;
    const path = await sync.exportToFile({
      profiles,
      prefs,
      deviceId: _syncDeviceIdCache,
      exportedSecrets: includeSecrets ? await collectExportedSecrets(profiles) : null,
    });
    if (path) toast(t("prefs_sync.done_export").replace("{path}", path), "success");
  } catch (err) {
    toast(`Export: ${err}`, "error", 6000);
  }
}

async function syncImportFile() {
  try {
    const summary = await sync.importFromFile({
      profiles, prefs, deviceId: _syncDeviceIdCache,
    });
    if (!summary) return;
    migrateLegacyFolderColors();
    normalizeWorkspaceColors();
    applySyncedUserFolders();
    registerAllCustomThemes();
    profiles = await invoke("get_profiles");
    renderConnectionList();
    applyTheme(prefs.theme);
    applyPrefsToAllTerminals();
    savePrefs();
    if (summary.credsChanged) renderCredList().catch(() => {});
    const total = summary.addedProfiles + summary.deletedProfiles
      + summary.themesChanged + summary.shortcutsChanged
      + (summary.secretsChanged || 0)
      + (summary.credsChanged || 0)
      + (summary.prefsChanged ? 1 : 0);
    toast(t("prefs_sync.done_import").replace("{n}", total), "success");
  } catch (err) {
    toast(`Import: ${err}`, "error", 6000);
  }
}

async function refreshSyncSnapshots() {
  const sel = document.getElementById("sync-snapshots");
  if (!sel) return;
  if (!_syncConfigCache?.enabled || _syncConfigCache.backend === "none") {
    sel.innerHTML = `<option value="">${escHtml(t("prefs_sync.snapshots_none"))}</option>`;
    return;
  }
  sel.innerHTML = `<option value="">${escHtml(t("prefs_sync.snapshots_loading"))}</option>`;
  try {
    const snapshots = await sync.listSnapshots();
    if (!snapshots.length) {
      sel.innerHTML = `<option value="">${escHtml(t("prefs_sync.snapshots_none"))}</option>`;
      return;
    }
    sel.innerHTML = snapshots
      .map((s) => `<option value="${escHtml(s.id)}">${escHtml(s.label)}</option>`)
      .join("");
  } catch (err) {
    sel.innerHTML = `<option value="">${escHtml(t("prefs_sync.snapshots_none"))}</option>`;
    console.error("[sync] snapshots", err);
  }
}

async function syncRestoreSnapshot() {
  const sel = document.getElementById("sync-snapshots");
  const id = sel?.value;
  if (!id) {
    toast(t("prefs_sync.snapshots_none"), "warning");
    return;
  }
  const okRestore = await confirmThemed({
    title: t("prefs_sync.snapshots_restore"),
    message: t("prefs_sync.snapshots_confirm"),
    submitLabel: t("prefs_sync.snapshots_restore"),
    danger: true,
  });
  if (!okRestore) return;
  try {
    setSyncStatus("busy", "prefs_sync.status_busy");
    const summary = await sync.restoreSnapshot(id, {
      profiles, prefs, deviceId: _syncDeviceIdCache,
    });
    migrateLegacyFolderColors();
    normalizeWorkspaceColors();
    applySyncedUserFolders();
    registerAllCustomThemes();
    profiles = await invoke("get_profiles");
    renderConnectionList();
    applyTheme(prefs.theme);
    applyPrefsToAllTerminals();
    savePrefs();
    setSyncStatus("success", "prefs_sync.status_success");
    if (summary?.credsChanged) renderCredList().catch(() => {});
    const total = (summary?.addedProfiles ?? 0) + (summary?.deletedProfiles ?? 0)
      + (summary?.themesChanged ?? 0) + (summary?.shortcutsChanged ?? 0)
      + (summary?.secretsChanged ?? 0)
      + (summary?.credsChanged ?? 0)
      + (summary?.prefsChanged ? 1 : 0);
    toast(`${t("prefs_sync.snapshots_restored")} (${total})`, "success");
  } catch (err) {
    setSyncStatus("error", "prefs_sync.status_error");
    toast(`Restore: ${err}`, "error", 6000);
  }
}

let _cachedSystemFonts = null;
async function populateFontFamilySelect(selected) {
  const sel = document.getElementById("pref-font-family");
  if (!sel) return;
  if (!_cachedSystemFonts) {
    try { _cachedSystemFonts = await invoke("list_monospace_fonts"); }
    catch { _cachedSystemFonts = []; }
  }
  const defaultLabel = t("prefs_terminal.font_family_default");
  let opts = `<option value="">${escHtml(defaultLabel)}</option>`;
  for (const f of _cachedSystemFonts) {
    opts += `<option value="${escHtml(f)}"${f === selected ? " selected" : ""}>${escHtml(f)}</option>`;
  }
  // Si la familia guardada no la detectó fontdb (ej. borrada), la mantenemos como opción "extranjera".
  if (selected && !_cachedSystemFonts.includes(selected)) {
    opts += `<option value="${escHtml(selected)}" selected>${escHtml(selected)} (?)</option>`;
  }
  sel.innerHTML = opts;
}

let _cachedAppVersion = null;
// ─── Autostart ────────────────────────────────────────────────────────────────

/**
 * Rellena los toggles de la pestaña Sistema con el estado actual de las
 * preferencias y sincroniza con el estado real del SO vía `isEnabled()`.
 */
async function populateAutostartToggles() {
  const chkAutostart  = document.getElementById("pref-autostart");
  const chkMinimized  = document.getElementById("pref-autostart-minimized");
  if (!chkAutostart || !chkMinimized) return;

  // Rellenamos primero con lo que hay en prefs (respuesta inmediata)
  chkAutostart.checked  = !!prefs.autostart;
  chkMinimized.checked  = !!prefs.autostartMinimized;

  // Luego sincronizamos con el estado real del SO y corregimos si divergen
  try {
    const realEnabled = await invoke("autostart_is_enabled");
    if (realEnabled !== chkAutostart.checked) {
      chkAutostart.checked = realEnabled;
      prefs.autostart = realEnabled;
    }
  } catch {
    // autostart_is_enabled puede no estar disponible en plataformas no soportadas
  }
}

/**
 * Aplica la preferencia de autostart al SO.
 * Llama al comando Rust `autostart_apply(enable, minimized)` que construye la
 * entrada correcta del SO con o sin `--minimized`.
 */
async function applyAutostartSetting(enable, minimized) {
  try {
    await invoke("autostart_apply", { enable, minimized });
  } catch (e) {
    console.error("[autostart] Error al aplicar:", e);
  }
}

async function populateAboutVersion() {
  const el = document.getElementById("about-version");
  if (!el) return;
  if (_cachedAppVersion) { el.textContent = `v${_cachedAppVersion}`; return; }
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    _cachedAppVersion = await getVersion();
    el.textContent = `v${_cachedAppVersion}`;
  } catch {
    el.textContent = "";
  }
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

function setAboutUpdateStatus(text, type = "") {
  const el = document.getElementById("about-update-status");
  if (!el) return;
  el.classList.remove("success", "warning", "error");
  if (type) el.classList.add(type);
  el.textContent = text;
}

/**
 * El updater de Tauri autoinstala en Windows y macOS (formato único, in-place
 * fiable) y en Linux **solo cuando la app es un AppImage** (único formato que el
 * updater sabe reemplazar). En el resto de formatos de Linux (deb/rpm/Flatpak/
 * Arch) se mantiene el aviso clásico que abre la página de releases, porque la
 * actualización corresponde al gestor de paquetes.
 */
async function platformSupportsUpdater() {
  const ua = navigator.userAgent || "";
  if (/Windows/.test(ua) || /Mac OS X|Macintosh/.test(ua)) return true;
  if (/Linux/.test(ua)) {
    try {
      return await invoke("is_appimage");
    } catch {
      return false;
    }
  }
  return false;
}

async function checkForUpdates({ interactive = true } = {}) {
  if (await platformSupportsUpdater()) {
    const handled = await checkForUpdatesViaUpdater({ interactive });
    if (handled) return;
    // Si el updater no estaba disponible (p. ej. ejecutando fuera del bundle),
    // caemos al aviso clásico por la API de GitHub.
  }
  await checkForUpdatesViaGithub({ interactive });
}

/**
 * Comprueba e instala una actualización con el updater de Tauri.
 * @returns {Promise<boolean>} true si gestionó el flujo (con o sin actualización);
 *   false si el updater no está disponible y conviene usar el fallback.
 */
async function checkForUpdatesViaUpdater({ interactive }) {
  const btn = document.getElementById("btn-about-check-updates");
  if (btn) btn.disabled = true;
  if (interactive) setAboutUpdateStatus(t("prefs_about.checking_updates"));
  try {
    const update = await checkUpdate();
    if (!update) {
      if (interactive) {
        recordActivity({ kind: "update", status: "ok", title: t("prefs_about.update_current") });
        setAboutUpdateStatus(t("prefs_about.update_current"), "success");
      }
      return true;
    }

    const version = `v${normalizeVersion(update.version) || update.version}`;
    recordActivity({
      kind: "update",
      status: "warning",
      title: t("prefs_about.update_available", { version }),
    });
    setAboutUpdateStatus(t("prefs_about.update_available", { version }), "warning");

    const doInstall = await confirmThemed({
      title: t("prefs_about.check_updates"),
      message: t("prefs_about.update_install_prompt", { version }),
      submitLabel: t("modal_credential.accept"),
    });
    if (!doInstall) {
      try { await update.close(); } catch {}
      return true;
    }

    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength || 0;
        setAboutUpdateStatus(t("prefs_about.update_downloading", { pct: 0 }), "warning");
      } else if (event.event === "Progress") {
        received += event.data.chunkLength || 0;
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        setAboutUpdateStatus(t("prefs_about.update_downloading", { pct }), "warning");
      } else if (event.event === "Finished") {
        setAboutUpdateStatus(t("prefs_about.update_installing"), "warning");
      }
    });

    setAboutUpdateStatus(t("prefs_about.update_restarting"), "success");
    await relaunch();
    return true;
  } catch (err) {
    console.warn("[updates] updater failed", err);
    // El updater no está disponible (ejecución fuera del bundle, plugin no
    // inicializado, etc.): deja que el caller use el fallback de GitHub.
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkForUpdatesViaGithub({ interactive = true } = {}) {
  const btn = document.getElementById("btn-about-check-updates");
  if (btn) btn.disabled = true;
  if (interactive) setAboutUpdateStatus(t("prefs_about.checking_updates"));

  try {
    await populateAboutVersion();
    const current = _cachedAppVersion || "0.0.0";
    const res = await fetch(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    const latest = normalizeVersion(release.tag_name || release.name);
    if (!latest) throw new Error("missing release version");

    if (compareVersions(latest, current) > 0) {
      recordActivity({
        kind: "update",
        status: "warning",
        title: t("prefs_about.update_available", { version: `v${latest}` }),
        detail: release.html_url || RELEASES_PAGE_URL,
      });
      setAboutUpdateStatus(
        t("prefs_about.update_available", { version: `v${latest}` }),
        "warning"
      );
      const openRelease = await confirmThemed({
        title: t("prefs_about.check_updates"),
        message: t("prefs_about.open_release", { version: `v${latest}` }),
        submitLabel: t("modal_credential.accept"),
      });
      if (openRelease) {
        invoke("plugin:opener|open_url", { url: release.html_url || RELEASES_PAGE_URL })
          .catch((err) => toast(`No se pudo abrir ${RELEASES_PAGE_URL}: ${err}`, "error", 6000));
      }
    } else {
      if (interactive) {
        recordActivity({
          kind: "update",
          status: "ok",
          title: t("prefs_about.update_current"),
        });
      }
      if (interactive) setAboutUpdateStatus(t("prefs_about.update_current"), "success");
    }
  } catch (err) {
    console.warn("[updates] check failed", err);
    if (interactive) {
      recordActivity({
        kind: "update",
        status: "error",
        title: t("prefs_about.update_error"),
        detail: String(err),
      });
    }
    if (interactive) {
      setAboutUpdateStatus(t("prefs_about.update_error"), "error");
      toast(`${t("prefs_about.update_error")}: ${err}`, "error", 6000);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function activityKindLabel(kind) {
  return {
    connection: "Conexión",
    sftp: "SFTP",
    sync: "Sync",
    update: "Aviso",
    toast: "Sistema",
  }[kind] || "Actividad";
}

function activityTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeActivityItem(item) {
  if (!item || typeof item !== "object" || !item.title) return null;
  const timestamp = new Date(item.timestamp);
  return {
    id: String(item.id || crypto.randomUUID()),
    kind: String(item.kind || "toast").slice(0, 40),
    status: String(item.status || "info").slice(0, 40),
    title: String(item.title).slice(0, 500),
    detail: item.detail ? String(item.detail).slice(0, 2000) : "",
    actionLabel: item.actionLabel ? String(item.actionLabel).slice(0, 80) : "",
    action: typeof item.action === "function" ? item.action : null,
    timestamp: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString(),
  };
}

function serializableActivityItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    detail: item.detail,
    actionLabel: item.actionLabel,
    timestamp: item.timestamp,
  };
}

function loadActivityHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_HISTORY_STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeActivityItem)
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, ACTIVITY_MAX_ITEMS);
  } catch {
    return [];
  }
}

let _persistActivityHistoryTimer = 0;
function persistActivityHistory() {
  // Debounce: ráfagas de eventos (p. ej. las ~7 etapas del handshake SFTP)
  // generaban un JSON.stringify + localStorage.setItem por cada uno,
  // bloqueando el hilo principal lo suficiente como para que KWin marcara
  // la ventana como "no responde". Agrupamos a un único write.
  clearTimeout(_persistActivityHistoryTimer);
  _persistActivityHistoryTimer = setTimeout(_persistActivityHistoryNow, 250);
}

function _persistActivityHistoryNow() {
  _persistActivityHistoryTimer = 0;
  try {
    localStorage.setItem(
      ACTIVITY_HISTORY_STORAGE_KEY,
      JSON.stringify(activityItems.slice(0, ACTIVITY_MAX_ITEMS).map(serializableActivityItem)),
    );
  } catch (err) {
    console.warn("[activity] could not persist history", err);
  }
}

/**
 * Devuelve la lista de entradas del centro de actividad agrupada por día
 * relativo: "Hoy", "Ayer", "Esta semana" (3-7 días) y fechas absolutas
 * para todo lo anterior.
 */
function groupActivityByDay(items) {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = new Map();
  for (const it of items) {
    const ts = it.timestamp ? new Date(it.timestamp).getTime() : Date.now();
    const dayStart = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth(), new Date(ts).getDate()).getTime();
    const diffDays = Math.round((startOfToday - dayStart) / dayMs);
    let key, label;
    if (diffDays <= 0) { key = "today"; label = t("activity.today"); }
    else if (diffDays === 1) { key = "yesterday"; label = t("activity.yesterday"); }
    else if (diffDays < 7) { key = "week"; label = t("activity.this_week"); }
    else {
      key = `d${dayStart}`;
      // Fecha absoluta localizada según el idioma activo.
      label = new Date(dayStart).toLocaleDateString(getLanguage());
    }
    if (!groups.has(key)) groups.set(key, { label, sort: dayStart, items: [] });
    groups.get(key).items.push(it);
  }
  return [...groups.values()].sort((a, b) => b.sort - a.sort);
}

function recordActivity({ kind = "toast", status = "info", title, detail = "", actionLabel = "", action = null } = {}) {
  if (!title) return;
  const item = normalizeActivityItem({
    id: crypto.randomUUID(),
    kind,
    status,
    title: String(title),
    detail: detail ? String(detail) : "",
    actionLabel,
    action,
    timestamp: new Date().toISOString(),
  });
  if (!item) return;
  activityItems.unshift(item);
  if (activityItems.length > ACTIVITY_MAX_ITEMS) activityItems.splice(ACTIVITY_MAX_ITEMS);
  persistActivityHistory();
  renderActivityCenter();
}

function openActivityCenter(filter = null) {
  if (filter) _activityFilter = filter;
  document.getElementById("activity-center-overlay")?.classList.remove("hidden");
  renderActivityCenter();
}

function closeActivityCenter() {
  document.getElementById("activity-center-overlay")?.classList.add("hidden");
}

function renderActivityCenter() {
  const list = document.getElementById("activity-center-list");
  if (!list) return;
  // Si el overlay está oculto el usuario no lo ve, así que evitamos el coste
  // de groupActivityByDay + innerHTML sobre hasta 250 ítems en cada recordActivity.
  // Sin esto, cada handshake SFTP (que dispara ~7 eventos seguidos) bloqueaba
  // el hilo principal lo suficiente para sacar el aviso "no responde".
  const overlay = document.getElementById("activity-center-overlay");
  if (overlay && overlay.classList.contains("hidden")) return;
  document.querySelectorAll(".activity-filter").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.activityFilter === _activityFilter);
  });
  const visible = _activityFilter === "all"
    ? activityItems
    : activityItems.filter((item) => item.kind === _activityFilter);
  if (!visible.length) {
    list.innerHTML = `<div class="activity-empty">${escHtml(t("activity.empty"))}</div>`;
    return;
  }
  // Agrupar por día relativo (Hoy / Ayer / Esta semana / fecha) para que la
  // lista no sea un muro indistinguible cuando hay >100 entradas.
  const groups = groupActivityByDay(visible);
  list.innerHTML = groups.map((g) => `
    <div class="activity-group-header">${escHtml(g.label)}</div>
    ${g.items.map((item) => `
      <div class="activity-item ${escHtml(item.status)}" data-activity-id="${escHtml(item.id)}">
        <span class="activity-dot"></span>
        <div class="activity-body">
          <div class="activity-main">
            <span class="activity-kind">${escHtml(activityKindLabel(item.kind))}</span>
            <span class="activity-title">${escHtml(item.title)}</span>
            <span class="activity-time">${escHtml(activityTime(item.timestamp))}</span>
          </div>
          ${item.detail ? `<div class="activity-detail">${escHtml(item.detail)}</div>` : ""}
        </div>
        ${item.actionLabel && typeof item.action === "function" ? `<button type="button" class="activity-action">${escHtml(item.actionLabel)}</button>` : ""}
      </div>
    `).join("")}
  `).join("");
  list.querySelectorAll(".activity-item").forEach((row) => {
    const item = activityItems.find((entry) => entry.id === row.dataset.activityId);
    const btn = row.querySelector(".activity-action");
    if (btn && typeof item?.action === "function") {
      btn.addEventListener("click", () => item.action());
    }
  });
}

let _terminalThemeSnapshot = undefined;
let _typographySnapshot = null;

function closeSettingsModal() {
  // Si se canceló: revertir el preview del tema de UI, del terminal y de tipografía.
  // `savePrefsFromModal` anula los snapshots antes de cerrar para saltarse este revert.
  if (_terminalThemeSnapshot !== undefined) prefs.terminalTheme = _terminalThemeSnapshot;
  if (_typographySnapshot) {
    prefs.fontFamily    = _typographySnapshot.fontFamily;
    prefs.fontSize      = _typographySnapshot.fontSize;
    prefs.lineHeight    = _typographySnapshot.lineHeight;
    prefs.letterSpacing = _typographySnapshot.letterSpacing;
  }
  _terminalThemeSnapshot = undefined;
  _typographySnapshot = null;
  uiThemePreview = null;
  applyTheme(prefs.theme);
  cancelShortcutCapture();
  document.getElementById("modal-prefs-overlay").classList.add("hidden");
}

function savePrefsFromModal() {
  const previousPrefs = prefs;
  // Tema: leer desde radio (fuente única de verdad) con fallback a prefs actuales
  const selectedTheme =
    document.querySelector('input[name="pref-theme"]:checked')?.value
    ?? document.querySelector('.theme-picker[data-for="ui"] .theme-option.selected')?.dataset.theme
    ?? prefs.theme;

  // Tema del terminal: "inherit" se normaliza a null en persistencia.
  const rawTerminalTheme =
    document.querySelector('input[name="pref-terminal-theme"]:checked')?.value
    ?? document.querySelector('.theme-picker[data-for="terminal"] .theme-option.selected')?.dataset.theme
    ?? "inherit";
  const selectedTerminalTheme = (rawTerminalTheme === "inherit") ? null : rawTerminalTheme;

  // "system" → guardar `lang: null` para que loadPrefs() vuelva a auto-detectar
  // en cada arranque. Cualquier otro valor reconocido se persiste tal cual.
  const rawLang = document.getElementById("pref-language")?.value || "system";
  const newLang = rawLang === "system" ? null : rawLang;

  prefs = {
    theme:           selectedTheme,
    terminalTheme:   selectedTerminalTheme,
    copyOnSelect:    document.getElementById("pref-copy-on-select").checked,
    rightClickPaste: document.getElementById("pref-right-click-paste").checked,
    confirmRiskyPaste: document.getElementById("pref-confirm-risky-paste")?.checked ?? true,
    shareCommandHistory: !!document.getElementById("pref-share-command-history")?.checked,
    captureScreen: document.getElementById("pref-capture-screen")?.checked ?? true,
    sftpConflictPolicy: normalizeSftpConflictPolicy(
      document.getElementById("pref-sftp-conflict-policy")?.value,
    ),
    sftpVerifySize:  document.getElementById("pref-sftp-verify-size")?.checked ?? false,
    sftpMaxConcurrent: (() => {
      const n = parseInt(document.getElementById("pref-sftp-max-concurrent")?.value, 10);
      return Number.isFinite(n) ? Math.min(64, Math.max(1, n)) : 4;
    })(),
    sftpRemoteSide:  document.getElementById("pref-sftp-remote-side")?.value === "right" ? "right" : "left",
    fontFamily:      (document.getElementById("pref-font-family")?.value || "").trim(),
    fontSize:        parseInt(document.getElementById("pref-font-size").value, 10) || DEFAULT_PREFS.fontSize,
    lineHeight:      (() => {
      const v = parseFloat(document.getElementById("pref-line-height").value);
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_PREFS.lineHeight;
    })(),
    letterSpacing:   (() => {
      const v = parseFloat(document.getElementById("pref-letter-spacing").value);
      return Number.isFinite(v) ? v : DEFAULT_PREFS.letterSpacing;
    })(),
    cursorStyle:     document.getElementById("pref-cursor-style").value,
    cursorBlink:     document.getElementById("pref-cursor-blink").checked,
    terminalLigatures: !!document.getElementById("pref-terminal-ligatures")?.checked,
    scrollback:      parseInt(document.getElementById("pref-scrollback").value, 10) || DEFAULT_PREFS.scrollback,
    bell:            document.getElementById("pref-bell").value,
    uiDensity:       (document.getElementById("pref-ui-density")?.value === "compact" ? "compact" : "comfortable"),
    uiZoom:          clampUiZoom(Number(previousPrefs.uiZoom ?? 1)),
    colorBlindSafe:  !!document.getElementById("pref-color-blind-safe")?.checked,
    searchAllWorkspaces: document.getElementById("pref-search-all-workspaces")?.checked ?? true,
    keepassPath:     document.getElementById("pref-keepass-path").value.trim(),
    keepassKeyfile:  document.getElementById("pref-keepass-keyfile").value.trim(),
    lang:            newLang === null ? null : (SUPPORTED_LANGS.includes(newLang) ? newLang : "es"),
    checkUpdatesOnStartup: document.getElementById("pref-check-updates-startup")?.checked ?? true,
    // Retención de logs de sesión: vacío / inválido → null (sin límite).
    sessionLogMaxAgeDays: readSessionLogLimit("pref-session-log-max-age"),
    sessionLogMaxTotalMb: readSessionLogLimit("pref-session-log-max-mb"),
    // Autostart: los toggles del panel Sistema. El estado real del SO se
    // actualiza mediante applyAutostartSetting() al guardar preferencias.
    autostart:          !!document.getElementById("pref-autostart")?.checked,
    autostartMinimized: !!document.getElementById("pref-autostart-minimized")?.checked,
    // Los atajos se editan en vivo (setShortcut/resetShortcut ya guardan), así
    // que aquí solo arrastramos lo que haya en memoria para no sobrescribirlos.
    shortcuts:       previousPrefs.shortcuts || {},
    // Temas importados persistidos aparte; evitar que se borren al guardar prefs.
    customThemes:    previousPrefs.customThemes || [],
    // Metadatos internos que no pertenecen al formulario pero sí deben sobrevivir.
    userFolders:     [], // legacy: vacío — fuente de verdad: userFoldersByWorkspace
    userFoldersByWorkspace: previousPrefs.userFoldersByWorkspace || {},
    favorites:       Array.isArray(previousPrefs.favorites) ? [...previousPrefs.favorites] : [],
    workspaces:      previousPrefs.workspaces || [{ id: "default", name: "Default" }],
    activeWorkspaceId: previousPrefs.activeWorkspaceId || "default",
    sidebarViewMode: previousPrefs.sidebarViewMode || "current",
    folderColors:    previousPrefs.folderColors || {},
    workspaceColors: previousPrefs.workspaceColors || {},
    highlightRules:  readHighlightRulesFromEditor(),
    _highlightRulesSeeded: true,
    templateProfileIds: previousPrefs.templateProfileIds || [],
    tombstones:      previousPrefs.tombstones || {},
    _shortcutsTs:    previousPrefs._shortcutsTs || {},
    _lastSyncAt:     previousPrefs._lastSyncAt || null,
    _prefsUpdatedAt: new Date().toISOString(),
  };

  savePrefs();
  // Aplicar la preferencia de autostart al SO (enable/disable la entrada del SO).
  applyAutostartSetting(prefs.autostart, prefs.autostartMinimized)
    .catch((e) => console.error("[autostart] apply", e));
  // Reaplica la disposición del panel SFTP (remoto izquierda/derecha) a los
  // paneles ya abiertos.
  applySftpRemoteSideToAll();
  // Persistir también la configuración de la pestaña de Sincronización
  // (config del backend + secretos al keyring) si existe el formulario.
  if (document.getElementById("sync-enabled")) {
    persistSyncConfig()
      .then((config) => {
        if (config.enabled && config.backend !== "none") {
          runSyncWithCurrentState({ persistConfig: false, announce: false })
            .catch((e) => console.error("[sync] close preferences", e));
        }
      })
      .catch((e) => console.error("[sync] saveConfig", e));
  }
  // Si lang es null ("Sistema"), aplicamos el idioma detectado del SO sin
  // persistirlo en prefs.lang (sigue siendo null para que cada arranque
  // re-detecte).
  const effectiveLang = prefs.lang || detectLanguage();
  if (effectiveLang !== getLanguage()) {
    setLanguage(effectiveLang);
    applyTranslations();
  }
  // Los snapshots ya no son relevantes: las prefs guardadas son la verdad.
  _terminalThemeSnapshot = undefined;
  _typographySnapshot = null;
  uiThemePreview = null;
  applyTheme(prefs.theme);
  applyUiDensity(prefs.uiDensity);
  applyUiZoom(prefs.uiZoom);
  applyColorBlindSafe(prefs.colorBlindSafe);
  applyPrefsToAllTerminals();
  renderConnectionList();
  closeSettingsModal();
  toast(t("toast.prefs_saved"), "success");
}

// ═══════════════════════════════════════════════════════════════
// KEEPASS
// ═══════════════════════════════════════════════════════════════

let keepassUnlocked = false;
let keepassEntries = [];

async function refreshKeepassStatus() {
  try {
    const st = await invoke("keepass_status");
    keepassUnlocked = !!st.unlocked;
  } catch {
    keepassUnlocked = false;
  }
  const label = document.getElementById("keepass-status-label");
  const btnUnlock = document.getElementById("btn-keepass-unlock");
  const btnLock = document.getElementById("btn-keepass-lock");
  if (!label) {
    updateKeepassEntryValidation();
    return;
  }
  if (keepassUnlocked) {
    label.textContent = "Desbloqueada";
    label.classList.remove("locked");
    label.classList.add("unlocked");
    btnUnlock.classList.add("hidden");
    btnLock.classList.remove("hidden");
    try { keepassEntries = await invoke("keepass_list_entries"); } catch { keepassEntries = []; }
  } else {
    label.textContent = "Bloqueada";
    label.classList.remove("unlocked");
    label.classList.add("locked");
    btnUnlock.classList.remove("hidden");
    btnLock.classList.add("hidden");
    keepassEntries = [];
  }
  updateKeepassEntryValidation();
}

async function browseKeepassPath() {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "KeePass", extensions: ["kdbx"] }],
  });
  if (typeof selected === "string") {
    document.getElementById("pref-keepass-path").value = selected;
  }
}

async function browseKeepassKeyfile() {
  const selected = await openDialog({ multiple: false });
  if (typeof selected === "string") {
    document.getElementById("pref-keepass-keyfile").value = selected;
  }
}

function openKeepassUnlockModal() {
  const path = document.getElementById("pref-keepass-path").value.trim();
  if (!path) { toast("Selecciona primero una base .kdbx", "warning"); return; }
  document.getElementById("kp-modal-path").value = path;
  document.getElementById("kp-modal-password").value = "";
  document.getElementById("kp-modal-error-row").style.display = "none";
  document.getElementById("modal-keepass-overlay").classList.remove("hidden");
  setTimeout(() => document.getElementById("kp-modal-password").focus(), 0);
}

function closeKeepassModal() {
  document.getElementById("modal-keepass-overlay").classList.add("hidden");
  document.getElementById("kp-modal-password").value = "";
}

async function submitKeepassUnlock() {
  const path = document.getElementById("kp-modal-path").value;
  const password = document.getElementById("kp-modal-password").value;
  const keyfile = document.getElementById("pref-keepass-keyfile").value.trim() || null;
  const errRow = document.getElementById("kp-modal-error-row");
  const errEl  = document.getElementById("kp-modal-error");
  try {
    await invoke("keepass_unlock", { path, password, keyfilePath: keyfile });
    closeKeepassModal();
    // Persistir rutas si no estaban
    prefs.keepassPath = path;
    if (keyfile) prefs.keepassKeyfile = keyfile;
    savePrefs();
    await refreshKeepassStatus();
    toast("KeePass desbloqueada", "success");
  } catch (e) {
    errEl.textContent = e?.toString() || "No se pudo desbloquear";
    errRow.style.display = "";
  }
}

async function lockKeepass() {
  try {
    await invoke("keepass_lock");
    await refreshKeepassStatus();
    toast("KeePass bloqueada", "success");
  } catch (e) {
    toast("Error al bloquear: " + e, "error");
  }
}

// ═══════════════════════════════════════════════════════════════
// INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════

async function init() {
  loadPrefs();
  await registerBundledThemePacks();
  enhanceThemePickers();
  // Los temas (incluidos los bundled, que se inyectan de forma diferida) ya
  // están registrados y aplicados: revelamos el chrome y quitamos el anti-flash
  // del arranque. Un rAF asegura que el navegador haya aplicado el CSS del tema
  // antes del fade-in.
  requestAnimationFrame(() => document.documentElement.classList.remove("booting"));

  // Skeleton durante la carga inicial: evita el flash vacío de la sidebar
  // mientras get_profiles termina. Si la carga es instantánea el usuario
  // apenas lo verá; con KeePass o muchos perfiles aporta feedback.
  const _connListBoot = document.getElementById("connection-list");
  if (_connListBoot) {
    _connListBoot.innerHTML = renderSidebarSkeleton();
    _connListBoot.setAttribute("aria-busy", "true");
  }

  try {
    profiles = await invoke("get_profiles");
  } catch {
    profiles = [];
  }

  ensureWorkspacesForProfiles();
  await refreshNotesIndex();
  loadSnapshotIndex();

  if (_connListBoot) _connListBoot.removeAttribute("aria-busy");
  renderConnectionList();
  bindUIEvents();
  await initTrayQuickLauncher().catch((e) => console.debug("[tray] init", e));
  await populateSyncTab().catch((e) => console.error("[sync] populate", e));
  if (_syncConfigCache?.enabled && _syncConfigCache.backend !== "none") {
    runSyncWithCurrentState({ persistConfig: false, announce: false })
      .catch((e) => console.error("[sync] startup", e));
  }
  if (prefs.checkUpdatesOnStartup !== false) {
    checkForUpdates({ interactive: false }).catch((e) => console.error("[updates] startup", e));
  }
  // Consultar estado KeePass al arranque (por si una sesión anterior dejó
  // la DB abierta — no ocurre en MVP, queda como no-op).
  refreshKeepassStatus();

  // Actualizar tema cuando cambia la preferencia del SO (solo relevante en modo "system")
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (prefs.theme === "system") applyTheme("system");
  });

  window.addEventListener("resize", () => {
    if (!activeSessionId) return;
    const s = sessions.get(activeSessionId);
    s?.fitAddon.fit();
    notifyResize(activeSessionId, s?.terminal);
  });
}

// ═══════════════════════════════════════════════════════════════
// ÁRBOL DE CARPETAS – estructura de datos
// ═══════════════════════════════════════════════════════════════

/**
 * Construye un árbol de nodos a partir de los perfiles y carpetas de usuario.
 * Las carpetas son rutas separadas por "/" (ej: "Producción/Web").
 */
function buildFolderTree() {
  const root = { connections: [], folders: {}, path: "" };

  // Primero añadir las carpetas creadas manualmente (pueden estar vacías)
  for (const folderPath of userFolders) {
    ensureFolderPath(root, folderPath);
  }

  // Luego añadir los perfiles del workspace activo en sus carpetas
  for (const p of profiles) {
    if (!profileBelongsToActiveWorkspace(p)) continue;
    if (!p.group) {
      root.connections.push(p);
    } else {
      const node = ensureFolderPath(root, p.group);
      node.connections.push(p);
    }
  }

  sortTreeConnections(root, getActiveWorkspaceId(), "");
  return root;
}

/**
 * Ordena en sitio las `connections` de cada nodo según `prefs.connectionSortMode`.
 * - "alpha": comparación case-insensitive por nombre, con desempate por host.
 * - "manual": respeta `prefs.connectionOrder[key]` (key = `wsId|folderPath`).
 *   Las conexiones no listadas se añaden al final por orden alfabético.
 */
function sortTreeConnections(node, wsId, folderPath) {
  const mode = prefs.connectionSortMode === "manual" ? "manual" : "alpha";
  if (node.connections?.length) {
    const alphaSort = (a, b) => {
      const an = (a?.name || "").toLowerCase();
      const bn = (b?.name || "").toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      const ah = (a?.host || "").toLowerCase();
      const bh = (b?.host || "").toLowerCase();
      return ah < bh ? -1 : ah > bh ? 1 : 0;
    };
    if (mode === "alpha") {
      node.connections.sort(alphaSort);
    } else {
      const key = connectionOrderKey(wsId, folderPath);
      const orderArr = Array.isArray(prefs.connectionOrder?.[key])
        ? prefs.connectionOrder[key]
        : [];
      const rank = new Map(orderArr.map((id, idx) => [id, idx]));
      const known = [];
      const unknown = [];
      for (const p of node.connections) {
        if (rank.has(p.id)) known.push(p);
        else unknown.push(p);
      }
      known.sort((a, b) => rank.get(a.id) - rank.get(b.id));
      unknown.sort(alphaSort);
      node.connections = [...known, ...unknown];
    }
  }
  if (node.folders) {
    for (const [name, child] of Object.entries(node.folders)) {
      const childPath = folderPath ? `${folderPath}/${name}` : name;
      sortTreeConnections(child, wsId, childPath);
    }
  }
}

function connectionOrderKey(wsId, folderPath) {
  return `${wsId || "default"}|${folderPath || ""}`;
}

/**
 * Mueve un perfil arriba o abajo dentro de su contenedor (mismo workspace y
 * carpeta). Cambia automáticamente a modo manual la primera vez que se invoca.
 * @param {string} profileId
 * @param {-1 | 1} delta
 */
function moveConnectionInOrder(profileId, delta) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const wsId = profileWorkspaceId(profile);
  const folder = profile.group || "";
  const peers = profiles
    .filter((p) => profileWorkspaceId(p) === wsId && (p.group || "") === folder);
  if (peers.length < 2) return;

  // Activar modo manual al primer reorder explícito.
  if (prefs.connectionSortMode !== "manual") {
    prefs.connectionSortMode = "manual";
  }
  prefs.connectionOrder = prefs.connectionOrder || {};
  const key = connectionOrderKey(wsId, folder);

  // Lista ordenada actual según el modo previo (alpha o manual). La usamos
  // como base para mover el ítem y luego persistir el nuevo orden completo.
  const current = [...peers];
  sortTreeConnections({ connections: current, folders: {} }, wsId, folder);

  const idx = current.findIndex((p) => p.id === profileId);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= current.length) return;
  [current[idx], current[target]] = [current[target], current[idx]];
  prefs.connectionOrder[key] = current.map((p) => p.id);
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();
}

function folderOrderKey(wsId, parentPath) {
  return `${wsId || "default"}|${parentPath || ""}`;
}

/**
 * Ordena una lista de nombres de carpeta hermanas según el modo activo:
 * "alpha" (alfabético) o "manual" (`prefs.folderOrder[wsId|parentPath]`, con
 * las no listadas al final por orden alfabético).
 */
function orderFolderNames(names, workspaceId, parentPath) {
  const alpha = [...names].sort((a, b) => {
    const an = a.toLowerCase(), bn = b.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  if (prefs.connectionSortMode !== "manual") return alpha;
  const orderArr = Array.isArray(prefs.folderOrder?.[folderOrderKey(workspaceId, parentPath)])
    ? prefs.folderOrder[folderOrderKey(workspaceId, parentPath)]
    : [];
  const rank = new Map(orderArr.map((n, i) => [n, i]));
  const known = alpha.filter((n) => rank.has(n)).sort((a, b) => rank.get(a) - rank.get(b));
  const unknown = alpha.filter((n) => !rank.has(n));
  return [...known, ...unknown];
}

/** Entradas `[nombre, nodo]` de las carpetas hijas de `node`, ya ordenadas. */
function sortedFolderEntries(node, workspaceId) {
  const entries = Object.entries(node.folders || {});
  if (entries.length < 2) return entries;
  const order = orderFolderNames(entries.map((e) => e[0]), workspaceId, node.path || "");
  const byName = new Map(entries);
  return order.map((name) => [name, byName.get(name)]);
}

/** Nombres de las carpetas hijas inmediatas de `parentPath` en un workspace. */
function siblingFolderNames(workspaceId, parentPath) {
  const prefix = parentPath ? `${parentPath}/` : "";
  const names = new Set();
  for (const p of getAllFolderPaths(workspaceId)) {
    if (parentPath && !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest || rest.includes("/")) continue; // vacío o no es hijo inmediato
    names.add(rest);
  }
  return [...names];
}

/**
 * Mueve una carpeta arriba o abajo entre sus hermanas (mismo padre y
 * workspace). Cambia a modo manual la primera vez que se invoca.
 * @param {string} workspaceId
 * @param {string} folderPath  ruta completa de la carpeta a mover
 * @param {-1 | 1} delta
 */
function moveFolderInOrder(workspaceId, folderPath, delta) {
  if (!folderPath) return;
  const parts = folderPath.split("/").filter(Boolean);
  const name = parts.pop();
  const parentPath = parts.join("/");
  const siblings = siblingFolderNames(workspaceId, parentPath);
  if (siblings.length < 2) return;

  if (prefs.connectionSortMode !== "manual") {
    prefs.connectionSortMode = "manual";
  }
  prefs.folderOrder = prefs.folderOrder || {};
  const key = folderOrderKey(workspaceId, parentPath);

  const current = orderFolderNames(siblings, workspaceId, parentPath);
  const idx = current.indexOf(name);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= current.length) return;
  [current[idx], current[target]] = [current[target], current[idx]];
  prefs.folderOrder[key] = current;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();
}

/**
 * Crea (si no existe) toda la cadena de nodos para una ruta y devuelve el nodo hoja.
 */
function ensureFolderPath(root, folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  let node = root;
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (!node.folders[part]) {
      node.folders[part] = { connections: [], folders: {}, path: currentPath };
    }
    node = node.folders[part];
  }
  return node;
}

function countConnections(node) {
  let n = node.connections.length;
  for (const child of Object.values(node.folders)) n += countConnections(child);
  return n;
}

/** Devuelve todos los paths de carpeta existentes (de perfiles + userFolders) */
function getAllFolderPaths(workspaceId = getActiveWorkspaceId()) {
  const paths = new Set(getWorkspaceFolders(workspaceId));
  for (const p of profiles) {
    if (profileWorkspaceId(p) !== workspaceId) continue;
    if (!p.group) continue;
    const parts = p.group.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      paths.add(cur);
    }
  }
  return [...paths].sort();
}

function normalizedUserFolders() {
  return [...new Set(
    [...userFolders]
      .filter((f) => typeof f === "string")
      .map((f) => f.trim())
      .filter(Boolean)
  )].sort();
}

function saveUserFolders({ touchPrefs = true } = {}) {
  const folders = normalizedUserFolders();
  userFolders = new Set(folders);
  const wsId = getActiveWorkspaceId();
  prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
  prefs.userFoldersByWorkspace[wsId] = folders;
  prefs.userFolders = []; // legacy vacío
  if (touchPrefs) prefs._prefsUpdatedAt = new Date().toISOString();
  localStorage.setItem("rustty-folders", JSON.stringify(folders));
  savePrefs();
}

function applySyncedUserFolders() {
  // Tras la migración, las carpetas viven en userFoldersByWorkspace; este
  // helper sigue existiendo para compatibilidad con flujos de sync que
  // entreguen el campo legacy `userFolders`.
  if (Array.isArray(prefs.userFolders) && prefs.userFolders.length > 0) {
    const wsId = getActiveWorkspaceId();
    prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
    const merged = new Set([
      ...(prefs.userFoldersByWorkspace[wsId] || []),
      ...prefs.userFolders
        .filter((f) => typeof f === "string")
        .map((f) => f.trim())
        .filter(Boolean),
    ]);
    prefs.userFoldersByWorkspace[wsId] = [...merged].sort();
    prefs.userFolders = [];
  }
  const wsId = getActiveWorkspaceId();
  const next = [...(prefs.userFoldersByWorkspace?.[wsId] || [])].sort();
  const current = normalizedUserFolders();
  if (JSON.stringify(current) === JSON.stringify(next)) {
    localStorage.setItem("rustty-folders", JSON.stringify(next));
    return false;
  }
  userFolders = new Set(next);
  saveUserFolders({ touchPrefs: false });
  return true;
}

// ═══════════════════════════════════════════════════════════════
// RENDERIZADO DEL ÁRBOL
// ═══════════════════════════════════════════════════════════════

let _sidebarSearchQuery = "";

/**
 * Devuelve HTML de placeholders shimmer para la sidebar durante la carga
 * inicial (clase utilitaria .skeleton definida en styles.css).
 */
function renderSidebarSkeleton(rows = 6) {
  const items = [];
  for (let i = 0; i < rows; i += 1) {
    const widthClass = i % 3 === 0 ? "is-medium" : "";
    items.push(
      `<div class="skeleton--row" aria-hidden="true">
         <span class="skeleton skeleton--avatar" style="width:14px;height:14px;border-radius:3px"></span>
         <span class="skeleton skeleton--text ${widthClass}"></span>
       </div>`,
    );
  }
  return `<div class="sidebar-skeleton" role="status" aria-label="${escHtml(t("sidebar.loading"))}">${items.join("")}</div>`;
}

function renderConnectionList() {
  const container = document.getElementById("connection-list");
  container?.classList.toggle("compact", Boolean(prefs.sidebarCompact));
  persistSidebarOpenFolders();
  scheduleTrayQuickLauncherUpdate();
  renderWorkspaceSwitcher();

  const sidebarQuery = _sidebarSearchQuery.trim();
  if (sidebarQuery) {
    const matches = sidebarSearchCandidates(sidebarQuery);
    container.innerHTML = matches.length
      ? matches.map((profile) => renderConnectionItem(profile, 0)).join("")
      : `<div class="empty-state sidebar-empty-search">${escHtml(t("sidebar.search_no_results"))}</div>`;
    bindTreeEvents(container);
    renderDashboard();
    return;
  }

  if (prefs.sidebarViewMode === "all") {
    container.innerHTML = renderAllWorkspacesTree();
    bindTreeEvents(container);
    renderDashboard();
    return;
  }

  if (prefs.sidebarViewMode === "favorites") {
    container.innerHTML = renderFavoritesTree();
    bindTreeEvents(container);
    renderDashboard();
    return;
  }

  const activeProfiles = profiles.filter(profileBelongsToActiveWorkspace);
  if (activeProfiles.length === 0 && userFolders.size === 0) {
    container.innerHTML = `
      <div class="empty-state empty-state--rich">
        <div class="empty-state__icon" aria-hidden="true">⊕</div>
        <div class="empty-state__title">${escHtml(t("sidebar.empty_title"))}</div>
        <p class="empty-state__hint">${escHtml(t("sidebar.empty_hint"))}</p>
        <div class="empty-state__actions">
          <button class="btn-link" id="btn-first-connection">${escHtml(t("sidebar.empty_cta"))}</button>
        </div>
      </div>`;
    container.querySelector("#btn-first-connection")
      ?.addEventListener("click", () => openNewConnectionModal());
    renderDashboard();
    return;
  }

  const tree = buildFolderTree();
  container.innerHTML = renderTreeNode(tree, 0);
  bindTreeEvents(container);
  renderDashboard();
}

function activeProfileId() {
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  return s?.profileId || null;
}

function openFolderPath(path) {
  if (!path) return false;
  let changed = false;
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const partial = parts.slice(0, i).join("/");
    if (!openFolders.has(partial)) {
      openFolders.add(partial);
      changed = true;
    }
  }
  return changed;
}

function markSidebarProfile(profileId, { scroll = false } = {}) {
  const container = document.getElementById("connection-list");
  if (!container) return;
  updateSidebarSelectionDom(container);
  if (!profileId) return;

  const item = container.querySelector(`.conn-item[data-id="${CSS.escape(profileId)}"]`);
  if (!item) return;
  if (scroll) {
    item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function syncSidebarToActiveSession({ scroll = false } = {}) {
  const profileId = activeProfileId();
  if (!profileId) {
    markSidebarProfile(null);
    return;
  }

  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    markSidebarProfile(null);
    return;
  }

  const workspaceId = profile.workspace_id || "default";
  let needsRender = false;

  if (prefs.sidebarViewMode === "favorites") {
    prefs.sidebarViewMode = "current";
    needsRender = true;
  }

  if (prefs.sidebarViewMode === "current" && getActiveWorkspaceId() !== workspaceId) {
    prefs.activeWorkspaceId = workspaceId;
    userFolders = new Set(getWorkspaceFolders(workspaceId));
    needsRender = true;
  }

  if (prefs.sidebarViewMode === "all" && !openFolders.has(`__ws__/${workspaceId}`)) {
    openFolders.add(`__ws__/${workspaceId}`);
    needsRender = true;
  }

  if (openFolderPath(profile.group || "")) {
    needsRender = true;
  }

  if (needsRender) {
    savePrefs();
    renderConnectionList();
  } else {
    markSidebarProfile(profileId);
  }

  if (scroll) {
    requestAnimationFrame(() => markSidebarProfile(profileId, { scroll: true }));
  }
}

function captureSidebarTreeState() {
  const container = document.getElementById("connection-list");
  const openVisibleFolders = [];
  container?.querySelectorAll(".folder-item").forEach((item) => {
    const path = item.dataset.folderPath;
    if (!path || !openFolders.has(path)) return;
    openVisibleFolders.push({
      path,
      workspaceId: workspaceForElement(item),
    });
  });
  return {
    activeWorkspaceId: getActiveWorkspaceId(),
    sidebarViewMode: prefs.sidebarViewMode,
    openFolders: [...openFolders],
    openVisibleFolders,
  };
}

function restoreSidebarTreeState(state) {
  if (!state) return;
  const workspaces = Array.isArray(prefs.workspaces) ? prefs.workspaces : [];
  if (workspaces.some((w) => w.id === state.activeWorkspaceId)) {
    prefs.activeWorkspaceId = state.activeWorkspaceId;
  }
  if (["current", "all", "favorites"].includes(state.sidebarViewMode)) {
    prefs.sidebarViewMode = state.sidebarViewMode;
  }
  userFolders = new Set(getWorkspaceFolders(getActiveWorkspaceId()));

  openFolders.clear();
  for (const path of state.openFolders || []) {
    if (path) openFolders.add(path);
  }
  for (const item of state.openVisibleFolders || []) {
    if (item?.path) openFolders.add(item.path);
    if (item?.workspaceId) openFolders.add(`__ws__/${item.workspaceId}`);
  }
}

function renderAllWorkspacesTree() {
  if (!prefs.workspaces.length) return `<div class="empty-state"><p>—</p></div>`;
  return prefs.workspaces.map((w) => {
    const wsProfiles = profiles.filter((p) => (p.workspace_id || "default") === w.id);
    const wsFolders = getWorkspaceFolders(w.id);
    const root = { connections: [], folders: {} };
    for (const fp of wsFolders) ensureFolderPath(root, fp);
    for (const p of wsProfiles) {
      if (!p.group) root.connections.push(p);
      else ensureFolderPath(root, p.group).connections.push(p);
    }
    const inner = renderTreeNode(root, 1, w.id);
    const open = openFolders.has(`__ws__/${w.id}`) ? "open" : "";
    const childrenHidden = open ? "" : "hidden";
    const count = wsProfiles.length;
    return `<div class="folder-item ws-folder-item" data-ws-root="${escHtml(w.id)}"${workspaceTintAttrs(w.id)}>
      <div class="folder-header" data-folder-path="__ws__/${escHtml(w.id)}">
        <span class="folder-arrow ${open}">▶</span>
        <span class="folder-icon">${folderIconSvg()}</span>
        <span class="folder-name">${escHtml(w.name)}</span>
        <span class="folder-count">${count}</span>
      </div>
      <div class="folder-children ${childrenHidden}">
        ${inner}
      </div>
    </div>`;
  }).join("");
}

function renderFavoritesTree() {
  const favs = profiles.filter((p) => isFavoriteProfile(p.id));
  if (favs.length === 0) {
    return `
      <div class="empty-state empty-state--rich">
        <div class="empty-state__icon" aria-hidden="true">★</div>
        <div class="empty-state__title">${escHtml(t("sidebar.favorites_empty"))}</div>
        <p class="empty-state__hint">${escHtml(t("sidebar.favorites_empty_hint"))}</p>
      </div>`;
  }
  favs.sort((a, b) => a.name.localeCompare(b.name));
  return favs.map((p) => renderConnectionItem(p, 0)).join("");
}

function renderWorkspaceSwitcher() {
  const ctxLabel = document.getElementById("sidebar-context-label");
  const ctxIcon  = document.querySelector("#sidebar-context-bar .app-folder-icon");
  const menu     = document.getElementById("workspace-menu");
  const activeWorkspace = prefs.workspaces.find((w) => w.id === getActiveWorkspaceId());
  if (ctxLabel) {
    if (prefs.sidebarViewMode === "all") {
      ctxLabel.textContent = t("sidebar.view_all");
    } else if (prefs.sidebarViewMode === "favorites") {
      ctxLabel.textContent = t("sidebar.view_favorites");
    } else {
      ctxLabel.textContent = activeWorkspace ? activeWorkspace.name : "Default";
    }
  }
  if (ctxIcon) {
    const color = prefs.sidebarViewMode === "current"
      ? getWorkspaceColor(activeWorkspace?.id)?.color
      : null;
    ctxIcon.style.color = color || "";
  }

  // Marcar el modo de vista activo
  document.querySelectorAll("[data-view-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.viewMode === prefs.sidebarViewMode);
  });
  const sortMode = prefs.connectionSortMode === "manual" ? "manual" : "alpha";
  document.querySelectorAll("[data-sort-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sortMode === sortMode);
  });
  const compactBtn = document.getElementById("btn-sidebar-compact");
  if (compactBtn) {
    compactBtn.classList.toggle("active", Boolean(prefs.sidebarCompact));
    compactBtn.setAttribute("aria-pressed", prefs.sidebarCompact ? "true" : "false");
  }
  const foldersFirstBtn = document.getElementById("btn-sidebar-folders-first");
  if (foldersFirstBtn) {
    const on = prefs.foldersFirst !== false;
    foldersFirstBtn.classList.toggle("active", on);
    foldersFirstBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  if (!menu) return;
  const items = prefs.workspaces.map((w) => {
    const isActive = w.id === getActiveWorkspaceId() && prefs.sidebarViewMode === "current";
    const color = getWorkspaceColor(w.id)?.color || "var(--overlay1)";
    return `<button class="ws-item${isActive ? " active" : ""}" data-ws-action="select" data-ws-id="${escHtml(w.id)}">
      <span class="ws-color-dot" style="--workspace-tint:${color}">${isActive ? "●" : "○"}</span>
      <span>${escHtml(w.name)}</span>
    </button>`;
  }).join("");
  const canDelete = prefs.workspaces.length > 1;
  menu.innerHTML = `${items}
    <div class="ws-sep"></div>
    <button class="ws-item" data-ws-action="new"><span>＋ ${escHtml(t("sidebar.workspace_new"))}</span></button>
    <button class="ws-item" data-ws-action="rename"><span>✎ ${escHtml(t("sidebar.workspace_rename"))}</span></button>
    <button class="ws-item danger" data-ws-action="delete" ${canDelete ? "" : "disabled"}><span>✕ ${escHtml(t("sidebar.workspace_delete"))}</span></button>`;
}

/**
 * Abre/cierra el popover de herramientas de la sidebar.
 * @param {boolean | undefined} open – fuerza estado abierto/cerrado.
 * @param {{ mode?: "full" | "search", anchor?: string }} [opts] – `mode: "search"`
 *   oculta workspace/vista y solo deja el buscador; `anchor` indica el id del
 *   botón al que se alinea (default `btn-sidebar-tools`).
 */
function toggleSidebarTools(open, opts = {}) {
  const popover = document.getElementById("sidebar-tools-popover");
  if (!popover) return;
  const wasSearchOnly = popover.classList.contains("search-only");
  if (open === undefined) popover.classList.toggle("hidden");
  else popover.classList.toggle("hidden", !open);
  if (!popover.classList.contains("hidden")) {
    popover.classList.toggle("search-only", opts.mode === "search");
    if (opts.mode !== "search") renderWorkspaceSwitcher();
    positionSidebarToolsPopover(opts.anchor);
  } else if (wasSearchOnly) {
    // Al cerrar el popover de búsqueda, descartar el filtro para no dejarlo
    // "enganchado" sobre la lista de conexiones cuando ya no es visible.
    const sidebarSearch = document.getElementById("sidebar-search");
    if (sidebarSearch && sidebarSearch.value) {
      sidebarSearch.value = "";
    }
    if (_sidebarSearchQuery) {
      _sidebarSearchQuery = "";
      renderConnectionList();
    }
  }
}

function positionSidebarToolsPopover(anchorId = "btn-sidebar-tools") {
  const trigger = document.getElementById(anchorId);
  const popover = document.getElementById("sidebar-tools-popover");
  if (!trigger || !popover) return;

  // Medir el popover (ya visible) y la posición del botón en viewport
  const triggerRect = trigger.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 6;

  // Por defecto: justo debajo del botón, alineado a su borde izquierdo
  let top = triggerRect.bottom + margin;
  let left = triggerRect.left;

  // Flip horizontal si se sale por la derecha del viewport
  if (left + popRect.width > window.innerWidth - margin) {
    left = Math.max(margin, triggerRect.right - popRect.width);
  }
  // Flip vertical si se sale por debajo del viewport
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, triggerRect.top - popRect.height - margin);
  }

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}
// Compatibilidad con llamadas previas
function toggleWorkspaceMenu(open) { toggleSidebarTools(open); }

function setSidebarViewMode(mode) {
  if (!["current", "all", "favorites"].includes(mode)) mode = "current";
  prefs.sidebarViewMode = mode;
  savePrefs();
  renderConnectionList();
  updateRailActiveState();
}

function setSidebarCompact(enabled) {
  prefs.sidebarCompact = Boolean(enabled);
  savePrefs();
  renderConnectionList();
}

function setFoldersFirst(enabled) {
  prefs.foldersFirst = Boolean(enabled);
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();
}

function setConnectionSortMode(mode) {
  if (mode !== "manual") mode = "alpha";
  if (prefs.connectionSortMode === mode) return;
  prefs.connectionSortMode = mode;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();
}

function switchToWorkspace(wsId) {
  if (!prefs.workspaces.some((w) => w.id === wsId)) return;
  prefs.activeWorkspaceId = wsId;
  prefs.sidebarViewMode = "current";
  userFolders = new Set(getWorkspaceFolders(wsId));
  savePrefs();
  renderConnectionList();
  updateRailActiveState();
  selectHomeTab();
}

function updateRailActiveState() {
  document.querySelectorAll("#rail [data-rail-view]").forEach((btn) => {
    const view = btn.dataset.railView;
    let active = false;
    if (view === "favorites") active = prefs.sidebarViewMode === "favorites";
    else if (view === "profiles") active = prefs.sidebarViewMode !== "favorites";
    btn.classList.toggle("active", active);
  });
}

async function handleWorkspaceMenuClick(action, wsId) {
  if (action === "select" && wsId) {
    if (wsId !== getActiveWorkspaceId()) {
      prefs.activeWorkspaceId = wsId;
      userFolders = new Set(getWorkspaceFolders(wsId));
      prefs.sidebarViewMode = "current";
      savePrefs();
      renderConnectionList();
    }
    toggleWorkspaceMenu(false);
    return;
  }
  if (action === "new") {
    toggleWorkspaceMenu(false);
    const name = await promptTextValue({
      title: t("sidebar.workspace_new"),
      label: t("sidebar.workspace_prompt_new"),
    });
    if (name) {
      const id = `ws-${crypto.randomUUID()}`;
      prefs.workspaces.push({ id, name });
      prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
      prefs.userFoldersByWorkspace[id] = [];
      prefs.activeWorkspaceId = id;
      userFolders = new Set();
      prefs.sidebarViewMode = "current";
      savePrefs();
      renderConnectionList();
    }
    return;
  }
  if (action === "rename") {
    const cur = prefs.workspaces.find((w) => w.id === getActiveWorkspaceId());
    if (!cur) return;
    toggleWorkspaceMenu(false);
    const name = await promptTextValue({
      title: t("sidebar.workspace_rename"),
      label: t("sidebar.workspace_prompt_rename"),
      initialValue: cur.name,
    });
    if (name) {
      cur.name = name;
      savePrefs();
      renderConnectionList();
    }
    return;
  }
  if (action === "delete") {
    if (prefs.workspaces.length <= 1) return;
    const cur = prefs.workspaces.find((w) => w.id === getActiveWorkspaceId());
    if (!cur) return;
    const inUse = profiles.some((p) => (p.workspace_id || "default") === cur.id);
    const msg = inUse
      ? t("sidebar.workspace_confirm_delete_full")
      : t("sidebar.workspace_confirm_delete");
    if (!confirm(msg)) return;
    const finalize = () => {
      prefs.workspaces = prefs.workspaces.filter((w) => w.id !== cur.id);
      if (prefs.userFoldersByWorkspace) delete prefs.userFoldersByWorkspace[cur.id];
      deleteWorkspaceColors(cur.id);
      prefs.activeWorkspaceId = prefs.workspaces[0].id;
      userFolders = new Set(getWorkspaceFolders(prefs.activeWorkspaceId));
      prefs._prefsUpdatedAt = new Date().toISOString();
      savePrefs();
      renderConnectionList();
      scheduleProfileAutoSync();
    };
    if (inUse) {
      const toDelete = profiles.filter((p) => (p.workspace_id || "default") === cur.id);
      Promise.all(toDelete.map((p) => invoke("delete_profile", { id: p.id }).catch(() => null)))
        .then(async () => {
          try { profiles = await invoke("get_profiles"); } catch {}
          finalize();
        });
    } else {
      finalize();
    }
    toggleWorkspaceMenu(false);
    return;
  }
}

function profileMatchesSidebarQuery(profile, query) {
  // Incluye los metadatos de la nota (título, tags y extracto) para que buscar
  // por contenido de runbook encuentre la conexión asociada.
  const note = notesIndex.get(profile.id);
  const haystack = [
    profile.name,
    profile.host,
    profile.username,
    profile.group,
    profile.connection_type || "ssh",
    note?.title,
    (note?.tags || []).join(" "),
    note?.excerpt,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function loadRecentConnections() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_CONNECTIONS_STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => typeof item === "string"
        ? { id: item, lastConnectedAt: null }
        : { id: item?.id, lastConnectedAt: item?.lastConnectedAt || null })
      .filter((item) => item.id);
  } catch {
    return [];
  }
}

function saveRecentConnections(items) {
  localStorage.setItem(RECENT_CONNECTIONS_STORAGE_KEY, JSON.stringify(items.slice(0, 12)));
  scheduleTrayQuickLauncherUpdate();
}

function recordRecentConnection(profileId) {
  const items = loadRecentConnections().filter((item) => item.id !== profileId);
  items.unshift({ id: profileId, lastConnectedAt: new Date().toISOString() });
  saveRecentConnections(items);
  renderDashboard();
}

function getRecentProfiles() {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return loadRecentConnections()
    .map((item) => ({ profile: byId.get(item.id), lastConnectedAt: item.lastConnectedAt }))
    .filter((item) => item.profile);
}

/**
 * Variante del historial filtrada según la vista activa de la sidebar.
 *   - "current"   → solo perfiles del workspace activo.
 *   - "all"       → historial global (sin filtro de workspace).
 *   - "favorites" → solo perfiles favoritos (transversal entre workspaces).
 * El quick launcher del tray usa `getRecentProfiles()` (global) para que
 * desde la bandeja se pueda conectar a cualquier perfil reciente.
 */
function getRecentProfilesForActiveView() {
  const mode = prefs.sidebarViewMode || "current";
  const activeWs = getActiveWorkspaceId();
  return getRecentProfiles().filter(({ profile }) => {
    if (mode === "favorites") return isFavoriteProfile(profile.id);
    if (mode === "all") return true;
    return profileWorkspaceId(profile) === activeWs;
  });
}

function trayProfileLabel(profile) {
  const user = profile.username ? `${profile.username}@` : "";
  const host = profile.host ? `${user}${profile.host}` : "";
  return host ? `${profile.name} · ${host}` : profile.name;
}

function buildTrayQuickLauncherPayload() {
  const favoriteIds = new Set(Array.isArray(prefs.favorites) ? prefs.favorites : []);
  const favorites = profiles
    .filter((profile) => favoriteIds.has(profile.id))
    .slice(0, 8)
    .map((profile) => ({ id: profile.id, label: trayProfileLabel(profile) }));
  const recent = getRecentProfiles()
    .slice(0, 8)
    .map(({ profile }) => ({ id: profile.id, label: trayProfileLabel(profile) }));
  const workspaces = (Array.isArray(prefs.workspaces) ? prefs.workspaces : [])
    .slice(0, 12)
    .map((workspace) => ({ id: workspace.id, label: workspace.name || "Default" }));
  const wake = profiles
    .filter((profile) => (profile.mac_address || "").trim())
    .slice(0, 8)
    .map((profile) => ({ id: profile.id, label: trayProfileLabel(profile) }));
  return { favorites, recent, workspaces, wake };
}

function scheduleTrayQuickLauncherUpdate() {
  clearTimeout(_trayQuickLauncherTimer);
  _trayQuickLauncherTimer = setTimeout(() => {
    _trayQuickLauncherTimer = null;
    updateTrayQuickLauncher().catch((err) => console.debug("[tray] update", err));
  }, 150);
}

async function updateTrayQuickLauncher() {
  await invoke("tray_update_quick_launcher", {
    payload: buildTrayQuickLauncherPayload(),
  });
}

async function initTrayQuickLauncher() {
  await listen(EVENT.trayAction, (/** @type {{ payload: TrayAction }} */ event) => {
    const payload = event.payload || {};
    if (payload.action === "local-shell") {
      openLocalShell();
    } else if (payload.action === "new-connection") {
      openNewConnectionModal();
    } else if (payload.action === "connect-profile" && payload.profileId) {
      connectProfile(payload.profileId, { force: true });
    } else if (payload.action === "switch-workspace" && payload.workspaceId) {
      switchToWorkspace(payload.workspaceId);
    } else if (payload.action === "wake-profile" && payload.profileId) {
      wakeProfile(payload.profileId);
    }
  });
  scheduleTrayQuickLauncherUpdate();
}

function profileMatchesDashboardQuery(profile, query) {
  if (!query) return true;
  const haystack = [
    profile.name,
    profile.host,
    profile.username,
    profile.group,
    profile.connection_type || "ssh",
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function dashboardProfileHost(profile) {
  const user = profile.username ? `${profile.username}@` : "";
  const port = profile.port ? `:${profile.port}` : "";
  return `${user}${profile.host}${port}`;
}

function formatDashboardTime(value) {
  if (!value) return "Sin actividad";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin actividad";
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Ahora";
  if (diff < hour) return `Hace ${Math.max(1, Math.floor(diff / minute))} min`;
  if (diff < day) return `Hace ${Math.floor(diff / hour)} h`;
  if (diff < 7 * day) return `Hace ${Math.floor(diff / day)} d`;
  return date.toLocaleDateString();
}

function dashboardProtocol(profile) {
  return (profile.connection_type || "ssh").toUpperCase();
}

function getDashboardCandidates(query = "") {
  const recent = getRecentProfiles().filter(
    (item) => query
      ? connectionSearchIncludesProfile(item.profile)
      : profileBelongsToActiveWorkspace(item.profile)
  );
  const recentIds = new Set(recent.map((item) => item.profile.id));
  const scoped = query
    ? profiles.filter(connectionSearchIncludesProfile)
    : profiles.filter(profileBelongsToActiveWorkspace);
  if (query) {
    return scoped
      .filter((profile) => profileMatchesDashboardQuery(profile, query))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => ({
        profile,
        lastConnectedAt: recent.find((item) => item.profile.id === profile.id)?.lastConnectedAt || null,
      }));
  }
  const rest = scoped
    .filter((profile) => !recentIds.has(profile.id))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "") || a.name.localeCompare(b.name))
    .map((profile) => ({ profile, lastConnectedAt: null }));
  return [...recent, ...rest];
}

function renderDashboard() {
  const root = document.getElementById("welcome-screen");
  if (!root) return;

  const search = document.getElementById("dashboard-search");
  const query = search?.value?.trim() || "";
  const candidates = getDashboardCandidates(query);
  const searchSection = document.getElementById("dashboard-search-section");
  const searchResults = document.getElementById("dashboard-search-results");
  if (searchSection && searchResults) {
    searchSection.classList.toggle("hidden", !query);
    if (query) {
      const visible = candidates.slice(0, 8);
      searchResults.innerHTML = visible.length
        ? visible.map(({ profile, lastConnectedAt }) => renderDashboardResultRow(profile, lastConnectedAt)).join("")
        : `<div class="dashboard-empty-line">No hay coincidencias</div>`;
      bindDashboardCards(searchResults);
    } else {
      searchResults.innerHTML = "";
    }
  }

  const activity = document.getElementById("dashboard-activity-list");
  if (activity) {
    const rows = getRecentProfilesForActiveView().slice(0, 5);
    const mode = prefs.sidebarViewMode || "current";
    const emptyMsg = rows.length
      ? null
      : (mode === "current"
          ? "Sin actividad en este workspace"
          : mode === "favorites"
            ? "Sin actividad en favoritos"
            : "La actividad aparecerá aquí al conectar perfiles");
    activity.innerHTML = rows.length
      ? rows.map(({ profile, lastConnectedAt }) => renderDashboardActivityRow(profile, lastConnectedAt)).join("")
      : `<div class="dashboard-empty-line">${escHtml(emptyMsg)}</div>`;
    bindDashboardCards(activity);
  }

  renderDashboardWorkspaceChip();
  renderDashboardPinnedTiles();
  renderDashboardFavoritesTiles();
}

/**
 * Tiles grandes en el dashboard para conexiones ancladas (prefs.pinnedProfiles).
 * Si no hay ninguna, oculta la sección completa. Útil para tener a mano los
 * 4-6 servidores que se abren a diario sin depender del filtro de favoritos.
 */
function renderDashboardPinnedTiles() {
  const card = document.getElementById("dashboard-pinned-card");
  const root = document.getElementById("dashboard-pinned-list");
  if (!card || !root) return;
  const ids = Array.isArray(prefs.pinnedProfiles) ? prefs.pinnedProfiles : [];
  const list = ids
    .map((id) => profiles.find((p) => p.id === id))
    .filter(Boolean)
    .slice(0, 6);
  if (list.length === 0) {
    card.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  card.classList.remove("hidden");
  root.innerHTML = list.map((p) => {
    const proto = dashboardProtocol(p);
    // Color de carpeta del perfil (franja de acento en el tile).
    const fc = getFolderColor(p.group, profileWorkspaceId(p));
    const tintAttr = fc ? ` style="--pin-tint:${fc.color}"` : "";
    const tintClass = fc ? " has-tint" : "";
    // Botón secundario para abrir SFTP (solo en perfiles SSH).
    const type = p.connection_type || "ssh";
    const sftpBtn = type === "ssh"
      ? `<button type="button" class="dashboard-pin-sftp" data-dashboard-connect data-pin-sftp="${escHtml(p.id)}" title="${escHtml(t("dashboard.open_sftp"))}" aria-label="${escHtml(t("dashboard.open_sftp"))}">${DASHBOARD_ICON_SFTP}</button>`
      : "";
    return `
      <div class="dashboard-fav-tile dashboard-pinned-tile${tintClass}" role="button" tabindex="0" data-profile-id="${escHtml(p.id)}" title="${escHtml(dashboardProfileHost(p))}"${tintAttr}>
        <span class="dashboard-fav-proto ${escHtml(proto.toLowerCase())}">${escHtml(proto)}</span>
        <span class="dashboard-fav-name">${escHtml(p.name)}</span>
        <span class="dashboard-fav-host">${escHtml(dashboardProfileHost(p))}</span>
        ${sftpBtn}
      </div>`;
  }).join("");
  bindDashboardCards(root);
  root.querySelectorAll("[data-pin-sftp]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openProfileSftp(btn.dataset.pinSftp);
    });
  });
}

// Icono SFTP del botón secundario de los tiles fijados (carpeta).
const DASHBOARD_ICON_SFTP = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>`;

// Perfiles para los que se debe abrir el panel SFTP en cuanto la sesión SSH
// se conecte (botón secundario de los tiles fijados del dashboard).
const pendingSftpOpenProfiles = new Set();

/**
 * Abre el panel SFTP de un perfil desde el dashboard. Si ya hay una sesión
 * conectada de ese perfil, conmuta/enfoca su panel; si no, conecta y marca el
 * perfil para abrir SFTP automáticamente cuando la sesión esté conectada.
 */
function openProfileSftp(profileId) {
  if (!profileId) return;
  for (const [sid, s] of sessions) {
    if (s.profileId === profileId && s.status === "connected") {
      setActiveTab(sid);
      const panel = s.sftp?.panel;
      if (!panel || panel.classList.contains("hidden")) toggleSftpPanel(sid);
      return;
    }
  }
  pendingSftpOpenProfiles.add(profileId);
  connectProfile(profileId);
}

function togglePinnedProfile(profileId) {
  if (!profileId) return;
  prefs.pinnedProfiles = Array.isArray(prefs.pinnedProfiles) ? prefs.pinnedProfiles : [];
  const idx = prefs.pinnedProfiles.indexOf(profileId);
  if (idx >= 0) prefs.pinnedProfiles.splice(idx, 1);
  else prefs.pinnedProfiles.push(profileId);
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderDashboard();
  scheduleProfileAutoSync();
}

/**
 * Chip discreto en la cabecera del dashboard con el workspace activo y el
 * conteo de conexiones. Se oculta si solo existe el workspace "Default" y
 * tiene 0 conexiones (estado inicial limpio).
 */
function renderDashboardWorkspaceChip() {
  const chip = document.getElementById("dashboard-workspace-chip");
  if (!chip) return;
  const mode = prefs.sidebarViewMode || "current";
  const ws = (prefs.workspaces || []).find((w) => w.id === getActiveWorkspaceId());
  const totalInWs = profiles.filter(profileBelongsToActiveWorkspace).length;
  let label = "";
  if (mode === "all") {
    label = `Todos los perfiles · ${profiles.length}`;
  } else if (mode === "favorites") {
    const favCount = (prefs.favorites || []).length;
    label = `Favoritos · ${favCount}`;
  } else if (ws) {
    label = `${ws.name || "Default"} · ${totalInWs}`;
  }
  chip.textContent = label;
  chip.classList.toggle("hidden", !label);
}

/**
 * Tarjetas de favoritos en el dashboard (hasta 6). Si no hay, muestra un
 * estado vacío con CTA para anclar conexiones desde el menú contextual.
 */
function renderDashboardFavoritesTiles() {
  const root = document.getElementById("dashboard-favorites-list");
  if (!root) return;
  const favIds = new Set(Array.isArray(prefs.favorites) ? prefs.favorites : []);
  const favs = profiles.filter((p) => favIds.has(p.id)).slice(0, 6);
  if (favs.length === 0) {
    root.innerHTML = `<div class="dashboard-empty-line">${escHtml(t("sidebar.favorites_empty"))}</div>`;
    return;
  }
  root.innerHTML = favs.map((p) => {
    const proto = dashboardProtocol(p);
    return `
      <button class="dashboard-fav-tile" data-profile-id="${escHtml(p.id)}" title="${escHtml(dashboardProfileHost(p))}">
        <span class="dashboard-fav-proto ${escHtml(proto.toLowerCase())}">${escHtml(proto)}</span>
        <span class="dashboard-fav-name">${escHtml(p.name)}</span>
        <span class="dashboard-fav-host">${escHtml(dashboardProfileHost(p))}</span>
      </button>`;
  }).join("");
  bindDashboardCards(root);
}

function renderDashboardResultRow(profile, lastConnectedAt) {
  const proto = dashboardProtocol(profile);
  const protoClass = proto.toLowerCase();
  return `
    <div class="dashboard-result-row" role="button" tabindex="0" data-profile-id="${escHtml(profile.id)}">
      <span class="dashboard-proto ${escHtml(protoClass)}">${escHtml(proto)}</span>
      <div>
        <div class="dashboard-result-name">${escHtml(profile.name)}</div>
        <div class="dashboard-result-meta">${escHtml(dashboardProfileHost(profile))} · ${escHtml(profile.group || "Sin carpeta")}</div>
      </div>
      <span class="dashboard-result-time">${escHtml(formatDashboardTime(lastConnectedAt))}</span>
      <button class="dashboard-connect" data-dashboard-connect="${escHtml(profile.id)}">Conectar</button>
    </div>`;
}

function renderDashboardActivityRow(profile, lastConnectedAt) {
  const proto = dashboardProtocol(profile);
  return `
    <div class="dashboard-activity-row" role="button" tabindex="0" data-profile-id="${escHtml(profile.id)}">
      <span class="dashboard-activity-name">${escHtml(profile.name)}</span>
      <span class="dashboard-activity-meta">${escHtml(proto)} · ${escHtml(formatDashboardTime(lastConnectedAt))}</span>
    </div>`;
}

function bindDashboardCards(root) {
  root.querySelectorAll("[data-profile-id]").forEach((el) => {
    const open = () => connectProfile(el.dataset.profileId);
    el.addEventListener("click", (event) => {
      if (event.target.closest("[data-dashboard-connect]")) return;
      open();
    });
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  });
  root.querySelectorAll("[data-dashboard-connect]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      connectProfile(btn.dataset.dashboardConnect);
    });
  });
}

function focusDashboardSearch() {
  const welcome = document.getElementById("welcome-screen");
  const search = document.getElementById("dashboard-search");
  if (!welcome || welcome.classList.contains("hidden") || !search) return false;
  search.focus();
  search.select();
  return true;
}

function sidebarSearchCandidates(query = "") {
  const q = String(query || "").trim().toLowerCase();
  return profiles
    .filter(connectionSearchIncludesProfile)
    .filter((profile) => !q || profileMatchesSidebarQuery(profile, q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function connectionSearchIncludesProfile(profile) {
  return prefs.searchAllWorkspaces !== false || profileBelongsToActiveWorkspace(profile);
}

function refitVisibleTerminalsSoon() {
  requestAnimationFrame(() => {
    for (const sid of viewSelection) {
      const s = sessions.get(sid);
      if (s?.fitAddon) {
        try {
          s.fitAddon.fit();
          notifyResize(sid, s.terminal);
        } catch {}
      }
    }
  });
}

function focusConnectionSearch() {
  if (focusDashboardSearch()) return;

  if (document.body.classList.contains("sidebar-collapsed")) {
    document.body.classList.remove("sidebar-collapsed");
    localStorage.setItem("rustty-sidebar-collapsed", "0");
    refitVisibleTerminalsSoon();
  }

  toggleSidebarTools(true, { mode: "search", anchor: "btn-sidebar-search" });
  requestAnimationFrame(() => {
    const search = document.getElementById("sidebar-search");
    if (!search) return;
    search.focus();
    search.select();
  });
}

function renderTreeNode(node, depth, workspaceId = getActiveWorkspaceId()) {
  let html = "";
  const renderConnections = () => {
    for (const p of node.connections) html += renderConnectionItem(p, depth);
  };
  const renderFolders = () => {
    for (const [name, child] of sortedFolderEntries(node, workspaceId)) {
      html += renderFolderNode(name, child, depth, workspaceId);
    }
  };
  if (prefs.foldersFirst !== false) {
    renderFolders();
    renderConnections();
  } else {
    renderConnections();
    renderFolders();
  }
  return html;
}

function renderFolderNode(name, node, depth, workspaceId) {
  const path = node.path;
  const isOpen = openFolders.has(path);
  const count = countConnections(node);
  const indent = 14 + depth * 12;
  const tintAttrs = folderTintAttrs(path, workspaceId);

  return `
    <div class="folder-item" data-folder-path="${escHtml(path)}" draggable="true"${tintAttrs}>
      <div class="folder-header" style="padding-left:${indent}px; padding-right:14px">
        <span class="folder-arrow ${isOpen ? "open" : ""}">▶</span>
        <span class="folder-icon">${folderIconSvg()}</span>
        <span class="folder-name">${escHtml(name)}</span>
        <span class="folder-count">${count}</span>
      </div>
      <div class="folder-children${isOpen ? "" : " hidden"}">
        ${renderTreeNode(node, depth + 1, workspaceId)}
      </div>
    </div>`;
}

function getFolderColor(path, workspaceId = getActiveWorkspaceId()) {
  if (!path || !prefs.folderColors) return null;
  const id = prefs.folderColors[folderColorKey(path, workspaceId)];
  if (!id) return null;
  return FOLDER_COLOR_PRESETS.find((c) => c.id === id) || null;
}

function getWorkspaceColor(workspaceId) {
  if (!workspaceId || !prefs.workspaceColors) return null;
  const id = prefs.workspaceColors[workspaceId];
  if (!id) return null;
  return FOLDER_COLOR_PRESETS.find((c) => c.id === id) || null;
}

function folderTintAttrs(path, workspaceId = getActiveWorkspaceId()) {
  const c = getFolderColor(path, workspaceId);
  if (!c) return "";
  return ` data-folder-tint="${escHtml(c.id)}" style="--folder-tint:${c.color}"`;
}

function workspaceTintAttrs(workspaceId) {
  const c = getWorkspaceColor(workspaceId);
  if (!c) return "";
  return ` data-folder-tint="${escHtml(c.id)}" style="--folder-tint:${c.color}"`;
}

function setFolderColor(path, colorId, workspaceId = getActiveWorkspaceId()) {
  if (!path) return;
  prefs.folderColors = prefs.folderColors || {};
  const key = folderColorKey(path, workspaceId);
  if (!colorId) delete prefs.folderColors[key];
  else prefs.folderColors[key] = colorId;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();
}

function setWorkspaceColor(workspaceId, colorId) {
  if (!workspaceId) return;
  prefs.workspaceColors = prefs.workspaceColors || {};
  if (!colorId) delete prefs.workspaceColors[workspaceId];
  else prefs.workspaceColors[workspaceId] = colorId;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();
}

function deleteWorkspaceColors(workspaceId) {
  let mutated = false;
  if (prefs.workspaceColors?.[workspaceId]) {
    delete prefs.workspaceColors[workspaceId];
    mutated = true;
  }
  if (prefs.folderColors) {
    const prefix = `${workspaceId}|`;
    for (const key of Object.keys(prefs.folderColors)) {
      if (!key.startsWith(prefix)) continue;
      delete prefs.folderColors[key];
      mutated = true;
    }
  }
  if (mutated) prefs._prefsUpdatedAt = new Date().toISOString();
}

function remapFolderColors(sourceWs, targetWs, folderPath, newPath) {
  if (!prefs.folderColors) return;
  const sourceKey = folderColorKey(folderPath, sourceWs);
  const targetKey = folderColorKey(newPath, targetWs);
  const remapped = {};
  let mutated = false;
  for (const [key, color] of Object.entries(prefs.folderColors)) {
    if (key === sourceKey) {
      remapped[targetKey] = color;
      mutated = true;
    } else if (key.startsWith(sourceKey + "/")) {
      remapped[targetKey + key.slice(sourceKey.length)] = color;
      mutated = true;
    } else {
      remapped[key] = color;
    }
  }
  if (!mutated) return;
  prefs.folderColors = remapped;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
}

function deleteFolderColors(workspaceId, folderPath) {
  if (!prefs.folderColors) return;
  const key = folderColorKey(folderPath, workspaceId);
  let mutated = false;
  for (const candidate of Object.keys(prefs.folderColors)) {
    if (candidate === key || candidate.startsWith(key + "/")) {
      delete prefs.folderColors[candidate];
      mutated = true;
    }
  }
  if (mutated) {
    prefs._prefsUpdatedAt = new Date().toISOString();
    savePrefs();
  }
}

// Prioridad para el "estado dominante" cuando el perfil tiene varias sesiones
// abiertas a la vez (poco común): mostramos el más llamativo.
const SESSION_STATE_PRIORITY = { error: 4, reconnecting: 3, connecting: 2, connected: 1, closed: 0 };

// Una sesión "viva" sigue manteniendo la conexión activa con el servidor o
// está intentándolo. Una vez `status === "closed"` el canal está muerto y la
// conexión debe pintarse en la sidebar como cerrada aunque la pestaña siga
// existiendo en el mapa.
function isLiveSessionStatus(status) {
  return status === "connected" || status === "connecting" || status === "reconnecting" || status === "error";
}

function profileSidebarState(profileId) {
  let dominant = "";
  let isOpen = false;
  for (const s of sessions.values()) {
    if (s.profileId !== profileId) continue;
    const st = s.status || "closed";
    if (!isLiveSessionStatus(st)) continue;
    isOpen = true;
    if (!dominant || (SESSION_STATE_PRIORITY[st] ?? 0) > (SESSION_STATE_PRIORITY[dominant] ?? 0)) {
      dominant = st;
    }
  }
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null;
  const isActiveTab = !!(
    activeSession &&
    activeSession.profileId === profileId &&
    isLiveSessionStatus(activeSession.status || "closed")
  );
  return { isOpen, isActiveTab, dominantState: dominant };
}

function renderConnectionItem(p, depth) {
  const { isOpen, isActiveTab, dominantState } = profileSidebarState(p.id);
  const isSelected = activeProfileId() === p.id || sidebarSelectedConnectionIds.has(p.id);
  const connType = p.connection_type || "ssh";
  const proto = connectionProtocolMeta(connType);
  const indent = 14 + depth * 12;
  const noteSummary = notesIndex.get(p.id);
  const notesBadge = noteSummary
    ? `<span class="conn-notes-badge" data-action="open-note" data-id="${p.id}" title="${escHtml(noteSummary.excerpt || t("notes.has_note"))}">${NOTE_ICON_SVG}</span>`
    : "";
  const cls = [
    "conn-item",
    isActiveTab ? "active" : "",
    !isActiveTab && isOpen ? "is-open" : "",
    isSelected ? "selected" : "",
    dominantState ? `state-${dominantState}` : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="${cls}"
         data-id="${p.id}"
         draggable="true"
         style="padding-left:${indent}px">
      <div class="conn-item-icon ${escHtml(proto.className)}${isOpen ? " connected" : ""}" title="${escHtml(proto.label)}">
        ${escHtml(proto.icon)}
      </div>
      <div class="conn-item-info">
        <div class="conn-item-name">
          ${escHtml(p.name)}
          <span class="conn-badge conn-badge-${escHtml(proto.className)}">${escHtml(proto.label)}</span>
          ${notesBadge}
        </div>
        <div class="conn-item-host">${escHtml(p.username)}@${escHtml(p.host)}:${p.port}</div>
      </div>
      <div class="conn-item-actions">
        <button class="btn-icon-sm conn-fav${isFavoriteProfile(p.id) ? " on" : ""}" data-action="toggle-favorite" data-id="${p.id}" title="${escHtml(t("ctx.toggle_favorite"))}">${isFavoriteProfile(p.id) ? "★" : "☆"}</button>
        <button class="btn-icon-sm" data-action="edit" data-id="${p.id}" title="Editar">✎</button>
        <button class="btn-icon-sm danger" data-action="delete" data-id="${p.id}" title="Eliminar">✕</button>
      </div>
    </div>`;
}

function getVisibleSidebarConnectionIds(container) {
  return [...container.querySelectorAll(".conn-item")]
    .map((el) => el.dataset.id)
    .filter(Boolean);
}

function updateSidebarSelectionDom(container = document.getElementById("connection-list")) {
  if (!container) return;
  const activeId = activeProfileId();
  container.querySelectorAll(".conn-item").forEach((el) => {
    const id = el.dataset.id;
    el.classList.toggle(
      "selected",
      sidebarSelectedConnectionIds.has(id) || id === activeId
    );
    // Estado abierto / pestaña activa / estado dominante. Sin esto, al
    // cambiar de pestaña sin re-renderizar la sidebar todas las conexiones
    // abiertas seguirían pintadas como activas.
    const { isOpen, isActiveTab, dominantState } = profileSidebarState(id);
    el.classList.toggle("active", isActiveTab);
    el.classList.toggle("is-open", isOpen && !isActiveTab);
    for (const cls of [...el.classList]) {
      if (cls.startsWith("state-")) el.classList.remove(cls);
    }
    if (dominantState) el.classList.add(`state-${dominantState}`);
    const icon = el.querySelector(".conn-item-icon");
    if (icon) icon.classList.toggle("connected", isOpen);
  });
}

function setSidebarConnectionSelection(ids, container = document.getElementById("connection-list")) {
  sidebarSelectedConnectionIds.clear();
  for (const id of ids) {
    if (id) sidebarSelectedConnectionIds.add(id);
  }
  updateSidebarSelectionDom(container);
}

function handleSidebarConnectionClick(e, el, container) {
  const id = el.dataset.id;
  if (!id) return;

  if (e.shiftKey && sidebarLastSelectedConnectionId) {
    const visibleIds = getVisibleSidebarConnectionIds(container);
    const from = visibleIds.indexOf(sidebarLastSelectedConnectionId);
    const to = visibleIds.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      setSidebarConnectionSelection(visibleIds.slice(start, end + 1), container);
      return;
    }
  }

  if (e.ctrlKey || e.metaKey) {
    if (sidebarSelectedConnectionIds.has(id)) {
      sidebarSelectedConnectionIds.delete(id);
    } else {
      sidebarSelectedConnectionIds.add(id);
    }
    sidebarLastSelectedConnectionId = id;
    updateSidebarSelectionDom(container);
    return;
  }

  sidebarLastSelectedConnectionId = id;
  setSidebarConnectionSelection([id], container);
}

function connectionProtocolMeta(type) {
  switch (type) {
    case "rdp":
      return { className: "rdp", label: "RDP", icon: "▣" };
    case "ftp":
      return { className: "ftp", label: "FTP", icon: "↕" };
    case "ftps":
      return { className: "ftps", label: "FTPS", icon: "⇅" };
    case "ssh":
    default:
      return { className: "ssh", label: "SSH", icon: ">_" };
  }
}

function isFileTransferConnectionType(type) {
  return type === "ftp" || type === "ftps";
}

function bindTreeEvents(container) {
  // Clic = seleccionar; doble clic = conectar
  container.querySelectorAll(".conn-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      handleSidebarConnectionClick(e, el, container);
    });
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-action]")) return;
      // El doble clic siempre abre una sesión nueva, aunque ya haya una pestaña
      // abierta de este perfil (force evita reutilizar la pestaña existente).
      connectProfile(el.dataset.id, { force: true });
    });
  });

  // Clic en botones de acción
  container.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditConnectionModal(btn.dataset.id);
    });
  });
  container.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProfile(btn.dataset.id);
    });
  });
  container.querySelectorAll("[data-action='toggle-favorite']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavoriteProfile(btn.dataset.id);
    });
  });
  container.querySelectorAll("[data-action='open-note']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openNoteEditor(btn.dataset.id);
    });
  });

  // Clic en carpeta → colapsar/expandir
  container.querySelectorAll(".folder-header").forEach((header) => {
    header.addEventListener("click", () => {
      const item = header.closest(".folder-item");
      const path = item.dataset.folderPath;
      const children = item.querySelector(".folder-children");
      const arrow = header.querySelector(".folder-arrow");
      if (openFolders.has(path)) {
        openFolders.delete(path);
        children.classList.add("hidden");
        arrow.classList.remove("open");
      } else {
        openFolders.add(path);
        children.classList.remove("hidden");
        arrow.classList.add("open");
      }
    });
  });

  bindSidebarDragAndDrop(container);
}

// ═══════════════════════════════════════════════════════════════
// DRAG & DROP EN LA SIDEBAR
// ═══════════════════════════════════════════════════════════════

let _dragState = null;

function workspaceForElement(el) {
  const wsRootEl = el?.closest?.("[data-ws-root]");
  if (wsRootEl) return wsRootEl.dataset.wsRoot;
  return getActiveWorkspaceId();
}

function folderContainsPath(path, folderPath) {
  return path === folderPath || path?.startsWith(folderPath + "/");
}

function findSidebarFolderItem(container, folderPath, workspaceId = null) {
  if (!container || !folderPath) return null;
  return [...container.querySelectorAll(".folder-item:not(.ws-folder-item)")]
    .find((el) =>
      el.dataset.folderPath === folderPath
      && (!workspaceId || workspaceForElement(el) === workspaceId)
    ) || null;
}

function bindSidebarDragAndDrop(container) {
  // Favoritos: solo lectura, no permitir reordenar/mover
  if (prefs.sidebarViewMode === "favorites") return;

  // ── Origen: conexiones ─────────────────────────────────────────
  container.querySelectorAll(".conn-item").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      const profile = profiles.find((p) => p.id === el.dataset.id);
      if (!profile) { e.preventDefault(); return; }
      const sourceWs = profileWorkspaceId(profile);
      if (!sidebarSelectedConnectionIds.has(profile.id)) {
        setSidebarConnectionSelection([profile.id], container);
      }
      const ids = [...sidebarSelectedConnectionIds].filter((id) => {
        const p = profiles.find((x) => x.id === id);
        return p && profileWorkspaceId(p) === sourceWs;
      });
      if (!ids.includes(profile.id)) ids.unshift(profile.id);
      _dragState = {
        kind: "conn",
        id: profile.id,
        ids,
        sourceWs,
      };
      container.querySelectorAll(".conn-item").forEach((item) => {
        item.classList.toggle("dragging", ids.includes(item.dataset.id));
      });
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ids.join(",")); } catch {}
    });
    el.addEventListener("dragend", () => {
      container.querySelectorAll(".conn-item.dragging")
        .forEach((item) => item.classList.remove("dragging"));
      clearDropTargets(container);
      _dragState = null;
    });
  });

  // ── Origen: carpetas ───────────────────────────────────────────
  container.querySelectorAll(".folder-item:not(.ws-folder-item)").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      // Si el dragstart proviene de una conn-item interna, no robarlo
      if (e.target.closest(".conn-item")) return;
      e.stopPropagation();
      _dragState = {
        kind: "folder",
        path: el.dataset.folderPath,
        sourceWs: workspaceForElement(el),
      };
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", el.dataset.folderPath); } catch {}
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      clearDropTargets(container);
      _dragState = null;
    });
  });

  // ── Destinos: cabeceras de carpeta (folder y workspace pseudo-folder) ──
  container.querySelectorAll(".folder-header").forEach((header) => {
    const folderItem = header.closest(".folder-item");
    header.addEventListener("dragover", (e) => {
      if (!_dragState) return;
      const targetPath = folderItem.dataset.folderPath || "";
      const isWsHeader = folderItem.classList.contains("ws-folder-item");
      const targetFolder = isWsHeader ? "" : targetPath;
      const targetWs = isWsHeader
        ? folderItem.dataset.wsRoot
        : workspaceForElement(folderItem);
      if (!isValidDropTarget(_dragState, targetFolder, targetWs)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropTargets(container);
      header.classList.add("drag-over");
    });
    header.addEventListener("dragleave", () => {
      header.classList.remove("drag-over");
    });
    header.addEventListener("drop", async (e) => {
      if (!_dragState) return;
      const targetPath = folderItem.dataset.folderPath || "";
      const isWsHeader = folderItem.classList.contains("ws-folder-item");
      const targetFolder = isWsHeader ? "" : targetPath;
      const targetWs = isWsHeader
        ? folderItem.dataset.wsRoot
        : workspaceForElement(folderItem);
      if (!isValidDropTarget(_dragState, targetFolder, targetWs)) return;
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove("drag-over");
      const drag = _dragState;
      _dragState = null;
      // Abrir la carpeta destino para que se vea el resultado
      if (targetFolder) openFolders.add(targetFolder);
      else if (isWsHeader) openFolders.add(`__ws__/${targetWs}`);
      await applyDrop(drag, targetFolder, targetWs);
    });
  });

  // ── Destino: zona vacía del contenedor (raíz del workspace activo) ──
  container.addEventListener("dragover", (e) => {
    if (!_dragState) return;
    if (e.target.closest(".folder-header")) return; // ya gestionado
    if (e.target.closest(".conn-item")) return;
    if (prefs.sidebarViewMode === "all") return; // raíz ambigua entre workspaces
    if (!isValidDropTarget(_dragState, "", getActiveWorkspaceId())) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropTargets(container);
    container.classList.add("drag-over-root");
  });
  container.addEventListener("dragleave", (e) => {
    if (e.target === container) container.classList.remove("drag-over-root");
  });
  container.addEventListener("drop", async (e) => {
    if (!_dragState) return;
    if (e.target.closest(".folder-header")) return;
    if (prefs.sidebarViewMode === "all") return;
    e.preventDefault();
    container.classList.remove("drag-over-root");
    const drag = _dragState;
    _dragState = null;
    await applyDrop(drag, "", getActiveWorkspaceId());
  });
}

function clearDropTargets(container) {
  container.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  container.classList.remove("drag-over-root");
}

function isValidDropTarget(drag, targetFolder, targetWs) {
  if (!drag) return false;
  if (drag.kind === "conn") {
    const ids = drag.ids?.length ? drag.ids : [drag.id];
    const selectedProfiles = ids
      .map((id) => profiles.find((x) => x.id === id))
      .filter((p) => p && profileWorkspaceId(p) === drag.sourceWs);
    if (!selectedProfiles.length) return false;
    return selectedProfiles.some(
      (p) => (p.group || "") !== targetFolder || profileWorkspaceId(p) !== targetWs
    );
  }
  if (drag.kind === "folder") {
    if (!drag.path) return false;
    const sameWs = drag.sourceWs === targetWs;
    if (sameWs) {
      // No mover dentro de sí misma o de un descendiente
      if (targetFolder === drag.path) return false;
      if (targetFolder.startsWith(drag.path + "/")) return false;
      // No-op: ya está en ese padre
      const parent = drag.path.includes("/") ? drag.path.slice(0, drag.path.lastIndexOf("/")) : "";
      if (parent === targetFolder) return false;
    }
    return true;
  }
  return false;
}

async function applyDrop(drag, targetFolder, targetWs) {
  try {
    if (drag.kind === "conn") {
      await moveConnectionsTo(drag.ids?.length ? drag.ids : [drag.id], targetFolder, targetWs);
    } else if (drag.kind === "folder") {
      await moveFolderTo(drag.path, drag.sourceWs, targetFolder, targetWs);
    }
  } catch (err) {
    toast(`Error al mover: ${err}`, "error");
  }
}

function saveWorkspaceFolders(wsId, folders) {
  const norm = [...new Set(folders.filter(Boolean))].sort();
  prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
  prefs.userFoldersByWorkspace[wsId] = norm;
  if (wsId === getActiveWorkspaceId()) {
    userFolders = new Set(norm);
    localStorage.setItem("rustty-folders", JSON.stringify(norm));
  }
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
}

async function moveConnectionTo(profileId, targetFolder, targetWs) {
  await moveConnectionsTo([profileId], targetFolder, targetWs);
}

async function moveConnectionsTo(profileIds, targetFolder, targetWs) {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  const updatedAt = new Date().toISOString();
  let moved = 0;
  for (const profileId of uniqueIds) {
    const p = profiles.find((x) => x.id === profileId);
    if (!p) continue;
    if ((p.group || "") === targetFolder && profileWorkspaceId(p) === targetWs) continue;
    const updated = {
      ...p,
      group: targetFolder || null,
      workspace_id: targetWs,
      updated_at: updatedAt,
    };
    await invoke("save_profile", { profile: updated });
    profiles[profiles.findIndex((x) => x.id === p.id)] = updated;
    moved++;
  }
  if (!moved) return;
  scheduleProfileAutoSync();
  renderConnectionList();
}

async function moveFolderTo(folderPath, sourceWs, targetParent, targetWs) {
  const folderName = folderPath.split("/").at(-1);
  const newPath = targetParent ? `${targetParent}/${folderName}` : folderName;
  const sameWs = sourceWs === targetWs;

  if (sameWs && newPath === folderPath) return;
  if (sameWs && newPath.startsWith(folderPath + "/")) {
    toast("No se puede mover una carpeta dentro de sí misma", "error");
    return;
  }

  const prefix = folderPath + "/";
  const newPrefix = newPath + "/";
  const updatedAt = new Date().toISOString();

  // Mover/renombrar perfiles afectados
  for (const p of profiles) {
    if ((p.workspace_id || "default") !== sourceWs) continue;
    if (!p.group) continue;
    let newGroup = null;
    if (p.group === folderPath) newGroup = newPath;
    else if (p.group.startsWith(prefix)) newGroup = newPrefix + p.group.slice(prefix.length);
    else continue;
    const updated = {
      ...p,
      group: newGroup,
      workspace_id: targetWs,
      updated_at: updatedAt,
    };
    await invoke("save_profile", { profile: updated }).catch(() => {});
    profiles[profiles.findIndex((x) => x.id === p.id)] = updated;
  }

  // Actualizar listas de carpetas
  const sourceList = new Set(getWorkspaceFolders(sourceWs));
  const targetList = sameWs ? sourceList : new Set(getWorkspaceFolders(targetWs));
  for (const f of [...sourceList]) {
    let np = null;
    if (f === folderPath) np = newPath;
    else if (f.startsWith(prefix)) np = newPrefix + f.slice(prefix.length);
    if (np !== null) {
      sourceList.delete(f);
      targetList.add(np);
    }
  }
  saveWorkspaceFolders(sourceWs, [...sourceList]);
  if (!sameWs) saveWorkspaceFolders(targetWs, [...targetList]);

  // Remapear colores asignados a la carpeta o sus descendientes
  remapFolderColors(sourceWs, targetWs, folderPath, newPath);

  // Estado de apertura
  if (openFolders.has(folderPath)) {
    openFolders.delete(folderPath);
    openFolders.add(newPath);
  }
  if (targetParent) openFolders.add(targetParent);

  scheduleProfileAutoSync();
  renderConnectionList();
}

// ═══════════════════════════════════════════════════════════════
// MENÚ CONTEXTUAL
// ═══════════════════════════════════════════════════════════════

function showContextMenu(x, y, type, id = null, folderPath = null, extra = {}) {
  ctxTarget = { type, id, folderPath, workspaceId: extra.workspaceId || null };

  const menu = document.getElementById("context-menu");

  // Las pseudo-carpetas que representan un workspace (__ws__/<id>) usan el
  // árbol de carpetas pero no son carpetas reales: ocultar acciones de carpeta.
  const isRealFolder = type === "folder"
    && typeof folderPath === "string"
    && !folderPath.startsWith("__ws__/");

  // Mostrar u ocultar secciones según el tipo de objetivo
  menu.querySelectorAll(".ctx-folder-only").forEach((el) =>
    el.classList.toggle("hidden", !isRealFolder)
  );
  menu.querySelectorAll(".ctx-conn-only").forEach((el) =>
    el.classList.toggle("hidden", type !== "connection")
  );
  // «Promover a credencial maestra» solo cuando el perfil usa su contraseña
  // propia (la acción verifica que realmente exista una guardada en keyring).
  const ctxProfile = type === "connection" ? profiles.find((p) => p.id === id) : null;
  const canPromote = !!ctxProfile && (ctxProfile.password_source || "own") === "own";
  menu.querySelectorAll(".ctx-promote-only").forEach((el) =>
    el.classList.toggle("hidden", type !== "connection" || !canPromote)
  );
  // Nota: etiqueta dinámica (Añadir/Editar) y visibilidad de "Eliminar nota".
  const hasNote = type === "connection" && id ? profileHasNote(id) : false;
  const noteLabel = document.getElementById("ctx-note-label");
  if (noteLabel) noteLabel.textContent = hasNote ? t("ctx.edit_note") : t("ctx.add_note");
  // Plantilla: etiqueta según si el perfil ya está marcado como tal.
  const tplLabel = document.getElementById("ctx-template-label");
  if (tplLabel && type === "connection" && id) {
    tplLabel.textContent = isProfileTemplate(id) ? t("templates.ctx_unmark") : t("templates.ctx_mark");
  }
  menu.querySelectorAll(".ctx-note-exists").forEach((el) =>
    el.classList.toggle("hidden", !hasNote)
  );
  menu.querySelectorAll(".ctx-ws-only").forEach((el) =>
    el.classList.toggle("hidden", type !== "workspace")
  );
  menu.querySelectorAll(".ctx-colorable").forEach((el) =>
    el.classList.toggle("hidden", type !== "folder" && type !== "workspace")
  );
  // "Abrir directorio de datos" solo visible en el clic sobre la zona vacía
  menu.querySelectorAll(".ctx-sidebar-only").forEach((el) =>
    el.classList.toggle("hidden", type !== "sidebar")
  );

  // «Conectar con otro usuario»: poblar el submenú con las identidades extra.
  const connectAsEl = document.getElementById("ctx-connect-as");
  const submenu = document.getElementById("ctx-connect-as-submenu");
  const extras = ctxProfile?.extra_credentials || [];
  if (connectAsEl && submenu) {
    submenu.innerHTML = "";
    for (const c of extras) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ctx-item";
      item.dataset.ctx = "connect-as";
      item.dataset.credId = c.id;
      const icon = document.createElement("span");
      icon.className = "ctx-icon";
      icon.innerHTML = '<svg class="ctx-icon-svg" aria-hidden="true"><use href="#ci-play"/></svg>';
      const label = document.createElement("span");
      label.textContent = c.label || c.username;
      item.append(icon, label);
      submenu.appendChild(item);
    }
    connectAsEl.classList.toggle("hidden", type !== "connection" || extras.length === 0);
  }

  // «Conectar y restaurar pantalla anterior»: solo si hay snapshot guardado.
  const restoreEl = document.getElementById("ctx-connect-restore");
  if (restoreEl) {
    const hasSnapshot = type === "connection" && id && snapshotIndex.has(id);
    restoreEl.classList.toggle("hidden", !hasSnapshot);
  }

  // Posicionar fuera de pantalla para medir, luego ajustar
  menu.style.left = "0px";
  menu.style.top  = "0px";
  menu.classList.remove("hidden");

  const { width, height } = menu.getBoundingClientRect();
  const finalX = Math.min(x, window.innerWidth  - width  - 6);
  menu.style.left = finalX + "px";
  menu.style.top  = Math.min(y, window.innerHeight - height - 6) + "px";
  // Si el menú queda en la mitad derecha, abrir el submenú hacia la izquierda.
  if (submenu) {
    submenu.classList.toggle("open-left", finalX + width + 190 > window.innerWidth);
  }
}

function hideContextMenu() {
  document.getElementById("context-menu").classList.add("hidden");
  ctxTarget = { type: null, id: null, folderPath: null, workspaceId: null };
}

function handleContextMenuAction(action) {
  const { id, folderPath, workspaceId } = ctxTarget;
  const targetWs = workspaceId || getActiveWorkspaceId();
  hideContextMenu();

  switch (action) {
    case "new-connection":
      // La carpeta contextual se pasa como prefijo
      openNewConnectionModal(folderPath, targetWs);
      break;
    case "new-folder":
      startInlineFolderCreation(folderPath, targetWs);
      break;
    case "rename-folder":
      renameFolder(folderPath, targetWs);
      break;
    case "move-folder-up":
      if (folderPath) moveFolderInOrder(targetWs, folderPath, -1);
      break;
    case "move-folder-down":
      if (folderPath) moveFolderInOrder(targetWs, folderPath, +1);
      break;
    case "delete-folder":
      deleteFolderAndMoveConnections(folderPath, targetWs);
      break;
    case "connect":
      connectProfile(id);
      break;
    case "connect-private":
      connectPrivateProfile(id);
      break;
    case "connect-restore":
      connectProfile(id, { force: true, restore: true });
      break;
    case "wake-on-lan":
      wakeProfile(id);
      break;
    case "new-tunnel":
      openTunnelForProfile(id);
      break;
    case "edit-conn":
      openEditConnectionModal(id);
      break;
    case "duplicate-conn":
      duplicateProfile(id);
      break;
    case "connect-overrides":
      duplicateSessionWithOverrides(id);
      break;
    case "edit-note":
      if (id) openNoteEditor(id);
      break;
    case "delete-note":
      if (id) deleteNote(id);
      break;
    case "promote-master":
      if (id) promoteProfilePasswordToMaster(id);
      break;
    case "toggle-favorite":
      if (id) toggleFavoriteProfile(id);
      break;
    case "toggle-pinned":
      if (id) togglePinnedProfile(id);
      break;
    case "toggle-template":
      if (id) toggleProfileTemplate(id);
      break;
    case "move-conn-up":
      if (id) moveConnectionInOrder(id, -1);
      break;
    case "move-conn-down":
      if (id) moveConnectionInOrder(id, +1);
      break;
    case "delete-conn":
      deleteProfile(id);
      break;
    case "rename-ws":
      renameWorkspaceById(ctxTarget.workspaceId);
      break;
    case "delete-ws":
      deleteWorkspaceById(ctxTarget.workspaceId);
      break;
    case "export-folder":
      if (folderPath) exportConnections(folderPath, targetWs);
      break;
    case "export-ws":
      if (ctxTarget.workspaceId) exportConnectionsByWorkspace(ctxTarget.workspaceId);
      break;
    case "open-data-dir":
      openDataDirectory();
      break;
  }
}

async function renameWorkspaceById(wsId) {
  const ws = prefs.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const name = await promptTextValue({
    title: t("sidebar.workspace_rename"),
    label: t("sidebar.workspace_prompt_rename"),
    initialValue: ws.name,
  });
  if (!name) return;
  ws.name = name;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
}

async function deleteWorkspaceById(wsId) {
  if (prefs.workspaces.length <= 1) return;
  const ws = prefs.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const inUse = profiles.some((p) => (p.workspace_id || "default") === ws.id);
  if (inUse) {
    const ok = await confirmDestructiveTyped({
      title: t("sidebar.workspace_delete"),
      message: t("sidebar.workspace_confirm_delete_full"),
      expectedText: ws.name,
      danger: true,
    });
    if (!ok) return;
  } else {
    const ok = await confirmThemed({
      title: t("sidebar.workspace_delete"),
      message: t("sidebar.workspace_confirm_delete"),
      submitLabel: t("modal_destructive.submit"),
      danger: true,
    });
    if (!ok) return;
  }
  const finalize = () => {
    if (prefs.userFoldersByWorkspace) delete prefs.userFoldersByWorkspace[ws.id];
    deleteWorkspaceColors(ws.id);
    prefs.workspaces = prefs.workspaces.filter((w) => w.id !== ws.id);
    if (prefs.activeWorkspaceId === ws.id) {
      prefs.activeWorkspaceId = prefs.workspaces[0].id;
      userFolders = new Set(getWorkspaceFolders(prefs.activeWorkspaceId));
    }
    prefs._prefsUpdatedAt = new Date().toISOString();
    savePrefs();
    renderConnectionList();
    scheduleProfileAutoSync();
  };
  if (inUse) {
    const toDelete = profiles.filter((p) => (p.workspace_id || "default") === ws.id);
    Promise.all(toDelete.map((p) => invoke("delete_profile", { id: p.id }).catch(() => null)))
      .then(async () => {
        try { profiles = await invoke("get_profiles"); } catch {}
        finalize();
      });
  } else {
    finalize();
  }
}

// ═══════════════════════════════════════════════════════════════
// GESTIÓN DE CARPETAS
// ═══════════════════════════════════════════════════════════════

/**
 * Inserta un input inline en el árbol para crear una nueva carpeta.
 * @param {string|null} parentPath  Carpeta padre (null = raíz)
 * @param {string|null} workspaceId Workspace donde se crea la carpeta
 */
function startInlineFolderCreation(parentPath = null, workspaceId = getActiveWorkspaceId()) {
  const container = document.getElementById("connection-list");

  // Eliminar cualquier input inline previo
  container.querySelector(".folder-inline-input")?.remove();

  const prefix = parentPath ? `${parentPath}/` : "";
  const indent = parentPath ? (parentPath.split("/").length * 12 + 14) : 14;

  const wrapper = document.createElement("div");
  wrapper.className = "folder-inline-input";
  wrapper.style.paddingLeft = `${indent}px`;
  wrapper.innerHTML = `
    <span class="folder-icon">${folderIconSvg()}</span>
    <input type="text" placeholder="Nombre de carpeta" data-prefix="${escHtml(prefix)}" />`;

  // Si hay carpeta padre, abrir la carpeta padre e insertar al principio de sus hijos
  if (parentPath) {
    const folderEl = findSidebarFolderItem(container, parentPath, workspaceId);
    if (folderEl) {
      openFolders.add(parentPath);
      const children = folderEl.querySelector(".folder-children");
      const arrow = folderEl.querySelector(".folder-arrow");
      children.classList.remove("hidden");
      arrow.classList.add("open");
      children.prepend(wrapper);
    } else {
      container.prepend(wrapper);
    }
  } else {
    container.prepend(wrapper);
  }

  const input = wrapper.querySelector("input");
  input.focus();

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const name = input.value.trim();
      wrapper.remove();
      if (!name) return;
      const fullPath = prefix + name;
      const folders = new Set(getWorkspaceFolders(workspaceId));
      folders.add(fullPath);
      saveWorkspaceFolders(workspaceId, [...folders]);
      openFolders.add(fullPath);
      renderConnectionList();
      scheduleProfileAutoSync();
      toast(`Carpeta "${name}" creada`, "success");
    } else if (e.key === "Escape") {
      wrapper.remove();
    }
  });

  // Cancelar si pierde el foco sin confirmar
  input.addEventListener("blur", () => setTimeout(() => wrapper.remove(), 200));
}

async function renameFolder(folderPath, workspaceId = getActiveWorkspaceId()) {
  const parts = folderPath.split("/");
  const currentName = parts.at(-1);
  const newName = await promptTextValue({
    title: t("sidebar.rename_folder"),
    label: t("sidebar.folder_prompt_rename"),
    initialValue: currentName,
  });
  if (!newName || newName === currentName) return;

  const newPath = [...parts.slice(0, -1), newName].join("/") || newName;
  const prefix    = folderPath + "/";
  const newPrefix = newPath + "/";
  const updatedAt = new Date().toISOString();

  // Actualizar perfiles que estén en esta carpeta o subcarpetas
  for (const p of profiles) {
    if (profileWorkspaceId(p) !== workspaceId) continue;
    if (!p.group) continue;
    let newGroup = null;
    if (p.group === folderPath) {
      newGroup = newPath;
    } else if (p.group.startsWith(prefix)) {
      newGroup = newPrefix + p.group.slice(prefix.length);
    } else {
      continue;
    }
    const updated = { ...p, group: newGroup, updated_at: updatedAt };
    await invoke("save_profile", { profile: updated }).catch(() => {});
    profiles[profiles.findIndex((x) => x.id === p.id)] = updated;
  }

  // Actualizar userFolders
  const toAdd = [];
  const folders = new Set(getWorkspaceFolders(workspaceId));
  for (const f of [...folders]) {
    if (f === folderPath) { folders.delete(f); toAdd.push(newPath); }
    else if (f.startsWith(prefix)) { folders.delete(f); toAdd.push(newPrefix + f.slice(prefix.length)); }
  }
  toAdd.forEach((f) => folders.add(f));
  saveWorkspaceFolders(workspaceId, [...folders]);

  // Remapear colores asignados a la carpeta o sus descendientes
  remapFolderColors(workspaceId, workspaceId, folderPath, newPath);

  // Actualizar estado de apertura
  if (openFolders.has(folderPath)) { openFolders.delete(folderPath); openFolders.add(newPath); }

  renderConnectionList();
  scheduleProfileAutoSync();
  toast(`Carpeta renombrada a "${newName.trim()}"`, "success");
}

async function deleteFolderAndMoveConnections(folderPath, workspaceId = getActiveWorkspaceId()) {
  const count = profiles.filter(
    (p) => profileWorkspaceId(p) === workspaceId && folderContainsPath(p.group, folderPath)
  ).length;

  const folderName = folderPath.includes("/")
    ? folderPath.slice(folderPath.lastIndexOf("/") + 1)
    : folderPath;

  if (count > 0) {
    const ok = await confirmDestructiveTyped({
      title: t("sidebar.delete_folder"),
      message: `¿Eliminar la carpeta "${folderPath}"?\n${count} conexión(es) se moverán a la raíz.`,
      expectedText: folderName,
      danger: true,
    });
    if (!ok) return;
  } else {
    const ok = await confirmThemed({
      title: t("sidebar.delete_folder"),
      message: `¿Eliminar la carpeta vacía "${folderPath}"?`,
      submitLabel: t("modal_destructive.submit"),
      danger: true,
    });
    if (!ok) return;
  }

  const updatedAt = new Date().toISOString();
  for (const p of profiles) {
    if (profileWorkspaceId(p) !== workspaceId || !folderContainsPath(p.group, folderPath)) continue;
    const updated = { ...p, group: null, updated_at: updatedAt };
    await invoke("save_profile", { profile: updated }).catch(() => {});
    profiles[profiles.findIndex((x) => x.id === p.id)] = updated;
  }

  // Eliminar la carpeta y todas sus subcarpetas de userFolders
  const folders = new Set(getWorkspaceFolders(workspaceId));
  for (const f of [...folders]) {
    if (folderContainsPath(f, folderPath)) folders.delete(f);
  }
  saveWorkspaceFolders(workspaceId, [...folders]);
  openFolders.delete(folderPath);

  // Limpiar colores asignados a la carpeta y sus descendientes
  deleteFolderColors(workspaceId, folderPath);

  renderConnectionList();
  scheduleProfileAutoSync();
  toast(`Carpeta "${folderPath}" eliminada`, "info");
}

// ═══════════════════════════════════════════════════════════════
// MODAL DE CONEXIÓN
// ═══════════════════════════════════════════════════════════════

const CONNECTION_MODAL_SIZE_KEY = "rustty-connection-modal-size";
const CONNECTION_MODAL_DEFAULT_WIDTH = 480;
const CONNECTION_MODAL_DEFAULT_HEIGHT = null;
const CONNECTION_MODAL_MIN_WIDTH = 480;
const CONNECTION_MODAL_MIN_HEIGHT = 360;

function keepAliveFromInput(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 3600);
}

function autoReconnectFromInput(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 20);
}

function wolPortFromInput(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 65535);
}

const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a18.54 18.54 0 0 1 4.93-5.66"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a18.6 18.6 0 0 1-2.06 3.06"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="3" y1="3" x2="21" y2="21"/></svg>`;

function setPasswordVisible(visible) {
  const input = document.getElementById("f-password");
  const btn = document.getElementById("btn-toggle-password");
  if (!input || !btn) return;

  input.type = visible ? "text" : "password";
  btn.setAttribute("aria-pressed", visible ? "true" : "false");
  btn.innerHTML = visible ? EYE_CLOSED_SVG : EYE_OPEN_SVG;

  const label = t(visible ? "modal_conn.hide_password" : "modal_conn.show_password");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

/**
 * Abre el modal para nueva conexión.
 * @param {string|null} preselectedFolder  Carpeta a preseleccionar en el picker
 * @param {string|null} workspaceId Workspace inicial
 */
// ── Algoritmos legacy seleccionables ───────────────────────────────────────
// El catálogo viene del backend (comando `legacy_algorithm_catalog`) para que
// lo que se muestra sea exactamente lo que se negocia. Se cachea tras la primera
// carga. Orden de categorías en la UI.
let legacyAlgoCatalog = null;
const LEGACY_CATEGORY_ORDER = ["cipher", "kex", "mac", "hostkey"];

async function ensureLegacyAlgoCatalog() {
  if (legacyAlgoCatalog) return legacyAlgoCatalog;
  try {
    legacyAlgoCatalog = await invoke("legacy_algorithm_catalog");
  } catch (e) {
    console.error("No se pudo cargar el catálogo de algoritmos legacy", e);
    legacyAlgoCatalog = [];
  }
  return legacyAlgoCatalog;
}

// Pinta las casillas agrupadas por categoría. `selectedIds` null = todas
// marcadas (perfil sin selección explícita); array = solo esas marcadas.
function renderLegacyAlgorithms(catalog, selectedIds) {
  const host = document.getElementById("legacy-algorithms-groups");
  if (!host) return;
  const isOn = (id) => selectedIds == null || selectedIds.includes(id);
  const byCat = {};
  for (const e of catalog) (byCat[e.category] ||= []).push(e);
  const cats = LEGACY_CATEGORY_ORDER.filter((c) => byCat[c]);
  host.innerHTML = cats
    .map((cat) => {
      const items = byCat[cat]
        .map(
          (e) => `
        <label class="checkbox-label legacy-algo-item">
          <input type="checkbox" class="legacy-algo-cb" value="${escHtml(e.id)}"${isOn(e.id) ? " checked" : ""} />
          <span>${escHtml(e.id)}</span>
        </label>`,
        )
        .join("");
      return `<div class="legacy-algo-group">
        <div class="legacy-algo-cat">${escHtml(t("modal_conn.legacy_cat_" + cat))}</div>
        <div class="legacy-algo-items">${items}</div>
      </div>`;
    })
    .join("");
}

function updateLegacyAlgosVisibility() {
  const on = document.getElementById("f-allow-legacy")?.checked;
  const box = document.getElementById("legacy-algorithms-list");
  if (box) box.hidden = !on;
}

// Renderiza las casillas con el estado del perfil y ajusta la visibilidad.
async function applyLegacyAlgorithmsUI(selectedIds) {
  const catalog = await ensureLegacyAlgoCatalog();
  renderLegacyAlgorithms(catalog, selectedIds);
  updateLegacyAlgosVisibility();
}

// Devuelve el valor a persistir: null si el toggle está apagado o si están
// todas marcadas (= todas, incluye futuras ampliaciones); array de ids si es
// una selección parcial.
function collectLegacyAlgorithms() {
  const on = document.getElementById("f-allow-legacy")?.checked;
  if (!on) return null;
  const cbs = Array.from(document.querySelectorAll(".legacy-algo-cb"));
  if (cbs.length === 0) return null;
  const checked = cbs.filter((c) => c.checked).map((c) => c.value);
  if (checked.length === cbs.length) return null;
  return checked;
}

function openNewConnectionModal(preselectedFolder = null, workspaceId = getActiveWorkspaceId()) {
  editingProfileId = null;
  resetConnectionTestPanel();
  document.getElementById("modal-title").textContent = "Nueva conexión";
  document.getElementById("form-connection").reset();
  setPasswordVisible(false);
  clearExtraCredRows();
  document.getElementById("f-conn-type").value = "ssh";
  document.getElementById("f-notes").value = "";
  setupModalNotePane();
  document.getElementById("f-save-password").checked = true;
  document.getElementById("f-save-passphrase").checked = true;
  applyLegacyAlgorithmsUI(null);
  setPasswordSource("own");
  populateMasterCredSelect(null);
  refreshKeepassStatus().then(() => {
    populateKeepassEntrySelect(null);
    updateConnTypeFields("ssh");
  });
  populateFolderSelect(preselectedFolder, workspaceId);
  populateWorkspaceFormSelect(workspaceId);
  // Las plantillas solo se ofrecen al crear (no al editar).
  document.getElementById("field-template")?.classList.remove("hidden");
  populateTemplateSelect();
  setConnectionModalPane("general");
  clearAllConnectionModalErrors();
  renderConnectionSummary();
  applyConnectionModalSize();
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("f-name").focus();
}

/**
 * Cambia la pestaña activa del modal de conexión. Slice estético #19.
 * Sincroniza la clase `active` de las tabs y el atributo
 * `data-active-pane` del form; CSS oculta los demás panes.
 */
function setConnectionModalPane(pane) {
  const form = document.getElementById("form-connection");
  if (!form) return;
  form.setAttribute("data-active-pane", pane);
  document.querySelectorAll(".modal-tab").forEach((btn) => {
    const active = btn.dataset.modalTab === pane;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

/**
 * Validación inline de un campo concreto. Escribe (o limpia) un mensaje
 * bajo el input usando el contenedor .form-error con `data-error-for`.
 * Devuelve true si el campo es válido. No es bloqueante: el guardado
 * sigue validándose por el flujo existente; esto solo da feedback visual.
 */
function validateConnectionField(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return true;
  const errEl = document.querySelector(`.form-error[data-error-for="${inputId}"]`);
  const value = (input.value || "").trim();
  let error = null;
  if (inputId === "f-host" && !value) error = t("modal_conn.err_host_required");
  if (inputId === "f-port") {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) error = t("modal_conn.err_port_range");
  }
  if (inputId === "f-proxy-jump" && value && !/^([^\s@]+@)?[^\s:]+(:\d{1,5})?$/.test(value)) {
    error = t("modal_conn.err_proxy_jump_format");
  }
  if (inputId === "f-mac-address" && value && !/^([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}$/.test(value)) {
    error = t("modal_conn.err_mac_format");
  }
  input.classList.toggle("input-invalid", !!error);
  if (errEl) {
    errEl.textContent = error || "";
    errEl.classList.toggle("hidden", !error);
  }
  return !error;
}

/**
 * Si el form tiene un campo inválido, salta a la pestaña que lo contiene
 * (subiendo en el DOM hasta encontrar el wrapper con `data-modal-pane`).
 * Útil para que `reportValidity()` nativo pueda enfocar el campo aunque
 * estuviera en un pane oculto por CSS.
 */
function revealFirstInvalidPane(form) {
  const invalid = form.querySelector(":invalid");
  if (!invalid) return;
  const paneWrap = invalid.closest("[data-modal-pane]");
  const pane = paneWrap?.getAttribute("data-modal-pane");
  if (pane) setConnectionModalPane(pane);
}

function clearAllConnectionModalErrors() {
  document.querySelectorAll("#form-connection .input-invalid").forEach((el) => el.classList.remove("input-invalid"));
  document.querySelectorAll("#form-connection .form-error").forEach((el) => {
    el.textContent = "";
    el.classList.add("hidden");
  });
}

/**
 * Renderiza el resumen "Lo que se va a usar" bajo el formulario.
 * Mira los campos críticos y muestra badges con la configuración
 * efectiva. Slice estético #19 (fase B).
 */
function renderConnectionSummary() {
  const root = document.getElementById("modal-conn-summary");
  if (!root) return;
  const connType = document.getElementById("f-conn-type")?.value || "ssh";
  const badges = [];

  if (connType === "ssh") {
    const authType = document.getElementById("f-auth-type")?.value || "password";
    const useKeepass = document.getElementById("f-use-keepass")?.checked;
    if (useKeepass) badges.push({ kind: "info", label: t("modal_conn.summary_auth_keepass") });
    else if (authType === "password") badges.push({ kind: "info", label: t("modal_conn.summary_auth_password") });
    else if (authType === "public_key") badges.push({ kind: "info", label: t("modal_conn.summary_auth_publickey") });
    else if (authType === "agent") badges.push({ kind: "info", label: t("modal_conn.summary_auth_agent") });

    const bastion = (document.getElementById("f-proxy-jump")?.value || "").trim();
    if (bastion) badges.push({ kind: "info", label: t("modal_conn.summary_bastion", { host: bastion }) });

    const ka = parseInt(document.getElementById("f-keep-alive")?.value || "0", 10);
    if (Number.isFinite(ka) && ka > 0) badges.push({ kind: "info", label: t("modal_conn.summary_keepalive", { n: ka }) });

    const recon = parseInt(document.getElementById("f-auto-reconnect")?.value || "0", 10);
    if (Number.isFinite(recon) && recon > 0) badges.push({ kind: "info", label: t("modal_conn.summary_reconnect", { n: recon }) });

    if (document.getElementById("f-allow-legacy")?.checked) badges.push({ kind: "warn", label: t("modal_conn.summary_legacy") });
    if (document.getElementById("f-agent-forwarding")?.checked) badges.push({ kind: "info", label: t("modal_conn.summary_agent_fwd") });
    if (document.getElementById("f-x11-forwarding")?.checked) badges.push({ kind: "info", label: t("modal_conn.summary_x11_fwd") });
    if (document.getElementById("f-session-log")?.checked) badges.push({ kind: "info", label: t("modal_conn.summary_session_log") });
    if ((document.getElementById("f-mac-address")?.value || "").trim()) badges.push({ kind: "info", label: t("modal_conn.summary_wol") });
  }

  if (badges.length === 0) {
    root.innerHTML = "";
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  root.innerHTML = badges
    .map((b) => `<span class="modal-summary-badge ${b.kind === "warn" ? "warn" : ""}">${escHtml(b.label)}</span>`)
    .join("");
}

function populateWorkspaceFormSelect(selectedId) {
  const field = document.getElementById("field-workspace");
  const sel = document.getElementById("f-workspace");
  if (!field || !sel) return;
  const list = Array.isArray(prefs.workspaces) ? prefs.workspaces : [];
  if (list.length <= 1) {
    field.classList.add("hidden");
    sel.innerHTML = "";
    return;
  }
  field.classList.remove("hidden");
  sel.innerHTML = list
    .map((w) => `<option value="${escHtml(w.id)}"${w.id === selectedId ? " selected" : ""}>${escHtml(w.name)}</option>`)
    .join("");
}

function openEditConnectionModal(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  editingProfileId = profileId;
  resetConnectionTestPanel();
  setupModalNotePane();
  document.getElementById("field-template")?.classList.add("hidden");
  document.getElementById("modal-title").textContent = "Editar conexión";

  document.getElementById("f-name").value  = profile.name;
  document.getElementById("f-host").value  = profile.host;
  document.getElementById("f-port").value  = profile.port;
  document.getElementById("f-user").value  = profile.username;
  const connType = profile.connection_type || "ssh";
  document.getElementById("f-conn-type").value  = connType;
  document.getElementById("f-domain").value     = profile.domain || "";
  document.getElementById("f-notes").value      = profile.notes || "";
  document.getElementById("f-auth-type").value  = profile.auth_type;
  document.getElementById("f-key-path").value   = profile.key_path || "";
  document.getElementById("f-password").value = "";
  setPasswordVisible(false);
  document.getElementById("f-passphrase").value = "";
  document.getElementById("f-save-password").checked = true;
  document.getElementById("f-save-passphrase").checked = true;
  refreshStoredCredentialCheckboxes(profile);
  loadStoredCredentialsIntoConnectionModal(profile);
  populateExtraCredRows(profile);

  populateFolderSelect(profile.group || "", profile.workspace_id || getActiveWorkspaceId());
  document.getElementById("f-keep-alive").value = profile.keep_alive_secs ?? "";
  document.getElementById("f-allow-legacy").checked = !!profile.allow_legacy_algorithms;
  applyLegacyAlgorithmsUI(profile.legacy_algorithms ?? null);
  document.getElementById("f-agent-forwarding").checked = !!profile.agent_forwarding;
  const disablePasteConfirmEl = document.getElementById("f-disable-paste-confirm");
  if (disablePasteConfirmEl) disablePasteConfirmEl.checked = !!profile.disable_paste_confirm;
  document.getElementById("f-x11-forwarding").checked = !!profile.x11_forwarding;
  document.getElementById("f-auto-reconnect").value = profile.auto_reconnect ?? "";
  document.getElementById("f-session-log").checked = !!profile.session_log;
  document.getElementById("f-proxy-jump").value = profile.proxy_jump || "";
  document.getElementById("f-mac-address").value = profile.mac_address || "";
  document.getElementById("f-wol-broadcast").value = profile.wol_broadcast || "";
  document.getElementById("f-wol-port").value = profile.wol_port ?? "";
  populateWorkspaceFormSelect(profile.workspace_id || getActiveWorkspaceId());
  // Origen de la contraseña: migración en memoria coherente con el backend
  // (si viene `own` pero hay keepass_entry_uuid, se trata como keepass).
  let source = profile.password_source || "own";
  if (source === "own" && profile.keepass_entry_uuid) source = "keepass";
  setPasswordSource(source);
  populateMasterCredSelect(profile.master_credential_id || null);
  refreshKeepassStatus().then(() => {
    const propEl = document.getElementById("f-keepass-property");
    if (propEl) propEl.value = profile.keepass_property || "password";
    populateKeepassEntrySelect(profile.keepass_entry_uuid || null);
    updateConnTypeFields(connType);
    renderConnectionSummary();
  });
  setConnectionModalPane("general");
  clearAllConnectionModalErrors();
  renderConnectionSummary();
  applyConnectionModalSize();
  document.getElementById("modal-overlay").classList.remove("hidden");
}

// ─── Usuarios adicionales (identidades múltiples por conexión) ──────────────
// Ids de las identidades extra que existían al abrir el modal, para detectar
// cuáles se borraron y limpiar su entrada de keyring al guardar.
let originalExtraCredIds = [];

/** Destruye los desplegables mejorados de una fila para no fugar listeners. */
function destroyRowSelects(row) {
  row.querySelectorAll("select").forEach((s) => s._destroyEnhanced?.());
}

function clearExtraCredRows() {
  const list = document.getElementById("extra-creds-list");
  if (list) {
    list.querySelectorAll(".extra-cred-row").forEach(destroyRowSelects);
    list.innerHTML = "";
  }
  originalExtraCredIds = [];
}

/** Rellena un <select> con el catálogo de credenciales maestras. */
function fillMasterOptions(sel, selectedId) {
  sel.innerHTML = "";
  for (const m of masterCredentials || []) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  if (!masterCredentials?.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("modal_conn.master_cred_none");
    sel.appendChild(opt);
  }
  if (selectedId) sel.value = selectedId;
}

/** Añade una fila de identidad adicional al formulario. `cred` precarga datos. */
function addExtraCredRow(cred = null, { focus = true } = {}) {
  const list = document.getElementById("extra-creds-list");
  if (!list) return;
  const existing = !!cred;
  const row = document.createElement("div");
  row.className = "extra-cred-row";
  row.dataset.credId = cred?.id || crypto.randomUUID();
  row.dataset.existing = existing ? "1" : "0";

  // ── Línea 1: usuario · credencial principal · eliminar ──
  // El usuario y su credencial (contraseña / credencial maestra / clave) van
  // a la misma altura para leerse como un par.
  const line1 = document.createElement("div");
  line1.className = "extra-cred-line1";

  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.className = "extra-cred-user";
  userInput.placeholder = t("modal_conn.user_ph");
  userInput.value = cred?.username || "";

  const credSlot = document.createElement("div");
  credSlot.className = "extra-cred-cred";

  const passWrap = document.createElement("div");
  passWrap.className = "password-field extra-cred-passwrap";
  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.className = "extra-cred-pass";
  passInput.placeholder = existing ? "••••••••" : t("modal_conn.password");
  passWrap.appendChild(passInput);

  const masterSel = document.createElement("select");
  masterSel.className = "extra-cred-master";
  fillMasterOptions(masterSel, cred?.master_credential_id);

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "extra-cred-keypath";
  keyInput.placeholder = "~/.ssh/id_rsa";
  keyInput.value = cred?.key_path || "";

  credSlot.append(passWrap, masterSel, keyInput);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-icon extra-cred-remove";
  removeBtn.title = t("modal_conn.remove_user");
  removeBtn.setAttribute("aria-label", t("modal_conn.remove_user"));
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => {
    destroyRowSelects(row);
    row.remove();
    renderConnectionSummary();
  });

  line1.append(userInput, credSlot, removeBtn);

  // ── Línea 2: tipo de auth · origen (contraseña) / passphrase (clave) ──
  const line2 = document.createElement("div");
  line2.className = "extra-cred-line2";

  const authSel = document.createElement("select");
  authSel.className = "extra-cred-auth";
  for (const [val, key] of [
    ["password", "modal_conn.auth_password"],
    ["public_key", "modal_conn.auth_publickey"],
    ["agent", "modal_conn.auth_agent"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = t(key);
    authSel.appendChild(opt);
  }
  authSel.value = cred?.auth_type || "password";

  const srcSel = document.createElement("select");
  srcSel.className = "extra-cred-source";
  for (const [val, key] of [
    ["own", "modal_conn.password_source_own"],
    ["master", "modal_conn.password_source_master"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = t(key);
    srcSel.appendChild(opt);
  }
  srcSel.value = cred?.password_source === "master" ? "master" : "own";

  const ppWrap = document.createElement("div");
  ppWrap.className = "password-field extra-cred-ppwrap";
  const ppInput = document.createElement("input");
  ppInput.type = "password";
  ppInput.className = "extra-cred-passphrase";
  ppInput.placeholder = existing ? "••••••••" : t("modal_conn.passphrase");
  ppWrap.appendChild(ppInput);

  line2.append(authSel, srcSel, ppWrap);

  row.append(line1, line2);
  list.appendChild(row);

  // Mejorar los <select> al desplegable personalizado del resto del formulario.
  enhanceSelect(authSel);
  enhanceSelect(srcSel);
  enhanceSelect(masterSel);

  authSel.addEventListener("change", () => renderExtraCredFields(row));
  srcSel.addEventListener("change", () => renderExtraCredFields(row));

  renderExtraCredFields(row);
  if (focus) userInput.focus();
}

/**
 * Muestra u oculta los campos de una fila de identidad extra según el tipo de
 * auth y, para contraseña, el origen (propia / credencial maestra). No recrea
 * los controles: solo alterna su visibilidad, de modo que el valor elegido en
 * cada desplegable se conserva.
 */
function renderExtraCredFields(row) {
  const authType = row.querySelector(".extra-cred-auth").value;
  const source = row.querySelector(".extra-cred-source").value;
  const isPwd = authType === "password";
  const isKey = authType === "public_key";
  const isMaster = isPwd && source === "master";

  const show = (sel, on) => {
    const el = row.querySelector(sel);
    if (el) (el.closest(".custom-select") || el).classList.toggle("hidden", !on);
  };
  show(".extra-cred-source", isPwd);
  show(".extra-cred-passwrap", isPwd && !isMaster);
  show(".extra-cred-master", isMaster);
  show(".extra-cred-keypath", isKey);
  show(".extra-cred-ppwrap", isKey);
}

/** Rellena las filas de identidades extra desde un perfil. */
async function populateExtraCredRows(profile) {
  clearExtraCredRows();
  const creds = profile?.extra_credentials || [];
  originalExtraCredIds = creds.map((c) => c.id);
  // Si alguna identidad usa credencial maestra, asegurar el catálogo cargado
  // para que su selector muestre el nombre correcto.
  if (creds.some((c) => c.password_source === "master") && !masterCredentials?.length) {
    try {
      masterCredentials = ((await invoke("master_cred_list")) || []).filter((c) => c.kind === "master");
    } catch { /* el selector quedará vacío; no bloquea */ }
  }
  for (const c of creds) addExtraCredRow(c, { focus: false });
}

/**
 * Recoge las identidades extra del formulario. Devuelve la lista de
 * `ProfileCredential` (sin secretos), las contraseñas a escribir en keyring y
 * las claves a borrar (identidades eliminadas o vaciadas).
 */
function collectExtraCredsFromForm(profileId) {
  const rows = [...document.querySelectorAll("#extra-creds-list .extra-cred-row")];
  const creds = [];
  const passwordWrites = [];
  const keptIds = new Set();
  for (const row of rows) {
    const id = row.dataset.credId;
    const username = row.querySelector(".extra-cred-user").value.trim();
    if (!username) continue; // ignora filas sin usuario
    keptIds.add(id);

    const authType = row.querySelector(".extra-cred-auth").value;
    let passwordSource = "own";
    let masterCredentialId = null;
    let keyPath = null;

    if (authType === "password") {
      const source = row.querySelector(".extra-cred-source")?.value || "own";
      if (source === "master") {
        passwordSource = "master";
        masterCredentialId = row.querySelector(".extra-cred-master")?.value || null;
      } else {
        const pass = row.querySelector(".extra-cred-pass")?.value;
        if (pass) passwordWrites.push({ key: credPasswordKey(profileId, id), secret: pass });
      }
    } else if (authType === "public_key") {
      keyPath = row.querySelector(".extra-cred-keypath")?.value.trim() || null;
      const pp = row.querySelector(".extra-cred-passphrase")?.value;
      if (pp) passwordWrites.push({ key: credPassphraseKey(profileId, id), secret: pp });
    }

    creds.push({
      id,
      username,
      label: null,
      auth_type: authType,
      key_path: keyPath,
      password_source: passwordSource,
      master_credential_id: masterCredentialId,
    });
  }
  // Identidades que existían y ya no están → borrar su keyring (pwd y passphrase).
  const deletes = [];
  for (const id of originalExtraCredIds) {
    if (!keptIds.has(id)) {
      deletes.push(credPasswordKey(profileId, id));
      deletes.push(credPassphraseKey(profileId, id));
    }
  }
  return { creds, passwordWrites, deletes };
}

async function deleteStoredSecret(key) {
  return invoke("keyring_delete", { service: KEYRING_SERVICE, key })
    .catch((err) => console.warn("[keyring] delete failed", key, err));
}

/**
 * Selector avanzado de entradas KeePass. Combina:
 * - un input de búsqueda (filtra título/usuario/URL/grupo)
 * - un hidden input que guarda el UUID seleccionado (el modelo del perfil)
 * - una lista desplegable con columnas Grupo / Título / Usuario / URL y
 *   sección de "Recientes" persistida en `prefs.recentKeepassEntries`.
 */
function populateKeepassEntrySelect(selectedUuid) {
  const search = document.getElementById("f-keepass-search");
  const hidden = document.getElementById("f-keepass-entry");
  const clearBtn = document.getElementById("btn-keepass-clear");
  if (!search || !hidden) return;
  hidden.value = selectedUuid || "";
  if (selectedUuid) {
    const entry = keepassEntries.find((e) => e.uuid === selectedUuid);
    search.value = entry ? formatKeepassEntryLine(entry) : "";
  } else {
    search.value = "";
  }
  if (clearBtn) clearBtn.classList.toggle("hidden", !selectedUuid);
  closeKeepassPicker();
  updateKeepassEntryValidation();
}

function formatKeepassEntryLine(entry) {
  if (!entry) return "";
  const title = entry.title || "(sin título)";
  const userPart = entry.username ? ` — ${entry.username}` : "";
  return entry.group ? `${entry.group} / ${title}${userPart}` : `${title}${userPart}`;
}

function keepassEntryLabel(entry) {
  if (!entry) return "";
  const title = entry.title || "(sin título)";
  return entry.group ? `${entry.group} / ${title}` : title;
}

function filterKeepassEntries(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return keepassEntries.slice();
  return keepassEntries.filter((e) => {
    return (
      (e.title || "").toLowerCase().includes(q) ||
      (e.username || "").toLowerCase().includes(q) ||
      (e.url || "").toLowerCase().includes(q) ||
      (e.group || "").toLowerCase().includes(q)
    );
  });
}

function recordKeepassRecent(uuid) {
  if (!uuid) return;
  const list = Array.isArray(prefs.recentKeepassEntries) ? prefs.recentKeepassEntries : [];
  const next = [uuid, ...list.filter((id) => id !== uuid)].slice(0, 8);
  prefs.recentKeepassEntries = next;
  try { savePrefs(); } catch { /* tolerable */ }
}

function renderKeepassPickerList(query) {
  const list = document.getElementById("keepass-picker-list");
  if (!list) return;
  if (!keepassUnlocked) {
    list.innerHTML = `<div class="keepass-picker-empty">${escHtml(t("modal_conn.keepass_entry_status_locked"))}</div>`;
    return;
  }
  const all = filterKeepassEntries(query);
  const recentIds = Array.isArray(prefs.recentKeepassEntries) ? prefs.recentKeepassEntries : [];
  const recent = !query
    ? recentIds
        .map((id) => keepassEntries.find((e) => e.uuid === id))
        .filter(Boolean)
    : [];
  const recentSet = new Set(recent.map((e) => e.uuid));
  const allOther = all.filter((e) => !recentSet.has(e.uuid));

  if (all.length === 0 && recent.length === 0) {
    list.innerHTML = `<div class="keepass-picker-empty">${escHtml(t("modal_conn.keepass_no_results"))}</div>`;
    return;
  }

  const renderItem = (e) => `
    <div class="keepass-picker-item" role="option" data-uuid="${escHtml(e.uuid)}" title="${escHtml(formatKeepassEntryLine(e))}">
      <span class="kp-col kp-col-group">${escHtml(e.group || "")}</span>
      <span class="kp-col kp-col-title">${escHtml(e.title || "(sin título)")}</span>
      <span class="kp-col kp-col-user">${escHtml(e.username || "")}</span>
      <span class="kp-col kp-col-url">${escHtml(e.url || "")}</span>
    </div>`;

  let html = "";
  if (recent.length) {
    html += `<div class="keepass-picker-section-label">${escHtml(t("modal_conn.keepass_recent_label"))}</div>`;
    html += recent.map(renderItem).join("");
    if (allOther.length) {
      html += `<div class="keepass-picker-section-label">${escHtml(t("modal_conn.keepass_all_label"))}</div>`;
    }
  }
  html += allOther.map(renderItem).join("");
  list.innerHTML = html;
}

function openKeepassPicker() {
  const list = document.getElementById("keepass-picker-list");
  const search = document.getElementById("f-keepass-search");
  if (!list || !search) return;
  list.classList.remove("hidden");
  search.setAttribute("aria-expanded", "true");
  renderKeepassPickerList(search.value);
}

function closeKeepassPicker() {
  const list = document.getElementById("keepass-picker-list");
  const search = document.getElementById("f-keepass-search");
  if (!list || !search) return;
  list.classList.add("hidden");
  search.setAttribute("aria-expanded", "false");
}

function selectKeepassEntry(uuid) {
  const entry = keepassEntries.find((e) => e.uuid === uuid);
  if (!entry) return;
  recordKeepassRecent(uuid);
  populateKeepassEntrySelect(uuid);
}

function updateKeepassEntryValidation() {
  const status = document.getElementById("keepass-entry-status");
  const hidden = document.getElementById("f-keepass-entry");
  const useKp = document.getElementById("f-use-keepass")?.checked;
  const authType = document.getElementById("f-auth-type")?.value;
  if (!status || !hidden) return;

  status.classList.remove("ok", "warning", "error");
  const visible = authType === "password" && useKp;
  status.classList.toggle("hidden", !visible);
  if (!visible) {
    status.textContent = "";
    return;
  }

  if (!keepassUnlocked) {
    status.textContent = t("modal_conn.keepass_entry_status_locked");
    status.classList.add("warning");
    return;
  }

  const uuid = hidden.value;
  if (!uuid) {
    status.textContent = t("modal_conn.keepass_entry_status_select");
    status.classList.add("warning");
    return;
  }

  const entry = keepassEntries.find((e) => e.uuid === uuid);
  if (!entry) {
    status.textContent = t("modal_conn.keepass_entry_status_not_found");
    status.classList.add("error");
    return;
  }

  const property = document.getElementById("f-keepass-property")?.value || "password";
  const user = entry.username
    ? t("modal_conn.keepass_entry_status_user", { username: entry.username })
    : t("modal_conn.keepass_entry_status_no_user");
  const entryLabel = keepassEntryLabel(entry);

  if (property === "password") {
    const textKey = entry.has_password
      ? "modal_conn.keepass_entry_status_ok"
      : "modal_conn.keepass_entry_status_no_password";
    status.textContent = t(textKey, { entry: entryLabel, user });
    status.classList.add(entry.has_password ? "ok" : "error");
    return;
  }

  const propertyHasValue = (() => {
    switch (property) {
      case "username": return !!entry.username;
      case "title":    return !!entry.title;
      case "url":      return !!entry.url;
      case "notes":    return !!entry.has_notes;
      default:         return false;
    }
  })();
  const propertyLabel = t(`modal_conn.keepass_property_${property}`);
  if (propertyHasValue) {
    status.textContent = t("modal_conn.keepass_entry_status_property_ok", {
      entry: entryLabel,
      user,
      property: propertyLabel,
    });
    status.classList.add("ok");
  } else {
    status.textContent = t("modal_conn.keepass_entry_status_property_empty", {
      entry: entryLabel,
    });
    status.classList.add("error");
  }
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  document.getElementById("form-connection").reset();
  setPasswordVisible(false);
  resetConnectionTestPanel();
  closeKeepassPicker();
  const hiddenKp = document.getElementById("f-keepass-entry");
  if (hiddenKp) hiddenKp.value = "";
  document.getElementById("btn-keepass-clear")?.classList.add("hidden");
  editingProfileId = null;
}

function getConnectionModalSizeLimits() {
  return {
    minWidth: Math.min(CONNECTION_MODAL_MIN_WIDTH, Math.floor(window.innerWidth * 0.95)),
    minHeight: Math.min(CONNECTION_MODAL_MIN_HEIGHT, Math.floor(window.innerHeight * 0.9)),
    maxWidth: Math.floor(window.innerWidth * 0.95),
    maxHeight: Math.floor(window.innerHeight * 0.9),
  };
}

function clampConnectionModalSize(width, height) {
  const limits = getConnectionModalSizeLimits();
  return {
    width: Math.min(limits.maxWidth, Math.max(limits.minWidth, Math.round(width || CONNECTION_MODAL_DEFAULT_WIDTH))),
    height: height
      ? Math.min(limits.maxHeight, Math.max(limits.minHeight, Math.round(height)))
      : null,
  };
}

function applyConnectionModalSize() {
  const modal = document.getElementById("modal-connection");
  if (!modal) return;
  let size = null;
  try { size = JSON.parse(localStorage.getItem(CONNECTION_MODAL_SIZE_KEY) || "null"); } catch {}
  if (!size) {
    modal.style.width = `${CONNECTION_MODAL_DEFAULT_WIDTH}px`;
    modal.style.height = CONNECTION_MODAL_DEFAULT_HEIGHT ? `${CONNECTION_MODAL_DEFAULT_HEIGHT}px` : "";
    return;
  }
  const clamped = clampConnectionModalSize(size.width, size.height);
  modal.style.width = `${clamped.width}px`;
  modal.style.height = clamped.height ? `${clamped.height}px` : "";
}

function resetConnectionModalSize() {
  const modal = document.getElementById("modal-connection");
  localStorage.removeItem(CONNECTION_MODAL_SIZE_KEY);
  if (!modal) return;
  modal.style.width = `${CONNECTION_MODAL_DEFAULT_WIDTH}px`;
  modal.style.height = "";
}

function initConnectionModalResizePersistence() {
  const modal = document.getElementById("modal-connection");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay || typeof ResizeObserver === "undefined") return;

  let saveTimer = null;
  const saveSize = () => {
    if (overlay.classList.contains("hidden")) return;
    const rect = modal.getBoundingClientRect();
    const size = clampConnectionModalSize(rect.width, rect.height);
    localStorage.setItem(CONNECTION_MODAL_SIZE_KEY, JSON.stringify(size));
  };

  const observer = new ResizeObserver(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSize, 250);
  });
  observer.observe(modal);

  modal.addEventListener("dblclick", (e) => {
    const rect = modal.getBoundingClientRect();
    const nearResizeCorner = e.clientX >= rect.right - 28 && e.clientY >= rect.bottom - 28;
    if (nearResizeCorner) resetConnectionModalSize();
  });

  window.addEventListener("resize", () => {
    if (!overlay.classList.contains("hidden")) applyConnectionModalSize();
  });
}

/** Rellena el <select> de carpetas con todos los paths existentes */
function populateFolderSelect(selectedPath = null, workspaceId = getActiveWorkspaceId()) {
  const select = document.getElementById("f-folder-select");
  const input  = document.getElementById("f-folder-input");
  const paths  = getAllFolderPaths(workspaceId);

  let opts = `<option value="">Sin carpeta (raíz)</option>`;
  for (const p of paths) {
    opts += `<option value="${escHtml(p)}"${p === selectedPath ? " selected" : ""}>${escHtml(p)}</option>`;
  }
  opts += `<option value="__new__">+ Nueva carpeta…</option>`;
  select.innerHTML = opts;

  // Si el path seleccionado no está en la lista, activar el input manual
  const isKnown = !selectedPath || paths.includes(selectedPath);
  if (!isKnown) {
    select.value = "__new__";
    input.value  = selectedPath || "";
    input.classList.remove("hidden");
  } else {
    input.classList.add("hidden");
  }
}

/** Catálogo de credenciales maestras cacheado para el desplegable del form. */
let masterCredentials = [];

/** Devuelve el origen de contraseña seleccionado en el form (own/master/keepass). */
function getPasswordSource() {
  return document.getElementById("f-password-source")?.value || "own";
}

/**
 * Fija el origen de contraseña del form y sincroniza el checkbox histórico
 * `f-use-keepass` (que sigue siendo consultado por toda la lógica KeePass).
 */
function setPasswordSource(source) {
  const sel = document.getElementById("f-password-source");
  if (sel) sel.value = source;
  const kp = document.getElementById("f-use-keepass");
  if (kp) kp.checked = source === "keepass";
}

/**
 * Puebla `#f-master-cred` con las credenciales maestras del catálogo. Si
 * `selectedId` referencia una credencial ausente, muestra el aviso de fallback.
 */
async function populateMasterCredSelect(selectedId) {
  const sel = document.getElementById("f-master-cred");
  const missing = document.getElementById("master-cred-missing");
  if (!sel) return;
  try {
    const all = await invoke("master_cred_list");
    masterCredentials = (all || []).filter((c) => c.kind === "master");
  } catch {
    masterCredentials = [];
  }
  sel.innerHTML = "";
  for (const cred of masterCredentials) {
    const opt = document.createElement("option");
    opt.value = cred.id;
    opt.textContent = cred.name;
    sel.appendChild(opt);
  }
  const exists = selectedId && masterCredentials.some((c) => c.id === selectedId);
  if (exists) {
    sel.value = selectedId;
  } else if (masterCredentials.length) {
    sel.selectedIndex = 0;
  }
  // Aviso de fallback: el perfil referenciaba un id que ya no existe.
  if (missing) missing.classList.toggle("hidden", !(selectedId && !exists));
}

function updateAuthFields(authType) {
  const isPwd = authType === "password";
  if (!isPwd) setPasswordVisible(false);
  const source = getPasswordSource();
  const useKp = isPwd && source === "keepass";
  const useMaster = isPwd && source === "master";
  const useOwn = isPwd && source === "own";

  document.getElementById("field-password").classList.toggle("hidden", !useOwn);
  document.getElementById("field-save-password").classList.toggle("hidden", !useOwn);
  document.getElementById("field-key-path").classList.toggle("hidden", authType !== "public_key");
  document.getElementById("field-passphrase").classList.toggle("hidden", authType !== "public_key");
  document.getElementById("field-save-passphrase").classList.toggle("hidden", authType !== "public_key");

  // El selector de origen sólo aplica a auth=password.
  document.getElementById("field-password-source").classList.toggle("hidden", !isPwd);
  document.getElementById("field-keepass-entry").classList.toggle("hidden", !useKp);
  document.getElementById("field-keepass-property")?.classList.toggle("hidden", !useKp);
  document.getElementById("field-master-cred").classList.toggle("hidden", !useMaster);
  if (!useOwn) setPasswordVisible(false);

  // Hint cuando la DB KeePass no está desbloqueada.
  const hint = document.getElementById("keepass-hint-locked");
  if (hint) hint.style.display = (useKp && !keepassUnlocked) ? "" : "none";
  updateKeepassEntryValidation();
}

/**
 * Muestra/oculta campos según el tipo de conexión.
 * RDP y FTP/FTPS usan contraseña; SSH mantiene clave/agente y opciones avanzadas.
 */
function updateConnTypeFields(type, adjustPort = false) {
  const isRdp = type === "rdp";
  const isFileTransfer = isFileTransferConnectionType(type);
  const isPasswordOnly = isRdp || isFileTransfer;
  document.getElementById("field-domain").classList.toggle("hidden", !isRdp);
  document.getElementById("field-auth-type").classList.toggle("hidden", isPasswordOnly);
  document.getElementById("field-key-path").classList.add("hidden");
  document.getElementById("field-passphrase").classList.add("hidden");
  document.getElementById("field-save-passphrase").classList.add("hidden");
  document.getElementById("field-advanced").classList.toggle("hidden", isPasswordOnly);
  // Ocultar la pestaña "Avanzado" del modal cuando no aplique (RDP/FTP/FTPS).
  document.querySelectorAll('.modal-tab[data-modal-tab="advanced"]').forEach((tab) => {
    tab.classList.toggle("hidden", isPasswordOnly);
    // Si la tab activa quedó oculta, vuelve a "general".
    if (isPasswordOnly && tab.classList.contains("active")) setConnectionModalPane("general");
  });

  if (isPasswordOnly) {
    document.getElementById("f-auth-type").value = "password";
    // RDP/FTP siempre usan auth=password: reutilizamos updateAuthFields para
    // que el selector de origen (own/master/keepass) muestre el campo correcto.
    updateAuthFields("password");
    if (adjustPort) {
      const portEl = document.getElementById("f-port");
      const current = parseInt(portEl.value, 10);
      if (isRdp && (current === 22 || current === 21)) portEl.value = 3389;
      if (isFileTransfer && (current === 22 || current === 3389)) portEl.value = 21;
    }
    updateKeepassEntryValidation();
  } else {
    updateAuthFields(document.getElementById("f-auth-type").value);
    if (adjustPort) {
      const portEl = document.getElementById("f-port");
      const current = parseInt(portEl.value, 10);
      if (current === 3389 || current === 21) portEl.value = 22;
    }
  }
}

function passwordKey(profileId) {
  return `password:${profileId}`;
}

function passphraseKey(profileId) {
  return `passphrase:${profileId}`;
}

// Claves de keyring de las identidades adicionales (usuarios extra). La
// principal usa `password:<id>` / `passphrase:<id>`; cada identidad extra
// indexa por su `credential_id` para no colisionar.
function credPasswordKey(profileId, credId) {
  return `password:${profileId}:${credId}`;
}

function credPassphraseKey(profileId, credId) {
  return `passphrase:${profileId}:${credId}`;
}

async function getStoredSecret(key) {
  return invoke("keyring_get", {
    service: KEYRING_SERVICE,
    key,
  }).catch((err) => {
    console.warn("[keyring] get failed", key, err);
    return null;
  });
}

async function saveStoredSecret(key, secret, label = "credencial") {
  if (!secret) return false;
  try {
    await invoke("keyring_set", {
      service: KEYRING_SERVICE,
      key,
      secret,
    });
    prefs._secretsTs = prefs._secretsTs || {};
    prefs._secretsTs[key] = new Date().toISOString();
    savePrefs();
    if (_syncConfigCache?.selective?.secrets) scheduleProfileAutoSync();
    return true;
  } catch (err) {
    console.warn("[keyring] set failed", key, err);
    toast(`No se pudo guardar la ${label} en el keyring: ${err}`, "warning", 8000);
    return false;
  }
}

let credentialPromptResolve = null;
let credentialExtraActionButtons = [];

function credentialTarget(profile) {
  const user = String(profile?.username || "").trim();
  const host = String(profile?.host || "").trim();
  return user && host ? `${user}@${host}` : (host || user || profile?.name || "");
}

function initCredentialModalEvents() {
  const overlay = document.getElementById("credential-modal-overlay");
  const form = document.getElementById("credential-modal-form");
  const cancelBtn = document.getElementById("btn-credential-cancel");
  const closeBtn = document.getElementById("btn-credential-close");
  if (!overlay || !form || !cancelBtn || !closeBtn) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("credential-modal-input");
    const remember = document.getElementById("credential-modal-remember");
    closeCredentialPrompt({
      action: "submit",
      value: input?.value ?? "",
      remember: !!remember?.checked,
    });
  });
  cancelBtn.addEventListener("click", () => closeCredentialPrompt(null));
  closeBtn.addEventListener("click", () => closeCredentialPrompt(null));
}

function closeCredentialPrompt(result = null) {
  const overlay = document.getElementById("credential-modal-overlay");
  if (overlay) overlay.classList.add("hidden");

  const inputRow = document.getElementById("credential-modal-input-row");
  const input = document.getElementById("credential-modal-input");
  const remember = document.getElementById("credential-modal-remember");
  const submitBtn = document.getElementById("btn-credential-submit");
  credentialExtraActionButtons.forEach((btn) => btn.remove());
  credentialExtraActionButtons = [];
  if (inputRow) inputRow.classList.remove("hidden");
  if (input) input.value = "";
  if (remember) remember.checked = false;
  if (submitBtn) submitBtn.classList.remove("danger");

  const resolve = credentialPromptResolve;
  credentialPromptResolve = null;
  if (resolve) resolve(result);
}

function promptCredential({
  title,
  message,
  label,
  rememberLabel,
  submitLabel = t("modal_credential.submit"),
  inputType = "password",
  initialValue = "",
  hideInput = false,
  danger = false,
  rememberDefault = false,
  extraActions = [],
}) {
  const overlay = document.getElementById("credential-modal-overlay");
  const titleEl = document.getElementById("credential-modal-title");
  const messageEl = document.getElementById("credential-modal-message");
  const labelEl = document.getElementById("credential-modal-label");
  const inputRow = document.getElementById("credential-modal-input-row");
  const input = document.getElementById("credential-modal-input");
  const rememberRow = document.getElementById("credential-modal-remember-row");
  const rememberLabelEl = document.getElementById("credential-modal-remember-label");
  const submitBtn = document.getElementById("btn-credential-submit");
  const actionsRow = submitBtn?.closest(".modal-actions");

  if (!overlay || !titleEl || !messageEl || !labelEl || !inputRow || !input || !rememberRow || !submitBtn) {
    console.warn("[credentials] modal is not available");
    return Promise.resolve(null);
  }

  if (credentialPromptResolve) closeCredentialPrompt(null);

  titleEl.textContent = title || t("modal_credential.password_title");
  messageEl.textContent = message || "";
  labelEl.textContent = label || t("modal_credential.password_label");
  input.type = inputType;
  input.value = initialValue;
  inputRow.classList.toggle("hidden", hideInput);
  submitBtn.textContent = submitLabel;
  submitBtn.classList.toggle("danger", danger);

  credentialExtraActionButtons.forEach((btn) => btn.remove());
  credentialExtraActionButtons = [];
  if (actionsRow) {
    extraActions.forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = action.className || "btn-secondary";
      if (action.danger) btn.classList.add("danger");
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        closeCredentialPrompt({
          action: action.value,
          value: input.value,
          remember: !!document.getElementById("credential-modal-remember")?.checked,
        });
      });
      actionsRow.insertBefore(btn, submitBtn);
      credentialExtraActionButtons.push(btn);
    });
  }

  if (rememberLabel) {
    rememberRow.classList.remove("hidden");
    rememberLabelEl.textContent = rememberLabel;
    const remember = document.getElementById("credential-modal-remember");
    if (remember) remember.checked = !!rememberDefault;
  } else {
    rememberRow.classList.add("hidden");
  }

  overlay.classList.remove("hidden");
  setTimeout(() => {
    if (hideInput) submitBtn.focus();
    else {
      input.focus();
      if (inputType === "text") input.select();
    }
  }, 0);

  return new Promise((resolve) => {
    credentialPromptResolve = resolve;
  });
}

async function promptTextValue({ title, message, label, initialValue = "", submitLabel = "Aceptar", validate = null }) {
  const promise = promptCredential({
    title,
    message,
    label,
    submitLabel,
    inputType: "text",
    initialValue,
  });

  // Validación en vivo opcional: mientras el valor sea inválido deshabilitamos el
  // botón y mostramos el motivo en el propio diálogo, en lugar de dejar que el
  // usuario confirme y avisarle a posteriori. `validate(value)` devuelve el
  // mensaje de error o `null` si el valor es aceptable.
  let inputHandler = null;
  const input = document.getElementById("credential-modal-input");
  const submitBtn = document.getElementById("btn-credential-submit");
  const messageEl = document.getElementById("credential-modal-message");
  if (validate && input && submitBtn && messageEl) {
    const baseMessage = message || "";
    inputHandler = () => {
      const value = input.value.trim();
      if (!value) {
        // Vacío: estado neutro (botón inhabilitado, sin texto de error).
        submitBtn.disabled = true;
        messageEl.textContent = baseMessage;
        messageEl.style.color = "";
        return;
      }
      const reason = validate(value);
      submitBtn.disabled = !!reason;
      messageEl.textContent = reason || baseMessage;
      messageEl.style.color = reason ? "var(--danger, #e06c75)" : "";
    };
    input.addEventListener("input", inputHandler);
    inputHandler();
  }

  const result = await promise;

  if (inputHandler && input) input.removeEventListener("input", inputHandler);
  if (submitBtn) submitBtn.disabled = false;
  if (messageEl) messageEl.style.color = "";

  if (!result) return null;
  const value = result.value.trim();
  return value || null;
}

/**
 * Devuelve el motivo por el que `name` no sirve como nombre de una entrada
 * (carpeta/archivo) o `null` si es válido. Un nombre debe ser un único
 * componente: si contiene «/» (separador de rutas en Unix y en el protocolo
 * SFTP) el sistema lo interpretaría como una jerarquía y crearía subcarpetas
 * en lugar de una sola entrada con ese nombre. En local sobre Windows «\»
 * también separa rutas.
 */
function invalidEntryNameReason(name, { isLocal = false } = {}) {
  const value = String(name ?? "").trim();
  if (!value) return "El nombre no puede estar vacío.";
  if (value === "." || value === "..") return "Ese nombre está reservado.";
  if (value.includes("/")) return "El nombre no puede contener «/».";
  // En remoto (Unix) «\» es un carácter válido en un nombre; solo lo vetamos
  // en local, donde puede actuar como separador de rutas (Windows).
  if (isLocal && value.includes("\\")) return "El nombre no puede contener «\\».";
  return null;
}

/**
 * Pide un nombre de entrada y lo valida como componente único. Reintenta
 * mientras sea inválido (conservando lo escrito) hasta que el usuario teclee
 * un nombre válido o cancele (→ `null`).
 */
async function promptEntryName({ title, message, label, submitLabel, initialValue = "", isLocal = false }) {
  let current = initialValue;
  for (;;) {
    const name = await promptTextValue({
      title, message, label, submitLabel, initialValue: current,
      validate: (value) => invalidEntryNameReason(value, { isLocal }),
    });
    if (!name) return null;
    // Red de seguridad: la validación en vivo ya impide confirmar un nombre
    // inválido, pero revalidamos por si se colara (p. ej. envío por Enter).
    const reason = invalidEntryNameReason(name, { isLocal });
    if (!reason) return name;
    toast(reason, "error");
    current = name;
  }
}

async function confirmThemed({ title, message, submitLabel = "Aceptar", danger = false }) {
  const result = await promptCredential({
    title,
    message,
    submitLabel,
    hideInput: true,
    danger,
  });
  return !!result;
}

/**
 * Confirmación destructiva con doble texto (estilo GitHub).
 * El usuario debe teclear `expectedText` para habilitar el botón de borrado.
 * Usar solo cuando la acción afecta a varios elementos (workspace con perfiles,
 * carpeta con perfiles, etc.).
 */
async function confirmDestructiveTyped({ title, message, expectedText, submitLabel, danger = true }) {
  const expected = String(expectedText || "").trim();
  if (!expected) {
    return confirmThemed({ title, message, submitLabel, danger });
  }
  const input = document.getElementById("credential-modal-input");
  const submitBtn = document.getElementById("btn-credential-submit");
  const labelEl = document.getElementById("credential-modal-label");

  let inputHandler = null;
  const cleanup = () => {
    if (inputHandler && input) input.removeEventListener("input", inputHandler);
    if (submitBtn) submitBtn.disabled = false;
    if (input) input.placeholder = "";
  };

  const promise = promptCredential({
    title,
    message,
    label: t("modal_destructive.type_to_confirm", { name: expected }),
    submitLabel: submitLabel || t("modal_destructive.submit"),
    danger,
    inputType: "text",
  });

  if (input && submitBtn) {
    submitBtn.disabled = true;
    input.placeholder = t("modal_destructive.type_to_confirm_placeholder", { name: expected });
    if (labelEl) labelEl.textContent = t("modal_destructive.type_to_confirm", { name: expected });
    inputHandler = () => {
      submitBtn.disabled = input.value.trim() !== expected;
    };
    input.addEventListener("input", inputHandler);
  }

  const result = await promise;
  cleanup();
  if (!result) return false;
  return String(result.value || "").trim() === expected;
}

async function chooseThemed({
  title,
  message,
  submitLabel = "Aceptar",
  rememberLabel,
  danger = false,
  actions = [],
}) {
  const result = await promptCredential({
    title,
    message,
    submitLabel,
    rememberLabel,
    hideInput: true,
    danger,
    extraActions: actions,
  });
  if (!result) return null;
  return {
    action: result.action || "submit",
    remember: !!result.remember,
  };
}

async function promptProfileSecret(profile, {
  titleKey,
  messageKey,
  labelKey,
  rememberKey,
  secretKey,
  secretLabel,
  submitKey = "modal_credential.submit",
}) {
  const result = await promptCredential({
    title: t(titleKey),
    message: t(messageKey, { target: credentialTarget(profile) }),
    label: t(labelKey),
    rememberLabel: rememberKey ? t(rememberKey) : null,
    rememberDefault: !!rememberKey,
    submitLabel: t(submitKey),
  });
  if (!result) return null;
  if (result.remember) await saveStoredSecret(secretKey, result.value, secretLabel);
  return result.value;
}

async function refreshStoredCredentialCheckboxes(profile) {
  const passwordCb = document.getElementById("f-save-password");
  const passphraseCb = document.getElementById("f-save-passphrase");
  if (passwordCb) passwordCb.checked = true;
  if (passphraseCb) passphraseCb.checked = true;
}

async function loadStoredCredentialsIntoConnectionModal(profile) {
  const profileId = profile?.id;
  if (!profileId) return;

  if (!profile.keepass_entry_uuid) {
    const password = await getStoredSecret(passwordKey(profileId));
    if (editingProfileId === profileId && password) {
      document.getElementById("f-password").value = password;
    }
  }

  if (profile.auth_type === "public_key") {
    const passphrase = await getStoredSecret(passphraseKey(profileId));
    if (editingProfileId === profileId && passphrase) {
      document.getElementById("f-passphrase").value = passphrase;
    }
  }
}

/** Lee el valor de carpeta del selector (select + input manual) */
function readFolderValue() {
  const select = document.getElementById("f-folder-select");
  const input  = document.getElementById("f-folder-input");
  if (select.value === "__new__") {
    const v = input.value.trim();
    return v || null;
  }
  return select.value || null;
}

function buildProfileFromConnectionForm({ persistIdentity = false } = {}) {
  const connType = document.getElementById("f-conn-type").value;
  const authType = (connType === "rdp" || isFileTransferConnectionType(connType))
    ? "password"
    : document.getElementById("f-auth-type").value;
  const passwordSource = authType === "password" ? getPasswordSource() : "own";
  const useKeepass = passwordSource === "keepass";
  const keepassEntryUuid = useKeepass
    ? (document.getElementById("f-keepass-entry").value || null)
    : null;
  const keepassProperty = useKeepass && keepassEntryUuid
    ? (document.getElementById("f-keepass-property")?.value || "password")
    : null;
  const masterCredentialId = passwordSource === "master"
    ? (document.getElementById("f-master-cred").value || null)
    : null;
  const wsSelect = document.getElementById("f-workspace");
  const wsFromForm = wsSelect && !wsSelect.closest(".form-row").classList.contains("hidden")
    ? wsSelect.value
    : null;
  const existing = editingProfileId
    ? profiles.find((p) => p.id === editingProfileId)
    : null;
  const workspaceId = wsFromForm || existing?.workspace_id || getActiveWorkspaceId() || "default";
  const now = new Date().toISOString();

  return {
    id: persistIdentity ? (editingProfileId || crypto.randomUUID()) : (editingProfileId || `test-${crypto.randomUUID()}`),
    name: document.getElementById("f-name").value.trim() || document.getElementById("f-host").value.trim() || "Prueba",
    host: document.getElementById("f-host").value.trim(),
    port: parseInt(document.getElementById("f-port").value, 10),
    username: document.getElementById("f-user").value.trim(),
    connection_type: connType,
    domain: document.getElementById("f-domain").value.trim() || null,
    auth_type: authType,
    key_path: document.getElementById("f-key-path").value || null,
    group: readFolderValue(),
    notes: (document.getElementById("f-notes").value || "").trim() || null,
    workspace_id: workspaceId,
    keepass_entry_uuid: keepassEntryUuid,
    keepass_property: keepassProperty,
    password_source: passwordSource,
    master_credential_id: masterCredentialId,
    follow_cwd: true,
    keep_alive_secs: keepAliveFromInput(document.getElementById("f-keep-alive").value),
    allow_legacy_algorithms: document.getElementById("f-allow-legacy").checked,
    legacy_algorithms: collectLegacyAlgorithms(),
    agent_forwarding: document.getElementById("f-agent-forwarding").checked,
    disable_paste_confirm: document.getElementById("f-disable-paste-confirm")?.checked ?? false,
    x11_forwarding: document.getElementById("f-x11-forwarding").checked,
    auto_reconnect: autoReconnectFromInput(document.getElementById("f-auto-reconnect").value),
    session_log: document.getElementById("f-session-log").checked,
    proxy_jump: (document.getElementById("f-proxy-jump").value || "").trim() || null,
    mac_address: (document.getElementById("f-mac-address").value || "").trim() || null,
    wol_broadcast: (document.getElementById("f-wol-broadcast").value || "").trim() || null,
    wol_port: wolPortFromInput(document.getElementById("f-wol-port").value),
    ssh_tunnels: existing?.ssh_tunnels || [],
    created_at: persistIdentity ? (existing?.created_at ?? now) : now,
    updated_at: now,
  };
}

function resetConnectionTestPanel() {
  if (_connectionTestUnlisten) {
    try { _connectionTestUnlisten(); } catch {}
    _connectionTestUnlisten = null;
  }
  const panel = document.getElementById("connection-test-panel");
  const list = document.getElementById("connection-test-list");
  const status = document.getElementById("connection-test-status");
  panel?.classList.add("hidden");
  if (list) list.innerHTML = "";
  if (status) {
    status.textContent = "Listo";
    status.className = "connection-test-status";
  }
}

function setConnectionTestStatus(text, status = "") {
  const statusEl = document.getElementById("connection-test-status");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `connection-test-status ${status}`.trim();
}

function appendConnectionTestLog(rawEntry = {}) {
  const panel = document.getElementById("connection-test-panel");
  const list = document.getElementById("connection-test-list");
  if (!panel || !list) return;
  const entry = normalizeConnectionLogEntry(rawEntry);
  panel.classList.remove("hidden");
  const row = document.createElement("div");
  row.className = `connection-test-row ${entry.status}`;
  row.innerHTML = `
    <span class="connection-test-dot"></span>
    <span class="connection-test-time">${escHtml(connectionLogTime(entry.timestamp))}</span>
    <span class="connection-test-message">${escHtml(entry.message)}</span>
  `;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

async function runConnectionTestFromModal() {
  const form = document.getElementById("form-connection");
  if (form && !form.reportValidity()) return;

  const btn = document.getElementById("btn-modal-test");
  const profile = buildProfileFromConnectionForm({ persistIdentity: false });
  const password = document.getElementById("f-password").value || null;
  const passphrase = document.getElementById("f-passphrase").value || null;
  const testId = `conn-test-${crypto.randomUUID()}`;
  resetConnectionTestPanel();
  document.getElementById("connection-test-panel")?.classList.remove("hidden");
  setConnectionTestStatus("Probando…", "busy");
  if (btn) btn.disabled = true;

  try {
    if (profile.connection_type === "rdp") {
      appendConnectionTestLog({
        stage: "connecting",
        status: "info",
        message: `Comprobando puerto RDP ${profile.host}:${profile.port}`,
      });
      const ms = await invoke("tcp_ping", { host: profile.host, port: profile.port });
      appendConnectionTestLog({
        stage: "connected",
        status: "ok",
        message: `Puerto RDP accesible (${ms} ms)`,
      });
      setConnectionTestStatus("OK", "ok");
      toast("Prueba RDP completada", "success");
      recordActivity({
        kind: "connection",
        status: "ok",
        title: `Prueba RDP OK: ${profile.name}`,
        detail: `${profile.host}:${profile.port}`,
      });
      return;
    }

    if (isFileTransferConnectionType(profile.connection_type)) {
      const proto = profile.connection_type.toUpperCase();
      appendConnectionTestLog({
        stage: "connecting",
        status: "info",
        message: `Comprobando puerto ${proto} ${profile.host}:${profile.port}`,
      });
      const ms = await invoke("tcp_ping", { host: profile.host, port: profile.port });
      appendConnectionTestLog({
        stage: "connected",
        status: "ok",
        message: `Puerto ${proto} accesible (${ms} ms)`,
      });
      setConnectionTestStatus("OK", "ok");
      toast(`Prueba ${proto} completada`, "success");
      recordActivity({
        kind: "connection",
        status: "ok",
        title: `Prueba ${proto} OK: ${profile.name}`,
        detail: `${profile.host}:${profile.port}`,
      });
      return;
    }

    _connectionTestUnlisten = await listen(eventName("sshLog", testId), (event) => {
      appendConnectionTestLog(event.payload || {});
    });
    await invoke("ssh_test_connection", {
      profile,
      password,
      passphrase,
      testId,
    });
    setConnectionTestStatus("OK", "ok");
    toast("Prueba SSH completada", "success");
    recordActivity({
      kind: "connection",
      status: "ok",
      title: `Prueba SSH OK: ${profile.name}`,
      detail: `${profile.host}:${profile.port}`,
    });
  } catch (err) {
    appendConnectionTestLog({
      stage: "error",
      status: "error",
      message: String(err),
    });
    setConnectionTestStatus("Error", "error");
    toast(`Prueba de conexión fallida: ${err}`, "error", 8000);
    recordActivity({
      kind: "connection",
      status: "error",
      title: `Prueba fallida: ${profile.name}`,
      detail: String(err),
    });
  } finally {
    if (_connectionTestUnlisten) {
      try { _connectionTestUnlisten(); } catch {}
      _connectionTestUnlisten = null;
    }
    if (btn) btn.disabled = false;
  }
}

/**
 * Guarda el perfil y opcionalmente conecta.
 * @param {boolean} shouldConnect
 */
async function saveAndClose(shouldConnect) {
  const connType = document.getElementById("f-conn-type").value;
  const authType       = (connType === "rdp" || isFileTransferConnectionType(connType))
    ? "password"
    : document.getElementById("f-auth-type").value;
  const password       = document.getElementById("f-password").value || null;
  const savePassword   = document.getElementById("f-save-password").checked;
  const keyPath        = document.getElementById("f-key-path").value || null;
  const passphrase     = document.getElementById("f-passphrase").value || null;
  const savePassphrase = document.getElementById("f-save-passphrase").checked;
  const group          = readFolderValue();

  const passwordSource = authType === "password" ? getPasswordSource() : "own";
  const useKeepass = passwordSource === "keepass";
  const keepassEntryUuid = useKeepass
    ? (document.getElementById("f-keepass-entry").value || null)
    : null;
  const keepassProperty = useKeepass && keepassEntryUuid
    ? (document.getElementById("f-keepass-property")?.value || "password")
    : null;
  const masterCredentialId = passwordSource === "master"
    ? (document.getElementById("f-master-cred").value || null)
    : null;

  const wsSelect = document.getElementById("f-workspace");
  const wsFromForm = wsSelect && !wsSelect.closest(".form-row").classList.contains("hidden")
    ? wsSelect.value
    : null;
  const fallbackWs = editingProfileId
    ? (profiles.find((p) => p.id === editingProfileId)?.workspace_id || getActiveWorkspaceId())
    : getActiveWorkspaceId();
  const workspaceId = wsFromForm || fallbackWs || "default";

  const profileId = editingProfileId || crypto.randomUUID();
  const { creds: extraCredentials, passwordWrites: extraPwWrites, deletes: extraPwDeletes } =
    collectExtraCredsFromForm(profileId);

  const profile = {
    id:                  profileId,
    name:                document.getElementById("f-name").value.trim(),
    host:                document.getElementById("f-host").value.trim(),
    port:                parseInt(document.getElementById("f-port").value, 10),
    username:            document.getElementById("f-user").value.trim(),
    connection_type:     connType,
    domain:              document.getElementById("f-domain").value.trim() || null,
    auth_type:           authType,
    key_path:            keyPath,
    group,
    notes:               (document.getElementById("f-notes").value || "").trim() || null,
    workspace_id:        workspaceId,
    keepass_entry_uuid:  keepassEntryUuid,
    keepass_property:    keepassProperty,
    password_source:     passwordSource,
    master_credential_id: masterCredentialId,
    extra_credentials:   extraCredentials,
    follow_cwd:          true,
    keep_alive_secs:     keepAliveFromInput(document.getElementById("f-keep-alive").value),
    allow_legacy_algorithms: document.getElementById("f-allow-legacy").checked,
    legacy_algorithms:   collectLegacyAlgorithms(),
    agent_forwarding:    document.getElementById("f-agent-forwarding").checked,
    disable_paste_confirm: document.getElementById("f-disable-paste-confirm")?.checked ?? false,
    x11_forwarding:      document.getElementById("f-x11-forwarding").checked,
    auto_reconnect:      autoReconnectFromInput(document.getElementById("f-auto-reconnect").value),
    session_log:         document.getElementById("f-session-log").checked,
    proxy_jump:          (document.getElementById("f-proxy-jump").value || "").trim() || null,
    mac_address:         (document.getElementById("f-mac-address").value || "").trim() || null,
    wol_broadcast:       (document.getElementById("f-wol-broadcast").value || "").trim() || null,
    wol_port:            wolPortFromInput(document.getElementById("f-wol-port").value),
    ssh_tunnels:         profiles.find((p) => p.id === editingProfileId)?.ssh_tunnels || [],
    created_at: editingProfileId
      ? (profiles.find((p) => p.id === editingProfileId)?.created_at ?? new Date().toISOString())
      : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    await invoke("save_profile", { profile });

    if (authType === "password" && passwordSource === "own" && password && savePassword) {
      await saveStoredSecret(passwordKey(profile.id), password, "contraseña");
    }
    if (authType === "public_key" && passphrase && savePassphrase) {
      await saveStoredSecret(passphraseKey(profile.id), passphrase, "passphrase");
    }
    // Identidades adicionales: guardar contraseñas nuevas y limpiar las borradas.
    for (const { key, secret } of extraPwWrites) {
      await saveStoredSecret(key, secret, "contraseña");
    }
    for (const key of extraPwDeletes) {
      await deleteStoredSecret(key);
    }

    // Si se especificó una carpeta nueva, persiste en el workspace del perfil.
    if (group) {
      const folders = new Set(getWorkspaceFolders(workspaceId));
      folders.add(group);
      saveWorkspaceFolders(workspaceId, [...folders]);
    }

    const idx = profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) profiles[idx] = profile;
    else profiles.push(profile);

    renderConnectionList();
    scheduleProfileAutoSync();
    closeModal();

    if (shouldConnect) {
      if (connType === "rdp") {
        await connectRdp(profile.id, { passwordOverride: password });
      } else if (isFileTransferConnectionType(connType)) {
        await connectFileTransferProfile(profile.id, { passwordOverride: password });
      } else {
        await connectProfileWithCredentials(profile.id, password, passphrase, savePassphrase);
      }
    } else {
      toast("Perfil guardado", "success");
    }
  } catch (err) {
    toast(`Error: ${err}`, "error");
  }
}

// ═══════════════════════════════════════════════════════════════
// CONEXIÓN SSH
// ═══════════════════════════════════════════════════════════════

/**
 * Resuelve las credenciales SSH del perfil (KeePass / keyring / prompt).
 * Devuelve { password, passphrase } o null si el usuario canceló.
 */
/** Devuelve la `ProfileCredential` (identidad adicional) por id, o null. */
function getProfileCredential(profile, credId) {
  if (!credId) return null;
  return (profile?.extra_credentials || []).find((c) => c.id === credId) || null;
}

/**
 * Vista unificada de una "identidad" del perfil para resolver credenciales:
 * la principal (`cred == null`) o una adicional. Normaliza usuario, tipo de
 * auth, ruta de clave, origen de contraseña y las claves de keyring.
 */
function identityView(profile, cred) {
  if (!cred) {
    return {
      credId: null,
      username: profile.username,
      authType: profile.auth_type,
      keyPath: profile.key_path,
      passwordSource: profile.password_source || "own",
      keepassEntryUuid: profile.keepass_entry_uuid,
      pwKey: passwordKey(profile.id),
      ppKey: passphraseKey(profile.id),
    };
  }
  return {
    credId: cred.id,
    username: cred.username,
    authType: cred.auth_type || "password",
    keyPath: cred.key_path,
    passwordSource: cred.password_source || "own",
    keepassEntryUuid: null,
    pwKey: credPasswordKey(profile.id, cred.id),
    ppKey: credPassphraseKey(profile.id, cred.id),
  };
}

/**
 * Resuelve las credenciales SSH del perfil para una identidad concreta
 * (KeePass / credencial maestra / keyring / prompt). `cred` es la identidad
 * adicional elegida o null para la principal.
 * Devuelve { password, passphrase } o null si el usuario canceló.
 */
async function resolveSshCredentials(profile, cred = null) {
  const view = identityView(profile, cred);
  // Etiqueta para los prompts: el perfil con el usuario de la identidad.
  const promptProfile = { ...profile, username: view.username };
  let password = null, passphrase = null;
  if (view.authType === "password") {
    if (view.keepassEntryUuid) {
      if (!keepassUnlocked) {
        toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
        return null;
      }
    } else if (view.passwordSource === "master") {
      // El backend resuelve la credencial maestra; no pedimos nada.
    } else {
      password = await getStoredSecret(view.pwKey);
      if (!password) {
        password = await promptProfileSecret(promptProfile, {
          titleKey: "modal_credential.password_title",
          messageKey: "modal_credential.ssh_message",
          labelKey: "modal_credential.password_label",
          rememberKey: "modal_credential.remember_password",
          secretKey: view.pwKey,
          secretLabel: "contraseña",
        });
        if (password === null) return null;
      }
    }
  } else if (view.authType === "public_key") {
    passphrase = await getStoredSecret(view.ppKey);
    if (!passphrase && view.keyPath) {
      passphrase = await promptProfileSecret(promptProfile, {
        titleKey: "modal_credential.passphrase_title",
        messageKey: "modal_credential.passphrase_message",
        labelKey: "modal_credential.passphrase_label",
        rememberKey: "modal_credential.remember_passphrase",
        secretKey: view.ppKey,
        secretLabel: "passphrase",
        submitKey: "modal_credential.accept",
      });
      if (passphrase === null) return null;
    }
  }
  return { password, passphrase };
}

async function resolvePasswordOnlyCredentials(profile, {
  passwordOverride = null,
  titleKey = "modal_credential.sftp_password_title",
  messageKey = "modal_credential.sftp_message",
  cred = null,
} = {}) {
  const view = identityView(profile, cred);
  const promptProfile = { ...profile, username: view.username };
  if (view.keepassEntryUuid) {
    if (!keepassUnlocked) {
      toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
      return null;
    }
    return passwordOverride || null;
  }
  if (view.passwordSource === "master") {
    // El backend resuelve la credencial maestra; no pedimos contraseña.
    return passwordOverride || null;
  }

  let password = passwordOverride || await getStoredSecret(view.pwKey);
  if (!password) {
    password = await promptProfileSecret(promptProfile, {
      titleKey,
      messageKey,
      labelKey: "modal_credential.password_label",
      rememberKey: "modal_credential.remember_password",
      secretKey: view.pwKey,
      secretLabel: "contraseña",
    });
    if (password === null) return null;
  }
  return password;
}

async function connectProfile(profileId, { force = false, credId = null, restore = false } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  // Al conectar desde un resultado de búsqueda, cierra el popover y limpia el
  // filtro de la sidebar (se mantenían abiertos para permitir el doble clic).
  if (_sidebarSearchQuery) {
    clearSidebarSearch();
    toggleSidebarTools(false);
  }

  if (profile.connection_type === "rdp") {
    return connectRdp(profileId, { credId });
  }

  if (isFileTransferConnectionType(profile.connection_type)) {
    return connectFileTransferProfile(profileId, { force, credId });
  }

  // Con una identidad alternativa abrimos siempre una sesión nueva; solo
  // reutilizamos una pestaña existente si coincide la misma identidad.
  if (!force) {
    for (const [sid, s] of sessions) {
      if (s.profileId === profileId && s.status !== "closed"
          && (s.credentialId || null) === (credId || null)) {
        setActiveTab(sid); return;
      }
    }
  }

  const cred = getProfileCredential(profile, credId);
  const creds = await resolveSshCredentials(profile, cred);
  if (!creds) return;
  await connectProfileWithCredentials(profileId, creds.password, creds.passphrase, false, { credId, restore });
}

/**
 * Conecta usando una identidad adicional (usuario alternativo) del perfil.
 * Abre siempre una sesión nueva con esa identidad.
 */
async function connectProfileAs(profileId, credId) {
  return connectProfile(profileId, { force: true, credId });
}

/**
 * Inicia una sesión privada/efímera para el perfil dado. El comportamiento es
 * idéntico al de una conexión normal salvo que la sesión se marca con
 * `session.private = true`, lo que suprime toda persistencia:
 *   - No registra el perfil en recientes ni en el quick launcher del tray.
 *   - No escribe entradas en el centro de actividad con detalle del host/ruta.
 *   - No guarda borrador de comando para esa sesión.
 *   - No activa la grabación de sesión a fichero (session_log desactivado).
 */
async function connectPrivateProfile(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  if (_sidebarSearchQuery) {
    clearSidebarSearch();
    toggleSidebarTools(false);
  }

  // Solo SSH soporta sesión privada por ahora.
  if (profile.connection_type !== "ssh") {
    return connectProfile(profileId);
  }

  const creds = await resolveSshCredentials(profile);
  if (!creds) return;
  await connectProfileWithCredentials(profileId, creds.password, creds.passphrase, false, { private: true });
}

async function wakeProfile(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  const macAddress = (profile.mac_address || "").trim();
  if (!macAddress) {
    toast("Configura una MAC Wake On LAN en el perfil", "warning", 6000, {
      actionLabel: "Editar",
      onAction: () => openEditConnectionModal(profileId),
    });
    return;
  }

  try {
    await invoke("wake_on_lan", {
      macAddress,
      broadcast: (profile.wol_broadcast || "").trim() || null,
      port: profile.wol_port || null,
    });
    toast(`Magic packet enviado a ${profile.name}`, "success", 7000, {
      actionLabel: "Conectar",
      onAction: () => connectProfile(profileId, { force: true }),
    });
  } catch (err) {
    toast(`Wake On LAN falló: ${err}`, "error", 7000, {
      actionLabel: "Reintentar",
      onAction: () => wakeProfile(profileId),
    });
  }
}

// ─── Preguntas al conectar (${ask:}) ─────────────────────────────
// Resolver de la promesa del diálogo de asks en curso (null si no hay).
let _askPromptResolve = null;

/**
 * Muestra un diálogo tematizado que pide un valor por cada `${ask:}` del perfil.
 * `specs` es la lista devuelta por `template_asks`: `{ label, options }`.
 * Devuelve un mapa { label: valor } o `null` si el usuario cancela.
 */
function promptAsks(specs) {
  const overlay = document.getElementById("ask-modal-overlay");
  const form = document.getElementById("ask-modal-form");
  const fields = document.getElementById("ask-modal-fields");
  if (!overlay || !form || !fields) return Promise.resolve(null);

  if (_askPromptResolve) closeAskPrompt(null);

  fields.innerHTML = specs
    .map((spec, i) => {
      const id = `ask-field-${i}`;
      const label = escHtml(spec.label);
      if (Array.isArray(spec.options) && spec.options.length) {
        const opts = spec.options
          .map((o) => `<option value="${escHtml(o)}">${escHtml(o)}</option>`)
          .join("");
        return `
          <div class="form-row">
            <label for="${id}">${label}</label>
            <select id="${id}" data-ask-label="${label}">${opts}</select>
          </div>`;
      }
      return `
        <div class="form-row">
          <label for="${id}">${label}</label>
          <input id="${id}" type="text" data-ask-label="${label}" autocomplete="off" />
        </div>`;
    })
    .join("");

  overlay.classList.remove("hidden");
  setTimeout(() => fields.querySelector("input, select")?.focus(), 0);

  return new Promise((resolve) => {
    _askPromptResolve = resolve;
  });
}

function closeAskPrompt(result) {
  const overlay = document.getElementById("ask-modal-overlay");
  overlay?.classList.add("hidden");
  const resolve = _askPromptResolve;
  _askPromptResolve = null;
  if (resolve) resolve(result);
}

/** Lee los valores actuales de los campos del diálogo de asks en un mapa. */
function collectAskAnswers() {
  const fields = document.getElementById("ask-modal-fields");
  const answers = {};
  fields?.querySelectorAll("[data-ask-label]").forEach((el) => {
    answers[el.dataset.askLabel] = el.value;
  });
  return answers;
}

/**
 * Si el perfil tiene `${ask:}`, pide los valores y devuelve el mapa de
 * respuestas; si no tiene, devuelve `{}`. Devuelve `null` si el usuario cancela
 * (el llamante debe abortar la conexión).
 */
async function askProfileAnswers(profileId) {
  let specs = [];
  try {
    specs = await invoke("template_asks", { profileId });
  } catch {
    // Si el escaneo falla, conectamos como hoy (sin diálogo).
    return {};
  }
  if (!specs || !specs.length) return {};
  return await promptAsks(specs);
}

// ─── Duplicar sesión con cambios (overrides puntuales) ───────────
// Mini formulario para abrir una sesión nueva del mismo perfil cambiando
// usuario, puerto, carpeta inicial, bastion o autenticación. Los cambios
// solo aplican a esa sesión; el perfil guardado no se toca.
let _dupPromptResolve = null;

function promptSessionOverrides(profile) {
  const overlay = document.getElementById("dup-modal-overlay");
  if (!overlay) return Promise.resolve(null);
  if (_dupPromptResolve) closeDupPrompt(null);

  document.getElementById("dup-modal-message").textContent =
    t("modal_dup.message", { name: profile.name, host: profile.host });
  document.getElementById("dup-ov-username").value = profile.username || "";
  document.getElementById("dup-ov-port").value = profile.port || 22;
  document.getElementById("dup-ov-dir").value = "";
  document.getElementById("dup-ov-bastion").value = profile.proxy_jump || "";
  document.getElementById("dup-ov-auth").value = "same";
  document.getElementById("dup-ov-key").value = profile.key_path || "";
  document.getElementById("dup-ov-key-row").classList.add("hidden");

  overlay.classList.remove("hidden");
  setTimeout(() => document.getElementById("dup-ov-username")?.focus(), 0);
  return new Promise((resolve) => { _dupPromptResolve = resolve; });
}

function closeDupPrompt(result) {
  document.getElementById("dup-modal-overlay")?.classList.add("hidden");
  const resolve = _dupPromptResolve;
  _dupPromptResolve = null;
  if (resolve) resolve(result);
}

function collectDupOverridesForm() {
  return {
    username: document.getElementById("dup-ov-username")?.value ?? "",
    port: document.getElementById("dup-ov-port")?.value ?? "",
    initialDir: document.getElementById("dup-ov-dir")?.value ?? "",
    bastion: document.getElementById("dup-ov-bastion")?.value ?? "",
    auth: document.getElementById("dup-ov-auth")?.value ?? "same",
    keyPath: document.getElementById("dup-ov-key")?.value ?? "",
  };
}

async function duplicateSessionWithOverrides(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  if (profile.connection_type !== "ssh") {
    toast(t("modal_dup.only_ssh"), "warning");
    return;
  }
  const form = await promptSessionOverrides(profile);
  if (!form) return;

  // Solo viajan al backend los campos que difieren del perfil.
  const overrides = {};
  const username = form.username.trim();
  if (username && username !== profile.username) overrides.username = username;
  const port = parseInt(form.port, 10);
  if (Number.isFinite(port) && port > 0 && port <= 65535 && port !== profile.port) {
    overrides.port = port;
  }
  const bastion = form.bastion.trim();
  if (bastion !== (profile.proxy_jump || "").trim()) overrides.proxy_jump = bastion;
  if (form.auth !== "same") {
    overrides.auth_type = form.auth;
    if (form.auth === "public_key") {
      const keyPath = form.keyPath.trim();
      if (!keyPath) {
        toast(t("modal_dup.key_required"), "warning");
        return;
      }
      overrides.key_path = keyPath;
    }
  }

  const creds = await resolveOverrideAuthCredentials(profile, overrides);
  if (!creds) return;

  await connectProfileWithCredentials(profileId, creds.password, creds.passphrase, false, {
    overrides: Object.keys(overrides).length ? overrides : null,
    initialDir: form.initialDir.trim() || null,
  });
}

/**
 * Resuelve credenciales según el método elegido en los overrides: con auth
 * puntual pregunta lo necesario (contraseña / passphrase de la clave) sin
 * guardar nada; sin override de auth reutiliza el flujo normal del perfil.
 */
async function resolveOverrideAuthCredentials(profile, overrides) {
  if (!overrides?.auth_type) {
    return resolveSshCredentials(profile, getProfileCredential(profile, null));
  }
  if (overrides.auth_type === "password") {
    const target = credentialTarget({ ...profile, username: overrides.username || profile.username });
    const result = await promptCredential({
      title: t("modal_credential.password_title"),
      message: t("modal_credential.ssh_message", { target }),
      label: t("modal_credential.password_label"),
    });
    if (!result) return null;
    return { password: result.value, passphrase: null };
  }
  if (overrides.auth_type === "public_key") {
    const result = await promptCredential({
      title: t("modal_dup.passphrase_title"),
      message: t("modal_dup.passphrase_message"),
      label: t("modal_dup.passphrase_label"),
    });
    if (!result) return null;
    return { password: null, passphrase: result.value || null };
  }
  // Agente SSH: no requiere secretos del frontend.
  return { password: null, passphrase: null };
}

async function connectProfileWithCredentials(profileId, password, passphrase, _savePassphrase, { private: isPrivate = false, credId = null, restore = false, overrides = null, initialDir = null } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  // Preguntas `${ask:}` (si las hay) antes de crear la pestaña: si el usuario
  // cancela, abortamos sin dejar nada a medias.
  const askAnswers = await askProfileAnswers(profileId);
  if (askAnswers === null) return;

  const sessionId = `ssh-${crypto.randomUUID()}`;
  // Con override de usuario, la pestaña lo muestra para distinguir la sesión.
  const tabProfile = overrides?.username
    ? { ...profile, name: `${profile.name} (${overrides.username})` }
    : profile;
  createTerminalTab(sessionId, tabProfile, "connecting", { private: isPrivate, credId });
  const session = sessions.get(sessionId);
  // Overrides puntuales de «Duplicar con cambios»: se conservan en la sesión
  // para reaplicarlos al reconectar (manual o tras caída).
  session._overrides = overrides || null;
  session._initialDir = initialDir || null;

  // Restaurar pantalla de la sesión anterior (solo visual) antes de conectar.
  if (restore && !isPrivate) {
    await restorePreviousScreen(sessionId, profileId);
  }

  appendConnectionLog(sessionId, {
    stage: "preparing",
    status: "info",
    message: `Preparando conexión con ${profile.name}`,
    timestamp: new Date().toISOString(),
  });

  try {
    session.unlisteners = await registerSshListeners(sessionId, session.terminal);
    await invoke("ssh_connect", {
      sessionId,
      profileId,
      password:   password   || null,
      passphrase: passphrase || null,
      askAnswers: Object.keys(askAnswers).length ? askAnswers : null,
      credentialId: credId || null,
      // En sesión privada, desactivar la grabación a fichero aunque el perfil
      // lo tenga habilitado (el backend aplica el override sobre su copia local).
      sessionLogOverride: isPrivate ? false : null,
      overrides: overrides || null,
    });

    updateTabStatus(sessionId, "connecting");
    setActiveTab(sessionId);
  } catch (err) {
    for (const ul of session?.unlisteners || []) { try { ul(); } catch {} }
    sessions.delete(sessionId);
    removeTab(sessionId);
    toast(`No se pudo conectar: ${err}`, "error");
  }
}

// ═══════════════════════════════════════════════════════════════
// CONEXIÓN RDP
// ═══════════════════════════════════════════════════════════════

async function connectRdp(profileId, { passwordOverride = null, credId = null } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  // Si ya hay una sesión activa para este perfil con la misma identidad,
  // traerla al frente.
  for (const [sid, s] of sessions) {
    if (s.profileId === profileId && s.type === "rdp" && s.status !== "closed"
        && (s.credentialId || null) === (credId || null)) {
      setActiveTab(sid);
      return;
    }
  }

  const cred = getProfileCredential(profile, credId);
  const view = identityView(profile, cred);
  const promptProfile = { ...profile, username: view.username };

  // Obtener contraseña: KeePass / maestra (si aplica), si no keyring, si no prompt
  let password = passwordOverride;
  if (view.keepassEntryUuid) {
    if (!keepassUnlocked) {
      toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
      return;
    }
  } else if (view.passwordSource === "master") {
    // El backend resuelve la credencial maestra.
  } else if (!password) {
    password = await getStoredSecret(view.pwKey);
    if (!password) {
      password = await promptProfileSecret(promptProfile, {
        titleKey: "modal_credential.rdp_password_title",
        messageKey: "modal_credential.rdp_message",
        labelKey: "modal_credential.password_label",
        rememberKey: "modal_credential.remember_password",
        secretKey: view.pwKey,
        secretLabel: "contraseña",
      });
      if (password === null) return; // usuario canceló
    }
  }

  const tempId = `rdp-${profileId}-${Date.now()}`;
  const sessionObj = {
    profileId,
    id: tempId,
    type: "rdp",
    status: "connecting",
    unlisteners: [],
    credentialId: credId,
    // RDP no usa terminal ni fitAddon
    terminal: null,
    fitAddon: null,
  };
  sessions.set(tempId, sessionObj);
  createRdpTab(tempId, profile, "connecting");

  try {
    const sessionId = await invoke("rdp_connect", {
      profileId,
      password: password || null,
      credentialId: credId || null,
    });

    // Migrar tempId → sessionId real
    sessionObj.id = sessionId;
    sessions.delete(tempId);
    sessions.set(sessionId, sessionObj);

    document.querySelectorAll(`[data-session="${tempId}"]`).forEach((el) => {
      el.dataset.session = sessionId;
    });
    const vi = viewSelection.indexOf(tempId);
    if (vi >= 0) viewSelection[vi] = sessionId;
    if (activeSessionId === tempId) activeSessionId = sessionId;

    sessionObj.status = "connected";
    updateTabStatus(sessionId, "connected");
    if (!sessionObj.private) recordRecentConnection(profileId);

    // Escuchar el cierre del proceso externo
    const unlisten = await listen(eventName("rdpClosed", sessionId), () => {
      sessionObj.status = "closed";
      updateTabStatus(sessionId, "error");
      renderConnectionList();
      // Actualizar el texto del panel RDP
      const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
      if (pane) {
        const label = pane.querySelector(".rdp-status-label");
        if (label) label.textContent = "Sesión cerrada";
        const btn = pane.querySelector(".rdp-disconnect-btn");
        if (btn) btn.textContent = "Cerrar pestaña";
      }
      toast(`Sesión RDP "${profile.name}" cerrada`, "info");
    });
    sessionObj.unlisteners.push(unlisten);

    renderConnectionList();
    setActiveTab(sessionId);
    toast(`Sesión RDP "${profile.name}" iniciada`, "success");
  } catch (err) {
    sessions.delete(tempId);
    removeTab(tempId);
    toast(`Error RDP: ${err}`, "error");
  }
}

async function closeRdpSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  for (const ul of s.unlisteners) { try { ul(); } catch {} }
  await invoke("rdp_disconnect", { sessionId }).catch(() => {});
  sessions.delete(sessionId);
  removeTab(sessionId);
  renderConnectionList();
}

async function connectFileTransferProfile(profileId, { passwordOverride = null, force = false, credId = null } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  for (const [sid, s] of [...sessions]) {
    if (s.profileId === profileId && isFileTransferConnectionType(s.type) && s.status !== "closed"
        && (s.credentialId || null) === (credId || null)) {
      if (!force) {
        setActiveTab(sid);
        return;
      }
      await closeSession(sid, { skipConfirm: true });
    }
  }

  const cred = getProfileCredential(profile, credId);
  const password = await resolvePasswordOnlyCredentials(profile, {
    passwordOverride,
    titleKey: "modal_credential.sftp_password_title",
    messageKey: "modal_credential.sftp_message",
    cred,
  });
  if (password === null) return;

  const sessionId = `${profile.connection_type}-${crypto.randomUUID()}`;
  const sessionObj = {
    profileId,
    id: sessionId,
    type: profile.connection_type,
    status: "connecting",
    terminal: null,
    fitAddon: null,
    unlisteners: [],
    remoteCwd: null,
    credentialId: credId,
    tunnels: new Map(),
    tunnelPanel: null,
  };
  sessions.set(sessionId, sessionObj);
  createFileTransferTab(sessionId, profile, "connecting");

  try {
    await openSftpPanel(sessionId, { passwordOverride: password, passphraseOverride: null });
    sessionObj.status = "connected";
    updateTabStatus(sessionId, "connected");
    if (!sessionObj.private) recordRecentConnection(profileId);
    renderConnectionList();
    setActiveTab(sessionId);
    toast(`${profile.connection_type.toUpperCase()} conectado: ${profile.name}`, "success");
  } catch (err) {
    sessions.delete(sessionId);
    removeTab(sessionId);
    console.warn("[file-transfer] open failed", err);
  }
}

function createFileTransferTab(sessionId, profile, initialStatus) {
  const pane = document.createElement("div");
  pane.className = "terminal-pane file-transfer-pane";
  pane.dataset.session = sessionId;
  document.getElementById("terminals-container").appendChild(pane);

  const tab = createTab(sessionId, profile, initialStatus, { sftp: false });
  tab.dataset.type = profile.connection_type;

  const s = sessions.get(sessionId);
  if (s) s.pane = pane;
  wirePaneFocusOnClick(pane, sessionId);

  document.getElementById("welcome-screen").classList.add("hidden");
  selectSession(sessionId, false);
}

/**
 * Crea el tab y el panel de estado para una sesión RDP.
 * En lugar de un terminal, muestra tarjeta informativa con botón de desconexión.
 */
function createRdpTab(sessionId, profile, initialStatus) {
  const pane = document.createElement("div");
  pane.className = "terminal-pane rdp-pane";
  pane.dataset.session = sessionId;

  const hostLine = profile.domain
    ? `${escHtml(profile.username)}@${escHtml(profile.domain)}\\${escHtml(profile.host)}:${profile.port}`
    : `${escHtml(profile.username)}@${escHtml(profile.host)}:${profile.port}`;

  pane.innerHTML = `
    <div class="rdp-status-card">
      <div class="rdp-status-icon">🖥️</div>
      <div class="rdp-status-info">
        <div class="rdp-status-name">${escHtml(profile.name)}</div>
        <div class="rdp-status-host">${hostLine}</div>
        <div class="rdp-status-label">Sesión RDP abierta en ventana externa</div>
      </div>
      <button class="btn-secondary rdp-disconnect-btn" data-session="${sessionId}">
        Desconectar
      </button>
    </div>`;
  pane.querySelector(".rdp-disconnect-btn").addEventListener("click", (e) =>
    closeRdpSession(e.target.dataset.session)
  );
  document.getElementById("terminals-container").appendChild(pane);

  const tab = createTab(sessionId, profile, initialStatus, { sftp: false });
  tab.dataset.type = "rdp";

  // Asociar pane al sessionObj ya creado en connectRdp
  const s = sessions.get(sessionId);
  if (s) s.pane = pane;
  wirePaneFocusOnClick(pane, sessionId);

  document.getElementById("welcome-screen").classList.add("hidden");
  selectSession(sessionId, false);
}

// ═══════════════════════════════════════════════════════════════
// VISTA MÚLTIPLE (clic = seleccionar una pestaña; Ctrl+clic = añadir)
// ═══════════════════════════════════════════════════════════════

/**
 * Crea el elemento de pestaña cableado para selección/multi-selección.
 * El pane asociado debe existir en `sessions.get(sessionId).pane`.
 */
function createTab(sessionId, profile, initialStatus, { sftp = true, private: isPrivate = false } = {}) {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.session = sessionId;
  // Si la sesión recién creada ya trajera un alias temporal, lo respetamos.
  const sessionAlias = (sessions.get(sessionId)?.alias || "").trim();
  const tabLabel = sessionAlias || profile.name;
  // En sesiones privadas, el tooltip indica el modo efímero.
  const baseTooltip = buildTabTooltip(profile, sessionAlias);
  tab.title = isPrivate
    ? `${baseTooltip} — ${t("private_session.tab_tooltip")}`
    : baseTooltip;
  if (sessionAlias) tab.classList.add("has-alias");
  if (isPrivate) tab.classList.add("is-private");
  tab.draggable = true;
  const sftpBtn = sftp ? `<button class="tab-sftp" title="Panel SFTP">⇅</button>` : "";
  const tunnelBtn = sftp ? `<button class="tab-tunnels" title="Túneles SSH">⇄</button>` : "";
  // Botón de nota/runbook solo para sesiones de un perfil guardado real
  // (excluye consolas locales, cuyo perfil es sintético `local-…`).
  const isSavedProfile = !!profile?.id && profiles.some((p) => p.id === profile.id);
  const runbookBtn = isSavedProfile
    ? `<button class="tab-notes" title="${escHtml(t("notes.runbook_title"))}">${NOTE_ICON_SVG}</button>`
    : "";
  // Badge de sesión privada: escudo SVG monocromo con currentColor.
  const privateBadge = isPrivate ? `<span class="tab-private-badge" title="${escHtml(t("private_session.tab_tooltip"))}">
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 2 L13.5 4.5 L13.5 8.5 C13.5 11.5 11 13.5 8 14.5 C5 13.5 2.5 11.5 2.5 8.5 L2.5 4.5 Z"/>
    </svg>
  </span>` : "";
  tab.innerHTML = `
    <span class="tab-dot ${initialStatus}"></span>
    <span class="tab-name">${escHtml(tabLabel)}</span>
    ${privateBadge}
    ${sftpBtn}
    ${tunnelBtn}
    ${runbookBtn}
    <button class="tab-close" title="Cerrar">✕</button>`;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) return;
    if (e.target.classList.contains("tab-sftp")) return;
    if (e.target.classList.contains("tab-tunnels")) return;
    if (e.target.classList.contains("tab-notes")) return;
    selectSession(tab.dataset.session, e.ctrlKey || e.metaKey);
  });
  tab.querySelector(".tab-close").addEventListener("click", () => closeSession(tab.dataset.session));
  tab.querySelector(".tab-sftp")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSftpPanel(tab.dataset.session);
  });
  tab.querySelector(".tab-tunnels")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTunnelPanel(tab.dataset.session);
  });
  tab.querySelector(".tab-notes")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRunbookPanel(tab.dataset.session);
  });
  attachTabDragHandlers(tab);
  document.getElementById("tabs-container").appendChild(tab);
  // Compactar al instante la pestaña de Inicio: aplicamos body.has-session-tabs
  // en el mismo tick que insertamos la .tab en el DOM (la siguiente llamada a
  // selectSession/renderView llega más tarde, así no parpadea).
  updateTabSelectionClasses();
  return tab;
}

/**
 * Construye el tooltip del tab. Para SSH/SFTP/FTP/RDP muestra "user@host:port".
 * Para shell local solo el nombre. Si falta info se omite.
 */
function buildTabTooltip(profile, alias = "") {
  if (!profile) return alias || "";
  const parts = [];
  // Si la sesión tiene un alias temporal, lo anteponemos al nombre del perfil
  // para que el tooltip refleje "alias · Nombre · user@host:port · TIPO".
  const trimmedAlias = (alias || "").trim();
  if (trimmedAlias) parts.push(trimmedAlias);
  parts.push(profile.name);
  if (profile.host) {
    const user = profile.username ? `${profile.username}@` : "";
    const port = profile.port ? `:${profile.port}` : "";
    parts.push(`${user}${profile.host}${port}`);
  }
  if (profile.connection_type) {
    parts.push(profile.connection_type.toUpperCase());
  }
  return parts.join(" · ");
}

/**
 * Resuelve la etiqueta visible de una pestaña: usa el alias temporal de la
 * sesión (`s.alias`) si existe y no está vacío; en caso contrario el nombre
 * del perfil asociado. El alias vive solo en runtime (no se persiste).
 */
function getSessionTabLabel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return "";
  const alias = (s.alias || "").trim();
  if (alias) return alias;
  const profile = profiles.find((p) => p.id === s.profileId);
  if (profile?.name) return profile.name;
  // Fallback: el nombre que ya estuviera pintado en la pestaña.
  const tab = document.querySelector(`.tab[data-session="${CSS.escape(sessionId)}"]`);
  return tab?.querySelector(".tab-name")?.textContent || "";
}

/**
 * Actualiza en el DOM el nombre visible y el tooltip de una pestaña según su
 * alias/perfil actuales. Marca la clase `has-alias` para poder estilarla.
 */
function updateTabLabel(sessionId) {
  const tab = document.querySelector(`.tab[data-session="${CSS.escape(sessionId)}"]`);
  if (!tab) return;
  const s = sessions.get(sessionId);
  const alias = (s?.alias || "").trim();
  const nameEl = tab.querySelector(".tab-name");
  if (nameEl) nameEl.textContent = getSessionTabLabel(sessionId);
  const profile = s ? profiles.find((p) => p.id === s.profileId) : null;
  tab.title = buildTabTooltip(profile, alias);
  tab.classList.toggle("has-alias", !!alias);
}

/**
 * Drag & drop entre tabs para reordenarlos. Mantiene el orden visual en el
 * contenedor — no persiste todavía (cada reapertura recolocaría según el
 * orden de los perfiles). Para persistir habría que guardar el orden en
 * prefs.tabOrder y aplicarlo al recrear sesiones.
 */
function attachTabDragHandlers(tab) {
  tab.addEventListener("dragstart", (e) => {
    if (e.target.closest(".tab-close, .tab-sftp, .tab-tunnels")) {
      e.preventDefault();
      return;
    }
    tab.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/x-rustty-tab", tab.dataset.session); } catch {}
  });
  tab.addEventListener("dragend", () => {
    tab.classList.remove("is-dragging");
    document.querySelectorAll(".tab.drop-before, .tab.drop-after")
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  });
  tab.addEventListener("dragover", (e) => {
    const dragging = document.querySelector(".tab.is-dragging");
    if (!dragging || dragging === tab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = tab.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    tab.classList.toggle("drop-before", before);
    tab.classList.toggle("drop-after", !before);
  });
  tab.addEventListener("dragleave", () => {
    tab.classList.remove("drop-before", "drop-after");
  });
  tab.addEventListener("drop", (e) => {
    e.preventDefault();
    const dragging = document.querySelector(".tab.is-dragging");
    tab.classList.remove("drop-before", "drop-after");
    if (!dragging || dragging === tab) return;
    const rect = tab.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    const parent = tab.parentNode;
    if (before) parent.insertBefore(dragging, tab);
    else parent.insertBefore(dragging, tab.nextSibling);
  });
}

function viewKey(selection = viewSelection) {
  return selection.join("|");
}

function getViewLayout() {
  return viewLayouts.get(viewKey()) || "columns";
}

function setViewLayout(layout) {
  if (!["columns", "rows", "grid"].includes(layout)) return;
  viewLayouts.set(viewKey(), layout);
  // Reset ratios when switching layout (axis may have changed)
  viewRatios.delete(viewKey());
  renderView();
}

function computeGridDims(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

function isBroadcastOn() {
  return broadcastViews.get(viewKey()) === true;
}

function toggleBroadcast() {
  if (viewSelection.length < 2) return;
  broadcastViews.set(viewKey(), !isBroadcastOn());
  updateLayoutBarActive();
  updateBroadcastClasses();
}

function updateBroadcastClasses() {
  const on = isBroadcastOn() && viewSelection.length > 1;
  document.querySelectorAll(".terminal-pane").forEach((p) => {
    const sid = p.dataset.session;
    const s = sessions.get(sid);
    const eligible = !!s && !!s.terminal && s.type !== "rdp" && viewSelection.includes(sid);
    p.classList.toggle("pane-broadcasting", on && eligible);
  });
  const btn = document.querySelector('#view-layout-bar button[data-action="broadcast"]');
  if (btn) btn.classList.toggle("active", on);
}

// Niveles de aviso en la pestaña, de menor a mayor severidad:
//   - actividad normal: output del terminal → azul/naranja (CSS por tema)
//   - important: aviso (reconectando, transfer terminada, etc.) → amarillo
//   - disconnect: la sesión murió o tuvo un error fatal → rojo
// `disconnect` gana sobre `important`; `important` gana sobre actividad normal.
function markTabActivity(sessionId, { important = false, kind = null } = {}) {
  if (!sessionId) return;
  if (sessionId === activeSessionId && !document.hidden) return;
  const tab = document.querySelector(`.tab[data-session="${CSS.escape(sessionId)}"]`);
  if (!tab) return;
  tab.classList.add("has-unread-activity");
  if (kind === "disconnect") {
    tab.classList.add("has-unread-disconnect");
    tab.classList.remove("has-unread-important");
  } else if (important && !tab.classList.contains("has-unread-disconnect")) {
    tab.classList.add("has-unread-important");
  }
}

function clearTabActivity(sessionId) {
  if (!sessionId) return;
  const tab = document.querySelector(`.tab[data-session="${CSS.escape(sessionId)}"]`);
  tab?.classList.remove(
    "has-unread-activity",
    "has-unread-important",
    "has-unread-disconnect",
  );
}

/**
 * Envía input a una sesión terminal (SSH o shell local).
 * Se usa tanto para la pane origen como para replicar en broadcast.
 */
function sendTerminalInput(sessionObj, data) {
  if (!sessionObj || sessionObj.status === "closed" || !sessionObj.terminal || sessionObj.type === "rdp") return;
  const cmd = sessionObj._closeOverride ? "local_shell_send_input" : "ssh_send_input";
  invoke(cmd, {
    sessionId: sessionObj.id,
    data: Array.from(new TextEncoder().encode(data)),
  }).catch(() => {});
}

async function readSystemClipboardText() {
  try {
    return await readClipboardText();
  } catch (err) {
    console.warn("[clipboard] plugin read failed, falling back to navigator", err);
    return await navigator.clipboard?.readText?.().catch(() => null);
  }
}

async function writeSystemClipboardText(text) {
  if (!text) return;
  try {
    await writeClipboardText(text);
  } catch (err) {
    console.warn("[clipboard] plugin write failed, falling back to navigator", err);
    await navigator.clipboard?.writeText?.(text).catch(() => {});
  }
}

// Umbral de longitud (caracteres) a partir del cual un pegado se considera
// "muy largo" y dispara la confirmación.
const PASTE_WARN_LENGTH = 2000;
// Caracteres de control C0 peligrosos: todo el rango 0x00–0x1F y DEL (0x7F)
// EXCEPTO tab (\t = 0x09), salto de línea (\n = 0x0A) y retorno (\r = 0x0D),
// que son habituales en texto legítimo. ESC (0x1B) y demás podrían inyectar
// secuencias de terminal.
const PASTE_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
// Cuántas líneas / caracteres mostrar como extracto en la previsualización.
const PASTE_PREVIEW_MAX_LINES = 10;
const PASTE_PREVIEW_MAX_CHARS = 500;

/**
 * Decide si un texto a pegar en el terminal es "peligroso" y, por tanto,
 * merece confirmación. Devuelve el motivo principal ("multiline" | "long" |
 * "control") o null si el pegado es seguro (corto, una sola línea y sin
 * caracteres de control). El orden prioriza el riesgo de ejecución de
 * comandos (multilínea) y la inyección de secuencias (control).
 */
function pasteNeedsConfirmation(text) {
  if (!text) return null;
  if (PASTE_CONTROL_CHARS_RE.test(text)) return "control";
  if (/[\r\n]/.test(text)) return "multiline";
  if (text.length > PASTE_WARN_LENGTH) return "long";
  return null;
}

/**
 * Construye el cuerpo de la previsualización tematizada: motivo, recuento de
 * líneas y caracteres, y un extracto truncado del texto. Se devuelve como
 * texto plano (la modal usa `textContent`), sin HTML.
 */
function buildPastePreviewMessage(text, reason) {
  const lineCount = text.split(/\r\n|\r|\n/).length;
  const charCount = text.length;
  const reasonKey =
    reason === "control" ? "modal_paste.reason_control"
    : reason === "long"  ? "modal_paste.reason_long"
    : "modal_paste.reason_multiline";

  // Extracto: primeras N líneas o M caracteres (lo que se alcance antes).
  let excerpt = text.split(/\r\n|\r|\n/).slice(0, PASTE_PREVIEW_MAX_LINES).join("\n");
  let truncated = lineCount > PASTE_PREVIEW_MAX_LINES;
  if (excerpt.length > PASTE_PREVIEW_MAX_CHARS) {
    excerpt = excerpt.slice(0, PASTE_PREVIEW_MAX_CHARS);
    truncated = true;
  }
  // Neutraliza caracteres de control en el extracto para que no afecten al
  // render de la modal (se sustituyen por su nombre simbólico básico).
  excerpt = excerpt.replace(PASTE_CONTROL_CHARS_RE, (ch) =>
    ch === "\x1b" ? "␛" : "·"
  );
  if (truncated) excerpt += "\n…";

  return [
    t(reasonKey),
    t("modal_paste.stats", { lines: lineCount, chars: charCount }),
    "",
    excerpt,
  ].join("\n");
}

async function pasteClipboardIntoSession(sessionObj) {
  if (!sessionObj || sessionObj.status === "closed" || !sessionObj.terminal || sessionObj.type === "rdp") return;
  const text = await readSystemClipboardText();
  if (!text) return;

  // Confirmación de pegado peligroso. Se omite si:
  //  - el texto es seguro (corto, una línea, sin caracteres de control),
  //  - la preferencia global `confirmRiskyPaste` está desactivada, o
  //  - el perfil de la sesión tiene la excepción `disable_paste_confirm`.
  const reason = pasteNeedsConfirmation(text);
  if (reason && prefs.confirmRiskyPaste !== false) {
    const profile = sessionObj.profileId
      ? profiles.find((p) => p.id === sessionObj.profileId)
      : null;
    const profileSkips = !!profile?.disable_paste_confirm;
    if (!profileSkips) {
      const ok = await confirmThemed({
        title: t("modal_paste.title"),
        message: buildPastePreviewMessage(text, reason),
        submitLabel: t("modal_paste.submit"),
        danger: true,
      });
      if (!ok) return;
    }
  }

  sendTerminalInput(sessionObj, text);
}

function queueTerminalEchoSuppression(sessionObj, needle) {
  if (!sessionObj || !needle) return;
  sessionObj._outputSuppression = {
    needle,
    buffer: "",
    expiresAt: Date.now() + 5000,
  };
}

/* ─── Editor de reglas de resaltado en Preferencias ─── */
const HIGHLIGHT_COLOR_OPTIONS = ["red", "yellow", "green", "blue", "magenta", "cyan", "white"];

function renderHighlightRulesEditor() {
  const body = document.getElementById("highlight-rules-body");
  if (!body) return;
  const rules = Array.isArray(prefs.highlightRules) ? prefs.highlightRules : [];
  body.innerHTML = rules.map((rule, idx) => `
    <tr data-rule-idx="${idx}">
      <td><input type="text" class="hl-pattern" value="${escHtml(rule.pattern || "")}" placeholder="ERROR|FAIL" spellcheck="false" /></td>
      <td>
        <select class="hl-color">
          ${HIGHLIGHT_COLOR_OPTIONS.map((c) =>
            `<option value="${c}"${c === rule.color ? " selected" : ""}>${c}</option>`
          ).join("")}
        </select>
      </td>
      <td><input type="checkbox" class="hl-bold"${rule.bold ? " checked" : ""} /></td>
      <td><button type="button" class="btn-icon-sm danger hl-delete" title="Eliminar">✕</button></td>
    </tr>`).join("");
}

function readHighlightRulesFromEditor() {
  const body = document.getElementById("highlight-rules-body");
  if (!body) return Array.isArray(prefs.highlightRules) ? prefs.highlightRules : [];
  return [...body.querySelectorAll("tr[data-rule-idx]")]
    .map((tr) => ({
      pattern: tr.querySelector(".hl-pattern").value.trim(),
      color: tr.querySelector(".hl-color").value,
      bold: tr.querySelector(".hl-bold").checked,
    }))
    .filter((r) => r.pattern);
}

// Tabla nombre-color → código SGR para foreground brillante (90–97).
const HIGHLIGHT_COLORS = {
  red:     "91",
  yellow:  "93",
  green:   "92",
  blue:    "94",
  magenta: "95",
  cyan:    "96",
  white:   "97",
};

let _compiledHighlightRules = null;
let _compiledHighlightRulesSnapshot = null;

function compileHighlightRules() {
  const raw = Array.isArray(prefs.highlightRules) ? prefs.highlightRules : [];
  const snapshot = JSON.stringify(raw);
  if (_compiledHighlightRulesSnapshot === snapshot) return _compiledHighlightRules;
  const compiled = [];
  for (const rule of raw) {
    if (!rule?.pattern) continue;
    const color = HIGHLIGHT_COLORS[rule.color] || HIGHLIGHT_COLORS.yellow;
    const bold = rule.bold ? "1;" : "";
    try {
      compiled.push({
        re: new RegExp(rule.pattern, "g"),
        prefix: `\x1b[${bold}${color}m`,
        suffix: "\x1b[0m",
      });
    } catch {
      // patrón inválido → ignorar la regla
    }
  }
  _compiledHighlightRules = compiled;
  _compiledHighlightRulesSnapshot = snapshot;
  return compiled;
}

/**
 * Aplica las reglas `prefs.highlightRules` envolviendo cada coincidencia con
 * códigos SGR. Se hace por chunk (no por línea), así que matches que crucen
 * un límite de chunk no se resaltan — limitación aceptable para reglas
 * típicas como `ERROR`, `WARN`, IPs, etc.
 */
function applyHighlightRules(text) {
  const rules = compileHighlightRules();
  if (!rules.length) return text;
  let out = text;
  for (const r of rules) {
    out = out.replace(r.re, (m) => `${r.prefix}${m}${r.suffix}`);
  }
  return out;
}

function filterSuppressedTerminalOutput(sessionObj, text) {
  const suppression = sessionObj?._outputSuppression;
  if (!suppression || !text) return text;

  suppression.buffer += text;
  const idx = suppression.buffer.indexOf(suppression.needle);
  if (idx >= 0) {
    const before = suppression.buffer.slice(0, idx);
    const after = suppression.buffer
      .slice(idx + suppression.needle.length)
      .replace(/^\r?\n/, "");
    delete sessionObj._outputSuppression;
    return before + after;
  }

  if (Date.now() > suppression.expiresAt) {
    const buffered = suppression.buffer;
    delete sessionObj._outputSuppression;
    return buffered;
  }

  let keepLen = 0;
  const maxKeep = Math.min(suppression.needle.length - 1, suppression.buffer.length);
  for (let len = 1; len <= maxKeep; len++) {
    if (suppression.needle.startsWith(suppression.buffer.slice(-len))) {
      keepLen = len;
    }
  }

  const flushLen = suppression.buffer.length - keepLen;
  if (flushLen <= 0) return "";

  const output = suppression.buffer.slice(0, flushLen);
  suppression.buffer = suppression.buffer.slice(flushLen);
  return output;
}

// Recorta la cola por su frente (lo más antiguo) cuando supera el límite. El
// recorte puede partir una secuencia de escape ANSI a la mitad y dejar un glitch
// visual puntual en el primer chunk que sí se pinta, pero ya estamos en modo
// degradado (avisamos del descarte) y conservar el final es lo útil para un `cat`.
function trimTerminalOutputQueue(sessionObj) {
  const queue = sessionObj?._outputQueue;
  if (!queue || (sessionObj._outputQueuedChars || 0) <= TERMINAL_OUTPUT_QUEUE_LIMIT_CHARS) return;

  let dropped = 0;
  while (queue.length && sessionObj._outputQueuedChars > TERMINAL_OUTPUT_QUEUE_LIMIT_CHARS) {
    const over = sessionObj._outputQueuedChars - TERMINAL_OUTPUT_QUEUE_LIMIT_CHARS;
    const first = queue[0] || "";
    if (first.length <= over) {
      dropped += first.length;
      sessionObj._outputQueuedChars -= first.length;
      queue.shift();
    } else {
      queue[0] = first.slice(over);
      dropped += over;
      sessionObj._outputQueuedChars -= over;
    }
  }
  if (dropped > 0) sessionObj._outputDroppedChars = (sessionObj._outputDroppedChars || 0) + dropped;
}

function takeTerminalOutputChunk(sessionObj) {
  if (!sessionObj?._outputQueue?.length && !sessionObj?._outputDroppedChars) return "";

  let out = "";
  if (sessionObj._outputDroppedChars) {
    const droppedKb = Math.ceil(sessionObj._outputDroppedChars / 1024);
    out += `\r\n\x1b[33m... salida omitida para mantener la terminal fluida (${droppedKb} KiB) ...\x1b[0m\r\n`;
    sessionObj._outputDroppedChars = 0;
  }

  const queue = sessionObj._outputQueue || [];
  while (queue.length && out.length < TERMINAL_OUTPUT_CHUNK_CHARS) {
    const first = queue[0] || "";
    const remaining = TERMINAL_OUTPUT_CHUNK_CHARS - out.length;
    if (first.length <= remaining) {
      out += first;
      sessionObj._outputQueuedChars -= first.length;
      queue.shift();
    } else {
      out += first.slice(0, remaining);
      queue[0] = first.slice(remaining);
      sessionObj._outputQueuedChars -= remaining;
    }
  }
  return out;
}

function scheduleTerminalOutputFlush(sessionObj) {
  if (!sessionObj || sessionObj._outputWriting || sessionObj._outputFlushScheduled) return;
  sessionObj._outputFlushScheduled = true;
  const run = () => {
    sessionObj._outputFlushScheduled = false;
    flushTerminalOutput(sessionObj);
  };
  // `requestAnimationFrame` no se dispara cuando la ventana está oculta o
  // minimizada. Si en ese estado llega una ráfaga (p. ej. un `cat` en una
  // pestaña de fondo) la cola dejaría de drenarse y se llenaría hasta el límite,
  // provocando descartes innecesarios al volver al primer plano. Con la ventana
  // oculta caemos a un temporizador para que la cola siga vaciándose.
  if (typeof document !== "undefined" && document.hidden) {
    setTimeout(run, 32);
  } else {
    requestAnimationFrame(run);
  }
}

function flushTerminalOutput(sessionObj) {
  if (!sessionObj?.terminal || sessionObj._outputWriting) return;
  const chunk = takeTerminalOutputChunk(sessionObj);
  if (!chunk) return;

  sessionObj._outputWriting = true;
  sessionObj.terminal.write(chunk, () => {
    sessionObj._outputWriting = false;
    if (sessionObj._outputQueue?.length || sessionObj._outputDroppedChars) {
      scheduleTerminalOutputFlush(sessionObj);
    }
  });
}

function enqueueTerminalOutput(sessionObj, text) {
  if (!sessionObj?.terminal || !text) return;
  if (!sessionObj._outputQueue) sessionObj._outputQueue = [];
  const str = String(text);
  sessionObj._outputQueue.push(str);
  sessionObj._outputQueuedChars = (sessionObj._outputQueuedChars || 0) + str.length;
  trimTerminalOutputQueue(sessionObj);
  scheduleTerminalOutputFlush(sessionObj);
}

function clearTerminalOutputQueue(sessionObj) {
  if (!sessionObj) return;
  sessionObj._outputQueue = [];
  sessionObj._outputQueuedChars = 0;
  sessionObj._outputDroppedChars = 0;
  sessionObj._outputFlushScheduled = false;
  sessionObj._outputWriting = false;
}

/**
 * Inyecta un hook OSC 7 en el shell remoto (bash/zsh) para que emita el
 * cwd después de cada prompt. Sin esto el panel SFTP no puede seguir al
 * terminal. Se ejecuta una sola vez por sesión SSH tras conectar.
 *
 * Limitación conocida: cuando el usuario eleva privilegios con `sudo su -`
 * o `sudo -i`, el nuevo shell no hereda PROMPT_COMMAND / precmd_functions
 * y además la sesión SFTP sigue siendo la del usuario original (sin
 * privilegios). Resultado: no se pueden seguir rutas como /root/.
 * Esto requiere un enfoque más amplio (bind-mount SFTP del shell actual
 * o exponer `sudo` al canal SFTP) que queda fuera de este arreglo.
 */
function injectOsc7Setup(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "connected" || s._osc7Injected) return;
  s._osc7Injected = true;
  // Para no contaminar el historial del shell remoto:
  //   - El espacio inicial hace que la línea se ignore si el shell tiene
  //     HISTCONTROL=ignorespace (bash, default en Fedora/Debian/Ubuntu) o
  //     HIST_IGNORE_SPACE (zsh).
  //   - Al final, en bash, `history -d $HISTCMD` borra esta línea del
  //     historial en memoria; cubre shells sin `ignorespace`.
  //   - En zsh, además activamos `HIST_IGNORE_SPACE` para que futuras
  //     reinyecciones (si se reconecta) queden silenciadas.
  const setup =
    ` { [ -n "$BASH_VERSION" ] && export PROMPT_COMMAND='printf "\\033]7;file://%s%s\\033\\\\" "$HOSTNAME" "$PWD"'"\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; ` +
    `[ -n "$ZSH_VERSION" ] && { _osc7() { printf "\\033]7;file://%s%s\\033\\\\" "$HOST" "$PWD"; }; ` +
    `typeset -ga precmd_functions; precmd_functions+=(_osc7); setopt HIST_IGNORE_SPACE 2>/dev/null; }; ` +
    `printf "\\033]7;file://%s%s\\033\\\\" "\${HOSTNAME:-$HOST}" "$PWD"; ` +
    `[ -n "$BASH_VERSION" ] && history -d $((HISTCMD)) 2>/dev/null; } 2>/dev/null`;
  queueTerminalEchoSuppression(s, setup.trimStart());
  sendTerminalInput(s, `${setup}\r`);
}

function canInjectOsc7ForSession(sessionObj) {
  const profile = sessionObj?.profileId ? profiles.find((p) => p.id === sessionObj.profileId) : null;
  return !profile || profile.follow_cwd !== false;
}

function setSftpFollow(sessionId, enabled, button = null) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  s.sftp.follow = !!enabled;
  button?.classList.toggle("active", s.sftp.follow);
  if (!s.sftp.follow) return;
  if (s.remoteCwd && s.remoteCwd !== s.sftp.cwd) {
    navigateSftpRemote(sessionId, s.remoteCwd);
  } else if (!s.remoteCwd && canInjectOsc7ForSession(s)) {
    injectOsc7Setup(sessionId);
  }
}

/**
 * Maneja input de una terminal. Si broadcast está activo y la sesión forma parte
 * de la vista actual, replica el input a todas las otras panes de la vista.
 */
/**
 * Reabre una sesión cerrada reutilizando la pestaña y el xterm existentes.
 * Para shell local: reusa el mismo sessionId.
 * Para SSH: reusa el sessionId para registrar diagnóstico antes del invoke.
 * RDP no entra aquí (tiene su propio botón de reconexión).
 */
async function reconnectSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !["closed", "error"].includes(s.status)) return;
  // Mostramos el overlay en modo "Reconectando…" inmediatamente para que el
  // usuario vea feedback al pulsar Intro/Reconectar. El handler de
  // `ssh-connected-*` (o el de éxito de local_shell_open) lo ocultará; si
  // falla, las catch blocks de reconnect*InPlace lo vuelven a mostrar como
  // error con botón activo.
  showReconnectingOverlay(sessionId);
  if (s._closeOverride) {
    await reconnectLocalInPlace(s);
  } else if (s.profileId) {
    await reconnectSshInPlace(s);
  }
}

async function reconnectLocalInPlace(s) {
  const sessionId = s.id;
  for (const ul of s.unlisteners) { try { ul(); } catch {} }
  s.unlisteners = [];
  s.status = "connecting";
  updateTabStatus(sessionId, "connecting");

  try {
    await invoke("local_shell_open", {
      sessionId,
      cols: s.terminal.cols,
      rows: s.terminal.rows,
    });
    s.status = "connected";
    hideReconnectOverlay(sessionId);
    updateTabStatus(sessionId, "connected");
    renderDashboard();

    const decoder = new TextDecoder();
    const ul = await listen(eventName("shellData", sessionId), (e) => {
      const text = decoder.decode(new Uint8Array(e.payload));
      if (text) {
        enqueueTerminalOutput(s, text);
        markTabActivity(sessionId);
      }
    });
    const ulClose = await listen(eventName("shellClosed", sessionId), () => {
      s.status = "closed";
      updateTabStatus(sessionId, "error");
      renderDashboard();
      showReconnectOverlay(sessionId, "Consola cerrada");
      enqueueTerminalOutput(s, `\r\n\x1b[33m• ${t("terminal.shell_ended")}\x1b[0m \x1b[90m${t("terminal.closed_hint")}\x1b[0m\r\n`);
      markTabActivity(sessionId, { kind: "disconnect" });
    });
    s.unlisteners.push(ul, ulClose);
  } catch (err) {
    s.status = "error";
    updateTabStatus(sessionId, "error");
    showReconnectOverlay(sessionId, "Error al reabrir");
    toast(`Error al reabrir la consola: ${err}`, "error");
  }
}

async function reconnectSshInPlace(s) {
  const oldSessionId = s.id;
  const profile = profiles.find((p) => p.id === s.profileId);
  if (!profile) {
    toast("Perfil no encontrado; no se puede reconectar", "error");
    return;
  }

  // Con auth puntual («Duplicar con cambios») se vuelve a preguntar lo
  // necesario; con la del perfil se reutiliza el flujo normal.
  const creds = s._overrides?.auth_type
    ? await resolveOverrideAuthCredentials(profile, s._overrides)
    : await resolveSshCredentials(profile);
  if (!creds) return;

  for (const ul of s.unlisteners) { try { ul(); } catch {} }
  s.unlisteners = [];
  s.status = "connecting";
  updateTabStatus(oldSessionId, "connecting");
  appendConnectionLog(oldSessionId, {
    stage: "reconnecting",
    status: "info",
    message: `Preparando reconexión con ${profile.name}`,
    timestamp: new Date().toISOString(),
  });

  try {
    s.unlisteners = await registerSshListeners(oldSessionId, s.terminal);
    await invoke("ssh_connect", {
      sessionId: oldSessionId,
      profileId: profile.id,
      password:   creds.password   || null,
      passphrase: creds.passphrase || null,
      // Conserva el modo privado al reconectar: no reactivar la grabación de
      // sesión aunque el perfil la tenga habilitada.
      sessionLogOverride: s.private ? false : null,
      overrides: s._overrides || null,
    });
    updateTabStatus(oldSessionId, "connecting");
  } catch (err) {
    for (const ul of s.unlisteners) { try { ul(); } catch {} }
    s.unlisteners = [];
    s.status = "error";
    updateTabStatus(oldSessionId, "error");
    showReconnectOverlay(oldSessionId, "Error al reconectar");
    toast(`No se pudo reconectar: ${err}`, "error");
  }
}

function handleTerminalInput(sessionObj, data) {
  if (!sessionObj) return;
  captureCommandKeystroke(sessionObj, data);
  if (isBroadcastOn() && viewSelection.includes(sessionObj.id) && viewSelection.length > 1) {
    viewSelection.forEach((sid) => {
      sendTerminalInput(sessions.get(sid), data);
    });
  } else {
    sendTerminalInput(sessionObj, data);
  }
}

/**
 * Cambia o amplía la selección de vista.
 * - additive=false: reemplaza la selección por [sid]
 * - additive=true:  toggle de sid dentro de la selección (mínimo 1)
 */
function selectSession(sid, additive = false) {
  if (!sessions.has(sid)) return;
  if (additive) {
    const idx = viewSelection.indexOf(sid);
    if (idx >= 0) {
      if (viewSelection.length > 1) viewSelection.splice(idx, 1);
      // si era la única, la dejamos
    } else {
      viewSelection.push(sid);
    }
  } else {
    viewSelection = [sid];
  }
  activeSessionId = sid;
  clearTabActivity(sid);
  renderView();
  updateStatusBar();
  syncSidebarToActiveSession({ scroll: true });
}

function focusPaneByOffset(delta) {
  if (viewSelection.length < 2) return;
  const currentIdx = Math.max(0, viewSelection.indexOf(activeSessionId));
  const nextIdx = (currentIdx + delta + viewSelection.length) % viewSelection.length;
  activeSessionId = viewSelection[nextIdx];
  clearTabActivity(activeSessionId);
  updateTabSelectionClasses();
  updateStatusBar();
  syncSidebarToActiveSession({ scroll: true });
  sessions.get(activeSessionId)?.terminal?.focus();
}

function selectHomeTab() {
  viewSelection = [];
  activeSessionId = null;
  renderView();
  updateStatusBar();
  syncSidebarToActiveSession();
}

let _statusLatencyTimer = null;

function refitVisibleTerminals() {
  requestAnimationFrame(() => {
    viewSelection.forEach((sid) => {
      const s = sessions.get(sid);
      if (s?.fitAddon) {
        try {
          s.fitAddon.fit();
          notifyResize(sid, s.terminal);
        } catch {}
      }
    });
  });
}

function setStatusBarVisible(visible) {
  const bar = document.getElementById("status-bar");
  const container = document.getElementById("terminals-container");
  if (!bar || !container) return;

  const changed = container.classList.contains("status-bar-visible") !== visible;
  bar.classList.toggle("hidden", !visible);
  bar.setAttribute("aria-hidden", visible ? "false" : "true");
  container.classList.toggle("status-bar-visible", visible);
  if (changed) refitVisibleTerminals();
}

function clearStatusBar() {
  setStatusBarVisible(false);
  const userHostEl = document.getElementById("status-user-host");
  if (userHostEl) userHostEl.textContent = "—";
  const latEl = document.getElementById("status-latency");
  if (latEl) latEl.textContent = "—";
  const logTrigger = document.getElementById("status-log-trigger");
  if (logTrigger) logTrigger.classList.add("hidden");
  const logText = document.getElementById("status-log-text");
  if (logText) logText.textContent = "—";
  const dot = document.getElementById("status-dot");
  if (dot) dot.classList.remove("connected", "error", "reconnecting");
  if (_statusLatencyTimer) {
    clearInterval(_statusLatencyTimer);
    _statusLatencyTimer = null;
  }
}

function renderStatusConnectionLog() {
  const trigger = document.getElementById("status-log-trigger");
  const text = document.getElementById("status-log-text");
  const dot = trigger?.querySelector(".status-log-dot");
  if (!trigger || !text || !dot) return;
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  const latest = s?.connectionLogs?.at(-1);
  trigger.classList.toggle("hidden", !latest);
  if (!latest) return;
  trigger.classList.remove("info", "ok", "warning", "error");
  trigger.classList.add(latest.status || "info");
  text.textContent = latest.message || "Diagnóstico de conexión";
}

function toggleActiveConnectionLogPanel() {
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!s || s.type === "rdp") return;
  toggleConnectionLogPanel(activeSessionId);
}

/**
 * Si la ruta empieza por /home/<user> o /Users/<user>, lo sustituye por ~.
 * Cosmético para que la status bar no quede atestada en sesiones con cwd
 * dentro del home.
 */
function collapseHomePath(path) {
  if (typeof path !== "string") return path;
  return path.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}

/**
 * Construye dentro de #status-cwd un breadcrumb de segmentos clicables a
 * partir de `rawPath` (el cwd remoto real). Normaliza:
 *   - Windows `\` → `/` para segmentar; conserva el drive (`C:`) como primer
 *     segmento, con `data-path` = `C:/`.
 *   - Rutas POSIX absolutas: primer segmento `/` (raíz) con `data-path` `/`.
 *   - Home colapsado: si la ruta cae dentro de /home/<user> o /Users/<user>,
 *     se muestra `~` como primer segmento, pero su `data-path` (y el de los
 *     segmentos siguientes) usa la base REAL del home, no `~`.
 * Cada segmento navega el panel SFTP a su ruta acumulada real al pulsar; con
 * Ctrl/Cmd+clic copia esa ruta. El icono 📂 copia la ruta completa.
 */
function renderCwdBreadcrumb(sessionId, rawPath) {
  const cwdEl = document.getElementById("status-cwd");
  if (!cwdEl) return;
  cwdEl.innerHTML = "";
  if (!rawPath) return;

  // Base real del home si la ruta colapsa a "~" (lo que recorta collapseHomePath).
  const collapsed = collapseHomePath(rawPath);
  const usesHome = collapsed.startsWith("~");
  let homeBase = "";
  if (usesHome) {
    const m = rawPath.match(/^\/(?:home|Users)\/[^/]+/);
    homeBase = m ? m[0] : "";
  }

  // Detectar drive de Windows al inicio (C:, D:, …), tolerando "\" o "/".
  const driveMatch = rawPath.match(/^([A-Za-z]):[\\/]?/);
  const isWindows = !!driveMatch;

  // Trabajamos siempre con "/" como separador para segmentar.
  const unified = collapsed.replace(/\\/g, "/");

  // segments: lista de { label, path } donde path es la ruta REAL acumulada.
  const segments = [];

  if (isWindows) {
    const drive = `${driveMatch[1]}:`;
    // Quitar el prefijo de drive (con o sin separador) del resto.
    const rest = unified.replace(/^[A-Za-z]:\/?/, "");
    segments.push({ label: drive, path: `${drive}/` });
    let acc = `${drive}`;
    for (const part of rest.split("/")) {
      if (!part) continue;
      acc = `${acc}/${part}`;
      segments.push({ label: part, path: acc });
    }
  } else if (usesHome) {
    // unified empieza por "~"; el resto cuelga del homeBase real.
    const rest = unified.replace(/^~\/?/, "");
    segments.push({ label: "~", path: homeBase || "/" });
    let acc = homeBase;
    for (const part of rest.split("/")) {
      if (!part) continue;
      acc = `${acc}/${part}`;
      segments.push({ label: part, path: acc });
    }
  } else {
    // POSIX absoluta o relativa.
    const absolute = unified.startsWith("/");
    let acc = "";
    if (absolute) segments.push({ label: "/", path: "/" });
    const parts = unified.split("/").filter(Boolean);
    for (const part of parts) {
      acc = absolute ? `${acc}/${part}` : (acc ? `${acc}/${part}` : part);
      segments.push({ label: part, path: acc });
    }
    if (!absolute && segments.length === 0 && unified) {
      segments.push({ label: unified, path: unified });
    }
  }

  // Pintar segmentos con separadores sutiles entre medias.
  segments.forEach((seg, i) => {
    if (i > 0) {
      const sepSpan = document.createElement("span");
      sepSpan.className = "cwd-sep";
      sepSpan.setAttribute("aria-hidden", "true");
      sepSpan.textContent = "/";
      cwdEl.appendChild(sepSpan);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cwd-seg";
    btn.dataset.path = seg.path;
    btn.textContent = seg.label;
    btn.title = `${t("status.cwd_seg_nav", { path: seg.path })} · ${t("status.cwd_copy_seg")}`;
    btn.setAttribute("aria-label", t("status.cwd_seg_nav", { path: seg.path }));
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // Ctrl/Cmd+clic copia la ruta acumulada del segmento en vez de navegar.
      if (ev.ctrlKey || ev.metaKey) {
        await writeSystemClipboardText(seg.path);
        toast(t("status.cwd_copied"), "success");
        return;
      }
      await navigateCwdBreadcrumb(sessionId, seg.path);
    });
    cwdEl.appendChild(btn);
  });
}

/**
 * Navega el panel SFTP remoto de `sessionId` a `path`. Si el panel no está
 * abierto/conectado, lo abre primero y luego navega. Muestra un toast si falla.
 */
async function navigateCwdBreadcrumb(sessionId, path) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    if (!s.sftp?.sftpSessionId) {
      // openSftpPanel ya navega al cwd inicial; tras conectar movemos al destino.
      await openSftpPanel(sessionId);
    }
    if (s.sftp?.sftpSessionId) {
      await navigateSftpRemote(sessionId, path);
    }
  } catch (err) {
    console.warn("[cwd-breadcrumb] navegación falló", err);
    toast(t("status.cwd_nav_error", { path }), "error");
  }
}

function updateStatusBar() {
  const bar = document.getElementById("status-bar");
  if (!bar) return;
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  const profile = s?.profileId ? profiles.find((p) => p.id === s.profileId) : null;
  // Solo mostramos status bar para sesiones SSH (RDP no es interactivo;
  // shell local no tiene host remoto).
  if (!profile || (profile.connection_type || "ssh") !== "ssh") {
    clearStatusBar();
    return;
  }
  setStatusBarVisible(true);

  const userHost = `${profile.username}@${profile.host}:${profile.port}`;
  const userHostEl = document.getElementById("status-user-host");
  if (userHostEl) userHostEl.textContent = userHost;

  const dot = document.getElementById("status-dot");
  if (dot) {
    dot.classList.remove("connected", "error", "reconnecting");
    if (s.status === "connected") dot.classList.add("connected");
    else if (s.status === "reconnecting") dot.classList.add("reconnecting");
    else if (s.status === "error" || s.status === "closed") dot.classList.add("error");
  }

  // CWD remoto detectado vía OSC 7 (solo si el shell lo emite).
  const cwdWrap = document.getElementById("status-cwd-wrap");
  const cwdSep  = document.querySelector(".status-cwd-sep");
  const cwdEl   = document.getElementById("status-cwd");
  if (cwdWrap && cwdEl && cwdSep) {
    if (s.remoteCwd) {
      // Breadcrumb de segmentos clicables (navegan el panel SFTP).
      renderCwdBreadcrumb(activeSessionId, s.remoteCwd);
      cwdEl.title = s.remoteCwd; // tooltip con la ruta completa real
      cwdWrap.classList.remove("hidden");
      cwdSep.classList.remove("hidden");

      // El icono 📂 copia la ruta completa real al portapapeles.
      const cwdIcon = cwdWrap.querySelector(".status-cwd-icon");
      if (cwdIcon && !cwdIcon.dataset.copyBound) {
        cwdIcon.dataset.copyBound = "1";
        cwdIcon.setAttribute("role", "button");
        cwdIcon.setAttribute("tabindex", "0");
        cwdIcon.title = t("status.cwd_copy");
        cwdIcon.setAttribute("aria-label", t("status.cwd_copy"));
        cwdIcon.addEventListener("click", async () => {
          const cur = activeSessionId ? sessions.get(activeSessionId) : null;
          if (!cur?.remoteCwd) return;
          await writeSystemClipboardText(cur.remoteCwd);
          toast(t("status.cwd_copied"), "success");
        });
      }
    } else {
      cwdEl.innerHTML = "";
      cwdWrap.classList.add("hidden");
      cwdSep.classList.add("hidden");
    }
  }

  // Dimensiones cols × rows del xterm activo.
  const dimsEl = document.getElementById("status-dims");
  if (dimsEl && s.terminal) {
    dimsEl.textContent = `${s.terminal.cols}×${s.terminal.rows}`;
  } else if (dimsEl) {
    dimsEl.textContent = "—";
  }

  // Badge REC si el perfil tiene session_log activado.
  const recWrap = document.getElementById("status-rec-wrap");
  if (recWrap) recWrap.classList.toggle("hidden", !profile.session_log);

  renderStatusConnectionLog();

  // Reanudar el probe de latencia cada vez que cambiamos de sesión activa
  if (_statusLatencyTimer) { clearInterval(_statusLatencyTimer); _statusLatencyTimer = null; }
  const latEl = document.getElementById("status-latency");
  if (latEl) latEl.textContent = "—";
  const probe = async () => {
    if (activeSessionId !== s.sessionId) return; // cambió la sesión activa
    try {
      const ms = await invoke("tcp_ping", { host: profile.host, port: profile.port });
      if (latEl && activeSessionId === s.sessionId) latEl.textContent = `${ms} ms`;
    } catch {
      if (latEl && activeSessionId === s.sessionId) latEl.textContent = "—";
    }
  };
  // Cachear sessionId en la propia sesión (no estaba)
  s.sessionId = activeSessionId;
  probe();
  _statusLatencyTimer = setInterval(probe, 10000);
}

function renderView() {
  const container = document.getElementById("terminals-container");
  const welcome   = document.getElementById("welcome-screen");
  const layoutBar = document.getElementById("view-layout-bar");

  // Desatar todas las panes (se conservan en memoria para no destruir xterm)
  sessions.forEach((s) => {
    if (s.pane && s.pane.parentElement) s.pane.parentElement.removeChild(s.pane);
  });
  // Eliminar cualquier wrapper de split previo
  container.querySelector(".view-split")?.remove();

  if (viewSelection.length === 0) {
    welcome.classList.remove("hidden");
    layoutBar?.classList.add("hidden");
    renderDashboard();
    updateTabSelectionClasses();
    return;
  }
  welcome.classList.add("hidden");

  if (viewSelection.length === 1) {
    const s = sessions.get(viewSelection[0]);
    if (s?.pane) container.appendChild(s.pane);
    layoutBar?.classList.add("hidden");
  } else {
    const layout = getViewLayout();
    const split = document.createElement("div");
    split.className = `view-split split-${layout}`;

    if (layout === "grid") {
      const { cols, rows } = computeGridDims(viewSelection.length);
      split.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      split.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      viewSelection.forEach((sid) => {
        const part = document.createElement("div");
        part.className = "view-part";
        const s = sessions.get(sid);
        if (s?.pane) part.appendChild(s.pane);
        split.appendChild(part);
      });
    } else {
      const axis = layout === "rows" ? "vertical" : "horizontal";
      const ratios = viewRatios.get(viewKey()) || viewSelection.map(() => 1);
      viewSelection.forEach((sid, i) => {
        if (i > 0) {
          const resizer = document.createElement("div");
          resizer.className = `view-resizer resizer-${axis}`;
          resizer.addEventListener("mousedown", (e) => startViewResize(e, split, i - 1, axis));
          split.appendChild(resizer);
        }
        const part = document.createElement("div");
        part.className = "view-part";
        part.style.flex = `${ratios[i] ?? 1} 1 0`;
        const s = sessions.get(sid);
        if (s?.pane) part.appendChild(s.pane);
        split.appendChild(part);
      });
    }
    container.appendChild(split);
    layoutBar?.classList.remove("hidden");
    updateLayoutBarActive();
  }

  updateTabSelectionClasses();
  updateBroadcastClasses();

  // Fit de todas las panes visibles (tras el siguiente paint)
  requestAnimationFrame(() => {
    viewSelection.forEach((sid) => {
      const s = sessions.get(sid);
      if (s?.fitAddon) {
        try { s.fitAddon.fit(); notifyResize(sid, s.terminal); } catch {}
      }
    });
    sessions.get(activeSessionId)?.terminal?.focus();
  });
}

function updateLayoutBarActive() {
  const current = getViewLayout();
  document.querySelectorAll("#view-layout-bar button[data-layout]").forEach((b) => {
    b.classList.toggle("active", b.dataset.layout === current);
  });
  const bcast = document.querySelector('#view-layout-bar button[data-action="broadcast"]');
  if (bcast) bcast.classList.toggle("active", isBroadcastOn());
}

function updateTabSelectionClasses() {
  const hasSessionTabs = document.querySelector("#tabs-container .tab") !== null;
  document.body.classList.toggle("has-session-tabs", hasSessionTabs);
  document.querySelectorAll(".tab").forEach((t) => {
    const sid = t.dataset.session;
    t.classList.toggle("in-view",  viewSelection.includes(sid));
    t.classList.toggle("active",   sid === activeSessionId);
  });
  document.getElementById("home-tab")
    ?.classList.toggle("active", viewSelection.length === 0);
  // Mantener visible la pestaña activa cuando la barra desborda horizontalmente.
  // `nearest` no hace scroll si ya está a la vista, así que es barato en cada render.
  document.querySelector("#tabs-container .tab.active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateTabOverflowButton();
  if (activeSessionId) clearTabActivity(activeSessionId);
  document.querySelectorAll(".terminal-pane").forEach((p) => {
    p.classList.toggle("pane-focused",
      viewSelection.length > 1 && p.dataset.session === activeSessionId);
  });
}

// ═══════════════════════════════════════════════════════════════
// OVERFLOW DE PESTAÑAS – botón ⋯ con popover (lista + buscador)
// ═══════════════════════════════════════════════════════════════

// Índice de la fila resaltada en el popover (navegación con ↑/↓).
let _tabOverflowIndex = -1;
let _tabOverflowSearchTimer = 0;

/**
 * Muestra/oculta el botón ⋯ según si la barra de pestañas desborda
 * horizontalmente. El contenedor scrollable es #tab-scroll (overflow-x:auto);
 * comparamos su scrollWidth con su clientWidth.
 */
function updateTabOverflowButton() {
  const btn = document.getElementById("btn-tab-overflow");
  if (!btn) return;
  const bar = document.getElementById("tab-scroll");
  const hasTabs = document.querySelector("#tabs-container .tab") !== null;
  // +1px de holgura para evitar parpadeos por redondeo subpíxel.
  const overflowing = !!bar && hasTabs && bar.scrollWidth > bar.clientWidth + 1;
  btn.classList.toggle("hidden", !overflowing);
  if (!overflowing && !document.getElementById("tab-overflow-popover")?.classList.contains("hidden")) {
    toggleTabOverflow(false);
  }
}

/** Etiqueta de estado (dot) para una sesión, reutilizando las clases de .tab-dot. */
function tabOverflowDotClass(sessionId) {
  const status = sessions.get(sessionId)?.status || "closed";
  // Las clases de .tab-dot existentes son connected/connecting/reconnecting/error.
  if (status === "connected" || status === "connecting" || status === "reconnecting" || status === "error") {
    return status;
  }
  return ""; // closed / desconocido → punto neutro
}

/** Construye la línea "host" que se muestra bajo el nombre en el popover. */
function tabOverflowHostLine(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return "";
  const profile = profiles.find((p) => p.id === s.profileId);
  if (!profile?.host) return "";
  const user = profile.username ? `${profile.username}@` : "";
  const port = profile.port ? `:${profile.port}` : "";
  return `${user}${profile.host}${port}`;
}

/** Pinta la lista del popover filtrando por el texto del buscador. */
function renderTabOverflowList(query = "") {
  const list = document.getElementById("tab-overflow-list");
  if (!list) return;
  const q = query.trim().toLowerCase();
  const tabs = [...document.querySelectorAll("#tabs-container .tab")];
  const rows = tabs
    .map((tab) => {
      const sid = tab.dataset.session;
      const name = getSessionTabLabel(sid);
      const host = tabOverflowHostLine(sid);
      return { sid, name, host };
    })
    .filter(({ name, host }) =>
      !q || name.toLowerCase().includes(q) || host.toLowerCase().includes(q));

  if (!rows.length) {
    list.innerHTML = `<div class="tab-overflow-empty">${escHtml(t("tab_overflow.empty"))}</div>`;
    _tabOverflowIndex = -1;
    return;
  }

  list.innerHTML = rows.map(({ sid, name, host }) => {
    const dot = tabOverflowDotClass(sid);
    const isActive = sid === activeSessionId;
    const hostHtml = host ? `<span class="tab-overflow-host">${escHtml(host)}</span>` : "";
    return `<button type="button" class="tab-overflow-item${isActive ? " active" : ""}" role="option" data-session="${escHtml(sid)}">
      <span class="tab-dot ${dot}"></span>
      <span class="tab-overflow-copy">
        <span class="tab-overflow-name">${escHtml(name)}</span>
        ${hostHtml}
      </span>
    </button>`;
  }).join("");

  // Resaltar por defecto la pestaña activa si está en la lista; si no, la primera.
  const items = [...list.querySelectorAll(".tab-overflow-item")];
  const activeIdx = items.findIndex((it) => it.dataset.session === activeSessionId);
  _tabOverflowIndex = activeIdx >= 0 ? activeIdx : 0;
  highlightTabOverflowRow();
}

/** Marca visualmente la fila resaltada y la desplaza a la vista. */
function highlightTabOverflowRow() {
  const items = [...document.querySelectorAll("#tab-overflow-list .tab-overflow-item")];
  items.forEach((it, i) => it.classList.toggle("highlighted", i === _tabOverflowIndex));
  items[_tabOverflowIndex]?.scrollIntoView({ block: "nearest" });
}

/** Activa la pestaña de la fila indicada (mismo handler que el clic en un tab). */
function activateTabOverflowRow(sid) {
  if (!sid) return;
  selectSession(sid, false);
  toggleTabOverflow(false);
}

/**
 * Abre/cierra el popover de overflow. Al abrir, refresca la lista, posiciona
 * bajo el botón ⋯ y enfoca el buscador.
 */
function toggleTabOverflow(open) {
  const popover = document.getElementById("tab-overflow-popover");
  const btn = document.getElementById("btn-tab-overflow");
  if (!popover || !btn) return;
  if (open === undefined) open = popover.classList.contains("hidden");
  popover.classList.toggle("hidden", !open);
  btn.setAttribute("aria-expanded", String(open));
  if (!open) return;
  // Mantener visible la pestaña activa al abrir, por si quedó tras el botón ⋯.
  document.querySelector("#tabs-container .tab.active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  const search = document.getElementById("tab-overflow-search");
  if (search) search.value = "";
  renderTabOverflowList("");
  positionTabOverflowPopover();
  search?.focus();
}

/** Coloca el popover bajo el botón ⋯, con flip si se sale del viewport. */
function positionTabOverflowPopover() {
  const trigger = document.getElementById("btn-tab-overflow");
  const popover = document.getElementById("tab-overflow-popover");
  if (!trigger || !popover) return;
  const triggerRect = trigger.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 6;
  let top = triggerRect.bottom + margin;
  let left = triggerRect.left;
  // Por defecto alineado al borde derecho del botón (suele estar a la derecha).
  if (left + popRect.width > window.innerWidth - margin) {
    left = Math.max(margin, triggerRect.right - popRect.width);
  }
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, triggerRect.top - popRect.height - margin);
  }
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

/**
 * Resizer entre las panes i e i+1 de la vista actual. Escribe en viewRatios
 * cuando termina el drag.
 */
function startViewResize(e, splitEl, index, axis = "horizontal") {
  e.preventDefault();
  const parts = [...splitEl.querySelectorAll(".view-part")];
  if (parts.length < 2) return;
  const a = parts[index], b = parts[index + 1];
  const rectA = a.getBoundingClientRect();
  const rectB = b.getBoundingClientRect();
  const isH = axis === "horizontal";
  const total = isH ? rectA.width + rectB.width : rectA.height + rectB.height;
  const start = isH ? e.clientX : e.clientY;
  const startFlexA = parseFloat(a.style.flex) || 1;
  const startFlexB = parseFloat(b.style.flex) || 1;
  const sizeA = isH ? rectA.width : rectA.height;
  document.body.style.cursor = isH ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";

  const onMove = (ev) => {
    const delta = (isH ? ev.clientX : ev.clientY) - start;
    const newA = Math.max(0.1, (sizeA + delta) / total * (startFlexA + startFlexB));
    const newB = Math.max(0.1, (startFlexA + startFlexB) - newA);
    a.style.flex = `${newA} 1 0`;
    b.style.flex = `${newB} 1 0`;
  };
  const onUp = () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup",   onUp);
    // Guardar proporciones para esta vista
    const ratios = parts.map((p) => parseFloat(p.style.flex) || 1);
    viewRatios.set(viewKey(), ratios);
    // Re-fit
    parts.forEach((p) => {
      const s = sessions.get(p.querySelector(".terminal-pane")?.dataset.session);
      if (s?.fitAddon) { try { s.fitAddon.fit(); notifyResize(s.id, s.terminal); } catch {} }
    });
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup",   onUp);
}

/**
 * Marca el click del usuario dentro de una pane como "sesión focada" cuando
 * la vista tiene más de una. Útil para saber dónde va el foco del teclado.
 */
function wirePaneFocusOnClick(pane, sessionId) {
  pane.addEventListener("mousedown", () => {
    if (viewSelection.length <= 1) return;
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    updateTabSelectionClasses();
    updateStatusBar();
    syncSidebarToActiveSession({ scroll: true });
  }, true);
}

// ═══════════════════════════════════════════════════════════════
// TERMINAL
// ═══════════════════════════════════════════════════════════════

function buildReconnectOverlay(sessionId) {
  const overlay = document.createElement("div");
  overlay.className = "terminal-reconnect-overlay hidden";
  overlay.innerHTML = `
    <div class="terminal-reconnect-box">
      <span class="terminal-reconnect-spinner" aria-hidden="true"></span>
      <div class="terminal-reconnect-title">Sesión cerrada</div>
      <button type="button" class="terminal-reconnect-btn">Reconectar</button>
    </div>
  `;
  overlay.querySelector(".terminal-reconnect-btn").addEventListener("click", () => {
    reconnectSession(overlay.closest(".terminal-pane")?.dataset.session || sessionId);
  });
  return overlay;
}

function showReconnectOverlay(sessionId, title = "Sesión cerrada") {
  const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  const overlay = pane?.querySelector(".terminal-reconnect-overlay");
  if (!overlay) return;
  overlay.classList.remove("reconnecting");
  overlay.querySelector(".terminal-reconnect-title").textContent = title;
  overlay.querySelector(".terminal-reconnect-btn").disabled = false;
  overlay.querySelector(".terminal-reconnect-btn").textContent = "Reconectar";
  overlay.classList.remove("hidden");
}

// Reutiliza el mismo overlay para mostrar feedback "Reconectando…" mientras
// dura el invoke. El botón se deshabilita (con etiqueta "…") y aparece un
// spinner. `hideReconnectOverlay` lo retira al recibir `ssh-connected`; si
// falla, `showReconnectOverlay` lo vuelve a poner en su estado anterior.
function showReconnectingOverlay(sessionId, title = "Reconectando…") {
  const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  const overlay = pane?.querySelector(".terminal-reconnect-overlay");
  if (!overlay) return;
  overlay.classList.add("reconnecting");
  overlay.querySelector(".terminal-reconnect-title").textContent = title;
  const btn = overlay.querySelector(".terminal-reconnect-btn");
  btn.disabled = true;
  btn.textContent = "…";
  overlay.classList.remove("hidden");
}

function hideReconnectOverlay(sessionId) {
  const overlay = document.querySelector(
    `.terminal-pane[data-session="${sessionId}"] .terminal-reconnect-overlay`,
  );
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("reconnecting");
  const btn = overlay.querySelector(".terminal-reconnect-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Reconectar";
  }
}

/**
 * Esquemas considerados seguros para abrir directamente desde un enlace
 * detectado en la salida del terminal. La salida remota es no confiable,
 * así que solo se abren sin preguntar estos esquemas.
 */
const SAFE_LINK_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/**
 * Abre una URL externa con el opener del sistema (mismo mecanismo que el
 * resto de la app, ver `plugin:opener|open_url`).
 */
function openExternalUrl(url) {
  return invoke("plugin:opener|open_url", { url }).catch((err) =>
    toast(`${t("toast.link_open_error")}: ${err}`, "error", 6000)
  );
}

/**
 * Handler de enlaces de WebLinksAddon. La salida de un servidor remoto no es
 * confiable, por lo que validamos el esquema antes de abrir:
 *  - https/http/mailto se abren directamente con el opener seguro de Tauri.
 *  - Cualquier otro esquema (o URLs no parseables) requiere confirmación
 *    explícita del usuario y nunca se abre sin preguntar.
 * El callback de WebLinksAddon no es async, así que la confirmación se
 * resuelve con una IIFE async desacoplada.
 */
function handleTerminalLink(_event, uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    parsed = null;
  }

  if (parsed && SAFE_LINK_SCHEMES.has(parsed.protocol)) {
    openExternalUrl(uri);
    return;
  }

  // Esquema inesperado o URL no parseable: pedir confirmación antes de abrir.
  (async () => {
    const ok = await confirmThemed({
      title: t("toast.link_open_confirm_title"),
      message: t("toast.link_open_confirm_msg", { uri }),
      submitLabel: t("toast.link_open_submit"),
      danger: true,
    });
    if (ok) openExternalUrl(uri);
  })();
}

// Observador compartido de panes: cuando cambia el tamaño del contenedor de un
// terminal (arrastre de sidebar, divisor SFTP, splits, ventana), re-ajusta el
// terminal sin depender de los fit() manuales dispersos. El fit() se coalesce
// por frame con rAF; el aviso de cols/rows al backend va aparte con debounce
// (scheduleBackendResize, disparado por terminal.onResize si cambian las dims).
const paneResizeObserver = typeof ResizeObserver !== "undefined"
  ? new ResizeObserver((entries) => {
      for (const entry of entries) {
        const s = sessions.get(entry.target.dataset.session);
        if (!s?.fitAddon || s._fitRaf) continue;
        s._fitRaf = requestAnimationFrame(() => {
          s._fitRaf = null;
          try { s.fitAddon.fit(); } catch {}
        });
      }
    })
  : null;

function createTerminalTab(sessionId, profile, initialStatus, opts = {}) {
  const { sftp = true, private: isPrivate = false, credId = null } = opts;

  // Construir pane y meterlo en #terminals-container para que xterm pueda medir.
  // renderView() lo reubicará según la selección actual.
  const pane = document.createElement("div");
  pane.className = "terminal-pane";
  pane.dataset.session = sessionId;
  const termArea = document.createElement("div");
  termArea.className = "term-area";
  const xtermDiv = document.createElement("div");
  xtermDiv.className = "xterm-container";
  termArea.appendChild(xtermDiv);
  termArea.appendChild(buildTerminalSearchBar(sessionId));
  pane.appendChild(termArea);
  pane.appendChild(buildReconnectOverlay(sessionId));
  pane.appendChild(buildConnectionLogPanel(sessionId));
  document.getElementById("terminals-container").appendChild(pane);
  paneResizeObserver?.observe(pane);

  // Crear pestaña
  createTab(sessionId, profile, initialStatus, { sftp, private: isPrivate });

  const terminal = new Terminal({
    cursorBlink: prefs.cursorBlink,
    cursorStyle: prefs.cursorStyle,
    fontFamily: resolveFontFamily(),
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    letterSpacing: prefs.letterSpacing,
    scrollback: prefs.scrollback,
    bellStyle: prefs.bell,
    theme: getTerminalTheme(),
    allowProposedApi: true,
    // Desplazamiento con la rueda: el default de xterm (1) avanza muy pocas
    // líneas por muesca y se siente "atrancado". Subimos la sensibilidad para
    // que el scroll acompañe mejor a la velocidad real del ratón; el modo
    // rápido (Alt+rueda) avanza aún más para saltos largos.
    scrollSensitivity: 3,
    fastScrollSensitivity: 8,
    // Selección inteligente con doble clic: trata como parte de la palabra
    // los caracteres comunes de rutas, URLs, SHAs y nombres con guiones.
    // El default de xterm corta por /, :, -, etc. Slice estético #22.
    wordSeparator: " ()[]{}'\"`,;<>",
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon(handleTerminalLink));
  terminal.loadAddon(searchAddon);
  terminal.open(xtermDiv);
  // Renderer WebGL: el backend DOM por defecto de xterm es muy costoso al pintar
  // salidas masivas (un `cat` de un log grande puede saturar el hilo de UI). El
  // addon WebGL descarga el pintado a la GPU y sube el techo de rendimiento de
  // forma notable. Se carga tras `open()` (lo exige el addon) y de forma
  // defensiva: si el contexto no se puede crear (p. ej. WebKitGTK sin WebGL) o
  // se pierde en caliente, hacemos `dispose()` y xterm vuelve solo al renderer
  // DOM, así que nunca dejamos el terminal sin pintar.
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      try { webglAddon.dispose(); } catch {}
    });
    terminal.loadAddon(webglAddon);
  } catch (err) {
    console.warn("[webgl] renderer no disponible, se usa el backend DOM:", err);
  }
  // Ligaduras: el addon requiere que el terminal ya esté abierto en el DOM.
  // Solo carga si el toggle está activo; cambios en caliente no se aplican
  // a sesiones ya abiertas (avisado en el hint de Preferencias).
  if (prefs.terminalLigatures) {
    try { terminal.loadAddon(new LigaturesAddon()); }
    catch (err) { console.warn("[ligatures] addon failed to load:", err); }
  }
  fitAddon.fit();

  const sessionObj = {
    profileId: profile.id,
    id: sessionId,
    type: "ssh",
    terminal,
    fitAddon,
    searchAddon,
    pane,
    unlisteners: [],
    status: initialStatus,
    remoteCwd: null,
    tunnels: new Map(),
    tunnelPanel: null,
    connectionLogs: [],
    connectionLogOpen: false,
    // Identidad adicional usada para conectar (`ProfileCredential.id`) o null si
    // se usó la principal. Lo consulta «pegar contraseña» (Ctrl+P).
    credentialId: credId,
    // Sesión privada/efímera: suprime toda persistencia (recientes, actividad,
    // borrador, session_log). Se establece en createTerminalTab y createTab.
    private: isPrivate,
  };
  sessions.set(sessionId, sessionObj);
  wirePaneFocusOnClick(pane, sessionId);
  terminal.onBell(() => triggerTerminalBell(prefs.bell, pane));

  // OSC 7: el shell remoto emite `\e]7;file://host/path\e\\` al cambiar de cwd.
  // Muchos bash/zsh/fish modernos lo soportan (bash requiere hook en PROMPT_COMMAND).
  terminal.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (!m) return false;
    try {
      sessionObj.remoteCwd = decodeURIComponent(m[1]);
    } catch { sessionObj.remoteCwd = m[1]; }
    // Si el panel SFTP sigue al terminal, navegar al nuevo cwd
    if (sessionObj.sftp?.follow && sessionObj.sftp.cwd !== sessionObj.remoteCwd) {
      navigateSftp(sessionObj.id, sessionObj.remoteCwd);
    }
    // Refrescar el cwd en la barra inferior si esta sesión es la activa.
    if (sessionObj.id === activeSessionId) updateStatusBar();
    return true;
  });

  // OSC 133 (FinalTerm semantic prompts): A=prompt start, B=command start,
  // C=output start, D[;code]=command end. bash/zsh/fish modernos los
  // emiten cuando están configurados; Rustty marca la línea del prompt
  // actual con una franja izquierda de 2 px usando una decoración del
  // marker correspondiente. Slice estético #15.
  terminal.parser.registerOscHandler(133, (data) => {
    const kind = (data || "")[0];
    if (kind === "A") {
      try {
        // Dispose del marker/decoración previos.
        sessionObj._oscPromptDecoration?.dispose?.();
        sessionObj._oscPromptMarker?.dispose?.();
        const marker = terminal.registerMarker(0);
        if (!marker) return true;
        sessionObj._oscPromptMarker = marker;
        sessionObj._oscPromptDecoration = terminal.registerDecoration({
          marker,
          width: 1,
          height: 1,
          x: 0,
          layer: "top",
          backgroundColor: undefined,
        });
        if (sessionObj._oscPromptDecoration) {
          sessionObj._oscPromptDecoration.onRender((el) => {
            el.classList.add("osc133-prompt-decoration");
          });
        }
      } catch (err) {
        // xterm no expone decoraciones en versiones antiguas: no-op.
        console.debug("[osc133]", err);
      }
    }
    // B/C/D no necesitan acción visual ahora; futuras iteraciones podrían
    // medir tiempo de comando o capturar bloques.
    return true;
  });

  // Copiar al portapapeles al seleccionar (se activa/desactiva según prefs en tiempo real)
  terminal.onSelectionChange(() => {
    if (!prefs.copyOnSelect) return;
    const sel = terminal.getSelection();
    if (sel) writeSystemClipboardText(sel);
  });

  // Pegar con clic derecho (se activa/desactiva según prefs en tiempo real).
  // El portapapeles externo se lee vía plugin Tauri para no depender de las
  // restricciones de activación de `navigator.clipboard` en el WebView.
  xtermDiv.addEventListener("contextmenu", (e) => {
    if (prefs.rightClickPaste) {
      e.preventDefault();
      e.stopPropagation();
      pasteClipboardIntoSession(sessionObj);
    }
  }, true);

  terminal.onData((data) => {
    if (sessionObj.status === "closed" || sessionObj.status === "error") {
      if (data === "\r" || data === "\n") reconnectSession(sessionObj.id);
      return;
    }
    handleTerminalInput(sessionObj, data);
  });

  terminal.onResize(() => scheduleBackendResize(sessionObj));

  document.getElementById("welcome-screen").classList.add("hidden");
  selectSession(sessionId, false);
}

function buildConnectionLogPanel(sessionId) {
  const panel = document.createElement("div");
  panel.className = "connection-log-panel hidden";
  panel.dataset.session = sessionId;
  panel.innerHTML = `
    <div class="connection-log-head">
      <span>Diagnóstico de conexión</span>
      <button type="button" class="connection-log-close" aria-label="Cerrar">✕</button>
    </div>
    <div class="connection-log-list"></div>
  `;
  panel.querySelector(".connection-log-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setConnectionLogPanelOpen(sessionId, false);
  });
  return panel;
}

function normalizeConnectionLogEntry(entry = {}) {
  return {
    stage: entry.stage || "info",
    status: entry.status || "info",
    message: entry.message || "",
    timestamp: entry.timestamp || new Date().toISOString(),
  };
}

function connectionLogTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function appendConnectionLog(sessionId, rawEntry) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const entry = normalizeConnectionLogEntry(rawEntry);
  if (!entry.message) return;
  s.connectionLogs = s.connectionLogs || [];
  const prev = s.connectionLogs[s.connectionLogs.length - 1];
  if (prev && prev.stage === entry.stage && prev.status === entry.status && prev.message === entry.message) {
    prev.timestamp = entry.timestamp;
  } else {
    s.connectionLogs.push(entry);
  }
  if (s.connectionLogs.length > 120) s.connectionLogs.splice(0, s.connectionLogs.length - 120);
  // En sesiones privadas no se persiste actividad con detalle del host/perfil.
  if (entry.status !== "info" && !s.private) {
    const profile = s.profileId ? profiles.find((p) => p.id === s.profileId) : null;
    recordActivity({
      kind: "connection",
      status: entry.status === "ok" ? "ok" : entry.status,
      title: entry.message,
      detail: profile?.name || "",
      actionLabel: "Ver",
      action: () => {
        setActiveTab(sessionId);
        setConnectionLogPanelOpen(sessionId, true);
      },
    });
  }
  renderConnectionLog(sessionId);
}

function renderConnectionLog(sessionId) {
  const s = sessions.get(sessionId);
  const pane = s?.pane || document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  if (!s || !pane) return;
  const logs = s.connectionLogs || [];
  const panel = pane.querySelector(".connection-log-panel");
  if (panel) {
    panel.classList.toggle("hidden", !s.connectionLogOpen);
    const list = panel.querySelector(".connection-log-list");
    if (list) {
      list.innerHTML = logs.map((item) => `
        <div class="connection-log-row ${escHtml(item.status)}">
          <span class="connection-log-row-dot"></span>
          <span class="connection-log-row-time">${escHtml(connectionLogTime(item.timestamp))}</span>
          <span class="connection-log-row-message">${escHtml(item.message)}</span>
        </div>
      `).join("");
      list.scrollTop = list.scrollHeight;
    }
  }
  if (sessionId === activeSessionId) renderStatusConnectionLog();
}

function setConnectionLogPanelOpen(sessionId, open) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.connectionLogOpen = !!open;
  renderConnectionLog(sessionId);
}

function toggleConnectionLogPanel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  setConnectionLogPanelOpen(sessionId, !s.connectionLogOpen);
}

// ─── Snapshots de pantalla por sesión (restaurar sesión anterior) ───────────
// Captura visual del output del terminal SSH para repintarlo como scrollback al
// reconectar. NO reanuda el proceso remoto; solo restaura lo que se vio.

// Tope del buffer en memoria por sesión (caracteres). Al superarlo se descarta
// lo más antiguo. ~512 KiB es holgado para el scrollback típico.
const SCREEN_CAPTURE_MAX = 512 * 1024;

// Ids de perfil con snapshot guardado en disco (alimenta el menú contextual).
const snapshotIndex = new Set();

/** Acumula output en el buffer de captura de la sesión (si está activado). */
function captureScreenChunk(s, text) {
  if (!s || s.private || s.type !== "ssh") return;
  if (prefs.captureScreen === false) return;
  s._screenBuf = (s._screenBuf || "") + text;
  if (s._screenBuf.length > SCREEN_CAPTURE_MAX) {
    s._screenBuf = s._screenBuf.slice(s._screenBuf.length - SCREEN_CAPTURE_MAX);
  }
}

/** Guarda en disco el snapshot acumulado de la sesión (best-effort). */
async function persistScreenSnapshot(s) {
  if (!s || s.private || s.type !== "ssh" || !s.profileId) return;
  if (prefs.captureScreen === false) return;
  if (s._snapshotSaved) return; // evita doble guardado (close + ssh-closed)
  const content = s._screenBuf || "";
  if (!content.trim()) return;
  s._snapshotSaved = true;
  try {
    await invoke("session_snapshot_set", { profileId: s.profileId, content });
    snapshotIndex.add(s.profileId);
  } catch (err) {
    console.warn("[snapshot] save failed", err);
  }
}

/**
 * Repinta en el terminal de una sesión nueva el snapshot guardado del perfil,
 * con un separador, antes de conectar. Restauración puramente visual.
 */
async function restorePreviousScreen(sessionId, profileId) {
  const s = sessions.get(sessionId);
  if (!s?.terminal) return;
  let snapshot = null;
  try {
    snapshot = await invoke("session_snapshot_get", { profileId });
  } catch (err) {
    console.warn("[snapshot] get failed", err);
    return;
  }
  if (!snapshot) return;
  const sep = (label) => `\r\n\x1b[2m──────── ${label} ────────\x1b[0m\r\n`;
  const when = new Date().toLocaleString();
  enqueueTerminalOutput(s, sep(`${t("ctx.snapshot_restored")} · ${when}`));
  enqueueTerminalOutput(s, snapshot.endsWith("\n") ? snapshot : snapshot + "\r\n");
  enqueueTerminalOutput(s, sep(t("ctx.snapshot_new_session")));
}

/** Carga el índice de perfiles con snapshot al arrancar. */
async function loadSnapshotIndex() {
  try {
    const ids = await invoke("session_snapshot_list");
    snapshotIndex.clear();
    for (const id of ids || []) snapshotIndex.add(id);
  } catch (err) {
    console.warn("[snapshot] list failed", err);
  }
}

async function registerSshListeners(sessionId, terminal) {
  const decoder = new TextDecoder();
  const ul = [];

  ul.push(await listen(eventName("sshData", sessionId), (e) => {
    const s = sessions.get(sessionId);
    const text = decoder.decode(new Uint8Array(e.payload));
    const filtered = filterSuppressedTerminalOutput(s, text);
    if (filtered) {
      enqueueTerminalOutput(s, applyHighlightRules(filtered));
      markTabActivity(sessionId);
      captureScreenChunk(s, filtered);
    }
  }));

  ul.push(await listen(eventName("sshLog", sessionId), (/** @type {{ payload: SshLogEvent }} */ e) => {
    appendConnectionLog(sessionId, e.payload || {});
  }));

  ul.push(await listen(eventName("sshConnected", sessionId), () => {
    const s = sessions.get(sessionId);
    if (s) s.status = "connected";
    // Apertura automática de SFTP si se pidió desde un tile fijado del dashboard.
    if (s && pendingSftpOpenProfiles.has(s.profileId)) {
      pendingSftpOpenProfiles.delete(s.profileId);
      openSftpPanel(sessionId).catch(() => {});
    }
    appendConnectionLog(sessionId, {
      stage: "connected",
      status: "ok",
      message: "Sesión SSH conectada",
      timestamp: new Date().toISOString(),
    });
    hideReconnectOverlay(sessionId);
    updateTabStatus(sessionId, "connected");
    // Al recuperar la sesión, el marcador rojo de desconexión deja de ser
    // cierto. Mantenemos el resto de activity flags (lo que pase tras el
    // reconnect sigue siendo "actividad").
    document
      .querySelector(`.tab[data-session="${CSS.escape(sessionId)}"]`)
      ?.classList.remove("has-unread-disconnect");
    if (s?.profileId && !s.private) recordRecentConnection(s.profileId);
    renderConnectionList();
    s?.fitAddon.fit();
    // El PTY recién abierto pudo crearse con un tamaño ya desfasado si el
    // usuario redimensionó durante el connect: reenviar siempre.
    notifyResize(sessionId, terminal, { force: true });
    // Carpeta inicial puntual («Duplicar con cambios»): entrar al directorio
    // nada más abrir el shell. El espacio inicial esquiva el historial en
    // shells con HISTCONTROL=ignorespace.
    if (s?._initialDir) {
      const dir = s._initialDir.replace(/'/g, `'\\''`);
      invoke("ssh_send_input", { sessionId, data: ` cd '${dir}'\r` }).catch(() => {});
    }
    startProfileAutoTunnels(sessionId);
  }));

  ul.push(await listen(eventName("sshError", sessionId), (e) => {
    const s = sessions.get(sessionId);
    if (s) s.status = "error";
    const message = String(e.payload || "Error SSH");
    // Avisos de cambio de host key: mensaje destacado, toast más largo y
    // overlay con título explícito para que el usuario decida si reconectar.
    const isHostKeyAlert = message.includes("host key") && message.includes("cambiado");
    appendConnectionLog(sessionId, {
      stage: isHostKeyAlert ? "host_key_changed" : "error",
      status: "error",
      message,
      timestamp: new Date().toISOString(),
    });
    updateTabStatus(sessionId, "error");
    showReconnectOverlay(sessionId, isHostKeyAlert ? "Host key cambiada" : "Error de conexión");
    if (isHostKeyAlert) {
      enqueueTerminalOutput(s, `\r\n\x1b[1;41;97m  ⚠ HOST KEY CAMBIADA  \x1b[0m\r\n\x1b[31m${message}\x1b[0m\r\n`);
      toast(message, "error", 12000);
    } else {
      enqueueTerminalOutput(s, `\r\n\x1b[31m✗ Error: ${message}\x1b[0m\r\n`);
      toast(`Error SSH: ${message}`, "error");
    }
    markTabActivity(sessionId, { kind: "disconnect" });
  }));

  ul.push(await listen(eventName("sshReconnecting", sessionId), (/** @type {{ payload: SshReconnectingEvent }} */ e) => {
    const s = sessions.get(sessionId);
    if (s) s.status = "reconnecting";
    updateTabStatus(sessionId, "error");
    const { attempt, max, delay_ms } = e.payload || {};
    const secs = Math.round((delay_ms || 0) / 1000);
    appendConnectionLog(sessionId, {
      stage: "reconnecting",
      status: "warning",
      message: `Reintentando conexión (${attempt}/${max}) en ${secs}s`,
      timestamp: new Date().toISOString(),
    });
    enqueueTerminalOutput(s, `\r\n\x1b[33m↻ Reintentando conexión (${attempt}/${max}) en ${secs}s…\x1b[0m\r\n`);
    markTabActivity(sessionId, { important: true });
  }));

  ul.push(await listen(eventName("sshClosed", sessionId), () => {
    const s = sessions.get(sessionId);
    if (s) s.status = "closed";
    persistScreenSnapshot(s);
    appendConnectionLog(sessionId, {
      stage: "closed",
      status: "warning",
      message: "Sesión SSH cerrada",
      timestamp: new Date().toISOString(),
    });
    updateTabStatus(sessionId, "error");
    showReconnectOverlay(sessionId, "Sesión cerrada");
    enqueueTerminalOutput(s, `\r\n\x1b[33m• ${t("terminal.closed")}\x1b[0m \x1b[90m${t("terminal.closed_hint")}\x1b[0m\r\n`);
    markTabActivity(sessionId, { kind: "disconnect" });
    // El subsistema SFTP muere con el canal SSH; cerrar el panel para no dejarlo huérfano.
    if (s?.sftp?.panel) closeSftpPanel(sessionId).catch(() => {});
    renderConnectionList();
  }));

  ul.push(await listen(eventName("sshTunnelTraffic", sessionId), (/** @type {{ payload: SshTunnelTrafficEvent }} */ e) => {
    const s = sessions.get(sessionId);
    const payload = e.payload || {};
    const tunnel = s?.tunnels?.get(payload.id);
    if (!tunnel) return;
    tunnel.bytesUp = payload.bytesUp || 0;
    tunnel.bytesDown = payload.bytesDown || 0;
    renderTunnelList(sessionId);
    if (isGlobalTunnelsModalOpen()) renderGlobalTunnelLists();
  }));

  return ul;
}

function setActiveTab(sessionId) {
  selectSession(sessionId, false);
}

function updateTabStatus(sessionId, status) {
  document.querySelector(`.tab[data-session="${sessionId}"] .tab-dot`)
    ?.setAttribute("class", `tab-dot ${status}`);
  if (sessionId === activeSessionId) updateStatusBar();
}

function isSessionLive(s) {
  if (!s) return false;
  return s.status === "connecting" || s.status === "connected" || s.status === "reconnecting";
}

function sessionHasActiveTransfers(s) {
  if (!s?.sftp) return false;
  if ((s.sftp.transferQueue?.length || 0) > 0) return true;
  for (const job of s.sftp.transfers?.values?.() || []) {
    if (job.status === "running" || job.status === "queued") return true;
  }
  return false;
}

async function confirmCloseSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return true;
  // Las consolas locales siempre tienen status "connected" mientras el PTY vive,
  // pero no son conexiones remotas: su confirmación propia (aviso de proceso
  // activo) se gestiona en closeSession justo antes de ejecutar _closeOverride.
  if (s._closeOverride) return true;
  if (!isSessionLive(s) && !sessionHasActiveTransfers(s)) return true;
  const profile = profiles.find((p) => p.id === s.profileId);
  const name = profile?.name || (s.type ? s.type.toUpperCase() : "sesión");
  const transfers = sessionHasActiveTransfers(s)
    ? "\n\nHay transferencias SFTP en curso que se cancelarán."
    : "";
  return confirmThemed({
    title: "Cerrar pestaña",
    message: `La conexión "${name}" sigue abierta. ¿Cerrar la pestaña y desconectar?${transfers}`,
    submitLabel: "Cerrar y desconectar",
    danger: true,
  });
}

async function closeSession(sessionId, opts = {}) {
  const { skipConfirm = false } = opts;
  const s = sessions.get(sessionId);
  if (!s) return;

  if (!skipConfirm && !(await confirmCloseSession(sessionId))) return;

  // Si hay un panel SFTP abierto, desconectarlo primero
  if (s.sftp?.sftpSessionId) {
    invoke("sftp_disconnect", { sessionId: s.sftp.sftpSessionId }).catch(() => {});
  }

  // Shell local: usa su propio manejador de cierre.
  // Antes de cerrar, comprobar si hay un proceso hijo activo (skipConfirm=true
  // en cierres en lote como "cerrar todas" omite esta comprobación).
  if (s._closeOverride) {
    if (!skipConfirm) {
      let hasJob = false;
      try { hasJob = await invoke("local_shell_has_job", { sessionId }); } catch {}
      if (hasJob) {
        const ok = await confirmThemed({
          title: t("close_local_shell.title"),
          message: t("close_local_shell.message"),
          submitLabel: t("close_local_shell.submit"),
          danger: true,
        });
        if (!ok) return;
      }
    }
    await s._closeOverride();
    removeTab(sessionId);
    renderConnectionList();
    return;
  }

  // RDP
  if (s.type === "rdp") {
    return closeRdpSession(sessionId);
  }

  if (isFileTransferConnectionType(s.type)) {
    sessions.delete(sessionId);
    removeTab(sessionId);
    renderConnectionList();
    return;
  }

  // SSH
  await persistScreenSnapshot(s);
  for (const ul of s.unlisteners) { try { ul(); } catch {} }
  await invoke("ssh_disconnect", { sessionId }).catch(() => {});
  clearTerminalOutputQueue(s);
  s.terminal.dispose();
  sessions.delete(sessionId);
  removeTab(sessionId);
  renderConnectionList();
}

/**
 * Acción global de emergencia: desconecta TODO. Cuenta las sesiones vivas y
 * las transferencias SFTP en curso, pide confirmación temática con el contador
 * y, si se acepta, cancela las transferencias activas, cierra explícitamente
 * los túneles SSH abiertos y cierra todas las sesiones (SSH, SFTP, RDP y
 * consolas locales) vía `closeSession(..., { skipConfirm: true })`.
 */
async function disconnectAll() {
  // Snapshot de los ids: el Map `sessions` muta al ir cerrando sesiones.
  const ids = [...sessions.keys()];
  const liveIds = ids.filter((sid) => isSessionLive(sessions.get(sid)));

  // Contar transferencias SFTP en curso (en cola o ejecutándose).
  let activeTransfers = 0;
  for (const [, s] of sessions) {
    for (const job of s.sftp?.transfers?.values?.() || []) {
      if (job.status === "running" || job.status === "queued" || job.status === "paused") {
        activeTransfers++;
      }
    }
  }

  if (liveIds.length === 0) {
    toast(t("disconnect_all.none"), "info");
    return;
  }

  const ok = await confirmThemed({
    title: t("disconnect_all.title"),
    message: t("disconnect_all.confirm", { n: liveIds.length, m: activeTransfers }),
    submitLabel: t("disconnect_all.submit"),
    danger: true,
  });
  if (!ok) return;

  // 1) Cancelar las transferencias SFTP activas antes de cerrar las sesiones.
  for (const [, s] of sessions) {
    const sftpSessionId = s.sftp?.sftpSessionId;
    for (const job of s.sftp?.transfers?.values?.() || []) {
      if (job.status === "queued") {
        // En cola: basta con marcarla como cancelada localmente.
        job.status = "canceled";
        if (s.sftp?.transferQueue) {
          s.sftp.transferQueue = s.sftp.transferQueue.filter((item) => item.id !== job.id);
        }
        markTransferCanceled(job.transferEl, "Cancelado");
      } else if ((job.status === "running" || job.status === "paused") && sftpSessionId) {
        invoke("sftp_cancel_transfer", { sessionId: sftpSessionId, transferId: job.id }).catch(() => {});
      }
    }
  }

  // 2) Cerrar explícitamente los túneles SSH activos (aunque caen al cerrar la
  //    sesión SSH, los detenemos en el backend para no dejar puertos abiertos).
  for (const sid of ids) {
    const s = sessions.get(sid);
    for (const tunnelId of [...(s?.tunnels?.keys?.() || [])]) {
      await stopSshTunnel(sid, tunnelId);
    }
  }

  // 3) Cerrar TODAS las sesiones (snapshot inicial; el Map muta en el bucle).
  for (const sid of ids) {
    await closeSession(sid, { skipConfirm: true });
  }

  toast(t("disconnect_all.done"), "success");
}

function removeTab(sessionId) {
  document.querySelector(`.tab[data-session="${sessionId}"]`)?.remove();
  const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  if (pane) {
    paneResizeObserver?.unobserve(pane);
    pane.remove();
  }
  // Expandir al instante la pestaña de Inicio si era la última sesión
  // (sin esperar al ciclo renderView, que llega tras varias operaciones).
  updateTabSelectionClasses();

  // Quitar de la vista
  const idx = viewSelection.indexOf(sessionId);
  if (idx >= 0) viewSelection.splice(idx, 1);

  // Si era la sesión activa, promover otra
  if (activeSessionId === sessionId) {
    activeSessionId = viewSelection[0] ?? null;
    if (!activeSessionId) {
      // Ninguna pane visible: coger la última pestaña restante
      const lastTab = document.querySelector("#tabs-container .tab:last-child");
      if (lastTab) {
        activeSessionId = lastTab.dataset.session;
        viewSelection = [activeSessionId];
      }
    }
  }
  renderView();
  updateStatusBar();
  syncSidebarToActiveSession({ scroll: true });
}

// ── Resize del terminal → backend: debounce + deduplicación ─────
// El fit() visual es inmediato (xterm reajusta el layout al momento), pero el
// aviso de cols/rows por IPC se agrupa por sesión para no disparar tormentas
// de ssh_resize / local_shell_resize al arrastrar la sidebar, el divisor SFTP
// o los splits. Las dimensiones ya enviadas se omiten; `force` reenvía siempre
// (necesario tras (re)conectar: el PTY nuevo puede haberse abierto con un
// tamaño ya desfasado).
const RESIZE_IPC_DELAY_MS = 180;

function flushBackendResize(s) {
  if (s._resizeTimer) { clearTimeout(s._resizeTimer); s._resizeTimer = null; }
  if (!sessions.has(s.id) || !s.terminal) return;
  const { cols, rows } = s.terminal;
  if (!cols || !rows) return;
  if (s._sentCols === cols && s._sentRows === rows) return;
  s._sentCols = cols;
  s._sentRows = rows;
  invoke(s._resizeCmd || "ssh_resize", { sessionId: s.id, cols, rows }).catch(() => {});
}

function scheduleBackendResize(s) {
  if (!s?.terminal) return;
  if (s._resizeTimer) clearTimeout(s._resizeTimer);
  s._resizeTimer = setTimeout(() => flushBackendResize(s), RESIZE_IPC_DELAY_MS);
}

function notifyResize(sessionId, _terminal, { force = false } = {}) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (force) {
    s._sentCols = s._sentRows = undefined;
    flushBackendResize(s);
  } else {
    scheduleBackendResize(s);
  }
}

// ═══════════════════════════════════════════════════════════════
// PERFILES
// ═══════════════════════════════════════════════════════════════

async function deleteProfile(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const confirmed = await confirmThemed({
    title: "Eliminar conexión",
    message: `¿Eliminar "${profile.name}"? Esta acción no se puede deshacer.`,
    submitLabel: "Eliminar",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await invoke("delete_profile", { id: profileId });
    // Limpiar contraseñas de identidades adicionales y el snapshot de pantalla.
    for (const c of profile.extra_credentials || []) {
      await deleteStoredSecret(credPasswordKey(profileId, c.id));
      await deleteStoredSecret(credPassphraseKey(profileId, c.id));
    }
    invoke("session_snapshot_delete", { profileId }).catch(() => {});
    snapshotIndex.delete(profileId);
    profiles = profiles.filter((p) => p.id !== profileId);
    sync.recordTombstone(prefs, "profiles", profileId);
    savePrefs();
    renderConnectionList();
    scheduleProfileAutoSync();
    toast("Conexión eliminada", "success");
  } catch (err) {
    toast(`Error al eliminar: ${err}`, "error");
  }
}

/**
 * Duplica un perfil de conexión: clona el original con nuevo UUID, sufija
 * el nombre con " (copia)" y deja el modal de edición abierto sobre la
 * copia para que el usuario pueda ajustarla antes de cerrarlo. Las
 * referencias a credenciales (keepass_entry_uuid, key_path) se copian tal
 * cual y, si el original tiene contraseña/passphrase en el keyring, también
 * se replican bajo la nueva clave `password:<id>` / `passphrase:<id>`.
 */
async function duplicateProfile(profileId) {
  const original = profiles.find((p) => p.id === profileId);
  if (!original) return;
  const copy = {
    ...original,
    id: crypto.randomUUID(),
    name: `${original.name} (copia)`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  try {
    await invoke("save_profile", { profile: copy });
    const [pw, pp] = await Promise.all([
      getStoredSecret(passwordKey(original.id)),
      getStoredSecret(passphraseKey(original.id)),
    ]);
    if (pw) await saveStoredSecret(passwordKey(copy.id), pw, "contraseña");
    if (pp) await saveStoredSecret(passphraseKey(copy.id), pp, "passphrase");
    // Replicar las contraseñas de las identidades adicionales bajo el id nuevo.
    for (const c of original.extra_credentials || []) {
      const ePw = await getStoredSecret(credPasswordKey(original.id, c.id));
      if (ePw) await saveStoredSecret(credPasswordKey(copy.id, c.id), ePw, "contraseña");
    }
    profiles = await invoke("get_profiles");
    renderConnectionList();
    scheduleProfileAutoSync();
    openEditConnectionModal(copy.id);
    toast(`Duplicado como "${copy.name}"`, "success");
  } catch (err) {
    toast(`Error al duplicar: ${err}`, "error");
  }
}

/**
 * Convierte la contraseña propia de un perfil en una credencial maestra
 * reutilizable. Pide un nombre (validado y único), crea la maestra con
 * `master_cred_set`, reapunta el perfil a `password_source="master"` con el
 * `master_credential_id` nuevo y, opcionalmente, borra la contraseña propia del
 * keyring tras confirmación.
 */
async function promoteProfilePasswordToMaster(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  // Solo tiene sentido sobre la contraseña propia del perfil.
  let ownPassword;
  try {
    ownPassword = await invoke("get_profile_password", { profileId });
  } catch (err) {
    toast(t("promote_master.error").replace("{err}", String(err)), "error", 6000);
    return;
  }
  if (!ownPassword) {
    toast(t("promote_master.no_password"), "warning", 6000);
    return;
  }

  // Pide y valida el nombre de la nueva maestra (sin espacios, único).
  let existing = [];
  try {
    existing = await invoke("master_cred_list");
  } catch {}
  const masterNames = new Set(
    (existing || []).filter((c) => c.kind === "master").map((c) => c.name)
  );
  const isValidCredName = (name) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name);

  let name = null;
  // Reintenta mientras el nombre sea inválido o duplicado.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await promptCredential({
      title: t("promote_master.title"),
      message: t("promote_master.message"),
      label: t("promote_master.name_label"),
      submitLabel: t("modal_credential.submit"),
      inputType: "text",
      initialValue: name || "",
    });
    if (!result) return; // cancelado
    name = (result.value || "").trim();
    if (!isValidCredName(name)) {
      toast(t("promote_master.invalid_name"), "warning", 6000);
      continue;
    }
    if (masterNames.has(name)) {
      toast(t("promote_master.duplicate_name"), "warning", 6000);
      continue;
    }
    break;
  }

  try {
    // Crea la credencial maestra (el valor va al keyring `master:<id>`).
    const meta = await invoke("master_cred_set", {
      id: null,
      name,
      kind: "master",
      description: null,
      value: ownPassword,
    });

    // Reapunta el perfil a la maestra recién creada.
    const updated = {
      ...profile,
      password_source: "master",
      master_credential_id: meta.id,
      updated_at: new Date().toISOString(),
    };
    await invoke("save_profile", { profile: updated });

    // Ofrece borrar la contraseña propia del perfil (opcional, con confirmación).
    const removeOwn = await confirmThemed({
      title: t("promote_master.delete_own_title"),
      message: t("promote_master.delete_own_message"),
      submitLabel: t("promote_master.delete_own_confirm"),
      danger: true,
    });
    if (removeOwn) {
      await invoke("keyring_delete", {
        service: KEYRING_SERVICE,
        key: passwordKey(profileId),
      }).catch((err) => console.warn("[promote] keyring_delete", err));
    }

    profiles = await invoke("get_profiles");
    renderConnectionList();
    renderCredList().catch(() => {});
    scheduleProfileAutoSync();
    toast(t("promote_master.done").replace("{name}", name), "success");
  } catch (err) {
    toast(t("promote_master.error").replace("{err}", String(err)), "error", 6000);
  }
}

// ═══════════════════════════════════════════════════════════════
// DIRECTORIO DE DATOS / BACKUP
// ═══════════════════════════════════════════════════════════════

/**
 * Abre el directorio donde se guarda profiles.json usando el gestor
 * de archivos nativo del sistema (xdg-open en Linux, Finder en macOS…).
 * Los perfiles se guardan en:
 *   Linux:   ~/.local/share/rustty/profiles.json
 *   macOS:   ~/Library/Application Support/com.rustty.app/profiles.json
 *   Windows: %APPDATA%\com.rustty.app\profiles.json
 */
async function openDataDirectory() {
  const dataDir = await invoke("get_data_dir").catch(() => null);
  if (!dataDir) { toast("No se pudo obtener el directorio de datos", "error"); return; }

  // El plugin opener ya está inicializado en Rust (tauri_plugin_opener::init)
  // y la capability autoriza `opener:allow-open-path`.
  try {
    await invoke("plugin:opener|open_path", { path: dataDir });
  } catch (err) {
    toast(`No se pudo abrir el directorio: ${err}. Ruta: ${dataDir}`, "error", 8000);
  }
}

// ═══════════════════════════════════════════════════════════════
// TÚNELES SSH
// ═══════════════════════════════════════════════════════════════

function normalizeTunnelConfig(raw = {}) {
  const type = raw.tunnel_type || raw.tunnelType || "local";
  return {
    id: raw.id || crypto.randomUUID(),
    name: raw.name || null,
    tunnelType: type,
    bindHost: raw.bind_host || raw.bindHost || "127.0.0.1",
    localPort: Number(raw.local_port ?? raw.localPort ?? 0),
    remoteHost: raw.remote_host ?? raw.remoteHost ?? null,
    remotePort: raw.remote_port ?? raw.remotePort ?? null,
    autoStart: !!(raw.auto_start ?? raw.autoStart),
  };
}

function tunnelToProfileShape(tunnel) {
  return {
    id: tunnel.id,
    name: tunnel.name || null,
    tunnel_type: tunnel.tunnelType,
    bind_host: tunnel.bindHost || "127.0.0.1",
    local_port: Number(tunnel.localPort || 0),
    remote_host: tunnel.remoteHost || null,
    remote_port: tunnel.remotePort ? Number(tunnel.remotePort) : null,
    auto_start: !!tunnel.autoStart,
  };
}

function findOpenSessionForProfile(profileId) {
  for (const [sid, s] of sessions) {
    if (s.profileId === profileId && s.status !== "closed" && s.type !== "rdp") return sid;
  }
  return null;
}

function findConnectedSessionForProfile(profileId) {
  for (const [sid, s] of sessions) {
    if (s.profileId === profileId && s.status === "connected" && s.type !== "rdp") return sid;
  }
  return null;
}

async function openTunnelForProfile(profileId) {
  if (!profileId) return;
  let sessionId = findOpenSessionForProfile(profileId);
  if (!sessionId) {
    await connectProfile(profileId);
    sessionId = findOpenSessionForProfile(profileId);
  }
  if (!sessionId) {
    toast("Abre primero una sesión SSH para crear el túnel", "warning");
    return;
  }
  await openTunnelPanel(sessionId, { focusForm: true });
}

function isSshProfile(profile) {
  return (profile?.connection_type || "ssh") === "ssh";
}

function profileTunnelLabel(profile) {
  const workspace = prefs.workspaces.find((w) => w.id === (profile.workspace_id || "default"))?.name || "Default";
  const folder = profile.group ? ` / ${profile.group}` : "";
  return `${profile.name} · ${workspace}${folder}`;
}

function populateGlobalTunnelProfileSelect(selectedId = null) {
  const select = document.getElementById("global-tunnel-profile");
  if (!select) return;
  const sshProfiles = profiles.filter(isSshProfile).sort((a, b) => a.name.localeCompare(b.name));
  select.innerHTML = sshProfiles.length
    ? sshProfiles.map((p) =>
        `<option value="${escHtml(p.id)}"${p.id === selectedId ? " selected" : ""}>${escHtml(profileTunnelLabel(p))}</option>`
      ).join("")
    : `<option value="">Sin conexiones SSH</option>`;
  select.disabled = sshProfiles.length === 0;
}

function openGlobalTunnelsModal() {
  const overlay = document.getElementById("global-tunnels-overlay");
  if (!overlay) return;
  const currentProfileId = activeProfileId();
  populateGlobalTunnelProfileSelect(currentProfileId);
  updateGlobalTunnelFields();
  renderGlobalTunnelLists();
  overlay.classList.remove("hidden");
  document.querySelector('[data-rail-action="tunnels"]')?.classList.add("active");
}

function closeGlobalTunnelsModal() {
  document.getElementById("global-tunnels-overlay")?.classList.add("hidden");
  document.querySelector('[data-rail-action="tunnels"]')?.classList.remove("active");
}

function isGlobalTunnelsModalOpen() {
  const overlay = document.getElementById("global-tunnels-overlay");
  return !!overlay && !overlay.classList.contains("hidden");
}

// ─── Gestor de known_hosts ───────────────────────────────────────
async function openKnownHostsModal() {
  const overlay = document.getElementById("known-hosts-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  await renderKnownHostsList();
}

function closeKnownHostsModal() {
  document.getElementById("known-hosts-overlay")?.classList.add("hidden");
}

async function renderKnownHostsList() {
  const list = document.getElementById("known-hosts-list");
  if (!list) return;
  list.innerHTML = `<div class="tunnel-empty">${escHtml(t("modal_known_hosts.loading"))}</div>`;
  let entries;
  try {
    entries = await invoke("list_known_hosts");
  } catch (err) {
    list.innerHTML = `<div class="tunnel-empty">${escHtml(String(err))}</div>`;
    return;
  }
  if (!entries.length) {
    list.innerHTML = `<div class="tunnel-empty">${escHtml(t("modal_known_hosts.empty"))}</div>`;
    return;
  }
  list.innerHTML = entries
    .map((e) => {
      const hostLabel = e.port && e.port !== 22 ? `${e.host}:${e.port}` : e.host;
      return `
        <div class="global-tunnel-row" data-line="${e.line}">
          <span class="tunnel-kind">${escHtml(e.algorithm)}</span>
          <span class="global-tunnel-profile">${escHtml(hostLabel)}</span>
          <span class="global-tunnel-desc">${escHtml(e.fingerprint)}</span>
          <span class="global-tunnel-row-actions">
            <button type="button" class="global-tunnel-action danger" data-known-host-action="remove">${escHtml(t("modal_known_hosts.remove"))}</button>
          </span>
        </div>`;
    })
    .join("");
}

async function removeKnownHostLine(line) {
  const ok = await confirmThemed({
    title: t("modal_known_hosts.title"),
    message: t("modal_known_hosts.confirm_remove"),
    submitLabel: t("modal_known_hosts.remove"),
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("remove_known_host_line", { line });
    toast(t("modal_known_hosts.removed"), "success");
    await renderKnownHostsList();
  } catch (err) {
    toast(`${err}`, "error", 8000);
  }
}

// ─── Credenciales: maestras, variables y secretos (Preferencias) ─────────
// Estado del editor: id de la credencial en edición (null = alta nueva).
let _credEditId = null;
// Tipo seleccionado en el filtro de la lista (master | var | secret).
let _credFilter = "master";

/** Construye el marcador `${<kind>:nombre}` para previsualización y copia. */
function credVar(kind, name) {
  return "${" + kind + ":" + name + "}";
}

/** Empty-state según el tipo activo del filtro. */
function credEmptyKey(kind) {
  if (kind === "var") return "prefs_credentials.empty_var";
  if (kind === "secret") return "prefs_credentials.empty_secret";
  return "prefs_credentials.empty";
}

/** Carga el catálogo y pinta la lista del tipo activo (master/var/secret). */
async function renderCredList() {
  const list = document.getElementById("cred-list");
  if (!list) return;
  let creds;
  try {
    creds = await invoke("master_cred_list");
  } catch (err) {
    list.innerHTML = `<div class="tunnel-empty">${escHtml(String(err))}</div>`;
    return;
  }
  const items = (creds || []).filter((c) => c.kind === _credFilter);
  if (!items.length) {
    list.innerHTML = `<div class="tunnel-empty">${escHtml(t(credEmptyKey(_credFilter)))}</div>`;
    return;
  }
  list.innerHTML = items
    .map((c) => {
      const varText = credVar(c.kind, c.name);
      // Descripción o, en variables (no secretas), su valor de texto.
      const descText = c.description
        ? c.description
        : (c.kind === "var" && c.value ? "= " + c.value : "");
      const desc = descText
        ? `<span class="cred-desc" title="${escHtml(descText)}">${escHtml(descText)}</span>`
        : "";
      const badge = `<span class="cred-kind-badge">${escHtml(t("prefs_credentials.badge_" + c.kind))}</span>`;
      return `
        <div class="cred-row" data-cred-id="${escHtml(c.id)}" data-cred-name="${escHtml(c.name)}" data-cred-kind="${escHtml(c.kind)}">
          <div class="cred-row-top">
            <span class="cred-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
            ${badge}
            ${desc}
            <span class="cred-row-actions">
              <button type="button" class="global-tunnel-action" data-cred-action="edit">${escHtml(t("prefs_credentials.edit"))}</button>
              <button type="button" class="global-tunnel-action danger" data-cred-action="delete">${escHtml(t("prefs_credentials.delete"))}</button>
            </span>
          </div>
          <button type="button" class="cred-var" data-cred-action="copy" title="${escHtml(t("prefs_credentials.copy_var"))}">
            <code>${escHtml(varText)}</code>
          </button>
        </div>`;
    })
    .join("");
}

/** Abre el editor de credencial. `cred` null = alta; objeto = edición. */
function openCredEditModal(cred = null) {
  const overlay = document.getElementById("cred-edit-overlay");
  if (!overlay) return;
  _credEditId = cred ? cred.id : null;

  const title = document.getElementById("cred-edit-title");
  const nameInput = document.getElementById("cred-edit-name");
  const valueInput = document.getElementById("cred-edit-value");
  const descInput = document.getElementById("cred-edit-desc");
  const optional = document.getElementById("cred-edit-value-optional");
  const kindSelect = document.getElementById("cred-edit-kind");
  const kindGroup = document.getElementById("cred-edit-kind-group");

  // Tipo: en alta se elige libremente (default = filtro activo); en edición es
  // fijo (cambiar el tipo movería el valor entre keyring y catálogo).
  const kind = cred ? cred.kind : _credFilter;
  if (kindSelect) {
    kindSelect.value = kind;
    kindSelect.disabled = !!cred;
  }
  kindGroup?.classList.toggle("hidden", !!cred);

  title.textContent = cred
    ? t("modal_credential_edit.title_edit")
    : t("modal_credential_edit.title_new");
  nameInput.value = cred ? cred.name : "";
  descInput.value = cred && cred.description ? cred.description : "";
  // Las variables NO son secretas: al editar precargamos su valor de texto.
  valueInput.value = cred && cred.kind === "var" && cred.value ? cred.value : "";

  if (cred && cred.kind !== "var") {
    // En edición de secreto/maestra el valor es opcional (rotación); dejar
    // vacío no lo cambia.
    optional?.classList.remove("hidden");
    valueInput.required = false;
    valueInput.placeholder = t("modal_credential_edit.value_keep_ph");
  } else {
    optional?.classList.add("hidden");
    valueInput.required = true;
    valueInput.placeholder = t("modal_credential_edit.value_ph");
  }

  // Restaurar el valor oculto al abrir y aplicar el modo según el tipo.
  resetCredValueToggle();
  applyCredKindMode(kind);
  updateCredVarPreview();

  overlay.classList.remove("hidden");
  nameInput.focus();
}

/**
 * Ajusta el editor según el tipo: las variables son texto plano (visible, sin
 * toggle de ocultar); secretos/maestras ocultan el valor en el keyring.
 */
function applyCredKindMode(kind) {
  const valueInput = document.getElementById("cred-edit-value");
  const toggle = document.getElementById("btn-cred-edit-toggle");
  const hint = document.getElementById("cred-edit-kind-hint");
  const isVar = kind === "var";
  if (valueInput) valueInput.type = isVar ? "text" : "password";
  // El toggle ojo solo tiene sentido para valores ocultos.
  if (toggle) toggle.classList.toggle("hidden", isVar);
  if (hint) hint.textContent = t("modal_credential_edit.kind_hint_" + kind);
}

function closeCredEditModal() {
  document.getElementById("cred-edit-overlay")?.classList.add("hidden");
  _credEditId = null;
}

function isCredEditModalOpen() {
  const overlay = document.getElementById("cred-edit-overlay");
  return !!overlay && !overlay.classList.contains("hidden");
}

/** Actualiza la previsualización `${<kind>:<nombre>}` mientras se teclea. */
function updateCredVarPreview() {
  const nameInput = document.getElementById("cred-edit-name");
  const preview = document.getElementById("cred-edit-var-preview");
  const kindSelect = document.getElementById("cred-edit-kind");
  if (!nameInput || !preview) return;
  const name = nameInput.value.trim();
  const kind = kindSelect ? kindSelect.value : "master";
  preview.textContent = name ? credVar(kind, name) : "";
}

/** Deja el campo de valor oculto (type=password) y el toggle en reposo. */
function resetCredValueToggle() {
  const valueInput = document.getElementById("cred-edit-value");
  const toggle = document.getElementById("btn-cred-edit-toggle");
  if (valueInput) valueInput.type = "password";
  if (toggle) {
    toggle.setAttribute("aria-pressed", "false");
    toggle.title = t("modal_credential_edit.show_value");
    toggle.setAttribute("aria-label", t("modal_credential_edit.show_value"));
  }
}

/** Alterna mostrar/ocultar el valor de la credencial. */
function toggleCredValueVisibility() {
  const valueInput = document.getElementById("cred-edit-value");
  const toggle = document.getElementById("btn-cred-edit-toggle");
  if (!valueInput || !toggle) return;
  const show = valueInput.type === "password";
  valueInput.type = show ? "text" : "password";
  toggle.setAttribute("aria-pressed", show ? "true" : "false");
  const key = show ? "modal_credential_edit.hide_value" : "modal_credential_edit.show_value";
  toggle.title = t(key);
  toggle.setAttribute("aria-label", t(key));
}

/** Guarda el alta o la edición de una credencial (master/var/secret). */
async function submitCredEdit(e) {
  e.preventDefault();
  const name = document.getElementById("cred-edit-name").value.trim();
  const valueRaw = document.getElementById("cred-edit-value").value;
  const descRaw = document.getElementById("cred-edit-desc").value.trim();
  const kindSelect = document.getElementById("cred-edit-kind");
  // En edición el tipo es fijo (select deshabilitado); leemos su valor igual.
  const kind = kindSelect ? kindSelect.value : "master";

  // Validación de cliente: nombre no vacío y sin espacios.
  if (!name || /\s/.test(name)) {
    toast(t("modal_credential_edit.name_invalid"), "error", 6000);
    return;
  }

  const description = descRaw ? descRaw : null;
  // En edición de secreto/maestra, solo enviamos `value` si el usuario escribió
  // uno (rotación): el backend no toca el keyring cuando `value` es null. Para
  // variables, el valor (texto) se envía siempre tal cual (puede ser vacío).
  const value = kind === "var" ? valueRaw : valueRaw ? valueRaw : null;

  try {
    await invoke("master_cred_set", {
      id: _credEditId,
      name,
      kind,
      description,
      value,
    });
    toast(t("modal_credential_edit.saved"), "success");
    closeCredEditModal();
    await renderCredList();
  } catch (err) {
    toast(`${err}`, "error", 8000);
  }
}

/** Copia el marcador `${<kind>:nombre}` al portapapeles. */
async function copyCredVar(kind, name) {
  await writeSystemClipboardText(credVar(kind, name));
  toast(t("prefs_credentials.copied"), "success");
}

/** Elimina una credencial; si hay perfiles que la referencian, reconfirma. */
async function deleteCred(id) {
  const ok = await confirmThemed({
    title: t("prefs_credentials.confirm_delete_title"),
    message: t("prefs_credentials.confirm_delete_msg"),
    submitLabel: t("prefs_credentials.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("master_cred_delete", { id, force: false });
  } catch (err) {
    // Si hay perfiles referenciando, el backend devuelve un error con el
    // conteo. Extraemos el número para avisar y pedir segunda confirmación.
    const msg = String(err);
    const m = msg.match(/(\d+)\s+perfil/i) || msg.match(/(\d+)\s+profile/i);
    if (!m) {
      toast(msg, "error", 8000);
      return;
    }
    const forced = await confirmThemed({
      title: t("prefs_credentials.confirm_delete_title"),
      message: t("prefs_credentials.referenced_warn", { n: m[1] }),
      submitLabel: t("prefs_credentials.delete"),
      danger: true,
    });
    if (!forced) return;
    try {
      await invoke("master_cred_delete", { id, force: true });
    } catch (err2) {
      toast(`${err2}`, "error", 8000);
      return;
    }
  }
  toast(t("prefs_credentials.deleted"), "success");
  await renderCredList();
}

function updateGlobalTunnelFields() {
  const form = document.getElementById("global-tunnel-form");
  if (!form) return;
  const type = form.elements.type?.value || "local";
  const remoteHost = form.elements.remoteHost;
  const remotePort = form.elements.remotePort;
  if (!remoteHost || !remotePort) return;
  remoteHost.placeholder = type === "remote" ? "Host local destino" : "Host remoto destino";
  remotePort.placeholder = type === "remote" ? "Puerto remoto" : "Puerto destino";
  remoteHost.disabled = type === "dynamic";
  remotePort.disabled = type === "dynamic";
  remotePort.required = type !== "dynamic";
  if (type === "dynamic") {
    remoteHost.value = "";
    remotePort.value = "";
  }
}

function readGlobalTunnelForm() {
  const form = document.getElementById("global-tunnel-form");
  const type = form.elements.type.value;
  return {
    profileId: form.elements.profileId.value,
    tunnel: {
      id: crypto.randomUUID(),
      name: form.elements.name.value.trim() || null,
      tunnelType: type,
      bindHost: form.elements.bindHost.value.trim() || "127.0.0.1",
      localPort: Number(form.elements.localPort.value || 0),
      remoteHost: type === "dynamic" ? null : (form.elements.remoteHost.value.trim() || "127.0.0.1"),
      remotePort: type === "dynamic" ? null : Number(form.elements.remotePort.value || 0),
      autoStart: form.elements.autoStart.checked,
    },
    persist: form.elements.save.checked || form.elements.autoStart.checked,
  };
}

async function waitForConnectedProfileSession(profileId, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const connected = findConnectedSessionForProfile(profileId);
    if (connected) return connected;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function ensureConnectedSshSessionForProfile(profileId) {
  const connected = findConnectedSessionForProfile(profileId);
  if (connected) return connected;

  const existing = findOpenSessionForProfile(profileId);
  if (existing) {
    setActiveTab(existing);
    const waited = await waitForConnectedProfileSession(profileId, 6000);
    if (waited) return waited;
  }

  await connectProfile(profileId, { force: true });
  return waitForConnectedProfileSession(profileId);
}

async function startGlobalTunnelFromForm() {
  const { profileId, tunnel, persist } = readGlobalTunnelForm();
  if (!profileId) {
    toast("Selecciona una conexión SSH", "warning");
    return;
  }
  try {
    const sessionId = await ensureConnectedSshSessionForProfile(profileId);
    if (!sessionId) {
      toast("No se pudo abrir una sesión SSH para el túnel", "error", 8000);
      return;
    }
    await startSshTunnel(sessionId, tunnel, { persist });
    const form = document.getElementById("global-tunnel-form");
    form?.reset();
    if (form?.elements.bindHost) form.elements.bindHost.value = "127.0.0.1";
    populateGlobalTunnelProfileSelect(profileId);
    updateGlobalTunnelFields();
    renderGlobalTunnelLists();
  } catch (err) {
    toast(`No se pudo abrir el túnel: ${err}`, "error", 8000);
  }
}

function activeTunnelEntries() {
  const rows = [];
  for (const [sessionId, session] of sessions) {
    if (!session.profileId || session.type === "rdp") continue;
    const profile = profiles.find((p) => p.id === session.profileId);
    for (const tunnel of session.tunnels?.values?.() || []) {
      rows.push({ sessionId, profile, tunnel });
    }
  }
  return rows;
}

function activeTunnelKey(profileId, tunnelId) {
  return `${profileId || ""}:${tunnelId || ""}`;
}

function renderGlobalTunnelLists() {
  const activeList = document.getElementById("global-active-tunnels");
  const savedList = document.getElementById("global-saved-tunnels");
  if (!activeList || !savedList) return;

  const active = activeTunnelEntries();
  activeList.innerHTML = active.length
    ? active.map(({ sessionId, profile, tunnel }) => `
        <div class="global-tunnel-row" data-session-id="${escHtml(sessionId)}" data-tunnel-id="${escHtml(tunnel.id)}">
          <span class="tunnel-kind">${tunnel.tunnelType === "dynamic" ? "SOCKS" : tunnel.tunnelType.toUpperCase()}</span>
          <span class="global-tunnel-profile">${escHtml(profile?.name || "SSH")}</span>
          <span class="global-tunnel-desc">${escHtml(describeTunnel(tunnel))}</span>
          <span class="global-tunnel-meta">↑ ${formatSize(tunnel.bytesUp || 0)} · ↓ ${formatSize(tunnel.bytesDown || 0)}</span>
          <span class="global-tunnel-row-actions">
            <button type="button" class="global-tunnel-action danger" data-global-tunnel-action="stop-active">Parar</button>
          </span>
        </div>`)
      .join("")
    : `<div class="tunnel-empty">Sin túneles activos</div>`;

  const activeKeys = new Set(active.map(({ profile, tunnel }) => activeTunnelKey(profile?.id, tunnel.id)));
  const saved = profiles
    .filter(isSshProfile)
    .flatMap((profile) => (profile.ssh_tunnels || []).map((raw) => ({ profile, tunnel: normalizeTunnelConfig(raw) })));

  savedList.innerHTML = saved.length
    ? saved.map(({ profile, tunnel }) => {
        const isActive = activeKeys.has(activeTunnelKey(profile.id, tunnel.id));
        return `
          <div class="global-tunnel-row" data-profile-id="${escHtml(profile.id)}" data-tunnel-id="${escHtml(tunnel.id)}">
            <span class="tunnel-kind">${tunnel.tunnelType === "dynamic" ? "SOCKS" : tunnel.tunnelType.toUpperCase()}</span>
            <span class="global-tunnel-profile">${escHtml(profile.name)}</span>
            <span class="global-tunnel-desc">${escHtml(tunnel.name || describeTunnel(tunnel))}</span>
            <span class="global-tunnel-meta">${escHtml(describeTunnel(tunnel))}${tunnel.autoStart ? " · Auto" : ""}</span>
            <span class="global-tunnel-row-actions">
              <button type="button" class="global-tunnel-action" data-global-tunnel-action="start-saved" ${isActive ? "disabled" : ""}>${isActive ? "Activo" : "Abrir"}</button>
              <button type="button" class="global-tunnel-action danger" data-global-tunnel-action="delete-saved">Borrar</button>
            </span>
          </div>`;
      }).join("")
    : `<div class="tunnel-empty">Sin túneles guardados</div>`;
}

async function startSavedGlobalTunnel(profileId, tunnelId) {
  const profile = profiles.find((p) => p.id === profileId);
  const tunnel = (profile?.ssh_tunnels || []).map(normalizeTunnelConfig).find((t) => t.id === tunnelId);
  if (!profile || !tunnel) return;
  try {
    const sessionId = await ensureConnectedSshSessionForProfile(profileId);
    if (!sessionId) {
      toast("No se pudo abrir una sesión SSH para el túnel", "error", 8000);
      return;
    }
    await startSshTunnel(sessionId, tunnel, { persist: false });
    renderGlobalTunnelLists();
  } catch (err) {
    toast(`No se pudo abrir el túnel: ${err}`, "error", 8000);
  }
}

async function deleteSavedGlobalTunnel(profileId, tunnelId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const ok = await confirmThemed({
    title: "Túneles SSH",
    message: "¿Borrar este túnel guardado?",
    submitLabel: "Borrar",
    danger: true,
  });
  if (!ok) return;
  profile.ssh_tunnels = (profile.ssh_tunnels || []).filter((raw) => normalizeTunnelConfig(raw).id !== tunnelId);
  profile.updated_at = new Date().toISOString();
  await invoke("save_profile", { profile });
  scheduleProfileAutoSync();
  renderGlobalTunnelLists();
}

async function toggleTunnelPanel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "connected") {
    toast("La sesión SSH debe estar conectada", "warning");
    return;
  }
  if (s.tunnelPanel) {
    s.tunnelPanel.classList.toggle("hidden");
    s.fitAddon?.fit();
    return;
  }
  await openTunnelPanel(sessionId);
}

async function openTunnelPanel(sessionId, opts = {}) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (!s.tunnels) s.tunnels = new Map();
  if (!s.tunnelPanel) {
    s.tunnelPanel = buildTunnelPanel(sessionId);
    s.pane.appendChild(s.tunnelPanel);
  }
  s.tunnelPanel.classList.remove("hidden");
  renderTunnelList(sessionId);
  s.fitAddon?.fit();
  if (opts.focusForm) s.tunnelPanel.querySelector('[name="localPort"]')?.focus();
}

function buildTunnelPanel(sessionId) {
  const panel = document.createElement("div");
  panel.className = "tunnel-panel";
  panel.innerHTML = `
    <div class="tunnel-panel-head">
      <div>
        <div class="tunnel-title">Túneles SSH</div>
        <div class="tunnel-subtitle">Port forwarding sobre la sesión activa</div>
      </div>
      <button class="tunnel-close" type="button" title="Cerrar panel">✕</button>
    </div>
    <form class="tunnel-form">
      <select name="type" title="Tipo de túnel">
        <option value="local">Local (-L)</option>
        <option value="remote">Remoto (-R)</option>
        <option value="dynamic">SOCKS (-D)</option>
      </select>
      <input name="bindHost" type="text" value="127.0.0.1" title="Host de escucha" />
      <input name="localPort" type="number" min="1" max="65535" placeholder="Puerto local" required />
      <input name="remoteHost" type="text" placeholder="Host destino" />
      <input name="remotePort" type="number" min="1" max="65535" placeholder="Puerto destino" />
      <input name="name" type="text" placeholder="Nombre opcional" />
      <label class="tunnel-check"><input name="save" type="checkbox" /> Guardar</label>
      <label class="tunnel-check"><input name="autoStart" type="checkbox" /> Auto</label>
      <button type="submit" class="btn-primary">Abrir</button>
    </form>
    <div class="tunnel-list"></div>`;

  panel.querySelector(".tunnel-close").addEventListener("click", () => {
    panel.classList.add("hidden");
    sessions.get(sessionId)?.fitAddon?.fit();
  });
  const typeSel = panel.querySelector('[name="type"]');
  const updateFields = () => {
    const type = typeSel.value;
    const remoteHost = panel.querySelector('[name="remoteHost"]');
    const remotePort = panel.querySelector('[name="remotePort"]');
    remoteHost.placeholder = type === "remote" ? "Host local destino" : "Host remoto destino";
    remotePort.placeholder = type === "remote" ? "Puerto remoto" : "Puerto destino";
    remoteHost.disabled = type === "dynamic";
    remotePort.disabled = type === "dynamic";
    if (type === "dynamic") {
      remoteHost.value = "";
      remotePort.value = "";
    }
  };
  typeSel.addEventListener("change", updateFields);
  updateFields();
  panel.querySelector(".tunnel-form").addEventListener("submit", (e) => {
    e.preventDefault();
    startTunnelFromPanel(sessionId, panel);
  });
  return panel;
}

function readTunnelForm(panel) {
  const type = panel.querySelector('[name="type"]').value;
  const localPort = Number(panel.querySelector('[name="localPort"]').value || 0);
  const remotePortValue = Number(panel.querySelector('[name="remotePort"]').value || 0);
  return {
    id: crypto.randomUUID(),
    name: panel.querySelector('[name="name"]').value.trim() || null,
    tunnelType: type,
    bindHost: panel.querySelector('[name="bindHost"]').value.trim() || "127.0.0.1",
    localPort,
    remoteHost: type === "dynamic"
      ? null
      : (panel.querySelector('[name="remoteHost"]').value.trim() || "127.0.0.1"),
    remotePort: type === "dynamic" ? null : remotePortValue,
    autoStart: panel.querySelector('[name="autoStart"]').checked,
    save: panel.querySelector('[name="save"]').checked,
  };
}

async function startTunnelFromPanel(sessionId, panel) {
  const cfg = readTunnelForm(panel);
  try {
    await startSshTunnel(sessionId, cfg, { persist: cfg.save || cfg.autoStart });
    panel.querySelector(".tunnel-form").reset();
    panel.querySelector('[name="bindHost"]').value = "127.0.0.1";
    panel.querySelector('[name="type"]').dispatchEvent(new Event("change"));
  } catch (err) {
    toast(`No se pudo abrir el túnel: ${err}`, "error", 8000);
  }
}

async function startSshTunnel(sessionId, cfg, opts = {}) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Sesión no encontrada");
  const tunnel = normalizeTunnelConfig(cfg);
  const info = await invoke("ssh_start_tunnel", {
    sessionId,
    config: {
      id: tunnel.id,
      name: tunnel.name,
      tunnelType: tunnel.tunnelType,
      bindHost: tunnel.bindHost,
      localPort: tunnel.localPort,
      remoteHost: tunnel.remoteHost,
      remotePort: tunnel.remotePort,
    },
  });
  tunnel.localPort = info.localPort || tunnel.localPort;
  tunnel.remotePort = info.remotePort || tunnel.remotePort;
  tunnel.bytesUp = 0;
  tunnel.bytesDown = 0;
  tunnel.status = "running";
  s.tunnels.set(tunnel.id, tunnel);
  renderTunnelList(sessionId);
  if (opts.persist && s.profileId) await persistTunnelForProfile(s.profileId, tunnel);
  renderGlobalTunnelLists();
  toast(`Túnel abierto: ${describeTunnel(tunnel)}`, "success");
  return tunnel;
}

async function stopSshTunnel(sessionId, tunnelId) {
  await invoke("ssh_stop_tunnel", { sessionId, tunnelId }).catch((err) => {
    toast(`No se pudo cerrar el túnel: ${err}`, "error");
  });
  const s = sessions.get(sessionId);
  const tunnel = s?.tunnels?.get(tunnelId);
  if (tunnel) tunnel.status = "closed";
  s?.tunnels?.delete(tunnelId);
  renderTunnelList(sessionId);
  renderGlobalTunnelLists();
}

async function persistTunnelForProfile(profileId, tunnel) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const list = Array.isArray(profile.ssh_tunnels) ? profile.ssh_tunnels.map(normalizeTunnelConfig) : [];
  const idx = list.findIndex((t) => t.id === tunnel.id);
  if (idx >= 0) list[idx] = tunnel;
  else list.push(tunnel);
  profile.ssh_tunnels = list.map(tunnelToProfileShape);
  profile.updated_at = new Date().toISOString();
  await invoke("save_profile", { profile });
  scheduleProfileAutoSync();
  renderGlobalTunnelLists();
}

async function startProfileAutoTunnels(sessionId) {
  const s = sessions.get(sessionId);
  const profile = s?.profileId ? profiles.find((p) => p.id === s.profileId) : null;
  const tunnels = Array.isArray(profile?.ssh_tunnels) ? profile.ssh_tunnels : [];
  for (const cfg of tunnels.map(normalizeTunnelConfig).filter((t) => t.autoStart)) {
    try {
      await startSshTunnel(sessionId, cfg, { persist: false });
    } catch (err) {
      toast(`Autotúnel "${cfg.name || cfg.id}" falló: ${err}`, "warning", 8000);
    }
  }
}

function describeTunnel(t) {
  if (t.tunnelType === "dynamic") return `${t.bindHost}:${t.localPort} SOCKS`;
  if (t.tunnelType === "remote") {
    return `${t.bindHost}:${t.remotePort} ⇢ ${t.remoteHost}:${t.localPort}`;
  }
  return `${t.bindHost}:${t.localPort} ⇢ ${t.remoteHost}:${t.remotePort}`;
}

function renderTunnelList(sessionId) {
  const s = sessions.get(sessionId);
  const panel = s?.tunnelPanel;
  if (!panel) return;
  const list = panel.querySelector(".tunnel-list");
  const tunnels = [...(s.tunnels?.values() || [])];
  if (!tunnels.length) {
    list.innerHTML = `<div class="tunnel-empty">Sin túneles activos</div>`;
    return;
  }
  list.innerHTML = tunnels.map((tun) => `
    <div class="tunnel-row" data-tunnel-id="${escHtml(tun.id)}">
      <span class="tunnel-kind">${tun.tunnelType === "dynamic" ? "SOCKS" : tun.tunnelType.toUpperCase()}</span>
      <span class="tunnel-main">
        <strong>${escHtml(tun.name || describeTunnel(tun))}</strong>
        <small>${escHtml(describeTunnel(tun))}</small>
      </span>
      <span class="tunnel-traffic">↑ ${formatSize(tun.bytesUp || 0)} · ↓ ${formatSize(tun.bytesDown || 0)}</span>
      <button type="button" class="tunnel-stop" title="Cerrar túnel">✕</button>
    </div>`).join("");
  list.querySelectorAll(".tunnel-stop").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.closest(".tunnel-row")?.dataset.tunnelId;
      if (id) stopSshTunnel(sessionId, id);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// SHELL LOCAL
// ═══════════════════════════════════════════════════════════════

let localShellCounter = 0;

async function openLocalShell() {
  localShellCounter++;
  const sessionId = `local-${crypto.randomUUID()}`;
  const shellName = (await getShellName()) || "Consola";
  const fakeProfile = { id: sessionId, name: `${shellName} #${localShellCounter}`, host: "local", port: 0, username: "" };

  createTerminalTab(sessionId, fakeProfile, "connecting", { sftp: false });

  const s = sessions.get(sessionId);
  // El resize de la consola local viaja por su propio comando IPC.
  s._resizeCmd = "local_shell_resize";
  try {
    await invoke("local_shell_open", {
      sessionId,
      cols: s.terminal.cols,
      rows: s.terminal.rows,
    });
    s.status = "connected";
    updateTabStatus(sessionId, "connected");

    const decoder = new TextDecoder();
    const ul = await listen(eventName("shellData", sessionId), (e) => {
      const text = decoder.decode(new Uint8Array(e.payload));
      if (text) {
        enqueueTerminalOutput(s, text);
        markTabActivity(sessionId);
      }
    });
    const ulClose = await listen(eventName("shellClosed", sessionId), () => {
      s.status = "closed";
      updateTabStatus(sessionId, "error");
      showReconnectOverlay(sessionId, "Consola cerrada");
      enqueueTerminalOutput(s, `\r\n\x1b[33m• ${t("terminal.shell_ended")}\x1b[0m \x1b[90m${t("terminal.closed_hint")}\x1b[0m\r\n`);
      markTabActivity(sessionId, { kind: "disconnect" });
    });
    s.unlisteners.push(ul, ulClose);

    // Nota: el input ya lo enruta `handleTerminalInput` (registrado en createTerminalTab)
    // detectando el tipo de sesión por `_closeOverride`. El resize también lo
    // gestiona el onResize de createTerminalTab vía scheduleBackendResize, que
    // enruta al comando correcto gracias a `_resizeCmd` (fijado arriba).

    // Sobreescribir el cierre de sesión para usar el comando de shell.
    // closeSession llama a removeTab() tras ejecutar este override.
    s._closeOverride = async () => {
      for (const ul of s.unlisteners) { try { ul(); } catch {} }
      await invoke("local_shell_close", { sessionId }).catch(() => {});
      clearTerminalOutputQueue(s);
      s.terminal.dispose();
      sessions.delete(sessionId);
    };
  } catch (err) {
    sessions.delete(sessionId);
    removeTab(sessionId);
    toast(`Error al abrir la consola: ${err}`, "error");
  }
}

async function getShellName() {
  // Leer $SHELL del entorno no es posible desde JS; usamos un nombre genérico
  return "Terminal";
}

// ═══════════════════════════════════════════════════════════════
// PANEL SFTP
// ═══════════════════════════════════════════════════════════════

async function toggleSftpPanel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  // Si el panel ya existe, permitir cerrarlo incluso si la sesión ya no está
  // conectada — así un panel huérfano se cierra con el mismo botón que lo abrió.
  if (s.sftp?.panel) {
    if (s.status !== "connected" && s.status !== "reconnecting") {
      await closeSftpPanel(sessionId);
      return;
    }
    const panel = s.sftp.panel;
    if (panel.classList.contains("hidden")) {
      panel.classList.remove("hidden");
      s.fitAddon?.fit();
    } else {
      panel.classList.add("hidden");
      s.fitAddon?.fit();
    }
    return;
  }
  if (s.status !== "connected") {
    toast("La sesión debe estar conectada", "warning");
    return;
  }
  await openSftpPanel(sessionId);
}

async function openSftpPanel(sessionId, { passwordOverride = null, passphraseOverride = null } = {}) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const profile = profiles.find((p) => p.id === s.profileId);
  if (!profile) return;
  const isFileTransfer = isFileTransferConnectionType(profile.connection_type);

  // Resolver credenciales: KeePass > keyring > prompt
  let password = passwordOverride, passphrase = passphraseOverride;
  if (profile.auth_type === "password" && !password) {
    if (profile.keepass_entry_uuid) {
      if (!keepassUnlocked) {
        toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
        return;
      }
    } else {
      password = await getStoredSecret(passwordKey(profile.id));
      if (!password) {
        password = await promptProfileSecret(profile, {
          titleKey: "modal_credential.sftp_password_title",
          messageKey: "modal_credential.sftp_message",
          labelKey: "modal_credential.password_label",
          rememberKey: "modal_credential.remember_password",
          secretKey: passwordKey(profile.id),
          secretLabel: "contraseña",
        });
        if (password === null) return;
      }
    }
  } else if (profile.auth_type === "public_key" && !passphrase) {
    passphrase = await getStoredSecret(passphraseKey(profile.id));
  }

  // Construir panel primero con estado "conectando"
  const panel = buildSftpPanel(sessionId);
  panel.classList.toggle("file-transfer-root", isFileTransfer);
  if (isFileTransfer) {
    panel.querySelector(".sftp-resize-handle")?.classList.add("hidden");
    panel.querySelector('[data-sftp-nav="follow"]')?.classList.add("hidden");
    panel.querySelector('[data-sftp-nav="sudo"]')?.classList.add("hidden");
    panel.querySelector("[data-sftp-sudo-badge]")?.classList.add("hidden");
    const title = panel.querySelector(".sftp-side-remote .sftp-side-title span");
    if (title) title.textContent = profile.connection_type.toUpperCase();
  }
  const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  pane.appendChild(panel);

  s.sftp = {
    sftpSessionId: null,
    cwd: "/",
    localCwd: "/",
    panel,
    unlisteners: [],
    entries: { local: [], remote: [] },
    sort: {
      local: { key: "name", direction: "asc" },
      remote: { key: "name", direction: "asc" },
    },
    transfers: new Map(),
    transferQueue: [],
    transferProcessing: false,
    follow: false,
    elevated: false,
  };

  setSftpStatus(panel, `Conectando ${isFileTransfer ? profile.connection_type.toUpperCase() : "SFTP"}…`);
  const protoLabel = isFileTransfer ? profile.connection_type.toUpperCase() : "SFTP";
  appendSftpActivity(panel, {
    status: "running",
    label: `Conectando ${protoLabel}`,
    detail: `${profile.username || ""}@${profile.host}:${profile.port || (isFileTransfer ? 21 : 22)}`,
  });

  // Preasignar sessionId y registrar listener antes de invocar el connect
  // para no perder los eventos tempranos de etapas de conexión.
  const sftpSessionId = crypto.randomUUID();
  const ulSftpLog = await listen(eventName("sftpLog", sftpSessionId), (/** @type {{ payload: SftpLogEvent }} */ ev) => {
    const payload = ev.payload || {};
    const status = payload.status === "ok" || payload.status === "error" ? payload.status : "running";
    if (!payload.message) return;
    appendSftpActivity(panel, {
      status,
      label: payload.message,
      detail: payload.stage ? `etapa: ${payload.stage}` : "",
    });
  });
  s.sftp.unlisteners.push(ulSftpLog);

  try {
    await invoke("sftp_connect", {
      profileId: profile.id,
      password: password || null,
      passphrase: passphrase || null,
      elevated: s.sftp.elevated,
      sessionId: sftpSessionId,
      maxConcurrent: sftpMaxConcurrent(),
      credentialId: s.credentialId || null,
    });
    s.sftp.sftpSessionId = sftpSessionId;
    appendSftpActivity(panel, {
      status: "ok",
      label: `${protoLabel} conectado`,
      detail: s.sftp.elevated ? "Sesión con privilegios elevados (sudo)" : "Sesión establecida",
    });

    // Si el terminal ya tiene un cwd conocido (por OSC 7) lo usamos,
    // si no, pedimos el home al servidor.
    const initial = (!isFileTransfer && s.remoteCwd)
      || await invoke("sftp_home_dir", { sessionId: sftpSessionId }).catch(() => "/");
    await navigateSftpRemote(sessionId, initial);

    // Lado local: arrancar en el home del usuario.
    const localHome = await invoke("local_home_dir").catch(() => "/");
    s.sftp.localCwd = localHome;
    await navigateSftpLocal(sessionId, localHome);
  } catch (err) {
    toast(`${protoLabel} falló: ${err}`, "error");
    appendSftpActivity(panel, {
      status: "error",
      label: `${protoLabel} falló`,
      detail: String(err),
    });
    panel.remove();
    s.sftp = null;
    throw err;
  }

  s.fitAddon?.fit();
}

/**
 * Reconecta la sesión SFTP invirtiendo el flag `elevated`. El backend lanza
 * `sudo -n sftp-server` por exec en lugar del subsistema SFTP estándar, lo
 * que da permisos de root sobre rutas como /root/. Requiere NOPASSWD en el
 * sudoers del usuario conectado para `sftp-server`.
 */
async function toggleSftpElevated(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const profile = profiles.find((p) => p.id === s.profileId);
  if (!profile) return;
  if (isFileTransferConnectionType(profile.connection_type)) return;
  const panel = s.sftp.panel;
  const btn = panel.querySelector('[data-sftp-nav="sudo"]');

  // Resolver credenciales igual que en openSftpPanel (pueden no estar ya
  // cacheadas), respetando la identidad con la que se abrió la sesión.
  const cred = getProfileCredential(profile, s.credentialId);
  const view = identityView(profile, cred);
  const promptProfile = { ...profile, username: view.username };
  let password = null, passphrase = null;
  if (view.authType === "password") {
    if (!view.keepassEntryUuid && view.passwordSource !== "master") {
      password = await getStoredSecret(view.pwKey);
      if (!password) {
        password = await promptProfileSecret(promptProfile, {
          titleKey: "modal_credential.sftp_password_title",
          messageKey: "modal_credential.sftp_message",
          labelKey: "modal_credential.password_label",
          rememberKey: "modal_credential.remember_password",
          secretKey: view.pwKey,
          secretLabel: "contraseña",
        });
        if (password === null) return;
      }
    }
  } else if (view.authType === "public_key") {
    passphrase = await getStoredSecret(view.ppKey);
  }

  const wasElevated = s.sftp.elevated;
  const targetElevated = !wasElevated;
  const prevCwd = s.sftp.cwd;

  setSftpStatus(panel, targetElevated ? "Reconectando con sudo…" : "Reconectando SFTP…");
  if (btn) btn.disabled = true;

  if (s.sftp.sftpSessionId) {
    await invoke("sftp_disconnect", { sessionId: s.sftp.sftpSessionId }).catch(() => {});
    s.sftp.sftpSessionId = null;
  }

  // Listener temprano para que las etapas de la reconexión aparezcan en el log.
  const newSftpSessionId = crypto.randomUUID();
  const ulSftpLog = await listen(eventName("sftpLog", newSftpSessionId), (/** @type {{ payload: SftpLogEvent }} */ ev) => {
    const payload = ev.payload || {};
    const status = payload.status === "ok" || payload.status === "error" ? payload.status : "running";
    if (!payload.message) return;
    appendSftpActivity(panel, {
      status,
      label: payload.message,
      detail: payload.stage ? `etapa: ${payload.stage}` : "",
    });
  });
  s.sftp.unlisteners.push(ulSftpLog);

  try {
    await invoke("sftp_connect", {
      profileId: profile.id,
      password: password || null,
      passphrase: passphrase || null,
      elevated: targetElevated,
      sessionId: newSftpSessionId,
      maxConcurrent: sftpMaxConcurrent(),
      credentialId: s.credentialId || null,
    });
    s.sftp.sftpSessionId = newSftpSessionId;
    s.sftp.elevated = targetElevated;
    btn?.classList.toggle("active", targetElevated);
    panel
      .querySelector("[data-sftp-sudo-badge]")
      ?.classList.toggle("hidden", !targetElevated);
    await navigateSftp(sessionId, prevCwd || "/");
    toast(targetElevated ? "SFTP elevado activo" : "SFTP sin privilegios extra",
          targetElevated ? "success" : "info");
  } catch (err) {
    toast(`No se pudo reconectar: ${err}`, "error");
    // Intentar volver al modo previo para no dejar el panel sin sesión
    try {
      const fallbackSftpSessionId = crypto.randomUUID();
      const ulFallback = await listen(eventName("sftpLog", fallbackSftpSessionId), (/** @type {{ payload: SftpLogEvent }} */ ev) => {
        const payload = ev.payload || {};
        const status = payload.status === "ok" || payload.status === "error" ? payload.status : "running";
        if (!payload.message) return;
        appendSftpActivity(panel, {
          status,
          label: payload.message,
          detail: payload.stage ? `etapa: ${payload.stage}` : "",
        });
      });
      s.sftp.unlisteners.push(ulFallback);
      await invoke("sftp_connect", {
        profileId: profile.id,
        password: password || null,
        passphrase: passphrase || null,
        elevated: wasElevated,
        sessionId: fallbackSftpSessionId,
        maxConcurrent: sftpMaxConcurrent(),
        credentialId: s.credentialId || null,
      });
      s.sftp.sftpSessionId = fallbackSftpSessionId;
      s.sftp.elevated = wasElevated;
      btn?.classList.toggle("active", wasElevated);
      await navigateSftp(sessionId, prevCwd || "/");
    } catch (err2) {
      toast(`SFTP caído: ${err2}`, "error");
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function activeSftpSession() {
  if (!activeSessionId) return null;
  const s = sessions.get(activeSessionId);
  return (s?.type === "ssh" || isFileTransferConnectionType(s?.type)) ? s : null;
}

function toggleActiveSftpPanel() {
  const s = activeSftpSession();
  if (!s) {
    toast("Selecciona una sesión SSH primero", "warning");
    return;
  }
  toggleSftpPanel(activeSessionId);
}

function toggleActiveSftpFollow() {
  const s = activeSftpSession();
  if (!s?.sftp || isFileTransferConnectionType(s.type)) {
    toast("Abre primero el panel SFTP", "warning");
    return;
  }
  const btn = s.sftp.panel.querySelector('[data-sftp-nav="follow"]');
  setSftpFollow(activeSessionId, !s.sftp.follow, btn);
}

function toggleActiveSftpElevated() {
  const s = activeSftpSession();
  if (!s?.sftp || isFileTransferConnectionType(s.type)) {
    toast("Abre primero el panel SFTP", "warning");
    return;
  }
  toggleSftpElevated(activeSessionId);
}

// ───── Autocompletado de rutas en los inputs sftp-path ─────
//
// Tab → completa al prefijo común más largo de los hijos del directorio padre
// que empiezan por el texto tras la última `/`. Si solo hay un candidato y es
// directorio, añade `/` para encadenar otro Tab. Mientras se escribe muestra
// un dropdown con las coincidencias (debounce 120 ms); flechas y Enter
// permiten escoger sin navegar todavía.

function splitPathPrefix(side, fullPath) {
  if (side === "local") {
    const sep = fullPath.lastIndexOf("\\") > fullPath.lastIndexOf("/") ? "\\" : "/";
    const idx = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
    if (idx < 0) return { parent: fullPath, prefix: "", sep };
    const parent = idx === 0 ? (fullPath.startsWith("/") ? "/" : fullPath.slice(0, 1) + sep)
                             : fullPath.slice(0, idx) || sep;
    return { parent, prefix: fullPath.slice(idx + 1), sep };
  }
  const idx = fullPath.lastIndexOf("/");
  if (idx < 0) return { parent: ".", prefix: fullPath, sep: "/" };
  const parent = idx === 0 ? "/" : fullPath.slice(0, idx);
  return { parent, prefix: fullPath.slice(idx + 1), sep: "/" };
}

function longestCommonPrefix(strings) {
  if (!strings.length) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length && prefix; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}

async function fetchSftpPathCandidates(sessionId, side, fullPath) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return null;
  const { parent, prefix, sep } = splitPathPrefix(side, fullPath);
  try {
    const entries = side === "local"
      ? await invoke("local_list_dir", { path: parent })
      : (s.sftp.sftpSessionId
          ? await invoke("sftp_list_dir", { sessionId: s.sftp.sftpSessionId, path: parent })
          : []);
    const lower = prefix.toLowerCase();
    const matches = (entries || [])
      .filter((e) => e.name.toLowerCase().startsWith(lower))
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { parent, prefix, sep, matches };
  } catch {
    return null;
  }
}

function buildSftpAutocompletePath(parent, name, sep) {
  if (parent === "/" || parent === "") return `/${name}`;
  if (sep === "\\") {
    return parent.endsWith("\\") || parent.endsWith("/") ? `${parent}${name}` : `${parent}\\${name}`;
  }
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

function closeSftpAutocomplete(input) {
  const popup = input._sftpAcPopup;
  if (popup) {
    popup.classList.add("hidden");
    popup.innerHTML = "";
  }
  input._sftpAcItems = [];
  input._sftpAcIndex = -1;
}

function renderSftpAutocompletePopup(input, items, parent, sep) {
  let popup = input._sftpAcPopup;
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "sftp-ac-popup hidden";
    input.parentElement.appendChild(popup);
    input._sftpAcPopup = popup;
  }
  if (!items.length) {
    closeSftpAutocomplete(input);
    return;
  }
  input._sftpAcItems = items;
  input._sftpAcIndex = -1;
  popup.innerHTML = items.map((e, i) => `
    <div class="sftp-ac-item" data-ac-idx="${i}">
      <span class="sftp-ac-icon">${e.is_dir ? "📁" : "📄"}</span>
      <span class="sftp-ac-name">${escHtml(e.name)}${e.is_dir ? "/" : ""}</span>
    </div>
  `).join("");
  popup.classList.remove("hidden");
  popup.querySelectorAll(".sftp-ac-item").forEach((el) => {
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const idx = Number(el.dataset.acIdx);
      const entry = items[idx];
      if (!entry) return;
      acceptSftpAutocompleteEntry(input, parent, entry, sep);
    });
  });
}

function acceptSftpAutocompleteEntry(input, parent, entry, sep) {
  const next = buildSftpAutocompletePath(parent, entry.name, sep);
  const side = input.dataset.side;
  const sessionId = input.closest(".terminal-pane")?.dataset.session;
  input.value = entry.is_dir ? next + (sep === "\\" ? "\\" : "/") : next;
  closeSftpAutocomplete(input);
  input.focus();
  // Si es directorio, navegamos al instante en lugar de pedir un Enter extra.
  if (entry.is_dir && sessionId) {
    if (side === "local") navigateSftpLocal(sessionId, next);
    else navigateSftpRemote(sessionId, next);
  }
}

function setupSftpPathAutocomplete(panel, input, sessionId) {
  let debounceId = 0;

  const triggerSuggestions = async () => {
    const side = input.dataset.side;
    const value = input.value;
    if (!value) { closeSftpAutocomplete(input); return; }
    const res = await fetchSftpPathCandidates(sessionId, side, value);
    if (!res || !res.matches.length) { closeSftpAutocomplete(input); return; }
    if (document.activeElement !== input) return;
    renderSftpAutocompletePopup(input, res.matches.slice(0, 12), res.parent, res.sep);
  };

  const doTabComplete = async () => {
    const side = input.dataset.side;
    const value = input.value;
    if (!value) return;
    const res = await fetchSftpPathCandidates(sessionId, side, value);
    if (!res || !res.matches.length) return;
    const names = res.matches.map((e) => e.name);
    const common = longestCommonPrefix(names);
    if (common.length > res.prefix.length) {
      const completedPath = buildSftpAutocompletePath(res.parent, common, res.sep);
      input.value = completedPath;
      if (res.matches.length === 1 && res.matches[0].is_dir) {
        input.value += res.sep === "\\" ? "\\" : "/";
        closeSftpAutocomplete(input);
      } else {
        renderSftpAutocompletePopup(input, res.matches.slice(0, 12), res.parent, res.sep);
      }
    } else {
      renderSftpAutocompletePopup(input, res.matches.slice(0, 12), res.parent, res.sep);
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(debounceId);
    debounceId = setTimeout(triggerSuggestions, 120);
  });

  input.addEventListener("keydown", (e) => {
    const items = input._sftpAcItems || [];
    const popup = input._sftpAcPopup;
    const popupVisible = popup && !popup.classList.contains("hidden") && items.length > 0;

    if (e.key === "Tab") {
      e.preventDefault();
      doTabComplete();
      return;
    }
    if (e.key === "Escape" && popupVisible) {
      e.preventDefault();
      closeSftpAutocomplete(input);
      return;
    }
    if (popupVisible && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      input._sftpAcIndex = ((input._sftpAcIndex ?? -1) + dir + items.length) % items.length;
      popup.querySelectorAll(".sftp-ac-item").forEach((el, i) => {
        el.classList.toggle("active", i === input._sftpAcIndex);
      });
      return;
    }
    if (e.key === "Enter") {
      if (popupVisible && input._sftpAcIndex >= 0) {
        e.preventDefault();
        const entry = items[input._sftpAcIndex];
        const { parent, sep } = splitPathPrefix(input.dataset.side, input.value);
        acceptSftpAutocompleteEntry(input, parent, entry, sep);
        return;
      }
      closeSftpAutocomplete(input);
      const side = input.dataset.side;
      const path = input.value.trim();
      if (!path) return;
      if (side === "local") navigateSftpLocal(sessionId, path);
      else navigateSftpRemote(sessionId, path);
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => closeSftpAutocomplete(input), 150);
  });
}

function getStoredSftpPanelHeightPercent() {
  const raw = Number(localStorage.getItem(SFTP_PANEL_HEIGHT_STORAGE_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SFTP_PANEL_DEFAULT_HEIGHT_PERCENT;
  return Math.min(85, Math.max(20, raw));
}

function applySftpPanelHeight(panel, percent = getStoredSftpPanelHeightPercent()) {
  panel.style.flexBasis = `${percent}%`;
  requestAnimationFrame(() => applySftpLogHeight(panel));
}

function setupSftpPanelResize(panel, sessionId) {
  const handle = panel.querySelector(".sftp-resize-handle");
  if (!handle) return;
  applySftpPanelHeight(panel);

  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(SFTP_PANEL_HEIGHT_STORAGE_KEY);
    applySftpPanelHeight(panel, SFTP_PANEL_DEFAULT_HEIGHT_PERCENT);
    const s = sessions.get(sessionId);
    s?.fitAddon?.fit();
    notifyResize(sessionId, s?.terminal);
  });

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const pane = panel.closest(".terminal-pane");
    if (!pane) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);

    const paneRect = pane.getBoundingClientRect();
    const startY = e.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const maxHeight = Math.max(
      SFTP_PANEL_MIN_HEIGHT,
      paneRect.height - SFTP_PANEL_MIN_TERMINAL_HEIGHT
    );
    let raf = null;

    document.body.classList.add("sftp-panel-resizing");

    const fitVisibleTerminal = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const s = sessions.get(sessionId);
        if (s?.fitAddon) {
          try {
            s.fitAddon.fit();
            notifyResize(sessionId, s.terminal);
          } catch {}
        }
      });
    };

    const onMove = (ev) => {
      const delta = ev.clientY - startY;
      const nextPx = Math.min(maxHeight, Math.max(SFTP_PANEL_MIN_HEIGHT, startHeight - delta));
      panel.style.flexBasis = `${nextPx}px`;
      fitVisibleTerminal();
    };

    const onUp = () => {
      document.body.classList.remove("sftp-panel-resizing");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      const finalHeight = panel.getBoundingClientRect().height;
      const pct = Math.min(85, Math.max(20, (finalHeight / paneRect.height) * 100));
      localStorage.setItem(SFTP_PANEL_HEIGHT_STORAGE_KEY, String(Math.round(pct)));
      applySftpPanelHeight(panel, pct);
      fitVisibleTerminal();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

function getStoredSftpLogHeight() {
  const raw = Number(localStorage.getItem(SFTP_LOG_HEIGHT_STORAGE_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SFTP_LOG_DEFAULT_HEIGHT;
  return Math.max(SFTP_LOG_MIN_HEIGHT, raw);
}

function getSftpLogMaxHeight(panel) {
  const panelHeight = panel?.getBoundingClientRect?.().height || 0;
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return Infinity;
  return Math.max(SFTP_LOG_MIN_HEIGHT, panelHeight - SFTP_LOG_MIN_FILE_AREA_HEIGHT);
}

function clampSftpLogHeight(panel, height) {
  const maxHeight = getSftpLogMaxHeight(panel);
  return Math.min(maxHeight, Math.max(SFTP_LOG_MIN_HEIGHT, height));
}

function applySftpLogHeight(panel, height = getStoredSftpLogHeight()) {
  const wrap = panel.querySelector(".sftp-transfers-wrap");
  if (!wrap) return;
  const next = clampSftpLogHeight(panel, height);
  panel.style.setProperty("--sftp-log-height", `${Math.round(next)}px`);
  wrap.style.height = "";
}

function setupSftpLogResize(panel) {
  const wrap = panel.querySelector(".sftp-transfers-wrap");
  const handle = panel.querySelector(".sftp-log-resize-handle");
  if (!wrap || !handle) return;
  applySftpLogHeight(panel);

  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(SFTP_LOG_HEIGHT_STORAGE_KEY);
    applySftpLogHeight(panel, SFTP_LOG_DEFAULT_HEIGHT);
  });

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);

    const startY = e.clientY;
    const startHeight = wrap.getBoundingClientRect().height;
    const maxHeight = getSftpLogMaxHeight(panel);

    document.body.classList.add("sftp-log-resizing");

    const onMove = (ev) => {
      const delta = ev.clientY - startY;
      const nextPx = Math.min(maxHeight, Math.max(SFTP_LOG_MIN_HEIGHT, startHeight - delta));
      panel.style.setProperty("--sftp-log-height", `${Math.round(nextPx)}px`);
    };

    const onUp = () => {
      document.body.classList.remove("sftp-log-resizing");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      const finalHeight = wrap.getBoundingClientRect().height;
      localStorage.setItem(SFTP_LOG_HEIGHT_STORAGE_KEY, String(Math.round(finalHeight)));
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

function setSftpLogTab(panel, tab) {
  panel.querySelectorAll(".sftp-log-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sftpLogTab === tab);
  });
  panel.querySelectorAll(".sftp-log-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.sftpLogPane === tab);
  });
  panel.querySelector(".sftp-transfers-clear")?.classList.toggle("hidden", tab !== "transfers");
  panel.querySelector(".sftp-activity-clear")?.classList.toggle("hidden", tab !== "activity");
}

function setupSftpLogTabs(panel) {
  panel.querySelectorAll(".sftp-log-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSftpLogTab(panel, btn.dataset.sftpLogTab || "transfers");
    });
  });
}

// Iconos SVG del panel SFTP: carpeta-con-+ (nueva carpeta) y documento-con-+
// (nuevo archivo). Trazo con currentColor para heredar el color del botón.
const SFTP_ICON_FOLDER_PLUS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
const SFTP_ICON_FILE_PLUS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
const SFTP_ICON_SEARCH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

/** Aplica la disposición de paneles (remoto a izquierda/derecha) a un panel. */
function applySftpRemoteSide(panel) {
  if (!panel) return;
  panel.classList.toggle("sftp-remote-right", prefs.sftpRemoteSide === "right");
}

/** Re-aplica la disposición a todos los paneles SFTP abiertos (al cambiar la pref). */
function applySftpRemoteSideToAll() {
  document.querySelectorAll(".sftp-panel-split").forEach(applySftpRemoteSide);
}

function buildSftpPanel(sessionId) {
  const panel = document.createElement("div");
  panel.className = "sftp-panel sftp-panel-split";
  panel.dataset.session = sessionId;
  applySftpRemoteSide(panel);
  panel.innerHTML = `
    <div class="sftp-resize-handle" title="Redimensionar panel SFTP"></div>
    <div class="sftp-header">
      <span class="sftp-header-title">SFTP</span>
      <button class="sftp-nav-btn sftp-close-btn" data-sftp-act="close" title="Cerrar panel SFTP" aria-label="Cerrar panel SFTP">✕</button>
    </div>
    <div class="sftp-side sftp-side-local" data-side="local">
      <div class="sftp-side-title">Local</div>
      <div class="sftp-toolbar">
        <button class="sftp-nav-btn" data-sftp-nav="up" data-side="local" title="Directorio padre">↑</button>
        <button class="sftp-nav-btn" data-sftp-nav="home" data-side="local" title="Inicio">⌂</button>
        <button class="sftp-nav-btn" data-sftp-nav="refresh" data-side="local" title="Refrescar">⟳</button>
        <input class="sftp-path" data-side="local" type="text" spellcheck="false" />
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="mkdir" data-side="local" title="Nueva carpeta" aria-label="Nueva carpeta">${SFTP_ICON_FOLDER_PLUS}</button>
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="touch" data-side="local" title="Nuevo archivo" aria-label="Nuevo archivo">${SFTP_ICON_FILE_PLUS}</button>
        <button class="sftp-nav-btn sftp-search-toggle" data-sftp-act="search-toggle" data-side="local" title="${escHtml(t("sftp_search.toggle_title"))}" aria-label="${escHtml(t("sftp_search.toggle_title"))}" aria-expanded="false">${SFTP_ICON_SEARCH}</button>
      </div>
      <div class="sftp-search-bar hidden" data-side="local">
        <span class="sftp-search-icon">${SFTP_ICON_SEARCH}</span>
        <input class="sftp-search-input" data-side="local" type="search" spellcheck="false"
               placeholder="${escHtml(t("sftp_search.placeholder"))}" />
        <button type="button" class="sftp-search-recursive" data-side="local"
                title="${escHtml(t("sftp_search.recursive_title"))}">${escHtml(t("sftp_search.recursive"))}</button>
        <span class="sftp-search-status" data-side="local"></span>
      </div>
      <div class="sftp-columns" data-side="local">
        <button type="button" class="sftp-sort-btn sftp-sort-type" data-side="local" data-sftp-sort="type">Tipo</button>
        <button type="button" class="sftp-sort-btn sftp-sort-name" data-side="local" data-sftp-sort="name">Nombre</button>
        <button type="button" class="sftp-sort-btn sftp-sort-size" data-side="local" data-sftp-sort="size">Tamaño</button>
        <button type="button" class="sftp-sort-btn sftp-sort-modified" data-side="local" data-sftp-sort="modified">Fecha</button>
        <span></span>
      </div>
      <div class="sftp-files" data-side="local" tabindex="0">
        <div class="sftp-empty">Cargando…</div>
      </div>
    </div>

    <div class="sftp-divider">
      <button class="sftp-xfer-btn" data-sftp-xfer="download" title="Descargar selección al local">⇨</button>
      <button class="sftp-xfer-btn" data-sftp-xfer="upload" title="Subir selección al remoto">⇦</button>
    </div>

    <div class="sftp-side sftp-side-remote" data-side="remote">
      <div class="sftp-side-title">
        <span>Remoto</span>
        <span class="sftp-sudo-badge hidden" data-sftp-sudo-badge title="Sesión SFTP con privilegios elevados (sudo)">sudo</span>
      </div>
      <div class="sftp-toolbar">
        <button class="sftp-nav-btn" data-sftp-nav="up" data-side="remote" title="Directorio padre">↑</button>
        <button class="sftp-nav-btn" data-sftp-nav="home" data-side="remote" title="Inicio">⌂</button>
        <button class="sftp-nav-btn" data-sftp-nav="refresh" data-side="remote" title="Refrescar">⟳</button>
        <button class="sftp-nav-btn sftp-follow-btn" data-sftp-nav="follow"
                title="Seguir el cwd del terminal (OSC 7)">CWD</button>
        <button class="sftp-nav-btn sftp-sudo-btn" data-sftp-nav="sudo"
                title="Reconectar SFTP elevado (sudo -n sftp-server). Requiere NOPASSWD en /etc/sudoers">sudo</button>
        <input class="sftp-path" data-side="remote" type="text" spellcheck="false" />
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="mkdir" data-side="remote" title="Nueva carpeta" aria-label="Nueva carpeta">${SFTP_ICON_FOLDER_PLUS}</button>
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="touch" data-side="remote" title="Nuevo archivo" aria-label="Nuevo archivo">${SFTP_ICON_FILE_PLUS}</button>
        <button class="sftp-nav-btn sftp-search-toggle" data-sftp-act="search-toggle" data-side="remote" title="${escHtml(t("sftp_search.toggle_title"))}" aria-label="${escHtml(t("sftp_search.toggle_title"))}" aria-expanded="false">${SFTP_ICON_SEARCH}</button>
      </div>
      <div class="sftp-search-bar hidden" data-side="remote">
        <span class="sftp-search-icon">${SFTP_ICON_SEARCH}</span>
        <input class="sftp-search-input" data-side="remote" type="search" spellcheck="false"
               placeholder="${escHtml(t("sftp_search.placeholder"))}" />
        <button type="button" class="sftp-search-recursive" data-side="remote"
                title="${escHtml(t("sftp_search.recursive_title"))}">${escHtml(t("sftp_search.recursive"))}</button>
        <span class="sftp-search-status" data-side="remote"></span>
      </div>
      <div class="sftp-columns" data-side="remote">
        <button type="button" class="sftp-sort-btn sftp-sort-type" data-side="remote" data-sftp-sort="type">Tipo</button>
        <button type="button" class="sftp-sort-btn sftp-sort-name" data-side="remote" data-sftp-sort="name">Nombre</button>
        <button type="button" class="sftp-sort-btn sftp-sort-size" data-side="remote" data-sftp-sort="size">Tamaño</button>
        <button type="button" class="sftp-sort-btn sftp-sort-modified" data-side="remote" data-sftp-sort="modified">Fecha</button>
        <span></span>
      </div>
      <div class="sftp-files" data-side="remote" tabindex="0">
        <div class="sftp-empty">Cargando…</div>
      </div>
    </div>

    <div class="sftp-transfers-wrap">
      <div class="sftp-log-resize-handle" title="Redimensionar logs SFTP"></div>
      <div class="sftp-log-tabs">
        <button class="sftp-log-tab active" data-sftp-log-tab="transfers">Transferencias</button>
        <button class="sftp-log-tab" data-sftp-log-tab="activity">Actividad</button>
        <span class="sftp-log-spacer"></span>
        <button class="sftp-transfers-clear" title="Limpiar completadas">Limpiar</button>
        <button class="sftp-activity-clear hidden" title="Limpiar actividad">Limpiar log</button>
      </div>
      <div class="sftp-log-pane active" data-sftp-log-pane="transfers">
        <div class="sftp-transfers">
          <div class="sftp-transfers-empty">Sin transferencias todavía</div>
        </div>
      </div>
      <div class="sftp-log-pane" data-sftp-log-pane="activity">
        <div class="sftp-activity-log">
          <div class="sftp-activity-empty">Sin actividad todavía</div>
        </div>
      </div>
    </div>
  `;

  // Navegación / acciones por lado
  panel.querySelectorAll("[data-sftp-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.dataset.sftpNav;
      const side = btn.dataset.side;
      const s = sessions.get(sessionId);
      if (!s?.sftp) return;
      if (nav === "follow") {
        setSftpFollow(sessionId, !s.sftp.follow, btn);
        return;
      }
      if (nav === "sudo") {
        toggleSftpElevated(sessionId);
        return;
      }
      if (side === "local") {
        if (nav === "up") {
          const parent = localParentPath(s.sftp.localCwd);
          if (parent && parent !== s.sftp.localCwd) navigateSftpLocal(sessionId, parent);
        } else if (nav === "home") {
          invoke("local_home_dir")
            .then((home) => navigateSftpLocal(sessionId, home))
            .catch((e) => toast(`Error: ${e}`, "error"));
        } else if (nav === "refresh") {
          navigateSftpLocal(sessionId, s.sftp.localCwd);
        }
      } else {
        if (nav === "up") {
          const parent = parentPath(s.sftp.cwd);
          if (parent !== s.sftp.cwd) navigateSftpRemote(sessionId, parent);
        } else if (nav === "home") {
          invoke("sftp_home_dir", { sessionId: s.sftp.sftpSessionId })
            .then((home) => navigateSftpRemote(sessionId, home))
            .catch((e) => toast(`Error: ${e}`, "error"));
        } else if (nav === "refresh") {
          navigateSftpRemote(sessionId, s.sftp.cwd);
        }
      }
    });
  });

  panel.querySelector(".sftp-transfers-clear").addEventListener("click", () => {
    panel.querySelectorAll(".sftp-transfer.done, .sftp-transfer.canceled").forEach((el) => {
      const transferId = el.dataset.transfer;
      sessions.get(sessionId)?.sftp?.transfers?.delete(transferId);
      el.remove();
    });
    updateTransfersVisibility(panel);
  });
  panel.querySelector(".sftp-activity-clear").addEventListener("click", () => {
    panel.querySelector(".sftp-activity-log").innerHTML = "";
    updateTransfersVisibility(panel);
  });

  setupSftpDropTargets(panel, sessionId);
  setupSftpContextMenus(panel, sessionId);
  setupSftpSortHeaders(panel, sessionId);
  setupSftpSearch(panel, sessionId);

  panel.querySelectorAll("[data-sftp-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.sftpAct;
      const side = btn.dataset.side;
      if (act === "mkdir") {
        promptMkdir(sessionId, side || "remote");
      } else if (act === "touch") {
        promptCreateFile(sessionId, side || "remote");
      } else if (act === "search-toggle") {
        toggleSftpSearchBar(sessionId, side || "remote");
      } else if (act === "close") {
        closeSftpPanel(sessionId);
      }
    });
  });

  panel.querySelectorAll(".sftp-path").forEach((input) => {
    setupSftpPathAutocomplete(panel, input, sessionId);
  });

  panel.querySelectorAll(".sftp-xfer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = btn.dataset.sftpXfer;
      if (dir === "upload") transferSelected(sessionId, "upload");
      else transferSelected(sessionId, "download");
    });
  });

  setupSftpPanelResize(panel, sessionId);
  setupSftpLogTabs(panel);
  setupSftpLogResize(panel);

  return panel;
}

function localParentPath(p) {
  if (!p) return null;
  const m = p.match(/^([a-zA-Z]:[\\/])(.*)$/); // Windows root
  if (m) {
    const rest = m[2];
    if (!rest || rest === "" || rest === "\\" || rest === "/") return p;
  }
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return p.startsWith("/") ? "/" : p;
  return p.slice(0, idx) || "/";
}

async function navigateSftpRemote(sessionId, path) {
  const s = sessions.get(sessionId);
  if (!s?.sftp?.sftpSessionId) return;
  const panel = s.sftp.panel;
  const filesDiv = panel.querySelector('.sftp-files[data-side="remote"]');

  setSftpStatus(panel, `Cargando ${path}…`);

  try {
    const entries = await invoke("sftp_list_dir", {
      sessionId: s.sftp.sftpSessionId,
      path,
    });
    s.sftp.cwd = path;
    panel.querySelector('.sftp-path[data-side="remote"]').value = path;
    resetSftpSearch(sessionId, "remote");
    renderSftpFiles(sessionId, "remote", entries);
    clearSftpStatus(panel);
  } catch (err) {
    const msg = String(err);
    const isPerm = /permission|denied|13/i.test(msg);
    if (isPerm) {
      toast(
        `SFTP sin permisos sobre ${path}. El subsistema SFTP conserva el usuario original; no puede seguir a un shell elevado (sudo su -).`,
        "warning",
        8000,
      );
    } else {
      toast(`No se pudo listar: ${err}`, "error");
    }
    appendSftpActivity(panel, {
      status: "error",
      label: "Listar Remoto",
      detail: `${path}: ${msg}`,
    });
    filesDiv.innerHTML = `<div class="sftp-empty error">Error: ${escHtml(msg)}</div>`;
  }
}

// Alias para preservar llamadas antiguas.
const navigateSftp = navigateSftpRemote;

async function navigateSftpLocal(sessionId, path) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const panel = s.sftp.panel;
  const filesDiv = panel.querySelector('.sftp-files[data-side="local"]');

  try {
    const entries = await invoke("local_list_dir", { path });
    s.sftp.localCwd = path;
    panel.querySelector('.sftp-path[data-side="local"]').value = path;
    resetSftpSearch(sessionId, "local");
    renderSftpFiles(sessionId, "local", entries);
  } catch (err) {
    appendSftpActivity(panel, {
      status: "error",
      label: "Listar Local",
      detail: `${path}: ${String(err)}`,
    });
    filesDiv.innerHTML = `<div class="sftp-empty error">Error: ${escHtml(String(err))}</div>`;
  }
}

function renderSftpFiles(sessionId, side, entries) {
  const s = sessions.get(sessionId);
  const filesDiv = s.sftp.panel.querySelector(`.sftp-files[data-side="${side}"]`);
  s.sftp.entries = s.sftp.entries || { local: [], remote: [] };
  s.sftp.entries[side] = Array.isArray(entries) ? [...entries] : [];
  updateSftpSortHeaders(s.sftp.panel, side, s.sftp.sort?.[side]);
  const sorted = sortSftpEntries(s.sftp.entries[side], s.sftp.sort?.[side]);
  if (sorted.length === 0) {
    filesDiv.innerHTML = `<div class="sftp-empty">Carpeta vacía</div>`;
    return;
  }
  filesDiv.innerHTML = sorted.map((e) => {
    const permsText = formatSftpPermissions(e.permissions);
    const permsOctal = formatSftpPermissionsOctal(e.permissions);
    const permsTip = permsOctal ? `${permsText} · ${permsOctal}` : permsText;
    return `
    <div class="sftp-row ${e.is_dir ? "is-dir" : "is-file"} ${sftpFileIconClass(e)}"
         draggable="${e.is_symlink ? "false" : "true"}"
         data-path="${escHtml(e.path)}"
         data-name="${escHtml(e.name)}"
         data-is-dir="${e.is_dir}"
         data-is-symlink="${e.is_symlink}"
         data-permissions="${e.permissions ?? ""}">
      <span class="sftp-icon">${sftpFileIconChar(e)}</span>
      <span class="sftp-name">${escHtml(e.name)}</span>
      <span class="sftp-perms" title="${escHtml(permsTip)}">${escHtml(permsText)}</span>
      <span class="sftp-size">${e.is_dir ? "" : formatSize(e.size)}</span>
      <span class="sftp-modified">${formatTime(e.modified)}</span>
      <span class="sftp-row-actions">
        <button class="sftp-row-btn" data-op="rename" title="Renombrar">✎</button>
        <button class="sftp-row-btn danger" data-op="delete" title="Eliminar">✕</button>
      </span>
      <div class="sftp-row-progress" aria-hidden="true"><span class="sftp-row-progress-bar"></span></div>
    </div>
  `;
  }).join("");

  filesDiv.querySelectorAll(".sftp-row").forEach((row) => {
    // Selección con click. Ctrl/Cmd/Alt toggle multi (Alt útil en entornos
    // como GNOME donde el WM intercepta Ctrl+Click sobre algunas zonas).
    row.addEventListener("click", (e) => {
      if (e.target.closest(".sftp-row-btn")) return;
      if (!(e.ctrlKey || e.metaKey || e.altKey)) {
        filesDiv.querySelectorAll(".sftp-row.selected").forEach((r) => r.classList.remove("selected"));
      }
      row.classList.toggle("selected");
    });

    row.addEventListener("dragstart", (e) => {
      if (row.dataset.isSymlink === "true") {
        e.preventDefault();
        return;
      }
      if (!row.classList.contains("selected")) {
        filesDiv.querySelectorAll(".sftp-row.selected").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
      }
      row.classList.add("dragging");
      const rows = selectedRows(sessionId, side).filter((r) => !r.isSymlink);
      setSftpDragPayload({ sessionId, sourceSide: side, rows });
      e.dataTransfer.effectAllowed = side === "local" ? "copyMove" : "copy";
      e.dataTransfer.setData("text/plain", rows.map((r) => r.name).join("\n"));
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      clearSftpDragPayload();
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!row.classList.contains("selected")) {
        filesDiv.querySelectorAll(".sftp-row.selected").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
      }
      showSftpContextMenu(e.clientX, e.clientY, sessionId, side);
    });

    // Doble clic: entrar en carpeta. En remoto: descargar archivo al cwd local. En local: subir al cwd remoto.
    row.addEventListener("dblclick", () => {
      const isDir = row.dataset.isDir === "true";
      if (side === "remote") {
        if (isDir) navigateSftpRemote(sessionId, row.dataset.path);
        else transferRows(sessionId, "download", [{
          path: row.dataset.path,
          name: row.dataset.name,
          isDir: false,
          isSymlink: false,
        }]);
      } else {
        if (isDir) navigateSftpLocal(sessionId, row.dataset.path);
        else transferRows(sessionId, "upload", [{
          path: row.dataset.path,
          name: row.dataset.name,
          isDir: false,
          isSymlink: false,
        }]);
      }
    });

    row.querySelectorAll(".sftp-row-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const op = btn.dataset.op;
        const isDir = row.dataset.isDir === "true";
        if (op === "rename") {
          promptRename(sessionId, side, row.dataset.path, row.dataset.name);
        } else if (op === "delete") {
          confirmDelete(sessionId, side, row.dataset.path, row.dataset.name, isDir);
        }
      });
    });
  });
}

// ───── Búsqueda fuzzy de ficheros en el panel SFTP/local ─────
// Función SEPARADA del autocompletado de rutas (sftp-path). Filtra por
// subcadena (case-insensitive) las entradas ya listadas del directorio
// actual y, opcionalmente, recorre subdirectorios de forma recursiva con
// límites y cancelación.

const SFTP_SEARCH_MAX_RESULTS = 500; // tope de resultados recursivos
const SFTP_SEARCH_MAX_DIRS = 2000;   // tope de directorios visitados
const SFTP_SEARCH_MAX_DEPTH = 8;     // profundidad máxima

// Estado de búsqueda por sesión y lado: { term, recursive, token }.
// El token es un contador; al incrementarlo se cancela cualquier recorrido en curso.
function sftpSearchState(s, side) {
  s.sftp.search = s.sftp.search || { local: null, remote: null };
  if (!s.sftp.search[side]) {
    s.sftp.search[side] = { term: "", recursive: false, token: 0 };
  }
  return s.sftp.search[side];
}

function setupSftpSearch(panel, sessionId) {
  panel.querySelectorAll(".sftp-search-bar").forEach((bar) => {
    const side = bar.dataset.side;
    const input = bar.querySelector(".sftp-search-input");
    const recBtn = bar.querySelector(".sftp-search-recursive");
    let debounceId = 0;

    const runSearch = () => {
      const s = sessions.get(sessionId);
      if (!s?.sftp) return;
      const st = sftpSearchState(s, side);
      st.term = input.value.trim();
      if (st.recursive && st.term) {
        runSftpRecursiveSearch(sessionId, side);
      } else {
        // Cancela cualquier recorrido recursivo en curso y filtra el dir actual.
        st.token++;
        applySftpCurrentDirFilter(sessionId, side);
      }
    };

    input.addEventListener("input", () => {
      clearTimeout(debounceId);
      debounceId = setTimeout(runSearch, 120);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // Limpia y pliega la barra, devolviendo el foco al listado.
        toggleSftpSearchBar(sessionId, side, false);
        return;
      }
      // Navegación por resultados recursivos con flechas + Enter.
      const filesDiv = panel.querySelector(`.sftp-files[data-side="${side}"]`);
      const results = filesDiv.querySelectorAll(".sftp-search-result");
      if (!results.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = Array.from(results);
        let idx = list.findIndex((r) => r.classList.contains("active"));
        list.forEach((r) => r.classList.remove("active"));
        if (e.key === "ArrowDown") idx = idx < list.length - 1 ? idx + 1 : 0;
        else idx = idx > 0 ? idx - 1 : list.length - 1;
        const target = list[idx];
        target.classList.add("active");
        target.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const active = filesDiv.querySelector(".sftp-search-result.active") || results[0];
        if (active) openSftpSearchResult(sessionId, side, active);
      }
    });

    recBtn.addEventListener("click", () => {
      const s = sessions.get(sessionId);
      if (!s?.sftp) return;
      const st = sftpSearchState(s, side);
      st.recursive = !st.recursive;
      recBtn.classList.toggle("active", st.recursive);
      runSearch();
      input.focus();
    });
  });
}

// Resetea el estado y la UI de búsqueda de un lado (al navegar/refrescar).
function resetSftpSearch(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const st = sftpSearchState(s, side);
  st.token++; // cancela recorridos en curso
  st.term = "";
  const panel = s.sftp.panel;
  const input = panel.querySelector(`.sftp-search-input[data-side="${side}"]`);
  if (input) input.value = "";
  setSftpSearchStatus(panel, side, "");
}

// Limpia la búsqueda manteniendo el modo recursivo, y restaura el listado.
function clearSftpSearch(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const st = sftpSearchState(s, side);
  st.token++;
  st.term = "";
  const panel = s.sftp.panel;
  const input = panel.querySelector(`.sftp-search-input[data-side="${side}"]`);
  if (input) input.value = "";
  setSftpSearchStatus(panel, side, "");
  renderSftpFiles(sessionId, side, s.sftp.entries?.[side] || []);
}

function setSftpSearchStatus(panel, side, text) {
  const el = panel.querySelector(`.sftp-search-status[data-side="${side}"]`);
  if (el) el.textContent = text || "";
}

// Pliega/despliega la barra de búsqueda de un lado del panel SFTP. Arranca
// plegada (solo el icono de lupa en la toolbar); al abrirla enfoca el input y
// al cerrarla limpia el filtro para no dejar el listado "enganchado".
function toggleSftpSearchBar(sessionId, side, forceOpen) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const panel = s.sftp.panel;
  const bar = panel.querySelector(`.sftp-search-bar[data-side="${side}"]`);
  const toggle = panel.querySelector(`.sftp-search-toggle[data-side="${side}"]`);
  if (!bar) return;
  const willOpen = forceOpen ?? bar.classList.contains("hidden");
  bar.classList.toggle("hidden", !willOpen);
  toggle?.classList.toggle("active", willOpen);
  toggle?.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) {
    const input = bar.querySelector(".sftp-search-input");
    input?.focus();
  } else {
    clearSftpSearch(sessionId, side);
  }
}

// Filtra (mostrar/ocultar) las filas ya renderizadas del directorio actual.
function applySftpCurrentDirFilter(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const panel = s.sftp.panel;
  const filesDiv = panel.querySelector(`.sftp-files[data-side="${side}"]`);
  const st = sftpSearchState(s, side);
  // Si veníamos de un resultado recursivo, restauramos el listado normal.
  if (filesDiv.querySelector(".sftp-search-result") || filesDiv.querySelector(".sftp-search-empty")) {
    renderSftpFiles(sessionId, side, s.sftp.entries?.[side] || []);
  }
  const term = st.term.toLocaleLowerCase();
  const rows = filesDiv.querySelectorAll(".sftp-row");
  if (!term) {
    rows.forEach((r) => r.classList.remove("sftp-filtered-out"));
    setSftpSearchStatus(panel, side, "");
    return;
  }
  let visible = 0;
  rows.forEach((r) => {
    const name = (r.dataset.name || "").toLocaleLowerCase();
    const hit = name.includes(term);
    r.classList.toggle("sftp-filtered-out", !hit);
    if (hit) visible++;
  });
  setSftpSearchStatus(panel, side, visible === 0 ? t("sftp_search.no_results") : "");
}

// Recorre subdirectorios en BFS desde el cwd con límites y cancelación.
async function runSftpRecursiveSearch(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const panel = s.sftp.panel;
  const filesDiv = panel.querySelector(`.sftp-files[data-side="${side}"]`);
  const st = sftpSearchState(s, side);
  const term = st.term.toLocaleLowerCase();
  if (!term) { clearSftpSearch(sessionId, side); return; }

  // Nuevo token: invalida cualquier recorrido previo en curso.
  st.token++;
  const myToken = st.token;
  const canceled = () => st.token !== myToken;

  const base = side === "local" ? s.sftp.localCwd : s.sftp.cwd;
  if (!base) return;
  const isLocal = side === "local";
  const listDir = (path) => isLocal
    ? invoke("local_list_dir", { path })
    : invoke("sftp_list_dir", { sessionId: s.sftp.sftpSessionId, path });

  setSftpSearchStatus(panel, side, t("sftp_search.searching"));

  const results = [];
  // Cola BFS de { path, depth }.
  const queue = [{ path: base, depth: 0 }];
  let visited = 0;
  let limitHit = false;

  while (queue.length) {
    if (canceled()) return;
    if (results.length >= SFTP_SEARCH_MAX_RESULTS || visited >= SFTP_SEARCH_MAX_DIRS) {
      limitHit = true;
      break;
    }
    const { path, depth } = queue.shift();
    visited++;
    let entries;
    try {
      entries = await listDir(path);
    } catch {
      continue; // dir sin permisos / inaccesible: lo saltamos
    }
    if (canceled()) return;
    for (const e of entries || []) {
      if ((e.name || "").toLocaleLowerCase().includes(term)) {
        results.push(e);
        if (results.length >= SFTP_SEARCH_MAX_RESULTS) { limitHit = true; break; }
      }
      // Encolamos subdirectorios reales (no symlinks) dentro de la profundidad.
      if (e.is_dir && !e.is_symlink && depth < SFTP_SEARCH_MAX_DEPTH) {
        queue.push({ path: e.path, depth: depth + 1 });
      }
    }
  }

  if (canceled()) return;
  renderSftpSearchResults(sessionId, side, base, results, limitHit);
}

function renderSftpSearchResults(sessionId, side, base, results, limitHit) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const panel = s.sftp.panel;
  const filesDiv = panel.querySelector(`.sftp-files[data-side="${side}"]`);
  if (!results.length) {
    filesDiv.innerHTML = `<div class="sftp-empty sftp-search-empty">${escHtml(t("sftp_search.no_results"))}</div>`;
    setSftpSearchStatus(panel, side, "");
    return;
  }
  const sep = side === "local" ? null : "/";
  filesDiv.innerHTML = results.map((e) => {
    const rel = sftpRelativePath(base, e.path, sep);
    return `
    <div class="sftp-row sftp-search-result ${e.is_dir ? "is-dir" : "is-file"} ${sftpFileIconClass(e)}"
         data-path="${escHtml(e.path)}"
         data-name="${escHtml(e.name)}"
         data-is-dir="${e.is_dir}"
         data-is-symlink="${e.is_symlink}">
      <span class="sftp-icon">${sftpFileIconChar(e)}</span>
      <span class="sftp-name" title="${escHtml(rel)}">${escHtml(rel)}</span>
      <span class="sftp-size">${e.is_dir ? "" : formatSize(e.size)}</span>
      <span class="sftp-modified">${formatTime(e.modified)}</span>
    </div>`;
  }).join("");

  filesDiv.querySelectorAll(".sftp-search-result").forEach((row) => {
    row.addEventListener("dblclick", () => openSftpSearchResult(sessionId, side, row));
    row.addEventListener("click", () => {
      filesDiv.querySelectorAll(".sftp-search-result.active").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
    });
  });

  setSftpSearchStatus(
    panel,
    side,
    limitHit ? t("sftp_search.limit_reached", { n: SFTP_SEARCH_MAX_RESULTS }) : "",
  );
}

// Ruta relativa de `full` respecto a `base` para mostrar en resultados.
function sftpRelativePath(base, full, sep) {
  if (!base || !full) return full || "";
  let b = base;
  if (sep === "/") {
    b = b.endsWith("/") ? b : b + "/";
    if (b === "//") b = "/";
  }
  if (full.startsWith(base)) {
    let rest = full.slice(base.length);
    rest = rest.replace(/^[\\/]+/, "");
    return rest || full;
  }
  return full;
}

// Navega a la carpeta contenedora del resultado y lo deja seleccionado.
function openSftpSearchResult(sessionId, side, row) {
  const fullPath = row.dataset.path;
  const isDir = row.dataset.isDir === "true";
  const name = row.dataset.name;
  // Para directorios entramos en ellos; para ficheros, a su carpeta padre.
  const target = isDir
    ? fullPath
    : (side === "local" ? localParentPath(fullPath) : parentPath(fullPath));
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const after = () => {
    // Tras renderizar el destino, seleccionamos la fila correspondiente.
    const panel = s.sftp.panel;
    const filesDiv = panel.querySelector(`.sftp-files[data-side="${side}"]`);
    const selName = isDir ? null : name;
    if (selName) {
      const r = filesDiv.querySelector(`.sftp-row[data-name="${CSS.escape(selName)}"]`);
      if (r) {
        filesDiv.querySelectorAll(".sftp-row.selected").forEach((x) => x.classList.remove("selected"));
        r.classList.add("selected");
        r.scrollIntoView({ block: "nearest" });
      }
    }
  };
  // resetSftpSearch se dispara dentro de navigate*, limpiando la caja.
  const nav = side === "local"
    ? navigateSftpLocal(sessionId, target)
    : navigateSftpRemote(sessionId, target);
  Promise.resolve(nav).then(after);
}

function sftpEntryTypeRank(entry) {
  if (entry?.is_dir) return 0;
  if (entry?.is_symlink) return 1;
  return 2;
}

function sftpEntrySortValue(entry, key) {
  if (key === "type") return sftpEntryTypeRank(entry);
  if (key === "size") return entry?.is_dir ? -1 : Number(entry?.size || 0);
  if (key === "modified") return Number(entry?.modified || 0);
  return String(entry?.name || "").toLocaleLowerCase();
}

function compareSftpEntries(a, b, key, direction) {
  const dir = direction === "desc" ? -1 : 1;
  const typeDelta = sftpEntryTypeRank(a) - sftpEntryTypeRank(b);
  if (key !== "type" && typeDelta !== 0) return typeDelta;
  const av = sftpEntrySortValue(a, key);
  const bv = sftpEntrySortValue(b, key);
  let delta = 0;
  if (typeof av === "number" && typeof bv === "number") {
    delta = av - bv;
  } else {
    delta = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  }
  if (delta === 0 && key !== "name") {
    delta = String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { numeric: true, sensitivity: "base" });
  }
  return delta * dir;
}

function sortSftpEntries(entries, sort = {}) {
  const key = ["type", "name", "size", "modified"].includes(sort.key) ? sort.key : "name";
  const direction = sort.direction === "desc" ? "desc" : "asc";
  return [...entries].sort((a, b) => compareSftpEntries(a, b, key, direction));
}

function updateSftpSortHeaders(panel, side, sort = {}) {
  const key = sort?.key || "name";
  const direction = sort?.direction === "desc" ? "desc" : "asc";
  panel.querySelectorAll(`.sftp-sort-btn[data-side="${side}"]`).forEach((btn) => {
    const active = btn.dataset.sftpSort === key;
    btn.classList.toggle("active", active);
    btn.classList.toggle("desc", active && direction === "desc");
    btn.setAttribute("aria-sort", active ? (direction === "desc" ? "descending" : "ascending") : "none");
  });
}

function setupSftpSortHeaders(panel, sessionId) {
  panel.querySelectorAll(".sftp-sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = sessions.get(sessionId);
      const side = btn.dataset.side;
      const key = btn.dataset.sftpSort;
      if (!s?.sftp || !side || !key) return;
      const current = s.sftp.sort?.[side] || { key: "name", direction: "asc" };
      const next = {
        key,
        direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
      };
      s.sftp.sort = s.sftp.sort || {};
      s.sftp.sort[side] = next;
      renderSftpFiles(sessionId, side, s.sftp.entries?.[side] || []);
    });
  });
}

function selectedRows(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return [];
  const filesDiv = s.sftp.panel.querySelector(`.sftp-files[data-side="${side}"]`);
  return Array.from(filesDiv.querySelectorAll(".sftp-row.selected")).map((row) => ({
    path: row.dataset.path,
    name: row.dataset.name,
    isDir: row.dataset.isDir === "true",
    isSymlink: row.dataset.isSymlink === "true",
    permissions: row.dataset.permissions ? Number(row.dataset.permissions) : null,
  }));
}

let sftpDragPayload = null;

function setSftpDragPayload(payload) {
  sftpDragPayload = payload;
}

function clearSftpDragPayload() {
  sftpDragPayload = null;
  document
    .querySelectorAll(".sftp-files.sftp-dragover")
    .forEach((el) => el.classList.remove("sftp-dragover"));
}

function setupSftpDropTargets(panel, sessionId) {
  panel.querySelectorAll(".sftp-files").forEach((filesDiv) => {
    filesDiv.addEventListener("dragover", (e) => {
      const payload = sftpDragPayload;
      const targetSide = filesDiv.dataset.side;
      if (!payload || payload.sessionId !== sessionId || payload.sourceSide === targetSide) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      filesDiv.classList.add("sftp-dragover");
    });
    filesDiv.addEventListener("dragleave", (e) => {
      if (!filesDiv.contains(e.relatedTarget)) {
        filesDiv.classList.remove("sftp-dragover");
      }
    });
    filesDiv.addEventListener("drop", async (e) => {
      const payload = sftpDragPayload;
      const targetSide = filesDiv.dataset.side;
      filesDiv.classList.remove("sftp-dragover");
      if (!payload || payload.sessionId !== sessionId || payload.sourceSide === targetSide) return;
      e.preventDefault();
      const direction = targetSide === "remote" ? "upload" : "download";
      await transferRows(sessionId, direction, payload.rows);
      clearSftpDragPayload();
    });
  });
}

// ── Arrastrar ficheros del SO hacia el panel SFTP remoto ──────────────────
//
// Con `dragDropEnabled` (por defecto) Tauri intercepta los drops de ficheros
// del sistema operativo, así que NO llegan por los eventos `drop` de HTML5
// (esos solo sirven para el arrastre interno local↔remoto). En su lugar el
// webview emite `onDragDropEvent` con las rutas y la posición física del
// cursor. Mapeamos esa posición al panel SFTP remoto que haya debajo y, si su
// sesión SFTP está conectada, subimos las rutas soltadas a su directorio
// remoto actual.

function osDropClearHighlight() {
  document.querySelectorAll(".sftp-files.os-dragover")
    .forEach((el) => el.classList.remove("os-dragover"));
}

/** Devuelve el panel SFTP remoto (conectado) bajo una posición física, o null. */
function remoteSftpFilesAtPosition(position) {
  if (!position) return null;
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
  if (!el) return null;
  const files = el.closest('.sftp-files[data-side="remote"]');
  if (!files) return null;
  const sessionId = files.closest(".sftp-panel")?.dataset.session;
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s?.sftp?.sftpSessionId) return null; // SFTP aún no conectado
  return { files, sessionId };
}

/** Sube rutas locales (de un drop del SO) al directorio remoto de la sesión. */
async function uploadOsPathsToRemote(sessionId, paths) {
  const s = sessions.get(sessionId);
  if (!s?.sftp?.sftpSessionId) return;
  const rows = [];
  for (const path of paths) {
    // Detectamos directorios probando a listarlos: si `local_list_dir` tiene
    // éxito es una carpeta; si lanza, lo tratamos como archivo.
    let isDir = false;
    try {
      await invoke("local_list_dir", { path });
      isDir = true;
    } catch {
      isDir = false;
    }
    rows.push({ path, name: localNameFromPath(path), isDir, isSymlink: false });
  }
  if (rows.length) transferRows(sessionId, "upload", rows);
}

async function initOsFileDrop() {
  let webview;
  try {
    const mod = await import("@tauri-apps/api/webview");
    webview = mod.getCurrentWebview();
  } catch (err) {
    console.warn("[sftp] arrastre de ficheros del SO no disponible:", err);
    return;
  }
  await webview.onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") {
      const target = remoteSftpFilesAtPosition(p.position);
      osDropClearHighlight();
      if (target) target.files.classList.add("os-dragover");
    } else if (p.type === "leave") {
      osDropClearHighlight();
    } else if (p.type === "drop") {
      osDropClearHighlight();
      const target = remoteSftpFilesAtPosition(p.position);
      if (!target) return; // soltado fuera de un panel remoto conectado
      const paths = Array.isArray(p.paths) ? p.paths : [];
      if (paths.length) uploadOsPathsToRemote(target.sessionId, paths);
    }
  });
}

function selectedSftpContextRows(sessionId, side) {
  const rows = selectedRows(sessionId, side);
  return rows.filter((row) => !row.isSymlink);
}

function positionFloatingMenu(menu, x, y) {
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.classList.remove("hidden");
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - height - 6)}px`;
}

function showSftpContextMenu(x, y, sessionId, side) {
  const menu = document.getElementById("sftp-context-menu");
  if (!menu) return;
  const rows = selectedSftpContextRows(sessionId, side);
  sftpCtxTarget = { sessionId, side };

  menu.querySelectorAll(".sftpctx-local-only").forEach((el) => {
    el.classList.toggle("hidden", side !== "local");
  });
  menu.querySelectorAll(".sftpctx-remote-only").forEach((el) => {
    el.classList.toggle("hidden", side !== "remote");
  });

  const hasSelection = rows.length > 0;
  const singleSelection = rows.length === 1;
  menu.querySelectorAll(".sftpctx-needs-selection").forEach((el) => {
    el.disabled = !hasSelection;
  });
  menu.querySelectorAll(".sftpctx-single-selection").forEach((el) => {
    el.disabled = !singleSelection;
  });

  positionFloatingMenu(menu, x, y);
}

function hideSftpContextMenu() {
  document.getElementById("sftp-context-menu")?.classList.add("hidden");
  sftpCtxTarget = null;
}

async function handleSftpContextMenuAction(action) {
  const target = sftpCtxTarget;
  hideSftpContextMenu();
  if (!target) return;
  const { sessionId, side } = target;
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const rows = selectedSftpContextRows(sessionId, side);

  switch (action) {
    case "refresh":
      if (side === "local") await navigateSftpLocal(sessionId, s.sftp.localCwd);
      else await navigateSftpRemote(sessionId, s.sftp.cwd);
      break;
    case "mkdir":
      await promptMkdir(sessionId, side);
      break;
    case "touch":
      await promptCreateFile(sessionId, side);
      break;
    case "download":
      if (rows.length) transferRows(sessionId, "download", rows);
      else toast("Selecciona uno o más elementos remotos", "warning");
      break;
    case "upload-selected":
      if (rows.length) transferRows(sessionId, "upload", rows);
      else toast("Selecciona uno o más elementos locales", "warning");
      break;
    case "upload-files":
      await uploadLocalFilesFromDialog(sessionId);
      break;
    case "rename":
      if (rows.length === 1) await promptRename(sessionId, side, rows[0].path, rows[0].name);
      else toast("Selecciona un único elemento para renombrar", "warning");
      break;
    case "chmod":
      if (rows.length) await promptSftpPermissions(sessionId, side, rows);
      else toast("Selecciona uno o más elementos", "warning");
      break;
    case "delete":
      if (rows.length) await confirmDeleteRows(sessionId, side, rows);
      else toast("Selecciona uno o más elementos", "warning");
      break;
  }
}

function setupSftpContextMenus(panel, sessionId) {
  panel.querySelectorAll(".sftp-files").forEach((filesDiv) => {
    filesDiv.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".sftp-row");
      if (row) return;
      e.preventDefault();
      showSftpContextMenu(e.clientX, e.clientY, sessionId, filesDiv.dataset.side);
    });
  });
}

function appendSftpActivity(panel, {
  status = "info",
  label,
  detail = "",
  bytes = 0,
  startedAt = 0,
  actionLabel = "Ver",
  action = null,
} = {}) {
  const wrap = panel.querySelector(".sftp-transfers-wrap");
  const log = panel.querySelector(".sftp-activity-log");
  if (!wrap || !log) return;

  wrap.classList.remove("hidden");
  log.querySelector(".sftp-activity-empty")?.remove();
  const row = document.createElement("div");
  row.className = `sftp-activity-row ${status}`;
  const elapsed = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  const speed = bytes > 0 && elapsed > 0 ? ` · ${formatSize(bytes / (elapsed / 1000))}/s` : "";
  const meta = [
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    bytes > 0 ? formatSize(bytes) : "",
    elapsed > 0 ? `${(elapsed / 1000).toFixed(1)} s${speed}` : "",
  ].filter(Boolean).join(" · ");
  row.innerHTML = `
    <div class="sftp-activity-main">
      <span class="sftp-activity-status">${escHtml(status)}</span>
      <span class="sftp-activity-label">${escHtml(label)}</span>
      <span class="sftp-activity-meta">${escHtml(meta)}</span>
    </div>
    <div class="sftp-activity-detail">${escHtml(detail)}</div>
  `;
  log.prepend(row);
  while (log.children.length > 100) log.lastElementChild?.remove();
  // En sesiones privadas no se persiste actividad SFTP en el centro de actividad.
  const _sftpSessionId = panel.closest("[data-session]")?.dataset?.session;
  const _sftpSession = _sftpSessionId ? sessions.get(_sftpSessionId) : null;
  if (!_sftpSession?.private) {
    recordActivity({
      kind: "sftp",
      status: status === "ok" || status === "renamed" || status === "overwritten" ? "ok" : status,
      title: label,
      detail,
      actionLabel,
      action: action || (() => revealSftpActivity(panel)),
    });
  }
  updateTransfersVisibility(panel);
}

function revealSftpActivity(panel) {
  const wrap = panel?.querySelector(".sftp-transfers-wrap");
  const log = panel?.querySelector(".sftp-activity-log");
  if (!wrap || !log) return;
  wrap.classList.remove("hidden");
  setSftpLogTab(panel, "activity");
  log.scrollTop = 0;
  wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function revealTransferBeforeInvoke(panel, transferEl) {
  panel?.querySelector(".sftp-transfers-wrap")?.classList.remove("hidden");
  if (panel) setSftpLogTab(panel, "transfers");
  transferEl?.scrollIntoView({ block: "nearest" });
  await waitForPaint();
}

function transferDirectionLabel(direction) {
  return direction === "upload" ? "Upload" : "Download";
}

function recursiveConflictPolicyForTransfer(resolved) {
  if (resolved?.renamed) return "overwrite";
  if (resolved?.overwrite) return "overwrite";
  const policy = normalizeSftpConflictPolicy(prefs.sftpConflictPolicy);
  return policy === "ask" ? "overwrite" : policy;
}

async function transferSelected(sessionId, direction) {
  const sourceSide = direction === "upload" ? "local" : "remote";
  const rows = selectedRows(sessionId, sourceSide);
  if (rows.length === 0) {
    toast(`Selecciona uno o más elementos en ${sourceSide === "local" ? "Local" : "Remoto"}`, "warning");
    return;
  }
  transferRows(sessionId, direction, rows);
}

function transferRows(sessionId, direction, rows) {
  enqueueSftpTransfers(sessionId, direction, rows);
}

function enqueueSftpTransfers(sessionId, direction, rows) {
  const s = sessions.get(sessionId);
  if (!s?.sftp?.sftpSessionId) return;
  const cleanRows = rows.filter((r) => !r.isSymlink);
  if (cleanRows.length === 0) return;

  const conflictState = createTransferConflictState();
  for (const row of cleanRows) {
    const transferId = crypto.randomUUID();
    const arrow = direction === "upload" ? "⬆" : "⬇";
    const transferEl = addTransfer(s.sftp.panel, `${arrow} ${row.name}`, transferId, "En cola");
    setTransferState(transferEl, "queued", "En cola");
    const job = {
      id: transferId,
      direction,
      row,
      conflictState,
      transferEl,
      status: "queued",
    };
    s.sftp.transferQueue.push(job);
    s.sftp.transfers.set(transferId, job);
  }
  processSftpQueue(sessionId);
}

async function processSftpQueue(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.sftp || s.sftp.transferProcessing) return;
  s.sftp.transferProcessing = true;
  try {
    while (s.sftp.transferQueue.length > 0) {
      const job = s.sftp.transferQueue.shift();
      if (!job || job.status === "canceled") continue;
      const result = await transferOne(
        sessionId,
        job.direction,
        job.row.path,
        job.row.name,
        job.row.isDir,
        job.conflictState,
        job,
      );
      job.status = result || "done";
      if (result === "cancel") {
        cancelQueuedTransfersForState(sessionId, job.conflictState);
        break;
      }
    }
  } finally {
    const current = sessions.get(sessionId);
    if (current?.sftp) current.sftp.transferProcessing = false;
  }
}

function cancelQueuedTransfersForState(sessionId, conflictState) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const remaining = [];
  for (const job of s.sftp.transferQueue) {
    if (job.conflictState === conflictState) {
      job.status = "canceled";
      markTransferCanceled(job.transferEl, "Cancelado");
    } else {
      remaining.push(job);
    }
  }
  s.sftp.transferQueue = remaining;
}

function cancelQueuedSftpTransfer(sessionId, transferId) {
  const s = sessions.get(sessionId);
  const job = s?.sftp?.transfers?.get(transferId);
  if (!job || job.status !== "queued") return;
  job.status = "canceled";
  s.sftp.transferQueue = s.sftp.transferQueue.filter((item) => item.id !== transferId);
  markTransferCanceled(job.transferEl, "Cancelado");
}

function retrySftpTransfer(sessionId, transferId) {
  const s = sessions.get(sessionId);
  const oldJob = s?.sftp?.transfers?.get(transferId);
  if (!oldJob || !["error", "skipped", "canceled"].includes(oldJob.status)) return;
  oldJob.status = "queued";
  oldJob.conflictState = createTransferConflictState();
  setTransferState(oldJob.transferEl, "queued", "En cola");
  s.sftp.transferQueue.push(oldJob);
  processSftpQueue(sessionId);
}

function createTransferConflictState() {
  return {
    policy: null,
    reservedNames: {
      local: new Set(),
      remote: new Set(),
    },
  };
}

function normalizeSftpConflictPolicy(policy) {
  return ["ask", "overwrite", "skip", "rename"].includes(policy) ? policy : "ask";
}

/** Concurrencia SFTP por sesión (handles en vuelo por transferencia), saneada a 1–64. */
function sftpMaxConcurrent() {
  const n = parseInt(prefs.sftpMaxConcurrent, 10);
  return Number.isFinite(n) ? Math.min(64, Math.max(1, n)) : 4;
}

function renderedSftpNames(sessionId, side) {
  const s = sessions.get(sessionId);
  const filesDiv = s?.sftp?.panel?.querySelector(`.sftp-files[data-side="${side}"]`);
  if (!filesDiv) return new Set();
  return new Set(
    Array.from(filesDiv.querySelectorAll(".sftp-row"))
      .map((row) => row.dataset.name)
      .filter(Boolean),
  );
}

function destinationNameExists(sessionId, side, name, conflictState = null) {
  if (renderedSftpNames(sessionId, side).has(name)) return true;
  return !!conflictState?.reservedNames?.[side]?.has(name);
}

function reserveDestinationName(side, name, conflictState = null) {
  conflictState?.reservedNames?.[side]?.add(name);
}

function autoRenameTransferName(sessionId, side, name, isDir, conflictState = null) {
  const dot = !isDir ? name.lastIndexOf(".") : -1;
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!destinationNameExists(sessionId, side, candidate, conflictState)) {
      reserveDestinationName(side, candidate, conflictState);
      return candidate;
    }
  }
  return `${base} (${Date.now()})${ext}`;
}

async function promptSftpTransferConflict(name, targetSide, isDir) {
  const kind = isDir ? "la carpeta" : "el fichero";
  const where = targetSide === "local" ? "Local" : "Remoto";
  const choice = await chooseThemed({
    title: "Conflicto de transferencia",
    message: `Ya existe ${kind} "${name}" en ${where}. Renombrar creará automáticamente una copia con sufijo numérico.`,
    submitLabel: "Sobrescribir",
    danger: true,
    rememberLabel: "Aplicar a todos los conflictos de esta transferencia",
    actions: [
      { value: "skip", label: "Omitir" },
      { value: "rename", label: "Renombrar" },
    ],
  });
  if (!choice) return { action: "cancel", applyAll: false };
  const action = choice.action === "submit" ? "overwrite" : choice.action;
  return { action, applyAll: choice.remember };
}

async function resolveTransferConflict(sessionId, direction, name, isDir, conflictState = null) {
  const targetSide = direction === "upload" ? "remote" : "local";
  if (!destinationNameExists(sessionId, targetSide, name, conflictState)) {
    reserveDestinationName(targetSide, name, conflictState);
    return { action: "transfer", name };
  }

  let action = conflictState?.policy;
  if (!action) {
    const prefPolicy = normalizeSftpConflictPolicy(prefs.sftpConflictPolicy);
    if (prefPolicy !== "ask") action = prefPolicy;
  }
  if (!action) {
    const choice = await promptSftpTransferConflict(name, targetSide, isDir);
    action = choice.action;
    if (choice.applyAll && action !== "cancel") {
      conflictState.policy = action;
    }
  }

  if (action === "cancel") return { action: "cancel", name };
  if (action === "skip") return { action: "skip", name };
  if (action === "rename") {
    return {
      action: "transfer",
      name: autoRenameTransferName(sessionId, targetSide, name, isDir, conflictState),
      renamed: true,
    };
  }

  reserveDestinationName(targetSide, name, conflictState);
  return { action: "transfer", name, overwrite: true };
}

async function transferOne(sessionId, direction, srcPath, name, isDir, conflictState = null, job = null) {
  const s = sessions.get(sessionId);
  if (!s?.sftp?.sftpSessionId) return;
  const resolved = await resolveTransferConflict(
    sessionId,
    direction,
    name,
    isDir,
    conflictState || createTransferConflictState(),
  );
  if (resolved.action === "cancel") return "cancel";
  if (resolved.action === "skip") {
    if (job?.transferEl) {
      markTransferSkipped(job.transferEl, "Omitido por política de conflictos");
      job.status = "skipped";
    }
    appendSftpActivity(s.sftp.panel, {
      status: "skipped",
      label: `${transferDirectionLabel(direction)} ${name}`,
      detail: "Omitido por política de conflictos",
    });
    toast(`Omitido: ${name}`, "info");
    return "skip";
  }

  const panel = s.sftp.panel;
  const transferId = job?.id || crypto.randomUUID();
  const arrow = direction === "upload" ? "⬆" : "⬇";
  const targetName = resolved.name;
  const label = targetName === name ? `${arrow} ${name}` : `${arrow} ${name} → ${targetName}`;
  const transferEl = job?.transferEl || addTransfer(panel, label, transferId);
  setTransferState(transferEl, "running", "Preparando…");
  transferEl.dataset.label = label;
  transferEl.querySelector(".sftp-transfer-label").textContent = label;
  if (job) job.status = "running";
  const startedAt = Date.now();
  const resultStatus = resolved.renamed ? "renamed" : (resolved.overwrite ? "overwritten" : "ok");
  let finalTargetPath = "";
  // Lado de la fila a marcar con la mini barra: para upload, la fila
  // origen vive en local (el panel local muestra el fichero que se sube);
  // para download, la fila origen vive en remoto.
  const rowSide = direction === "upload" ? "local" : "remote";
  const rowName = name;
  setSftpRowProgress(panel, rowSide, rowName, 0, true);
  const ul = await listen(eventName("sftpProgress", transferId), (/** @type {{ payload: SftpProgressEvent }} */ ev) => {
    updateTransfer(transferEl, ev.payload);
    const { transferred = 0, total = 0, done = false } = ev.payload || {};
    const pct = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : (done ? 100 : 0);
    setSftpRowProgress(panel, rowSide, rowName, pct, !done);
  });

  try {
    if (direction === "upload") {
      const remotePath = joinRemote(s.sftp.cwd, targetName);
      finalTargetPath = remotePath;
      const invokeArgs = {
        sessionId: s.sftp.sftpSessionId,
        localPath: srcPath,
        remotePath,
        transferId,
        verifySize: !!prefs.sftpVerifySize,
      };
      if (isDir) invokeArgs.conflictPolicy = recursiveConflictPolicyForTransfer(resolved);
      appendSftpActivity(panel, {
        status: "running",
        label: `${transferDirectionLabel(direction)} ${label}`,
        detail: `${srcPath} → ${remotePath}`,
        startedAt,
      });
      await revealTransferBeforeInvoke(panel, transferEl);
      const cmd = isDir ? "sftp_upload_dir" : "sftp_upload";
      await invoke(cmd, invokeArgs);
      markTransferSuccess(transferEl, `✓ Subido a ${remotePath}`);
      if (job) job.status = "done";
      appendSftpActivity(panel, {
        status: resultStatus,
        label: `${transferDirectionLabel(direction)} ${label}`,
        detail: `${srcPath} → ${remotePath}`,
        bytes: parseInt(transferEl.dataset.lastTotal || "0", 10),
        startedAt,
      });
      await navigateSftpRemote(sessionId, s.sftp.cwd);
    } else {
      const localPath = await invoke("local_path_join", {
        base: s.sftp.localCwd,
        name: targetName,
      });
      finalTargetPath = localPath;
      const invokeArgs = {
        sessionId: s.sftp.sftpSessionId,
        remotePath: srcPath,
        localPath,
        transferId,
        verifySize: !!prefs.sftpVerifySize,
      };
      if (isDir) invokeArgs.conflictPolicy = recursiveConflictPolicyForTransfer(resolved);
      appendSftpActivity(panel, {
        status: "running",
        label: `${transferDirectionLabel(direction)} ${label}`,
        detail: `${srcPath} → ${localPath}`,
        startedAt,
      });
      await revealTransferBeforeInvoke(panel, transferEl);
      const cmd = isDir ? "sftp_download_dir" : "sftp_download";
      await invoke(cmd, invokeArgs);
      markTransferSuccess(transferEl, `✓ Guardado en ${localPath}`);
      if (job) job.status = "done";
      appendSftpActivity(panel, {
        status: resultStatus,
        label: `${transferDirectionLabel(direction)} ${label}`,
        detail: `${srcPath} → ${localPath}`,
        bytes: parseInt(transferEl.dataset.lastTotal || "0", 10),
        startedAt,
      });
      await navigateSftpLocal(sessionId, s.sftp.localCwd);
    }
  } catch (err) {
    const canceled = /cancelad|cancel/i.test(String(err));
    if (canceled) {
      markTransferCanceled(transferEl, "Cancelado");
      if (job) job.status = "canceled";
    } else {
      markTransferError(transferEl, String(err));
      if (job) job.status = "error";
    }
    const transferredBytes = parseInt(transferEl.dataset.lastTransferred || "0", 10);
    const totalBytes = parseInt(transferEl.dataset.lastTotal || "0", 10);
    const partialDetail = totalBytes > 0
      ? ` (${formatSize(transferredBytes)} de ${formatSize(totalBytes)})`
      : "";
    appendSftpActivity(panel, {
      status: canceled ? "canceled" : "error",
      label: `${transferDirectionLabel(direction)} ${label}`,
      detail: `${srcPath}${finalTargetPath ? ` → ${finalTargetPath}` : ""}${partialDetail}: ${String(err)}`,
      bytes: transferredBytes,
      startedAt,
      actionLabel: canceled ? "Ver" : "Reintentar",
      action: canceled ? (() => revealSftpActivity(panel)) : (() => retrySftpTransfer(sessionId, transferId)),
    });
    if (!canceled) {
      toast(`Fallo transferencia: ${err}`, "error", 8000, {
        category: "transfer",
        actionLabel: "Ver log",
        onAction: () => revealSftpActivity(panel),
      });
    }
    return canceled ? "canceled" : "error";
  } finally {
    try { ul(); } catch {}
    setSftpRowProgress(panel, rowSide, rowName, 0, false);
  }
  return "done";
}

/**
 * Actualiza la mini barra de progreso de una fila SFTP (local o remoto)
 * por nombre del fichero. `active=true` la muestra, `false` la oculta.
 * Si la fila no existe (porque el usuario navegó), no hace nada.
 */
function setSftpRowProgress(panel, side, name, pct, active) {
  if (!panel || !name) return;
  const row = panel.querySelector(
    `.sftp-files[data-side="${side}"] .sftp-row[data-name="${cssAttrEscape(name)}"]`
  );
  if (!row) return;
  row.classList.toggle("is-transferring", !!active);
  const bar = row.querySelector(".sftp-row-progress-bar");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
}

/**
 * Escapado mínimo para usar un string como valor en un selector CSS de
 * atributo. Evita romper si el nombre tiene comillas, barras o llaves.
 */
function cssAttrEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

async function promptMkdir(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const name = await promptEntryName({
    title: "Nueva carpeta",
    message: `Crear carpeta en ${side === "local" ? "Local" : "Remoto"}.`,
    label: "Nombre",
    submitLabel: "Crear",
    isLocal: side === "local",
  });
  if (!name) return;
  const where = side === "local" ? "Local" : "Remoto";
  try {
    let path;
    if (side === "local") {
      path = await invoke("local_path_join", { base: s.sftp.localCwd, name });
      await invoke("local_mkdir", { path });
      navigateSftpLocal(sessionId, s.sftp.localCwd);
    } else {
      if (!s.sftp.sftpSessionId) return;
      path = joinRemote(s.sftp.cwd, name);
      await invoke("sftp_mkdir", { sessionId: s.sftp.sftpSessionId, path });
      navigateSftpRemote(sessionId, s.sftp.cwd);
    }
    appendSftpActivity(s.sftp.panel, {
      status: "ok",
      label: `Mkdir ${where}`,
      detail: path,
    });
  } catch (err) {
    toast(`Error: ${err}`, "error");
    appendSftpActivity(s.sftp.panel, {
      status: "error",
      label: `Mkdir ${where}`,
      detail: `${name}: ${String(err)}`,
    });
  }
}

async function promptCreateFile(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const name = await promptEntryName({
    title: "Nuevo archivo",
    message: `Crear archivo vacío en ${side === "local" ? "Local" : "Remoto"}.`,
    label: "Nombre",
    submitLabel: "Crear",
    isLocal: side === "local",
  });
  if (!name) return;
  const where = side === "local" ? "Local" : "Remoto";
  try {
    let path;
    if (side === "local") {
      path = await invoke("local_path_join", { base: s.sftp.localCwd, name });
      await invoke("local_create_file", { path });
      navigateSftpLocal(sessionId, s.sftp.localCwd);
    } else {
      if (!s.sftp.sftpSessionId) return;
      path = joinRemote(s.sftp.cwd, name);
      await invoke("sftp_create_file", { sessionId: s.sftp.sftpSessionId, path });
      navigateSftpRemote(sessionId, s.sftp.cwd);
    }
    appendSftpActivity(s.sftp.panel, {
      status: "ok",
      label: `Nuevo archivo ${where}`,
      detail: path,
    });
  } catch (err) {
    toast(`Error: ${err}`, "error");
    appendSftpActivity(s.sftp.panel, {
      status: "error",
      label: `Nuevo archivo ${where}`,
      detail: `${name}: ${String(err)}`,
    });
  }
}

async function promptRename(sessionId, side, oldPath, oldName) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const newName = await promptEntryName({
    title: "Renombrar",
    message: `Cambiar nombre en ${side === "local" ? "Local" : "Remoto"}.`,
    label: "Nuevo nombre",
    initialValue: oldName,
    submitLabel: "Renombrar",
    isLocal: side === "local",
  });
  if (!newName || newName === oldName) return;
  const where = side === "local" ? "Local" : "Remoto";
  try {
    let newPath;
    if (side === "local") {
      const parent = localParentPath(oldPath);
      newPath = await invoke("local_path_join", { base: parent, name: newName });
      await invoke("local_rename", { from: oldPath, to: newPath });
      navigateSftpLocal(sessionId, s.sftp.localCwd);
    } else {
      if (!s.sftp.sftpSessionId) return;
      newPath = joinRemote(parentPath(oldPath), newName);
      await invoke("sftp_rename", {
        sessionId: s.sftp.sftpSessionId,
        from: oldPath,
        to: newPath,
      });
      navigateSftpRemote(sessionId, s.sftp.cwd);
    }
    appendSftpActivity(s.sftp.panel, {
      status: "ok",
      label: `Renombrar ${where}`,
      detail: `${oldPath} → ${newPath}`,
    });
  } catch (err) {
    toast(`Error: ${err}`, "error");
    appendSftpActivity(s.sftp.panel, {
      status: "error",
      label: `Renombrar ${where}`,
      detail: `${oldPath} → ${newName}: ${String(err)}`,
    });
  }
}

async function confirmDelete(sessionId, side, path, name, isDir) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const kind = isDir ? "la carpeta" : "el fichero";
  const where = side === "local" ? "Local" : "Remoto";
  const ok = await confirmThemed({
    title: "Eliminar",
    message: `¿Eliminar ${kind} "${name}" de ${where}?`,
    submitLabel: "Eliminar",
    danger: true,
  });
  if (!ok) return;
  try {
    if (side === "local") {
      await invoke("local_remove", { path });
      navigateSftpLocal(sessionId, s.sftp.localCwd);
    } else {
      if (!s.sftp.sftpSessionId) return;
      await invoke("sftp_remove", {
        sessionId: s.sftp.sftpSessionId,
        path,
        isDir,
      });
      navigateSftpRemote(sessionId, s.sftp.cwd);
    }
    appendSftpActivity(s.sftp.panel, {
      status: "ok",
      label: `Eliminar ${where}`,
      detail: path,
    });
  } catch (err) {
    toast(`Error: ${err}`, "error");
    appendSftpActivity(s.sftp.panel, {
      status: "error",
      label: `Eliminar ${where}`,
      detail: `${path}: ${String(err)}`,
    });
  }
}

async function confirmDeleteRows(sessionId, side, rows) {
  if (rows.length === 1) {
    return confirmDelete(sessionId, side, rows[0].path, rows[0].name, rows[0].isDir);
  }
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const where = side === "local" ? "Local" : "Remoto";
  const ok = await confirmThemed({
    title: "Eliminar selección",
    message: `¿Eliminar ${rows.length} elementos de ${where}?`,
    submitLabel: "Eliminar",
    danger: true,
  });
  if (!ok) return;

  let okCount = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (side === "local") {
        await invoke("local_remove", { path: row.path });
      } else if (s.sftp.sftpSessionId) {
        await invoke("sftp_remove", {
          sessionId: s.sftp.sftpSessionId,
          path: row.path,
          isDir: row.isDir,
        });
      }
      okCount += 1;
    } catch (err) {
      failed += 1;
      appendSftpActivity(s.sftp.panel, {
        status: "error",
        label: `Eliminar ${where}`,
        detail: `${row.path}: ${String(err)}`,
      });
    }
  }

  if (side === "local") await navigateSftpLocal(sessionId, s.sftp.localCwd);
  else await navigateSftpRemote(sessionId, s.sftp.cwd);
  appendSftpActivity(s.sftp.panel, {
    status: failed ? "error" : "ok",
    label: `Eliminar ${where}`,
    detail: `${okCount} eliminados${failed ? `, ${failed} errores` : ""}`,
  });
}

async function uploadLocalFilesFromDialog(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.sftp?.sftpSessionId) return;
  let paths;
  try {
    paths = await openDialog({
      title: "Subir archivos",
      multiple: true,
      directory: false,
    });
  } catch (err) {
    toast(`Error al abrir diálogo: ${err}`, "error");
    return;
  }
  if (!paths) return;
  const selected = Array.isArray(paths) ? paths : [paths];
  if (!selected.length) return;
  const rows = selected.map((path) => ({
    path,
    name: localNameFromPath(path),
    isDir: false,
    isSymlink: false,
  }));
  transferRows(sessionId, "upload", rows);
}

function localNameFromPath(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "archivo";
}

function formatOctalMode(mode) {
  if (!Number.isFinite(mode)) return "";
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function parseOctalMode(input) {
  const value = String(input || "").trim();
  if (!/^[0-7]{3,4}$/.test(value)) return null;
  const parsed = parseInt(value, 8);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0o7777) return null;
  return parsed;
}

async function promptSftpPermissions(sessionId, side, rows) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const where = side === "local" ? "Local" : "Remoto";
  const initial = rows.length === 1 ? formatOctalMode(rows[0].permissions) : "";
  const modeText = await promptTextValue({
    title: "Cambiar permisos",
    message: `${where}: ${rows.length === 1 ? rows[0].name : `${rows.length} elementos`}. Usa formato octal, por ejemplo 755 o 0644.`,
    label: "Permisos",
    initialValue: initial,
    submitLabel: "Aplicar",
  });
  if (!modeText) return;
  const mode = parseOctalMode(modeText);
  if (mode === null) {
    toast("Permisos no válidos. Usa octal, por ejemplo 755 o 0644.", "warning");
    return;
  }

  let okCount = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (side === "local") {
        await invoke("local_chmod", { path: row.path, mode });
      } else if (s.sftp.sftpSessionId) {
        await invoke("sftp_chmod", {
          sessionId: s.sftp.sftpSessionId,
          path: row.path,
          mode,
        });
      }
      okCount += 1;
    } catch (err) {
      failed += 1;
      appendSftpActivity(s.sftp.panel, {
        status: "error",
        label: `Permisos ${where}`,
        detail: `${row.path}: ${String(err)}`,
      });
    }
  }

  if (side === "local") await navigateSftpLocal(sessionId, s.sftp.localCwd);
  else await navigateSftpRemote(sessionId, s.sftp.cwd);
  appendSftpActivity(s.sftp.panel, {
    status: failed ? "error" : "ok",
    label: `Permisos ${where}`,
    detail: `${okCount} actualizados a ${mode.toString(8)}${failed ? `, ${failed} errores` : ""}`,
  });
}

async function closeSftpPanel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const closesWholeTab = isFileTransferConnectionType(s.type);
  if (s.sftp.sftpSessionId) {
    invoke("sftp_disconnect", { sessionId: s.sftp.sftpSessionId }).catch(() => {});
  }
  for (const ul of s.sftp.unlisteners || []) {
    try { ul(); } catch {}
  }
  s.sftp.panel.remove();
  s.sftp = null;
  s.fitAddon?.fit();
  if (closesWholeTab) {
    sessions.delete(sessionId);
    removeTab(sessionId);
    renderConnectionList();
  }
}

function addTransfer(panel, label, transferId, detail = "") {
  const wrap = panel.querySelector(".sftp-transfers-wrap");
  wrap.classList.remove("hidden");
  setSftpLogTab(panel, "transfers");
  panel.querySelector(".sftp-transfers-empty")?.remove();
  const el = document.createElement("div");
  el.className = "sftp-transfer";
  el.dataset.transfer = transferId;
  el.dataset.label = label;
  el.dataset.startedAt = String(Date.now());
  el.dataset.lastTotal = "0";
  el.innerHTML = `
    <div class="sftp-transfer-label">${escHtml(label)}</div>
    <div class="sftp-transfer-text">0 B / ?</div>
    <div class="sftp-transfer-bar"><div class="sftp-transfer-fill" style="width:0%"></div></div>
    <div class="sftp-transfer-detail">${escHtml(detail)}</div>
    <div class="sftp-transfer-actions">
      <button class="sftp-transfer-pause hidden" title="Pausar">⏸</button>
      <button class="sftp-transfer-resume hidden" title="Reanudar">▶</button>
      <button class="sftp-transfer-retry hidden" title="Reintentar">↻</button>
      <button class="sftp-transfer-close" title="Descartar / cancelar">✕</button>
    </div>
  `;
  el.querySelector(".sftp-transfer-pause").addEventListener("click", () => {
    const sessionId = panel.closest(".terminal-pane")?.dataset.session;
    if (sessionId) pauseSftpTransfer(sessionId, transferId);
  });
  el.querySelector(".sftp-transfer-resume").addEventListener("click", () => {
    const sessionId = panel.closest(".terminal-pane")?.dataset.session;
    if (sessionId) resumeSftpTransfer(sessionId, transferId);
  });
  el.querySelector(".sftp-transfer-retry").addEventListener("click", () => {
    const sessionId = panel.closest(".terminal-pane")?.dataset.session;
    if (sessionId) retrySftpTransfer(sessionId, transferId);
  });
  el.querySelector(".sftp-transfer-close").addEventListener("click", () => {
    const sessionId = panel.closest(".terminal-pane")?.dataset.session;
    const job = sessionId ? sessions.get(sessionId)?.sftp?.transfers?.get(transferId) : null;
    if (job?.status === "queued") {
      cancelQueuedSftpTransfer(sessionId, transferId);
      return;
    }
    if (job?.status === "running" || job?.status === "paused") {
      setTransferState(el, "running", "Cancelando…");
      invoke("sftp_cancel_transfer", {
        sessionId: sessions.get(sessionId)?.sftp?.sftpSessionId,
        transferId,
      }).catch((err) => toast(`No se pudo cancelar: ${err}`, "error"));
      return;
    }
    if (sessionId) sessions.get(sessionId)?.sftp?.transfers?.delete(transferId);
    el.remove();
    updateTransfersVisibility(panel);
  });
  panel.querySelector(".sftp-transfers").appendChild(el);
  return el;
}

function setTransferState(el, state, detail = "") {
  if (!el) return;
  el.classList.remove("queued", "running", "paused", "done", "error", "skipped", "canceled");
  el.classList.add(state);
  if (["done", "error", "skipped", "canceled"].includes(state)) el.classList.add("done");
  else el.classList.remove("done");
  el.querySelector(".sftp-transfer-detail").textContent = detail;
  el.querySelector(".sftp-transfer-retry")?.classList.toggle(
    "hidden",
    !["error", "skipped", "canceled"].includes(state),
  );
  el.querySelector(".sftp-transfer-pause")?.classList.toggle(
    "hidden",
    state !== "running",
  );
  el.querySelector(".sftp-transfer-resume")?.classList.toggle(
    "hidden",
    state !== "paused",
  );
  if (state === "queued") {
    delete el.dataset.startedAt;
  }
  if (state === "running" && !el.dataset.startedAt) {
    el.dataset.startedAt = String(Date.now());
  }
}

function updateTransfer(el, { transferred, total, done, paused }) {
  // El backend envía `paused: true|false` al cambiar de estado. Reflejamos el
  // estado visual aquí en vez de en setTransferState para no perder el flag
  // si llega entremedias de otros eventos de progreso.
  if (paused === true && !el.classList.contains("paused") && !el.classList.contains("done")) {
    el.classList.remove("running");
    el.classList.add("paused");
    el.querySelector(".sftp-transfer-pause")?.classList.add("hidden");
    el.querySelector(".sftp-transfer-resume")?.classList.remove("hidden");
  } else if (paused === false && el.classList.contains("paused")) {
    el.classList.remove("paused");
    el.classList.add("running");
    el.querySelector(".sftp-transfer-pause")?.classList.remove("hidden");
    el.querySelector(".sftp-transfer-resume")?.classList.add("hidden");
  }
  // En cuanto entra el primer byte real, el detalle "Preparando…" deja de
  // ser cierto. Mostramos el estado descriptivo ("Descargando…" / "Subiendo…")
  // o vaciamos si ya estamos en pausa (paused tiene su propio texto).
  if (
    transferred > 0 &&
    !done &&
    !el.classList.contains("paused") &&
    el.classList.contains("running")
  ) {
    const detail = el.querySelector(".sftp-transfer-detail");
    if (detail && (detail.textContent === "Preparando…" || detail.textContent === "Reanudando…")) {
      const label = el.dataset.label || "";
      detail.textContent = label.startsWith("⬇") ? "Descargando…" : "Subiendo…";
    }
  }
  const pct = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  el.querySelector(".sftp-transfer-fill").style.width = pct + "%";
  const startedAt = parseInt(el.dataset.startedAt || "0", 10);
  const pausedAccumMs = parseInt(el.dataset.pausedMs || "0", 10);
  const elapsed = Math.max(
    0.001,
    (Date.now() - startedAt - pausedAccumMs) / 1000,
  );
  const speed = transferred > 0 ? transferred / elapsed : 0;
  const eta = speed > 0 && total > transferred && !el.classList.contains("paused")
    ? ` · ${formatDuration((total - transferred) / speed)}`
    : "";
  el.querySelector(".sftp-transfer-text").textContent =
    `${formatSize(transferred)} / ${total > 0 ? formatSize(total) : "?"}${speed > 0 ? ` · ${formatSize(speed)}/s${eta}` : ""}${done ? " ✓" : ""}`;
  if (Number.isFinite(total) && total > 0) {
    el.dataset.lastTotal = String(total);
  }
  if (Number.isFinite(transferred) && transferred >= 0) {
    el.dataset.lastTransferred = String(transferred);
  }
  if (done) el.classList.add("done");
}

function pauseSftpTransfer(sessionId, transferId) {
  const s = sessions.get(sessionId);
  const job = s?.sftp?.transfers?.get(transferId);
  if (!job || job.status !== "running") return;
  job.status = "paused";
  job.pausedAt = Date.now();
  job.transferEl.dataset.pausedAt = String(job.pausedAt);
  setTransferState(job.transferEl, "paused", "En pausa");
  invoke("sftp_pause_transfer", {
    sessionId: s.sftp.sftpSessionId,
    transferId,
  }).catch((err) => toast(`No se pudo pausar: ${err}`, "error"));
}

function resumeSftpTransfer(sessionId, transferId) {
  const s = sessions.get(sessionId);
  const job = s?.sftp?.transfers?.get(transferId);
  if (!job || job.status !== "paused") return;
  job.status = "running";
  const pausedAt = parseInt(job.transferEl.dataset.pausedAt || "0", 10);
  if (pausedAt > 0) {
    const prev = parseInt(job.transferEl.dataset.pausedMs || "0", 10);
    job.transferEl.dataset.pausedMs = String(prev + (Date.now() - pausedAt));
    delete job.transferEl.dataset.pausedAt;
  }
  setTransferState(job.transferEl, "running", "Reanudando…");
  invoke("sftp_resume_transfer", {
    sessionId: s.sftp.sftpSessionId,
    transferId,
  }).catch((err) => toast(`No se pudo reanudar: ${err}`, "error"));
}

function markTransferSuccess(el, detail) {
  setTransferState(el, "done", detail);
  el.querySelector(".sftp-transfer-fill").style.width = "100%";
  maybeNotifyTransfer(el, true);
}

function markTransferError(el, detail) {
  setTransferState(el, "error", `✗ ${detail}`);
  maybeNotifyTransfer(el, false, detail);
}

function markTransferSkipped(el, detail) {
  setTransferState(el, "skipped", detail);
  el.querySelector(".sftp-transfer-text").textContent = "omitido";
}

function markTransferCanceled(el, detail) {
  setTransferState(el, "canceled", detail);
  el.querySelector(".sftp-transfer-text").textContent = "cancelado";
}

const SFTP_NOTIFY_MIN_MS = 5000;
const SFTP_NOTIFY_MIN_BYTES = 10 * 1024 * 1024;

function maybeNotifyTransfer(el, success, errorDetail = "") {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  const startedAt = parseInt(el.dataset.startedAt || "0", 10);
  const total = parseInt(el.dataset.lastTotal || "0", 10);
  const elapsed = Date.now() - (startedAt || Date.now());
  // Solo notifica para errores siempre, o transferencias largas/grandes.
  if (success && elapsed < SFTP_NOTIFY_MIN_MS && total < SFTP_NOTIFY_MIN_BYTES) return;
  const label = el.dataset.label || "Transferencia SFTP";
  const body = success
    ? `${label} completada en ${(elapsed / 1000).toFixed(1)} s`
    : `${label} falló: ${errorDetail}`;
  const send = () => {
    try {
      new Notification("Rustty SFTP", {
        body,
        silent: success,
      });
    } catch {}
  };
  if (Notification.permission === "granted") {
    send();
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((p) => { if (p === "granted") send(); }).catch(() => {});
  }
}

function updateTransfersVisibility(panel) {
  const list = panel.querySelector(".sftp-transfers");
  const activity = panel.querySelector(".sftp-activity-log");
  const wrap = panel.querySelector(".sftp-transfers-wrap");
  if (!wrap) return;
  // El wrap se mantiene siempre visible mientras el panel SFTP esté abierto:
  // los placeholders cubren el caso "sin contenido".
  wrap.classList.remove("hidden");
  if (list && !list.querySelector(".sftp-transfer") && !list.querySelector(".sftp-transfers-empty")) {
    const empty = document.createElement("div");
    empty.className = "sftp-transfers-empty";
    empty.textContent = "Sin transferencias todavía";
    list.appendChild(empty);
  }
  if (activity && !activity.querySelector(".sftp-activity-row") && !activity.querySelector(".sftp-activity-empty")) {
    const empty = document.createElement("div");
    empty.className = "sftp-activity-empty";
    empty.textContent = "Sin actividad todavía";
    activity.appendChild(empty);
  }
}

function setSftpStatus(panel, msg) {
  // En modo split, escribimos solo en el panel remoto (lo que justifica el
  // mensaje "Conectando SFTP…"). El local se carga por su lado.
  const filesDiv = panel.querySelector('.sftp-files[data-side="remote"]')
    || panel.querySelector(".sftp-files");
  if (filesDiv) {
    filesDiv.innerHTML = `<div class="sftp-empty">${escHtml(msg)}</div>`;
  }
}

function clearSftpStatus(_panel) { /* replaced by renderSftpFiles */ }

function parentPath(p) {
  if (!p || p === "/") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function joinRemote(base, name) {
  if (base.endsWith("/")) return base + name;
  return base + "/" + name;
}

/**
 * Devuelve la clase CSS para colorear el icono según el tipo de fichero.
 * El glifo lo da sftpFileIconChar(); aquí solo decidimos el tinte.
 */
function sftpFileIconClass(entry) {
  if (entry.is_dir) return "ftype-dir";
  if (entry.is_symlink) return "ftype-link";
  const name = (entry.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (["png","jpg","jpeg","gif","webp","svg","bmp","ico","tiff","avif"].includes(ext)) return "ftype-image";
  if (["mp4","mkv","mov","webm","avi","flv","wmv","m4v"].includes(ext)) return "ftype-video";
  if (["mp3","wav","flac","ogg","aac","m4a","opus"].includes(ext)) return "ftype-audio";
  if (["zip","tar","gz","bz2","xz","7z","rar","zst","tgz","tbz","tbz2","txz"].includes(ext)) return "ftype-archive";
  if (["pdf","epub","mobi"].includes(ext)) return "ftype-doc";
  if (["md","txt","log","cfg","conf","ini","yaml","yml","toml","env"].includes(ext)) return "ftype-text";
  if (["js","ts","jsx","tsx","py","rs","go","rb","php","java","kt","swift","c","cpp","h","hpp","cs","sh","bash","zsh","fish","lua","sql","json","xml","html","css","scss","vue","svelte"].includes(ext)) return "ftype-code";
  // Ejecutable Unix: ningún punto y permiso x; aproximación por permisos.
  if (entry.permissions && /[1357]/.test(String(entry.permissions))) return "ftype-exec";
  return "";
}

/**
 * Glifo del icono. Mantiene los emoji originales para directorio/symlink
 * (forma reconocible) y usa caracteres planos por categoría para
 * fichero. Acompañado por el color de sftpFileIconClass.
 */
function sftpFileIconChar(entry) {
  if (entry.is_dir) return "📁";
  if (entry.is_symlink) return "🔗";
  const cls = sftpFileIconClass(entry);
  switch (cls) {
    case "ftype-image":   return "🖼";
    case "ftype-video":   return "🎬";
    case "ftype-audio":   return "🎵";
    case "ftype-archive": return "📦";
    case "ftype-doc":     return "📕";
    case "ftype-text":    return "📝";
    case "ftype-code":    return "⟨/⟩";
    case "ftype-exec":    return "▶";
    default:              return "📄";
  }
}

/**
 * Permisos POSIX en formato compacto "rwxr-x---". Si no hay modo
 * (carpeta sin info, Windows local) devuelve cadena vacía.
 */
function formatSftpPermissions(mode) {
  if (mode == null) return "";
  const m = Number(mode) & 0o777;
  if (!Number.isFinite(m)) return "";
  const parts = [m >> 6, (m >> 3) & 7, m & 7];
  return parts.map((p) => (
    (p & 4 ? "r" : "-") +
    (p & 2 ? "w" : "-") +
    (p & 1 ? "x" : "-")
  )).join("");
}

/**
 * Permisos en formato octal "0750" para el tooltip.
 */
function formatSftpPermissionsOctal(mode) {
  if (mode == null) return "";
  const m = Number(mode) & 0o777;
  if (!Number.isFinite(m)) return "";
  return "0" + m.toString(8).padStart(3, "0");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return v.toFixed(v >= 100 ? 0 : 1) + " " + units[u];
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatTime(secs) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const yr = d.getFullYear();
  const now = new Date();
  if (yr === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString();
}

// ═══════════════════════════════════════════════════════════════
// EXPORTAR / IMPORTAR CONEXIONES
// ═══════════════════════════════════════════════════════════════

async function askExportStoredSecrets(count) {
  const choice = await chooseThemed({
    title: "Exportar contraseñas",
    message: `Vas a exportar ${count} conexión(es). ¿Quieres incluir también las contraseñas/passphrases guardadas en este equipo? Si las incluyes, el JSON contendrá secretos legibles: guárdalo cifrado o en un lugar seguro.`,
    submitLabel: "Incluir contraseñas",
    danger: true,
    actions: [
      { value: "without-secrets", label: "Sin contraseñas" },
    ],
  });
  if (!choice) return null;
  return choice.action === "submit";
}

async function collectExportedSecrets(profilesToExport) {
  const entries = {};
  for (const profile of profilesToExport) {
    const secrets = {};
    const password = await getStoredSecret(passwordKey(profile.id));
    const passphrase = await getStoredSecret(passphraseKey(profile.id));
    if (password) secrets.password = password;
    if (passphrase) secrets.passphrase = passphrase;
    if (Object.keys(secrets).length > 0) entries[profile.id] = secrets;
  }
  return {
    version: 1,
    storage: "keyring",
    exportedAt: new Date().toISOString(),
    entries,
  };
}

async function buildConnectionsExportData(
  profilesToExport,
  foldersToExport,
  foldersByWorkspace = null
) {
  const includeSecrets = await askExportStoredSecrets(profilesToExport.length);
  if (includeSecrets === null) return null;

  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: "Rustty",
    profiles: profilesToExport,
    folders: foldersToExport,
    secretsIncluded: includeSecrets,
  };
  if (foldersByWorkspace) {
    data.foldersByWorkspace = foldersByWorkspace;
  }
  if (includeSecrets) {
    data.secrets = await collectExportedSecrets(profilesToExport);
  }
  return data;
}

async function importExportedSecrets(data) {
  const entries = data?.secrets?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return 0;

  const choice = await chooseThemed({
    title: "Importar contraseñas",
    message: "El archivo contiene contraseñas o passphrases exportadas. ¿Quieres guardarlas en el keyring local de este equipo?",
    submitLabel: "Guardar en keyring",
    danger: true,
    actions: [
      { value: "skip-secrets", label: "No importar" },
    ],
  });
  if (!choice || choice.action !== "submit") return 0;

  let imported = 0;
  for (const [profileId, secrets] of Object.entries(entries)) {
    if (!secrets || typeof secrets !== "object") continue;
    if (secrets.password) {
      if (await saveStoredSecret(passwordKey(profileId), secrets.password, "contraseña importada")) {
        imported++;
      }
    }
    if (secrets.passphrase) {
      if (await saveStoredSecret(passphraseKey(profileId), secrets.passphrase, "passphrase importada")) {
        imported++;
      }
    }
  }
  return imported;
}

/**
 * Exporta perfiles a un archivo JSON descargable.
 * @param {string|null} folderFilter  Si se indica, exporta solo esa carpeta (y subcarpetas).
 */
async function exportConnections(folderFilter, workspaceId = getActiveWorkspaceId()) {
  let profilesToExport = profiles;
  let foldersByWorkspace = Object.fromEntries(
    Object.entries(prefs.userFoldersByWorkspace || {})
      .map(([wsId, folders]) => [wsId, Array.isArray(folders) ? folders : []])
  );
  let foldersToExport = Object.values(foldersByWorkspace).flat();

  if (folderFilter) {
    profilesToExport = profiles.filter(
      (p) =>
        profileWorkspaceId(p) === workspaceId &&
        folderContainsPath(p.group, folderFilter)
    );
    foldersToExport = [...getWorkspaceFolders(workspaceId)].filter(
      (f) => folderContainsPath(f, folderFilter)
    );
    foldersByWorkspace = { [workspaceId]: foldersToExport };
  }

  const data = await buildConnectionsExportData(
    profilesToExport,
    foldersToExport,
    foldersByWorkspace
  );
  if (!data) return;

  const suffix = folderFilter ? `-${folderFilter.replace(/\//g, "_")}` : "";
  const defaultName = `rustty-connections${suffix}-${new Date().toISOString().slice(0, 10)}.json`;

  let path;
  try {
    path = await saveDialog({
      title: "Exportar conexiones",
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) {
    toast(`Error al abrir diálogo: ${err}`, "error");
    return;
  }
  if (!path) return; // usuario canceló

  try {
    await invoke("write_text_file", {
      path,
      contents: JSON.stringify(data, null, 2),
    });
    toast(
      `${profilesToExport.length} conexiones exportadas${folderFilter ? ` (${folderFilter})` : ""}`,
      "success"
    );
  } catch (err) {
    toast(`Error al escribir fichero: ${err}`, "error");
  }
}

/**
 * Exporta a JSON todos los perfiles de un workspace concreto, junto con sus carpetas.
 */
async function exportConnectionsByWorkspace(workspaceId) {
  const ws = prefs.workspaces.find((w) => w.id === workspaceId);
  const wsName = ws ? ws.name : workspaceId;
  const profilesToExport = profiles.filter(
    (p) => (p.workspace_id || "default") === workspaceId
  );
  const foldersToExport = getWorkspaceFolders(workspaceId);

  const data = await buildConnectionsExportData(
    profilesToExport,
    foldersToExport,
    { [workspaceId]: foldersToExport }
  );
  if (!data) return;

  const safeName = wsName.replace(/[^\w\-]+/g, "_");
  const defaultName = `rustty-connections-${safeName}-${new Date().toISOString().slice(0, 10)}.json`;

  let path;
  try {
    path = await saveDialog({
      title: "Exportar conexiones",
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) {
    toast(`Error al abrir diálogo: ${err}`, "error");
    return;
  }
  if (!path) return;

  try {
    await invoke("write_text_file", {
      path,
      contents: JSON.stringify(data, null, 2),
    });
    toast(`${profilesToExport.length} conexiones exportadas (${wsName})`, "success");
  } catch (err) {
    toast(`Error al escribir fichero: ${err}`, "error");
  }
}

/**
 * Importa perfiles desde un archivo JSON exportado por Rustty.
 * Hace merge: actualiza si el id existe, añade si no.
 */
async function importConnections() {
  let path;
  try {
    path = await openDialog({
      title: "Importar conexiones",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) {
    toast(`Error al abrir diálogo: ${err}`, "error");
    return;
  }
  if (!path) return; // usuario canceló

  try {
    const text = await invoke("read_text_file", { path });
    const data = JSON.parse(text);

    if (!data.profiles || !Array.isArray(data.profiles)) {
      throw new Error("Formato de archivo no válido");
    }

    let added = 0, updated = 0;
    for (const profile of data.profiles) {
      await invoke("save_profile", { profile });
      const idx = profiles.findIndex((p) => p.id === profile.id);
      if (idx >= 0) { profiles[idx] = profile; updated++; }
      else { profiles.push(profile); added++; }
    }

    if (data.foldersByWorkspace && typeof data.foldersByWorkspace === "object" && !Array.isArray(data.foldersByWorkspace)) {
      for (const [wsId, folders] of Object.entries(data.foldersByWorkspace)) {
        if (!wsId || !Array.isArray(folders)) continue;
        saveWorkspaceFolders(wsId, [
          ...getWorkspaceFolders(wsId),
          ...folders.filter((f) => typeof f === "string" && f.trim()),
        ]);
      }
    } else if (Array.isArray(data.folders)) {
      const workspaceIds = [...new Set(
        data.profiles.map((p) => profileWorkspaceId(p)).filter(Boolean)
      )];
      const targetWs = workspaceIds.length === 1 ? workspaceIds[0] : getActiveWorkspaceId();
      saveWorkspaceFolders(targetWs, [
        ...getWorkspaceFolders(targetWs),
        ...data.folders.filter((f) => typeof f === "string" && f.trim()),
      ]);
    }

    const importedSecrets = await importExportedSecrets(data);

    renderConnectionList();
    scheduleProfileAutoSync();
    toast(
      `Importadas: ${added} nuevas, ${updated} actualizadas${importedSecrets ? `, ${importedSecrets} secretos` : ""}`,
      "success",
    );
  } catch (err) {
    toast(`Error al importar: ${err}`, "error");
  }
}

/**
 * Claves OpenSSH que reconocemos pero NO mapeamos a ningún campo de Rustty.
 * Solo se usan para informar al usuario en el resumen de importación; no
 * incluimos aquí las que sí sabemos traducir (HostName, User, forwards, etc.).
 */
const SSH_UNSUPPORTED_KEYS = new Set([
  "match", "controlmaster", "controlpath", "controlpersist", "forwardagent",
  "forwardx11", "serveralivecountmax", "stricthostkeychecking", "userknownhostsfile",
  "preferredauthentications", "pubkeyauthentication", "passwordauthentication",
  "ciphers", "macs", "kexalgorithms", "hostkeyalgorithms", "loglevel",
  "compression", "addkeystoagent", "requesttty", "sendenv", "setenv",
  "canonicalizehostname", "tcpkeepalive", "connecttimeout", "connectionattempts",
]);

/**
 * Resuelve una ruta de `Include`/`IdentityFile` a un path absoluto.
 * Absolutas se respetan; `~` y relativas se anclan a `~/.ssh/`.
 */
function resolveSshPath(p, homeDir) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return s;
  if (s.startsWith("~/")) return homeDir ? `${homeDir}/${s.slice(2)}` : s;
  if (s === "~") return homeDir || s;
  if (s.startsWith("/")) return s;          // absoluta
  // Relativa: respecto a ~/.ssh/ (comportamiento de OpenSSH para el config de usuario).
  return homeDir ? `${homeDir}/.ssh/${s}` : s;
}

/**
 * Expande las directivas `Include` de un config de OpenSSH inlineando el
 * contenido de los ficheros referenciados en el punto del Include (respeta el
 * orden). Soporta globs simples (`*`) vía `local_list_dir`. Evita recursión
 * con un Set de paths ya vistos y un límite de profundidad.
 *
 * Devuelve el contenido ya expandido y registra en `unsupported` los Include
 * que no se pudieron resolver.
 */
async function expandSshIncludes(content, homeDir, seen, depth, unsupported) {
  if (depth > 16) return content;
  const out = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^include\s+(.+)$/i);
    if (!m) {
      out.push(rawLine);
      continue;
    }
    // Un Include puede listar varios patrones separados por espacios.
    const patterns = m[1].trim().split(/\s+/).filter(Boolean);
    for (const pat of patterns) {
      const resolved = resolveSshPath(pat, homeDir);
      let files = [];
      if (/[*?]/.test(resolved)) {
        // Glob simple: listamos el directorio padre y filtramos por el patrón.
        const slash = resolved.lastIndexOf("/");
        const dir = slash >= 0 ? resolved.slice(0, slash) : ".";
        const globPart = slash >= 0 ? resolved.slice(slash + 1) : resolved;
        const re = new RegExp("^" + globPart.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        try {
          const entries = await invoke("local_list_dir", { path: dir });
          files = entries
            .filter((e) => !e.is_dir && re.test(e.name))
            .map((e) => e.path)
            .sort();
        } catch {
          unsupported.add(`Include ${pat}`);
        }
      } else {
        files = [resolved];
      }
      for (const file of files) {
        if (seen.has(file)) continue;       // evita ciclos
        seen.add(file);
        let inner;
        try {
          inner = await invoke("read_text_file", { path: file });
        } catch {
          unsupported.add(`Include ${pat}`);
          continue;
        }
        const expanded = await expandSshIncludes(inner, homeDir, seen, depth + 1, unsupported);
        out.push(expanded);
      }
    }
  }
  return out.join("\n");
}

/**
 * Parsea uno o varios forwards de OpenSSH a la forma de túnel de Rustty.
 * Formatos:
 *   LocalForward  [bind:]lport rhost:rport   → {tunnel_type:"local"}
 *   RemoteForward [bind:]rport lhost:lport   → {tunnel_type:"remote"}
 *   DynamicForward [bind:]lport              → {tunnel_type:"dynamic"}
 * Devuelve el objeto de túnel (esquema SshTunnelProfile) o `null` si no parsea.
 */
function parseSshForward(kind, value) {
  // Separa un token `[bind:]port` en {bind, port}. Soporta IPv6 entre corchetes.
  const splitHostPort = (tok) => {
    const t = String(tok || "").trim();
    const v6 = t.match(/^\[([^\]]+)\]:(\d+)$/);
    if (v6) return { host: v6[1], port: parseInt(v6[2], 10) };
    const parts = t.split(":");
    if (parts.length === 1) return { host: null, port: parseInt(parts[0], 10) };
    return { host: parts.slice(0, -1).join(":"), port: parseInt(parts[parts.length - 1], 10) };
  };
  const tokens = value.trim().split(/\s+/);
  const base = { id: crypto.randomUUID(), name: null, auto_start: false };
  if (kind === "dynamicforward") {
    const a = splitHostPort(tokens[0]);
    if (!Number.isFinite(a.port)) return null;
    return { ...base, tunnel_type: "dynamic", bind_host: a.host || "127.0.0.1",
             local_port: a.port, remote_host: null, remote_port: null };
  }
  if (tokens.length < 2) return null;
  const left = splitHostPort(tokens[0]);
  const right = splitHostPort(tokens[1]);
  if (kind === "localforward") {
    // [bind:]lport rhost:rport
    if (!Number.isFinite(left.port) || !right.host || !Number.isFinite(right.port)) return null;
    return { ...base, tunnel_type: "local", bind_host: left.host || "127.0.0.1",
             local_port: left.port, remote_host: right.host, remote_port: right.port };
  }
  if (kind === "remoteforward") {
    // [bind:]rport lhost:lport → el puerto que escucha en el remoto es local_port
    // en nuestro esquema (el extremo que abre Rustty), y el destino es remote_*.
    if (!Number.isFinite(left.port) || !right.host || !Number.isFinite(right.port)) return null;
    return { ...base, tunnel_type: "remote", bind_host: left.host || "127.0.0.1",
             local_port: left.port, remote_host: right.host, remote_port: right.port };
  }
  return null;
}

/**
 * Parsea el contenido de un fichero `~/.ssh/config` (formato OpenSSH).
 *
 * Es asíncrono porque resuelve las directivas `Include` (lee ficheros vía el
 * backend). Soporta: Host, HostName, User, Port, IdentityFile, ProxyJump,
 * ServerAliveInterval (keepalive), IdentityAgent y los forwards
 * (Local/Remote/Dynamic). Las claves reconocidas pero no mapeables se acumulan
 * en `unsupported` (globales y por host) para mostrarlas en el resumen.
 *
 * Devuelve `{ blocks, unsupported }` donde cada bloque incluye además
 * `keepAliveSecs` y `tunnels`.
 */
async function parseSshConfig(content, homeDir) {
  const unsupported = new Set();
  const expanded = await expandSshIncludes(content, homeDir, new Set(), 0, unsupported);

  const blocks = [];
  let current = null;
  for (const rawLine of expanded.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    // Aceptar `Key Value` o `Key=Value`
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*[=\s]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      // Puede haber varios alias separados por espacio: tomamos el primero sin
      // wildcards.
      const aliases = value.split(/\s+/).filter((a) => !/[*?]/.test(a));
      if (aliases.length === 0) {
        current = null; // bloque comodín, lo ignoramos
        continue;
      }
      current = { alias: aliases[0], host: aliases[0], tunnels: [] };
      blocks.push(current);
    } else if (key === "include") {
      // Ya expandido en expandSshIncludes; ignorar.
    } else {
      switch (key) {
        case "hostname":      if (current) current.host = value; break;
        case "user":          if (current) current.user = value; break;
        case "port":          if (current) current.port = parseInt(value, 10); break;
        case "identityfile":  if (current) current.identityFile = value.replace(/^~/, ""); break;
        case "proxyjump":     if (current) current.proxyJump = value; break;
        case "serveraliveinterval": {
          // Keepalive → keep_alive_secs (entero en segundos).
          const secs = parseInt(value, 10);
          if (current && Number.isFinite(secs)) current.keepAliveSecs = secs;
          break;
        }
        case "identityagent": {
          // Rustty ya usa el agente del SO, así que un IdentityAgent normal no
          // requiere acción. Solo si el valor es `none` (sin agente) lo anotamos
          // como no soportado para avisar al usuario.
          if (/^none$/i.test(value)) unsupported.add("IdentityAgent none");
          break;
        }
        case "localforward":
        case "remoteforward":
        case "dynamicforward": {
          const tun = parseSshForward(key, value);
          if (tun) {
            if (current) current.tunnels.push(tun);
          } else {
            unsupported.add(`${m[1]} ${value}`);
          }
          break;
        }
        default:
          // Claves reconocidas pero sin mapeo: informar.
          if (SSH_UNSUPPORTED_KEYS.has(key)) unsupported.add(m[1]);
      }
    }
  }
  return { blocks: blocks.filter((b) => b.alias && b.host), unsupported: [...unsupported] };
}

/**
 * Importa los hosts del fichero `~/.ssh/config` del usuario como perfiles
 * Rustty bajo la carpeta `SSH Config` del workspace activo. Si un perfil con
 * el mismo `name` ya existe en esa carpeta, no se duplica.
 */
async function importFromSshConfig() {
  let path;
  try {
    const home = await invoke("local_home_dir").catch(() => null);
    const defaultPath = home ? `${home}/.ssh/config` : null;
    path = await openDialog({
      title: "Importar ~/.ssh/config",
      multiple: false,
      defaultPath,
    });
  } catch (err) {
    toast(`Error al abrir diálogo: ${err}`, "error");
    return;
  }
  if (!path) return;

  let parsed, home;
  try {
    home = await invoke("local_home_dir").catch(() => null);
    const text = await invoke("read_text_file", { path });
    parsed = await parseSshConfig(text, home);
  } catch (err) {
    toast(`No se pudo leer ${path}: ${err}`, "error");
    return;
  }
  const { blocks, unsupported } = parsed;

  if (blocks.length === 0) {
    toast(t("import_ssh.no_hosts"), "info");
    return;
  }

  const wsId = getActiveWorkspaceId();
  const folder = "SSH Config";

  // Perfiles existentes en la carpeta SSH Config del workspace, indexados por alias.
  const existingByName = new Map(
    profiles
      .filter((p) => (p.workspace_id || "default") === wsId && p.group === folder)
      .map((p) => [p.name, p])
  );

  // Mapea un bloque del config a los campos de un perfil Rustty.
  const blockToFields = (b) => {
    const hasKey = !!b.identityFile;
    return {
      host: b.host,
      port: Number.isFinite(b.port) ? b.port : 22,
      username: b.user || "",
      auth_type: hasKey ? "public_key" : "password",
      key_path: hasKey ? b.identityFile : null,
      keep_alive_secs: Number.isFinite(b.keepAliveSecs) ? b.keepAliveSecs : null,
      proxy_jump: b.proxyJump || null,
      ssh_tunnels: b.tunnels || [],
    };
  };

  // Compara los campos mapeados de dos perfiles; los túneles se comparan por
  // forma (ignorando el `id`, que es aleatorio). Devuelve la lista de campos
  // que cambiarían.
  const tunnelKey = (list) =>
    JSON.stringify(
      (list || [])
        .map((tnl) => normalizeTunnelConfig(tnl))
        .map((tnl) => ({ t: tnl.tunnelType, b: tnl.bindHost, lp: tnl.localPort, rh: tnl.remoteHost, rp: tnl.remotePort }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
    );
  const diffFields = (fields, prof) => {
    const changed = [];
    if (fields.host !== prof.host) changed.push("host");
    if (fields.port !== (prof.port ?? 22)) changed.push("port");
    if (fields.username !== (prof.username || "")) changed.push("user");
    if ((fields.key_path || null) !== (prof.key_path || null)) changed.push("key_path");
    if ((fields.proxy_jump || null) !== (prof.proxy_jump || null)) changed.push("proxy_jump");
    if ((fields.keep_alive_secs ?? null) !== (prof.keep_alive_secs ?? null)) changed.push("keep_alive_secs");
    if (tunnelKey(fields.ssh_tunnels) !== tunnelKey(prof.ssh_tunnels)) changed.push("ssh_tunnels");
    return changed;
  };

  // Clasifica cada bloque: nuevo / a actualizar / sin cambios.
  const toCreate = [], toUpdate = [], unchanged = [];
  for (const b of blocks) {
    const fields = blockToFields(b);
    const prof = existingByName.get(b.alias);
    if (!prof) {
      toCreate.push({ b, fields });
    } else {
      const changed = diffFields(fields, prof);
      if (changed.length) toUpdate.push({ b, fields, prof, changed });
      else unchanged.push(b.alias);
    }
  }

  // Resumen tematizado con recuentos, campos a cambiar y directivas no soportadas.
  const lines = [
    t("import_ssh.summary", { new: toCreate.length, update: toUpdate.length, same: unchanged.length }),
    "",
    t("import_ssh.new_label", { count: toCreate.length }) +
      (toCreate.length ? ` — ${toCreate.map((x) => x.b.alias).join(", ")}` : ""),
    t("import_ssh.update_label", { count: toUpdate.length }),
  ];
  for (const u of toUpdate) {
    lines.push(`  • ${u.b.alias}: ${u.changed.join(", ")}`);
  }
  lines.push(t("import_ssh.same_label", { count: unchanged.length }));
  if (unsupported.length) {
    lines.push("", t("import_ssh.unsupported_label", { items: unsupported.join(", ") }));
  }

  if (toCreate.length === 0 && toUpdate.length === 0) {
    toast(t("import_ssh.nothing"), "info");
    return;
  }

  const ok = await confirmThemed({
    title: t("import_ssh.title"),
    message: lines.join("\n"),
    submitLabel: t("import_ssh.apply"),
  });
  if (!ok) return;

  saveWorkspaceFolders(wsId, [...getWorkspaceFolders(wsId), folder]);

  // Construye un perfil completo nuevo a partir de los campos mapeados.
  const buildNewProfile = (alias, fields, now) => ({
    id: crypto.randomUUID(),
    name: alias,
    host: fields.host,
    port: fields.port,
    username: fields.username,
    connection_type: "ssh",
    domain: null,
    auth_type: fields.auth_type,
    key_path: fields.key_path,
    group: folder,
    notes: null,
    workspace_id: wsId,
    keepass_entry_uuid: null,
    keepass_property: null,
    follow_cwd: true,
    keep_alive_secs: fields.keep_alive_secs,
    allow_legacy_algorithms: false,
    legacy_algorithms: null,
    agent_forwarding: false,
    disable_paste_confirm: false,
    x11_forwarding: false,
    auto_reconnect: null,
    session_log: false,
    session_log_dir: null,
    proxy_jump: fields.proxy_jump,
    mac_address: null,
    wol_broadcast: null,
    wol_port: null,
    ssh_tunnels: fields.ssh_tunnels,
    created_at: now,
    updated_at: now,
  });

  let added = 0, updatedCount = 0;
  const now = new Date().toISOString();

  for (const { b, fields } of toCreate) {
    const profile = buildNewProfile(b.alias, fields, now);
    try {
      await invoke("save_profile", { profile });
      profiles.push(profile);
      added++;
    } catch (err) {
      console.error("[ssh_config] save_profile failed for", b.alias, err);
    }
  }

  for (const { fields, prof } of toUpdate) {
    // Actualiza el perfil existente conservando id y created_at.
    const profile = {
      ...prof,
      host: fields.host,
      port: fields.port,
      username: fields.username,
      auth_type: fields.auth_type,
      key_path: fields.key_path,
      keep_alive_secs: fields.keep_alive_secs,
      proxy_jump: fields.proxy_jump,
      ssh_tunnels: fields.ssh_tunnels,
      updated_at: now,
    };
    try {
      await invoke("save_profile", { profile });
      const idx = profiles.findIndex((p) => p.id === prof.id);
      if (idx >= 0) profiles[idx] = profile;
      updatedCount++;
    } catch (err) {
      console.error("[ssh_config] save_profile update failed for", prof.name, err);
    }
  }

  renderConnectionList();
  scheduleProfileAutoSync();
  toast(t("import_ssh.done", { new: added, update: updatedCount, same: unchanged.length }), "success");
}

// ═══════════════════════════════════════════════════════════════
// ASISTENTE DE IMPORTACIÓN (mRemoteNG, …)
//
// Parser + descifrado en frontend (DOMParser + WebCrypto), sin nuevas
// dependencias Rust. Vuelca a un perfil-contenedor (workspace) nuevo,
// reconstruyendo el árbol de carpetas del origen. Las contraseñas se
// descifran de forma opt-in y se guardan en el keyring local.
// ═══════════════════════════════════════════════════════════════

// Mapa Protocol de mRemoteNG → connection_type de Rustty. Lo no listado
// se omite (se cuenta como "no soportado").
const MRNG_PROTOCOL_MAP = { SSH2: "ssh", SSH1: "ssh", RDP: "rdp" };

const importWizard = {
  source: "mremoteng",
  fileName: null,
  meta: null,
  tree: null,
  step: 1,
  protocols: new Set(), // protocolos soportados marcados
};

/**
 * Parsea el contenido XML de un export de mRemoteNG (confCons, ConfVersion
 * 2.x). Devuelve `{ meta, tree }` donde `tree` usa el modelo de nodo
 * normalizado que comparten todas las fuentes del asistente:
 * `{ uid, name, type, protocol, connType, host, port, username, domain,
 *   notes, encPassword, children }`. No descifra nada (la herencia de
 * atributos sí se resuelve por adelantado).
 */
function parseMremoteng(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(t("import_wizard.err_xml"));
  }
  const root = doc.documentElement;
  if (!root || !/Connections$/.test(root.localName || root.nodeName)) {
    throw new Error(t("import_wizard.err_not_mremoteng"));
  }
  const meta = {
    source: "mremoteng",
    name: root.getAttribute("Name") || "mRemoteNG",
    blockCipherMode: (root.getAttribute("BlockCipherMode") || "GCM").toUpperCase(),
    kdfIterations: parseInt(root.getAttribute("KdfIterations") || "1000", 10) || 1000,
    protectedCanary: root.getAttribute("Protected") || null,
    fullFileEncryption: (root.getAttribute("FullFileEncryption") || "false") === "true",
    confVersion: root.getAttribute("ConfVersion") || "",
    // El paso de contraseña maestra solo aplica si el fichero está protegido.
    needsMasterPassword: !!root.getAttribute("Protected"),
    hasPasswords: !!root.getAttribute("Protected"),
    protocolMap: { ...MRNG_PROTOCOL_MAP },
  };

  // Primera pasada: árbol "crudo" con referencia al elemento DOM y al padre,
  // necesario para resolver la herencia de atributos (mrngResolveAttr).
  let counter = 0;
  const walk = (el, parent) => {
    const out = [];
    for (const child of Array.from(el.children)) {
      if ((child.tagName || child.nodeName) !== "Node") continue;
      const node = {
        uid: `iw-${counter++}`,
        el: child,
        parent,
        name: child.getAttribute("Name") || "(sin nombre)",
        type: child.getAttribute("Type") || "Connection",
        protocol: child.getAttribute("Protocol") || "",
        children: [],
      };
      node.children = walk(child, node);
      out.push(node);
    }
    return out;
  };
  const raw = walk(root, null);

  // Segunda pasada: normaliza al modelo común resolviendo la herencia.
  const normalize = (n) => {
    const isConn = n.type !== "Container";
    const connType = isConn ? (MRNG_PROTOCOL_MAP[n.protocol] || null) : null;
    const portRaw = parseInt(mrngResolveAttr(n, "Port") || "", 10);
    return {
      uid: n.uid,
      name: n.name,
      type: isConn ? "Connection" : "Container",
      protocol: n.protocol,
      connType,
      host: isConn ? (mrngResolveAttr(n, "Hostname") || n.name) : null,
      port: Number.isFinite(portRaw) && portRaw > 0 ? portRaw : null,
      username: isConn ? (mrngResolveAttr(n, "Username") || "") : null,
      domain: isConn ? (mrngResolveAttr(n, "Domain") || null) : null,
      notes: isConn ? (n.el.getAttribute("Descr") || null) : null,
      encPassword: isConn ? (mrngResolveAttr(n, "Password") || null) : null,
      children: n.children.map(normalize),
    };
  };
  const tree = raw.map(normalize);
  return { meta, tree };
}

/**
 * Resuelve un atributo de un nodo respetando la herencia de mRemoteNG: si el
 * nodo declara `Inherit<Attr>="true"`, sube al contenedor padre.
 */
function mrngResolveAttr(node, attr) {
  let cur = node;
  while (cur) {
    const inherit = cur.el.getAttribute("Inherit" + attr);
    if (inherit === "true" && cur.parent) {
      cur = cur.parent;
      continue;
    }
    return cur.el.getAttribute(attr);
  }
  return null;
}

/** Deriva la clave AES-256 desde la contraseña maestra (PBKDF2-HMAC-SHA1). */
async function mrngDeriveKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-1" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

/**
 * Descifra un campo cifrado de mRemoteNG (modo GCM). El blob base64 es
 * `salt(16) || nonce(16) || ciphertext+tag`. Lanza si el tag GCM no valida
 * (contraseña incorrecta). Solo se soporta GCM (el modo moderno por defecto).
 */
async function mrngDecryptGcm(b64, password, iterations) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length < 32) throw new Error("blob demasiado corto");
  const salt = raw.slice(0, 16);
  const nonce = raw.slice(16, 32);
  const ct = raw.slice(32);
  const key = await mrngDeriveKey(password, salt, iterations);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    key,
    ct
  );
  return new TextDecoder().decode(pt);
}

/** Contraseña efectiva: vacía → predeterminada histórica de mRemoteNG. */
function mrngEffectivePassword(input) {
  return input && input.length ? input : "mR3m";
}

/** Aplana el árbol normalizado a la lista de nodos Connection con su ruta de carpeta. */
function flattenConnections(tree) {
  const out = [];
  const walk = (nodes, pathParts) => {
    for (const n of nodes) {
      if (n.type === "Container") {
        walk(n.children, [...pathParts, n.name]);
      } else {
        out.push({ node: n, folder: pathParts.join("/") });
      }
    }
  };
  walk(tree, []);
  return out;
}

/** Conjunto de protocolos presentes que mapean a un tipo de Rustty soportado. */
function supportedProtocols(tree) {
  const set = new Set();
  for (const { node } of flattenConnections(tree)) {
    if (node.connType) set.add(node.protocol);
  }
  return set;
}

function setImportWizardStep(step) {
  importWizard.step = step;
  const overlay = document.getElementById("import-wizard-overlay");
  if (!overlay) return;
  overlay.querySelectorAll(".iw-pane").forEach((p) => {
    p.classList.toggle("hidden", Number(p.dataset.pane) !== step);
  });
  overlay.querySelectorAll(".iw-step").forEach((s) => {
    const n = Number(s.dataset.step);
    s.classList.toggle("is-active", n === step);
    s.classList.toggle("is-done", n < step);
  });
  const hasPwStep = !!importWizard.meta?.hasPasswords;
  const back = document.getElementById("iw-back");
  const next = document.getElementById("iw-next");
  const imp = document.getElementById("iw-import");
  back.classList.toggle("hidden", step === 1);
  // El último paso es 3 si hay contraseñas cifradas, si no el 2.
  const lastStep = hasPwStep ? 3 : 2;
  next.classList.toggle("hidden", step >= lastStep);
  imp.classList.toggle("hidden", step < lastStep);
  // El grupo de contraseña maestra solo aplica a fuentes que lo necesitan
  // (mRemoteNG protegido); Ásbrú usa una clave fija y no pide nada.
  document
    .getElementById("iw-master-group")
    ?.classList.toggle("hidden", !importWizard.meta?.needsMasterPassword);
}

function openImportWizard() {
  importWizard.fileName = null;
  importWizard.meta = null;
  importWizard.tree = null;
  importWizard.protocols = new Set();
  const overlay = document.getElementById("import-wizard-overlay");
  document.getElementById("iw-file-name").textContent = "";
  document.getElementById("iw-parse-error").textContent = "";
  document.getElementById("iw-parse-summary").classList.add("hidden");
  document.getElementById("iw-pw-result").textContent = "";
  document.getElementById("iw-master-password").value = "";
  document.getElementById("iw-import-passwords").checked = false;
  document.getElementById("iw-next").disabled = true;
  document.getElementById("iw-progress")?.classList.add("hidden");
  document.getElementById("iw-import").disabled = false;
  document.getElementById("iw-back").disabled = false;
  overlay.classList.remove("hidden");
  setImportWizardStep(1);
}

function closeImportWizard() {
  document.getElementById("import-wizard-overlay")?.classList.add("hidden");
}

async function importWizardPickFile() {
  // La fuente seleccionada determina el filtro de fichero y el parser.
  importWizard.source = document.getElementById("iw-source").value || "mremoteng";
  const filters = importWizard.source === "asbru"
    ? [{ name: "Ásbrú Connection Manager", extensions: ["yml", "yaml"] }]
    : [{ name: "mRemoteNG", extensions: ["xml"] }];
  let path;
  try {
    path = await openDialog({
      title: t("import_wizard.pick_file"),
      multiple: false,
      filters,
    });
  } catch (err) {
    toast(`${err}`, "error");
    return;
  }
  if (!path) return;
  importWizard.fileName = Array.isArray(path) ? path[0] : path;
  document.getElementById("iw-parse-error").textContent = "";
  try {
    let meta, tree, defaultName;
    if (importWizard.source === "asbru") {
      // Ásbrú se parsea y descifra en el backend (YAML + Blowfish/MD5). El
      // backend devuelve códigos estables («code» o «code|detalle») que se
      // traducen aquí.
      try {
        tree = await invoke("parse_asbru", { path: importWizard.fileName });
      } catch (e) {
        const [code, detail] = `${e}`.split("|");
        const key = { not_asbru: "err_not_asbru", read: "err_read", yaml: "err_yaml" }[code];
        throw new Error(key ? t(`import_wizard.${key}`, { detail: detail || "" }) : `${e}`);
      }
      meta = {
        source: "asbru",
        name: "Ásbrú",
        needsMasterPassword: false,
        hasPasswords: true,
        protocolMap: { SSH: "ssh", RDP: "rdp" },
      };
      defaultName = "Ásbrú";
    } else {
      const text = await invoke("read_text_file", { path: importWizard.fileName });
      ({ meta, tree } = parseMremoteng(text));
      if (meta.fullFileEncryption) {
        document.getElementById("iw-parse-error").textContent = t("import_wizard.err_full_encryption");
        document.getElementById("iw-next").disabled = true;
        return;
      }
      defaultName = meta.name && meta.name !== "Conexiones" ? meta.name : "mRemoteNG";
    }

    importWizard.meta = meta;
    importWizard.tree = tree;
    importWizard.protocols = supportedProtocols(tree);

    const conns = flattenConnections(tree);
    const supported = conns.filter((c) => c.node.connType).length;
    let containers = 0;
    const countContainers = (nodes) => {
      for (const n of nodes) {
        if (n.type === "Container") { containers++; countContainers(n.children); }
      }
    };
    countContainers(tree);

    const fname = importWizard.fileName.split(/[/\\]/).pop();
    document.getElementById("iw-file-name").textContent = fname;
    const summary = document.getElementById("iw-parse-summary");
    summary.innerHTML = t("import_wizard.summary", {
      total: conns.length,
      supported,
      folders: containers,
      protocols: [...importWizard.protocols].join(", ") || "—",
    }).replace(/\n/g, "<br>");
    summary.classList.remove("hidden");
    document.getElementById("iw-next").disabled = supported === 0;
    if (supported === 0) {
      document.getElementById("iw-parse-error").textContent = t("import_wizard.err_no_supported");
    }
    // Prefijar nombre del workspace con el del origen.
    document.getElementById("iw-workspace-name").value = defaultName;
  } catch (err) {
    importWizard.tree = null;
    document.getElementById("iw-parse-error").textContent = `${err.message || err}`;
    document.getElementById("iw-next").disabled = true;
  }
}

/** Pinta los chips de protocolo y el árbol con checkboxes del paso 2. */
function renderImportWizardSelection() {
  const protoBox = document.getElementById("iw-proto-filter");
  protoBox.innerHTML = "";
  const protoMap = importWizard.meta?.protocolMap || {};
  for (const proto of [...importWizard.protocols]) {
    const id = `iw-proto-${proto}`;
    const label = document.createElement("label");
    label.className = "iw-proto-chip";
    label.innerHTML = `<input type="checkbox" id="${id}" checked data-proto="${proto}"><span>${proto} → ${protoMap[proto] || "?"}</span>`;
    protoBox.appendChild(label);
  }
  protoBox.querySelectorAll("input[data-proto]").forEach((cb) => {
    cb.addEventListener("change", () => {
      // Marca/desmarca todas las conexiones de ese protocolo en el árbol.
      const proto = cb.dataset.proto;
      document.querySelectorAll(`#iw-tree .iw-conn[data-proto="${proto}"] input`).forEach((c) => {
        c.checked = cb.checked;
        c.disabled = !cb.checked;
        c.closest(".iw-node")?.classList.toggle("iw-disabled", !cb.checked);
      });
      updateImportWizardCount();
    });
  });

  const treeBox = document.getElementById("iw-tree");
  treeBox.innerHTML = "";
  const renderNodes = (nodes, depth) => {
    for (const n of nodes) {
      const supported = n.type === "Connection" && !!n.connType;
      const isUnsupportedConn = n.type === "Connection" && !supported;
      const row = document.createElement("div");
      row.className = "iw-node " + (n.type === "Container" ? "iw-container" : "iw-conn");
      if (isUnsupportedConn) row.classList.add("iw-disabled");
      if (n.type === "Connection") row.dataset.proto = n.protocol;
      row.dataset.uid = n.uid;
      const protoBadge = n.type === "Connection"
        ? `<span class="iw-node-proto">${n.protocol || "?"}</span>`
        : "";
      row.style.paddingLeft = `${10 + depth * 18}px`;
      row.innerHTML = `<label><input type="checkbox" ${supported || n.type === "Container" ? "checked" : ""} ${isUnsupportedConn ? "disabled" : ""}><span class="iw-node-name">${escHtml(n.name)}</span></label>${protoBadge}`;
      treeBox.appendChild(row);
      const cb = row.querySelector("input");
      cb._uid = n.uid;
      if (n.type === "Container") {
        cb.addEventListener("change", () => {
          // Propaga el check a los descendientes visibles y no deshabilitados.
          const start = Array.from(treeBox.children).indexOf(row);
          for (let i = start + 1; i < treeBox.children.length; i++) {
            const r = treeBox.children[i];
            const rd = parseInt(r.style.paddingLeft, 10);
            if (rd <= 10 + depth * 18) break; // salió del subárbol
            const c = r.querySelector("input");
            if (!c.disabled) c.checked = cb.checked;
          }
          updateImportWizardCount();
        });
      } else {
        cb.addEventListener("change", updateImportWizardCount);
      }
      if (n.children.length) renderNodes(n.children, depth + 1);
    }
  };
  renderNodes(importWizard.tree, 0);
  updateImportWizardCount();
}

function updateImportWizardCount() {
  const n = document.querySelectorAll("#iw-tree .iw-conn input:checked").length;
  document.getElementById("iw-selected-count").textContent = t("import_wizard.selected", { count: n });
}

async function importWizardValidatePassword() {
  const result = document.getElementById("iw-pw-result");
  const pw = mrngEffectivePassword(document.getElementById("iw-master-password").value);
  if (importWizard.meta.blockCipherMode !== "GCM") {
    result.textContent = t("import_wizard.pw_mode_unsupported", { mode: importWizard.meta.blockCipherMode });
    result.style.color = "var(--red)";
    return false;
  }
  try {
    await mrngDecryptGcm(importWizard.meta.protectedCanary, pw, importWizard.meta.kdfIterations);
    result.textContent = t("import_wizard.pw_ok");
    result.style.color = "var(--green)";
    return true;
  } catch {
    result.textContent = t("import_wizard.pw_bad");
    result.style.color = "var(--red)";
    return false;
  }
}

/** Ejecuta la importación: crea el workspace y vuelca los perfiles seleccionados. */
async function importWizardRun() {
  const wsName = (document.getElementById("iw-workspace-name").value || "mRemoteNG").trim();
  const importPw = document.getElementById("iw-import-passwords").checked;
  const masterPw = mrngEffectivePassword(document.getElementById("iw-master-password").value);

  // Conexiones seleccionadas (checkbox marcado y soportadas).
  const selectedUids = new Set(
    Array.from(document.querySelectorAll("#iw-tree .iw-conn input:checked")).map((c) => c._uid)
  );
  const conns = flattenConnections(importWizard.tree).filter(
    (c) => c.node.connType && selectedUids.has(c.node.uid)
  );
  if (conns.length === 0) {
    toast(t("import_wizard.err_nothing_selected"), "warning");
    return;
  }

  // mRemoteNG valida la contraseña maestra antes de importar; Ásbrú usa una
  // clave fija y no necesita esta comprobación.
  if (importPw && importWizard.meta?.needsMasterPassword) {
    const ok = await importWizardValidatePassword();
    if (!ok) {
      const cont = await confirmThemed({
        title: t("import_wizard.title"),
        message: t("import_wizard.pw_continue_without"),
        submitLabel: t("import_wizard.continue"),
      });
      if (!cont) return;
    }
  }

  // Crea el perfil-contenedor (workspace) nuevo.
  const wsId = `ws-${crypto.randomUUID()}`;
  prefs.workspaces = Array.isArray(prefs.workspaces) ? prefs.workspaces : [];
  prefs.workspaces.push({ id: wsId, name: wsName });
  prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
  prefs.userFoldersByWorkspace[wsId] = [];

  const now = new Date().toISOString();
  const folderSet = new Set();
  let imported = 0, withPw = 0, pwFailed = 0, processed = 0;

  // Feedback de progreso: el volcado es un bucle de IPC que puede tardar con
  // muchos perfiles, así que mostramos una barra y un contador en vivo.
  const total = conns.length;
  const progressBox = document.getElementById("iw-progress");
  const progressFill = document.getElementById("iw-progress-fill");
  const progressText = document.getElementById("iw-progress-text");
  const importBtn = document.getElementById("iw-import");
  const backBtn = document.getElementById("iw-back");
  const updateProgress = (done) => {
    const pct = total ? Math.round((done / total) * 100) : 100;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = t("import_wizard.progress", { done, total, pct });
  };
  if (importBtn) importBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  if (progressFill) progressFill.style.width = "0%";
  progressBox?.classList.remove("hidden");
  updateProgress(0);

  for (const { node, folder } of conns) {
    const ctype = node.connType;
    const port = Number.isFinite(node.port) && node.port > 0
      ? node.port
      : (ctype === "rdp" ? 3389 : 22);
    const id = crypto.randomUUID();
    if (folder) folderSet.add(folder);

    const profile = {
      id,
      name: node.name,
      host: node.host || node.name,
      port,
      username: node.username || "",
      connection_type: ctype,
      domain: ctype === "rdp" ? (node.domain || null) : null,
      auth_type: "password",
      key_path: null,
      group: folder || null,
      notes: node.notes || null,
      workspace_id: wsId,
      keepass_entry_uuid: null,
      keepass_property: null,
      follow_cwd: true,
      keep_alive_secs: null,
      allow_legacy_algorithms: false,
      legacy_algorithms: null,
      agent_forwarding: false,
      disable_paste_confirm: false,
      x11_forwarding: false,
      auto_reconnect: null,
      session_log: false,
      session_log_dir: null,
      proxy_jump: null,
      mac_address: null,
      wol_broadcast: null,
      wol_port: null,
      ssh_tunnels: [],
      created_at: now,
      updated_at: now,
    };

    let saved = false;
    try {
      await invoke("save_profile", { profile });
      profiles.push(profile);
      imported++;
      saved = true;
    } catch (err) {
      console.error("[import] save_profile failed for", node.name, err);
    }

    if (saved && importPw && node.encPassword) {
      try {
        // El descifrado depende de la fuente: mRemoteNG (AES-GCM en WebCrypto)
        // o Ásbrú (Blowfish/MD5 en el backend).
        const plain = importWizard.source === "asbru"
          ? await invoke("asbru_decrypt", { blob: node.encPassword })
          : await mrngDecryptGcm(node.encPassword, masterPw, importWizard.meta.kdfIterations);
        if (plain) {
          await saveStoredSecret(passwordKey(id), plain, "contraseña");
          withPw++;
        }
      } catch {
        pwFailed++;
      }
    }

    processed++;
    updateProgress(processed);
  }

  // Registra las carpetas (incluyendo las intermedias) en el workspace nuevo.
  const allFolders = new Set();
  for (const f of folderSet) {
    const parts = f.split("/");
    for (let i = 1; i <= parts.length; i++) allFolders.add(parts.slice(0, i).join("/"));
  }
  prefs.userFoldersByWorkspace[wsId] = [...allFolders];

  prefs.activeWorkspaceId = wsId;
  prefs.sidebarViewMode = "current";
  userFolders = new Set(prefs.userFoldersByWorkspace[wsId]);
  savePrefs();
  renderConnectionList();
  scheduleProfileAutoSync();

  // Restaura los controles del asistente para una posible reapertura.
  if (importBtn) importBtn.disabled = false;
  if (backBtn) backBtn.disabled = false;
  progressBox?.classList.add("hidden");
  closeImportWizard();

  let msg = t("import_wizard.done", { count: imported, workspace: wsName });
  if (importPw) msg += " " + t("import_wizard.done_passwords", { ok: withPw, failed: pwFailed });
  toast(msg, "success", 8000);
}

// ═══════════════════════════════════════════════════════════════
// ENLACE DE EVENTOS DE LA UI
// ═══════════════════════════════════════════════════════════════

function bindUIEvents() {
  // Bloquear el menú contextual nativo del WebView (Atrás, Recargar, Inspeccionar…).
  // Los menús de la app llaman a showContextMenu() y no dependen del default.
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && activeSessionId) clearTabActivity(activeSessionId);
  });

  // Botón flotante para salir del modo zen (también se sale con el atajo).
  document.getElementById("zen-exit-btn")?.addEventListener("click", () => applyZenMode(false));

  // Tabs del modal de conexión (General / Autenticación / Avanzado / Notas).
  document.querySelectorAll(".modal-tab").forEach((btn) => {
    btn.addEventListener("click", () => setConnectionModalPane(btn.dataset.modalTab));
  });

  // Validación inline y resumen reactivo del modal de conexión.
  const _connForm = document.getElementById("form-connection");
  if (_connForm) {
    _connForm.addEventListener("input", (e) => {
      if (e.target?.id) {
        if (["f-host", "f-port", "f-proxy-jump", "f-mac-address"].includes(e.target.id)) {
          validateConnectionField(e.target.id);
        }
      }
      renderConnectionSummary();
    });
    _connForm.addEventListener("change", () => renderConnectionSummary());
  }

  // Despliega/oculta la lista granular de algoritmos legacy al activar la opción.
  const legacyToggle = document.getElementById("f-allow-legacy");
  if (legacyToggle) {
    legacyToggle.addEventListener("change", async () => {
      const host = document.getElementById("legacy-algorithms-groups");
      if (legacyToggle.checked && host && !host.children.length) {
        await applyLegacyAlgorithmsUI(null);
      }
      updateLegacyAlgosVisibility();
    });
  }

  // Confirmación al activar el reenvío del agente SSH: es peligroso heredarlo
  // silenciosamente, así que solo se habilita tras aceptar el aviso de seguridad.
  const agentFwdToggle = document.getElementById("f-agent-forwarding");
  if (agentFwdToggle) {
    agentFwdToggle.addEventListener("change", async () => {
      if (!agentFwdToggle.checked) return;
      const ok = await confirmThemed({
        title: t("modal_conn.agent_forwarding_confirm_title"),
        message: t("modal_conn.agent_forwarding_confirm_message"),
        submitLabel: t("modal_conn.agent_forwarding_confirm_submit"),
        danger: true,
      });
      if (!ok) {
        // El usuario canceló: el toggle vuelve a quedar desactivado.
        agentFwdToggle.checked = false;
        renderConnectionSummary();
      }
    });
  }

  // Reemplazar todos los <select> nativos por el dropdown personalizado
  document.querySelectorAll("select").forEach(enhanceSelect);
  enhanceNumberSteppers();

  // Botón 🔍 → abre el popover y enfoca el buscador (atajo equivalente Ctrl+K)
  const searchBtn = document.getElementById("btn-sidebar-search");
  if (searchBtn) {
    searchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      focusConnectionSearch();
    });
  }

  // Botón ≡ → popover compacto con switcher + modos de vista + buscador
  const toolsBtn = document.getElementById("btn-sidebar-tools");
  const popover  = document.getElementById("sidebar-tools-popover");
  if (toolsBtn && popover) {
    toolsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSidebarTools();
    });
    popover.addEventListener("click", (e) => {
      const wsBtn = e.target.closest(".ws-item");
      if (wsBtn && !wsBtn.disabled) {
        handleWorkspaceMenuClick(wsBtn.dataset.wsAction, wsBtn.dataset.wsId);
        return;
      }
      const viewBtn = e.target.closest("[data-view-mode]");
      if (viewBtn) {
        setSidebarViewMode(viewBtn.dataset.viewMode);
        renderWorkspaceSwitcher();
        return;
      }
      const sortBtn = e.target.closest("[data-sort-mode]");
      if (sortBtn) {
        setConnectionSortMode(sortBtn.dataset.sortMode);
        renderWorkspaceSwitcher();
        return;
      }
      const densityBtn = e.target.closest("#btn-sidebar-compact");
      if (densityBtn) {
        setSidebarCompact(!prefs.sidebarCompact);
        renderWorkspaceSwitcher();
        return;
      }
      const foldersFirstBtn = e.target.closest("#btn-sidebar-folders-first");
      if (foldersFirstBtn) {
        setFoldersFirst(prefs.foldersFirst === false);
        renderWorkspaceSwitcher();
        return;
      }
    });
    document.addEventListener("click", (e) => {
      if (popover.classList.contains("hidden")) return;
      if (popover.contains(e.target) || toolsBtn.contains(e.target)) return;
      // Si el clic recae sobre una conexión de los resultados, no cierres el
      // popover de búsqueda: así la lista no se re-renderiza en el primer clic
      // y el doble clic para conectar puede completarse. El popover y el filtro
      // se cierran/limpian al conectar (connectProfile) o al clicar fuera de la
      // lista.
      if (e.target.closest(".conn-item")) return;
      toggleSidebarTools(false);
    });
  }

  // Búsqueda en la sidebar
  const sidebarSearch = document.getElementById("sidebar-search");
  if (sidebarSearch) {
    sidebarSearch.addEventListener("input", () => {
      _sidebarSearchQuery = sidebarSearch.value;
      renderConnectionList();
    });
    sidebarSearch.addEventListener("keydown", (e) => {
      const combo = comboFromEvent(e);
      const clearCombo = getShortcut("clear_sidebar_search");
      if (combo && clearCombo && combo === clearCombo) {
        clearSidebarSearch();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Enter") {
        const first = sidebarSearchCandidates(sidebarSearch.value)[0];
        if (first) {
          connectProfile(first.id);
          toggleSidebarTools(false);
          e.preventDefault();
        }
      }
    });
  }

  // Overflow de pestañas: botón ⋯ + popover con buscador, lista y teclado
  const tabOverflowBtn = document.getElementById("btn-tab-overflow");
  const tabOverflowPopover = document.getElementById("tab-overflow-popover");
  const tabOverflowSearch = document.getElementById("tab-overflow-search");
  if (tabOverflowBtn && tabOverflowPopover) {
    tabOverflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTabOverflow();
    });
    // Clic en una fila → activar esa pestaña y cerrar.
    document.getElementById("tab-overflow-list")?.addEventListener("click", (e) => {
      const item = e.target.closest(".tab-overflow-item");
      if (item) activateTabOverflowRow(item.dataset.session);
    });
    // Búsqueda con debounce ligero (mismo criterio que el resto del proyecto).
    tabOverflowSearch?.addEventListener("input", () => {
      clearTimeout(_tabOverflowSearchTimer);
      _tabOverflowSearchTimer = setTimeout(
        () => renderTabOverflowList(tabOverflowSearch.value), 120);
    });
    // Teclado: ↑/↓ navegar, Enter activar, Esc cerrar.
    tabOverflowSearch?.addEventListener("keydown", (e) => {
      const items = [...document.querySelectorAll("#tab-overflow-list .tab-overflow-item")];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length) {
          _tabOverflowIndex = (_tabOverflowIndex + 1) % items.length;
          highlightTabOverflowRow();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) {
          _tabOverflowIndex = (_tabOverflowIndex - 1 + items.length) % items.length;
          highlightTabOverflowRow();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        activateTabOverflowRow(items[_tabOverflowIndex]?.dataset.session);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        toggleTabOverflow(false);
        tabOverflowBtn.focus();
      }
    });
    // Cerrar al hacer clic fuera.
    document.addEventListener("click", (e) => {
      if (!tabOverflowPopover.classList.contains("hidden") &&
          !tabOverflowPopover.contains(e.target) &&
          !tabOverflowBtn.contains(e.target)) {
        toggleTabOverflow(false);
      }
    });
  }
  // Recalcular el overflow cuando cambia el tamaño de la ventana.
  window.addEventListener("resize", updateTabOverflowButton);

  // Botones de nueva conexión
  document.getElementById("btn-new-connection")
    ?.addEventListener("click", () => openNewConnectionModal());
  document.getElementById("home-tab")
    ?.addEventListener("click", () => selectHomeTab());
  document.getElementById("status-dot")
    ?.addEventListener("click", toggleActiveConnectionLogPanel);
  document.getElementById("status-dot")
    ?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleActiveConnectionLogPanel();
    });
  document.getElementById("status-log-trigger")
    ?.addEventListener("click", toggleActiveConnectionLogPanel);
  document.getElementById("dashboard-search")
    ?.addEventListener("input", () => renderDashboard());
  document.getElementById("dashboard-search")
    ?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = getDashboardCandidates(e.currentTarget.value.trim())[0]?.profile;
      if (first) connectProfile(first.id);
    });
  document.querySelectorAll("[data-dashboard-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.dashboardAction;
      if (action === "new-connection") openNewConnectionModal();
      else if (action === "local-shell") openLocalShell();
    });
  });
  document.getElementById("btn-activity-close")
    ?.addEventListener("click", closeActivityCenter);
  document.getElementById("activity-center-overlay")
    ?.addEventListener("click", (e) => {
      if (e.target.id === "activity-center-overlay") closeActivityCenter();
    });
  document.getElementById("btn-activity-clear")
    ?.addEventListener("click", () => {
      activityItems.length = 0;
      persistActivityHistory();
      renderActivityCenter();
    });
  document.querySelectorAll(".activity-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      _activityFilter = btn.dataset.activityFilter || "all";
      renderActivityCenter();
    });
  });
  // Barra de layouts para la vista múltiple
  document.querySelectorAll("#view-layout-bar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "broadcast") toggleBroadcast();
      else if (btn.dataset.layout) setViewLayout(btn.dataset.layout);
    });
  });

  // Botón de preferencias (⚙)
  document.getElementById("btn-settings")
    ?.addEventListener("click", openSettingsModal);
  document.getElementById("sidebar-sync-status")
    ?.addEventListener("click", () => {
      prefsActiveTab = "data";
      openSettingsModal();
    });

  // Botón de shell local ($_ )
  document.getElementById("btn-local-shell")
    ?.addEventListener("click", openLocalShell);

  // Rail vertical de iconos (acciones rápidas + cambio de vista)
  document.querySelectorAll("#rail [data-rail-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.railAction;
      if (action === "new-connection") openNewConnectionModal();
      else if (action === "local-shell") openLocalShell();
      else if (action === "tunnels") openGlobalTunnelsModal();
      else if (action === "activity") openActivityCenter();
      else if (action === "disconnect-all") disconnectAll();
      else if (action === "settings") openSettingsModal();
    });
  });
  document.querySelectorAll("#rail [data-rail-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.railView;
      if (view === "favorites") setSidebarViewMode("favorites");
      else setSidebarViewMode("current");
      updateRailActiveState();
    });
  });
  updateRailActiveState();

  // Toggle de la barra lateral (persistido en localStorage)
  initSidebarToggle();
  initSidebarResize();
  initSidebarScrollSpeed();

  // Controles de ventana (CSD): min / max / close + detección de plataforma
  initWindowControls();
  initCredentialModalEvents();
  initCommandEditor();
  initNoteEditor();
  initUiZoomControl();
  loadCommandHistory();
  initOsFileDrop();

  // ── Modal de preferencias ────────────────────────────────────
  document.getElementById("btn-prefs-close")
    .addEventListener("click", closeSettingsModal);
  document.getElementById("btn-prefs-cancel")
    .addEventListener("click", closeSettingsModal);
  document.getElementById("btn-prefs-save")
    .addEventListener("click", savePrefsFromModal);

  // Editor de reglas de resaltado
  document.getElementById("btn-highlight-add")
    ?.addEventListener("click", () => {
      const rules = readHighlightRulesFromEditor();
      rules.push({ pattern: "", color: "yellow", bold: false });
      prefs.highlightRules = rules; // estado intermedio sólo para re-render
      renderHighlightRulesEditor();
      // Foco en el input recién añadido
      const tbody = document.getElementById("highlight-rules-body");
      tbody?.querySelector("tr:last-child .hl-pattern")?.focus();
    });
  document.getElementById("highlight-rules-body")
    ?.addEventListener("click", (e) => {
      if (e.target.classList.contains("hl-delete")) {
        const tr = e.target.closest("tr[data-rule-idx]");
        tr?.remove();
      }
    });

  // Navegación entre secciones de Preferencias
  document.querySelectorAll(".prefs-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchPrefsTab(btn.dataset.prefsTab));
  });

  // Atajos de teclado: delegación sobre la lista
  const shortcutsList = document.getElementById("shortcuts-list");
  if (shortcutsList) {
    shortcutsList.addEventListener("click", (e) => {
      const row = e.target.closest(".shortcut-row");
      if (!row) return;
      const id = row.dataset.shortcutId;
      if (e.target.classList.contains("btn-shortcut-edit"))  startShortcutCapture(id, row);
      if (e.target.classList.contains("btn-shortcut-clear")) setShortcut(id, null);
      if (e.target.classList.contains("btn-shortcut-reset")) resetShortcut(id);
    });
  }
  document.getElementById("btn-shortcuts-export")
    ?.addEventListener("click", () => exportShortcuts());
  document.getElementById("btn-shortcuts-import")
    ?.addEventListener("click", () => importShortcuts());
  document.getElementById("btn-shortcuts-apply-preset")
    ?.addEventListener("click", () => applyShortcutPresetFromUi());

  // Acerca de: enlaces externos (pasan por el opener del sistema)
  document.querySelectorAll(".about-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = a.dataset.url;
      if (!url) return;
      invoke("plugin:opener|open_url", { url }).catch((err) =>
        toast(`No se pudo abrir ${url}: ${err}`, "error", 6000)
      );
    });
  });
  document.getElementById("btn-about-check-updates")
    ?.addEventListener("click", () => checkForUpdates());

  // Export / Import de tema actual
  document.getElementById("btn-export-theme")
    ?.addEventListener("click", () => exportCurrentTheme());
  document.getElementById("btn-export-theme-template")
    ?.addEventListener("click", () => exportThemeTemplate());
  document.getElementById("btn-import-theme")
    ?.addEventListener("click", () => importTheme());

  // Sincronización en la nube
  document.getElementById("sync-backend")
    ?.addEventListener("change", syncUpdateBackendVisibility);
  document.getElementById("btn-sync-local-browse")
    ?.addEventListener("click", () => syncBrowseLocalFolder());
  document.getElementById("btn-sync-local-open")
    ?.addEventListener("click", () => syncOpenLocalFolder());
  document.getElementById("btn-sync-icloud-open")
    ?.addEventListener("click", () => syncOpenBackendFolder());
  document.getElementById("btn-sync-test")
    ?.addEventListener("click", () => syncTestNow());
  document.getElementById("btn-sync-now")
    ?.addEventListener("click", () => syncRunNow());
  document.getElementById("btn-sync-export")
    ?.addEventListener("click", () => syncExportFile());
  document.getElementById("btn-sync-import")
    ?.addEventListener("click", () => syncImportFile());
  document.getElementById("btn-sync-oauth-connect")
    ?.addEventListener("click", () => syncOAuthConnectNow());
  document.getElementById("btn-sync-oauth-disconnect")
    ?.addEventListener("click", () => syncOAuthDisconnectNow());
  document.getElementById("btn-sync-snapshots-refresh")
    ?.addEventListener("click", () => refreshSyncSnapshots());
  document.getElementById("btn-sync-restore")
    ?.addEventListener("click", () => syncRestoreSnapshot());

  // KeePass
  document.getElementById("btn-keepass-browse")
    .addEventListener("click", () => browseKeepassPath());
  document.getElementById("btn-keepass-keyfile-browse")
    .addEventListener("click", () => browseKeepassKeyfile());
  document.getElementById("btn-keepass-unlock")
    .addEventListener("click", () => openKeepassUnlockModal());
  document.getElementById("btn-keepass-lock")
    .addEventListener("click", () => lockKeepass());
  document.getElementById("btn-keepass-close")
    .addEventListener("click", () => closeKeepassModal());
  document.getElementById("btn-keepass-modal-cancel")
    .addEventListener("click", () => closeKeepassModal());
  document.getElementById("form-keepass-unlock")
    .addEventListener("submit", (e) => { e.preventDefault(); submitKeepassUnlock(); });

  // Exportar / Importar
  document.getElementById("btn-export-all")
    .addEventListener("click", () => exportConnections(null));
  document.getElementById("btn-export-folder")
    .addEventListener("click", () => {
      const sel = document.getElementById("export-folder-select").value;
      if (!sel) { toast("Selecciona una carpeta primero", "warning"); return; }
      exportConnections(sel);
    });
  document.getElementById("btn-import")
    .addEventListener("click", () => importConnections());
  document.getElementById("btn-import-ssh-config")
    ?.addEventListener("click", () => importFromSshConfig());

  // Asistente de importación (mRemoteNG, Ásbrú, …)
  document.getElementById("btn-import-external")
    ?.addEventListener("click", () => openImportWizard());
  document.getElementById("btn-import-wizard-close")
    ?.addEventListener("click", () => closeImportWizard());
  document.getElementById("iw-pick-file")
    ?.addEventListener("click", () => importWizardPickFile());
  document.getElementById("iw-back")?.addEventListener("click", () => {
    if (importWizard.step > 1) setImportWizardStep(importWizard.step - 1);
  });
  document.getElementById("iw-next")?.addEventListener("click", () => {
    if (importWizard.step === 1) {
      if (!importWizard.tree) return;
      setImportWizardStep(2);
      renderImportWizardSelection();
    } else if (importWizard.step === 2) {
      setImportWizardStep(3);
    }
  });
  document.getElementById("iw-import")?.addEventListener("click", () => importWizardRun());
  document.getElementById("iw-validate-password")
    ?.addEventListener("click", () => importWizardValidatePassword());
  document.getElementById("iw-select-all")?.addEventListener("click", () => {
    document.querySelectorAll("#iw-tree input:not(:disabled)").forEach((c) => (c.checked = true));
    updateImportWizardCount();
  });
  document.getElementById("iw-select-none")?.addEventListener("click", () => {
    document.querySelectorAll("#iw-tree input").forEach((c) => (c.checked = false));
    updateImportWizardCount();
  });
  document.getElementById("iw-master-toggle")?.addEventListener("click", () => {
    const inp = document.getElementById("iw-master-password");
    const btn = document.getElementById("iw-master-toggle");
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", show ? "true" : "false");
  });
  document.getElementById("import-wizard-overlay")?.addEventListener("mousedown", (e) => {
    if (e.target?.id === "import-wizard-overlay") closeImportWizard();
  });

  // Logs de sesión: retención
  document.getElementById("btn-session-logs-prune")
    ?.addEventListener("click", () => sessionLogsPruneNow());
  document.getElementById("btn-session-logs-open")
    ?.addEventListener("click", () => sessionLogsOpenFolder());

  // Gestor de known_hosts
  document.getElementById("btn-manage-known-hosts")
    ?.addEventListener("click", () => openKnownHostsModal());
  document.getElementById("btn-known-hosts-close")
    ?.addEventListener("click", closeKnownHostsModal);
  document.getElementById("known-hosts-overlay")
    ?.addEventListener("mousedown", (e) => {
      if (e.target.id === "known-hosts-overlay") closeKnownHostsModal();
    });
  document.getElementById("known-hosts-modal")
    ?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-known-host-action]");
      if (!btn) return;
      const row = btn.closest(".global-tunnel-row");
      if (btn.dataset.knownHostAction === "remove") {
        removeKnownHostLine(Number(row.dataset.line));
      }
    });

  // Credenciales (Preferencias → Credenciales): master / var / secret
  document.getElementById("btn-cred-add")
    ?.addEventListener("click", () => openCredEditModal(null));
  document.getElementById("cred-filter")
    ?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cred-filter]");
      if (!btn) return;
      _credFilter = btn.dataset.credFilter;
      document.querySelectorAll("#cred-filter [data-cred-filter]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      renderCredList();
    });
  document.getElementById("cred-list")
    ?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-cred-action]");
      if (!btn) return;
      const row = btn.closest("[data-cred-id]");
      if (!row) return;
      const id = row.dataset.credId;
      const name = row.dataset.credName;
      const kind = row.dataset.credKind || "master";
      const action = btn.dataset.credAction;
      if (action === "copy") copyCredVar(kind, name);
      else if (action === "edit") {
        // Recargamos el catálogo para obtener el valor (solo variables lo traen).
        let cred = { id, name, kind, description: "" };
        try {
          const all = await invoke("master_cred_list");
          const found = (all || []).find((c) => c.id === id);
          if (found) cred = found;
        } catch {}
        openCredEditModal(cred);
      } else if (action === "delete") deleteCred(id);
    });
  document.getElementById("cred-edit-form")
    ?.addEventListener("submit", submitCredEdit);
  document.getElementById("cred-edit-name")
    ?.addEventListener("input", updateCredVarPreview);
  document.getElementById("cred-edit-kind")
    ?.addEventListener("change", (e) => {
      applyCredKindMode(e.target.value);
      updateCredVarPreview();
    });
  document.getElementById("btn-cred-edit-toggle")
    ?.addEventListener("click", toggleCredValueVisibility);
  document.getElementById("btn-cred-edit-close")
    ?.addEventListener("click", closeCredEditModal);
  document.getElementById("btn-cred-edit-cancel")
    ?.addEventListener("click", closeCredEditModal);
  document.getElementById("cred-edit-overlay")
    ?.addEventListener("mousedown", (e) => {
      if (e.target.id === "cred-edit-overlay") closeCredEditModal();
    });

  // Snippets, comandos locales, plantillas y paleta de comandos.
  initCommandsAndPalette();

  // Diálogo de preguntas al conectar (${ask:})
  document.getElementById("ask-modal-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      closeAskPrompt(collectAskAnswers());
    });
  document.getElementById("btn-ask-cancel")
    ?.addEventListener("click", () => closeAskPrompt(null));
  document.getElementById("btn-ask-close")
    ?.addEventListener("click", () => closeAskPrompt(null));
  document.getElementById("ask-modal-overlay")
    ?.addEventListener("mousedown", (e) => {
      if (e.target.id === "ask-modal-overlay") closeAskPrompt(null);
    });

  // Diálogo «Duplicar sesión con cambios»
  document.getElementById("dup-modal-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      closeDupPrompt(collectDupOverridesForm());
    });
  document.getElementById("btn-dup-cancel")
    ?.addEventListener("click", () => closeDupPrompt(null));
  document.getElementById("btn-dup-close")
    ?.addEventListener("click", () => closeDupPrompt(null));
  document.getElementById("dup-modal-overlay")
    ?.addEventListener("mousedown", (e) => {
      if (e.target.id === "dup-modal-overlay") closeDupPrompt(null);
    });
  // La fila de la ruta de clave solo se muestra con auth "Clave privada".
  document.getElementById("dup-ov-auth")
    ?.addEventListener("change", (e) => {
      document.getElementById("dup-ov-key-row")
        ?.classList.toggle("hidden", e.target.value !== "public_key");
    });

  // Panel global de túneles SSH
  document.getElementById("btn-global-tunnels-close")
    ?.addEventListener("click", closeGlobalTunnelsModal);
  document.getElementById("global-tunnels-overlay")
    ?.addEventListener("mousedown", (e) => {
      if (e.target.id === "global-tunnels-overlay") closeGlobalTunnelsModal();
    });
  document.getElementById("global-tunnel-type")
    ?.addEventListener("change", updateGlobalTunnelFields);
  document.getElementById("global-tunnel-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!e.currentTarget.checkValidity()) {
        e.currentTarget.reportValidity();
        return;
      }
      startGlobalTunnelFromForm();
    });
  document.getElementById("global-tunnels-modal")
    ?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-global-tunnel-action]");
      if (!btn) return;
      const row = btn.closest(".global-tunnel-row");
      const action = btn.dataset.globalTunnelAction;
      if (action === "stop-active") {
        stopSshTunnel(row.dataset.sessionId, row.dataset.tunnelId);
      } else if (action === "start-saved") {
        startSavedGlobalTunnel(row.dataset.profileId, row.dataset.tunnelId);
      } else if (action === "delete-saved") {
        deleteSavedGlobalTunnel(row.dataset.profileId, row.dataset.tunnelId);
      }
    });

  // Selector de tema de UI: sincronizar .selected con el radio + preview en vivo
  document.querySelectorAll('input[name="pref-theme"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      selectUiTheme(radio.value);
    });
  });

  // Selector de tema del terminal: preview aplica sólo a los terminales
  document.querySelectorAll('input[name="pref-terminal-theme"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      selectTerminalTheme(radio.value);
    });
  });

  // Vista previa en vivo de tipografía: font-size, line-height, letter-spacing.
  // El revert por cancelación lo hace closeSettingsModal con _typographySnapshot.
  const wireTypographyPreview = (id, prop, parser, guard) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      const raw = parser(el.value);
      if (!Number.isFinite(raw)) return;
      const val = guard ? guard(raw) : raw;
      prefs[prop] = val;
      applyPrefsToAllTerminals();
    });
  };
  wireTypographyPreview("pref-font-size",      "fontSize",      (v) => parseInt(v, 10), (v) => Math.max(8, Math.min(32, v)));
  wireTypographyPreview("pref-line-height",    "lineHeight",    (v) => parseFloat(v),   (v) => Math.max(0.5, Math.min(3, v)));
  wireTypographyPreview("pref-letter-spacing", "letterSpacing", (v) => parseFloat(v));

  const fontFamilySel = document.getElementById("pref-font-family");
  if (fontFamilySel) {
    fontFamilySel.addEventListener("change", () => {
      prefs.fontFamily = fontFamilySel.value || "";
      applyPrefsToAllTerminals();
    });
  }

  const bellSel = document.getElementById("pref-bell");
  if (bellSel) {
    bellSel.addEventListener("change", () => previewBellStyle(bellSel.value));
  }

  // Cerrar modal de conexión
  document.getElementById("btn-modal-close").addEventListener("click", closeModal);
  document.getElementById("btn-modal-cancel").addEventListener("click", closeModal);

  // Tipo de conexión → ajustar campos y puerto
  document.getElementById("f-conn-type").addEventListener("change", (e) =>
    updateConnTypeFields(e.target.value, true)
  );

  // Tipo de auth → actualizar campos (solo relevante en SSH)
  document.getElementById("f-auth-type").addEventListener("change", (e) =>
    updateAuthFields(e.target.value)
  );

  // Selector de origen de la contraseña (own/master/keepass). Sincroniza el
  // checkbox histórico f-use-keepass y refresca los campos visibles.
  document.getElementById("f-password-source").addEventListener("change", (e) => {
    setPasswordSource(e.target.value);
    updateAuthFields(document.getElementById("f-auth-type").value);
    renderConnectionSummary();
  });

  // Selector avanzado KeePass: abrir/cerrar + filtrar + seleccionar
  const kpSearch = document.getElementById("f-keepass-search");
  const kpList   = document.getElementById("keepass-picker-list");
  const kpClear  = document.getElementById("btn-keepass-clear");
  const kpPicker = document.getElementById("keepass-picker");
  if (kpSearch && kpList && kpPicker) {
    kpSearch.addEventListener("focus", () => openKeepassPicker());
    kpSearch.addEventListener("input", () => {
      // Al teclear, el usuario está filtrando: la selección previa queda invalidada.
      document.getElementById("f-keepass-entry").value = "";
      if (kpClear) kpClear.classList.add("hidden");
      openKeepassPicker();
      updateKeepassEntryValidation();
    });
    kpSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeKeepassPicker();
      } else if (e.key === "Enter") {
        const first = kpList.querySelector(".keepass-picker-item");
        if (first) {
          e.preventDefault();
          selectKeepassEntry(first.dataset.uuid);
        }
      }
    });
    kpList.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".keepass-picker-item");
      if (!item) return;
      // mousedown (en vez de click) para no perder el foco antes de procesar.
      e.preventDefault();
      selectKeepassEntry(item.dataset.uuid);
    });
    document.addEventListener("mousedown", (e) => {
      if (!kpPicker.contains(e.target)) closeKeepassPicker();
    });
  }
  if (kpClear) {
    kpClear.addEventListener("click", () => {
      populateKeepassEntrySelect(null);
    });
  }
  document.getElementById("f-keepass-property")?.addEventListener("change", () =>
    updateKeepassEntryValidation()
  );

  document.getElementById("btn-toggle-password").addEventListener("click", () => {
    const input = document.getElementById("f-password");
    setPasswordVisible(input.type === "password");
    input.focus();
  });
  document.getElementById("btn-add-extra-cred")?.addEventListener("click", () => addExtraCredRow());
  initConnectionModalResizePersistence();

  // Selector de carpeta → mostrar/ocultar input manual
  document.getElementById("f-folder-select").addEventListener("change", (e) => {
    const input = document.getElementById("f-folder-input");
    input.classList.toggle("hidden", e.target.value !== "__new__");
    if (e.target.value === "__new__") input.focus();
  });
  document.getElementById("f-workspace")?.addEventListener("change", (e) => {
    populateFolderSelect(readFolderValue(), e.target.value || getActiveWorkspaceId());
  });

  // Botones del modal
  document.getElementById("btn-modal-test")?.addEventListener("click", runConnectionTestFromModal);
  // "Guardar y conectar" es un botón explícito (no el submit por defecto), para
  // que al pulsar Intro en el formulario solo se GUARDE, sin conectar.
  document.getElementById("btn-modal-save-connect").addEventListener("click", () => {
    const form = document.getElementById("form-connection");
    if (!form.checkValidity()) {
      revealFirstInvalidPane(form);
      form.reportValidity();
      return;
    }
    saveAndClose(true);
  });
  // Submit del formulario (botón "Guardar", que es el por defecto, o Intro) →
  // guardar sin conectar.
  document.getElementById("form-connection").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      revealFirstInvalidPane(form);
      form.reportValidity();
      return;
    }
    saveAndClose(false);
  });

  // ── Menú contextual ──────────────────────────────────────

  // Clic derecho en el sidebar (delegación de eventos)
  document.getElementById("connection-list").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const connItem   = e.target.closest(".conn-item");
    const folderHeader = e.target.closest(".folder-header");

    if (connItem) {
      const profile = profiles.find((p) => p.id === connItem.dataset.id);
      showContextMenu(e.clientX, e.clientY, "connection", connItem.dataset.id, profile?.group ?? null);
    } else if (folderHeader) {
      const folderItem = folderHeader.closest(".folder-item");
      const wsRoot = folderItem.dataset.wsRoot;
      if (wsRoot) {
        showContextMenu(e.clientX, e.clientY, "workspace", null, null, { workspaceId: wsRoot });
      } else {
        showContextMenu(e.clientX, e.clientY, "folder", null, folderItem.dataset.folderPath, {
          workspaceId: workspaceForElement(folderItem),
        });
      }
    } else {
      showContextMenu(e.clientX, e.clientY, "sidebar");
    }
  });

  // Clic derecho en la cabecera del sidebar (zona logo + botón)
  document.getElementById("sidebar-header").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, "sidebar");
  });

  // Acciones del menú contextual
  document.getElementById("context-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ctx]");
    if (!btn) return;
    if (btn.dataset.ctx === "connect-as") {
      const credId = btn.dataset.credId;
      const profileId = ctxTarget.id;
      hideContextMenu();
      if (profileId && credId) connectProfileAs(profileId, credId);
      return;
    }
    if (btn.dataset.ctx === "set-folder-color") {
      const colorId = btn.dataset.colorId || null;
      const { type, folderPath, workspaceId } = ctxTarget;
      hideContextMenu();
      const nextColor = colorId === "none" ? null : colorId;
      if (type === "workspace" && workspaceId) {
        setWorkspaceColor(workspaceId, nextColor);
      } else if (folderPath) {
        setFolderColor(folderPath, nextColor, workspaceId || getActiveWorkspaceId());
      }
      return;
    }
    handleContextMenuAction(btn.dataset.ctx);
  });

  // Clic derecho en una pestaña
  document.getElementById("tabs-container").addEventListener("contextmenu", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    e.preventDefault();
    // Usa la sesión primaria del workspace (guardada en dataset.session)
    showTabContextMenu(e.clientX, e.clientY, tab.dataset.session);
  });

  document.getElementById("tab-context-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tabctx]");
    if (btn) handleTabContextAction(btn.dataset.tabctx);
  });

  document.getElementById("sftp-context-menu")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sftpctx]");
    if (!btn || btn.disabled) return;
    handleSftpContextMenuAction(btn.dataset.sftpctx);
  });

  // Cerrar los menús contextuales al hacer clic fuera de ellos
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("context-menu");
    if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
      hideContextMenu();
    }
    const tabMenu = document.getElementById("tab-context-menu");
    if (!tabMenu.classList.contains("hidden") && !tabMenu.contains(e.target)) {
      hideTabContextMenu();
    }
    const sftpMenu = document.getElementById("sftp-context-menu");
    if (sftpMenu && !sftpMenu.classList.contains("hidden") && !sftpMenu.contains(e.target)) {
      hideSftpContextMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const credentialOverlay = document.getElementById("credential-modal-overlay");
      if (credentialOverlay && !credentialOverlay.classList.contains("hidden")) {
        closeCredentialPrompt(null);
        e.preventDefault();
        return;
      }
      if (isCredEditModalOpen()) {
        closeCredEditModal();
        e.preventDefault();
        return;
      }
      const dupOverlay = document.getElementById("dup-modal-overlay");
      if (dupOverlay && !dupOverlay.classList.contains("hidden")) {
        closeDupPrompt(null);
        e.preventDefault();
        return;
      }
      if (isGlobalTunnelsModalOpen()) {
        closeGlobalTunnelsModal();
        e.preventDefault();
        return;
      }
      closeModal();
      closeSettingsModal();
      hideContextMenu();
      hideTabContextMenu();
      hideSftpContextMenu();
    }
  });

  // Atajos de teclado globales (capture phase para preempt a xterm)
  document.addEventListener("keydown", handleGlobalShortcut, { capture: true });
  // Ctrl+Rueda → zoom del terminal. passive:false para poder preventDefault y
  // así evitar el zoom de la WebView. capture para ganarle a xterm.
  document.addEventListener("wheel", handleZoomWheel, { capture: true, passive: false });
}

// ═══════════════════════════════════════════════════════════════
// ATAJOS DE TECLADO
// ═══════════════════════════════════════════════════════════════
//
// Registro central de acciones con atajo. Los defaults se fusionan con
// prefs.shortcuts[id] (null = desactivado, string = accelerator tipo
// "Ctrl+Shift+N"). Las teclas se codifican con keyLabelFromCode() para
// evitar la ambigüedad de e.key por layout/locale.

/* ════════════════════════════════════════════════════════════════════════
   Plantillas de perfil · Snippets remotos · Comandos locales · Paleta global
   Comparten el motor de sustitución ${...} (subst.substituteWith) para
   resolver internos, ${var:nombre} (catálogo) y ${ask:Etiqueta} (diálogo).
   ════════════════════════════════════════════════════════════════════════ */

/** Fecha local YYYY-MM-DD (espejo del motor Rust). */
function substLocalDate() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
/** Hora local HH:MM:SS. */
function substLocalTime() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${mi}:${s}`;
}

/** Contexto de internos a partir de la sesión/perfil activos. */
function activeSubstContext() {
  const pid = activeProfileId();
  const profile = pid ? profiles.find((p) => p.id === pid) : null;
  let workspace = "";
  if (profile?.workspace_id) {
    workspace = (prefs.workspaces || []).find((w) => w.id === profile.workspace_id)?.name || "";
  }
  return {
    host: profile?.host || "",
    port: profile?.port != null ? String(profile.port) : "",
    user: profile?.username || "",
    profileName: profile?.name || "",
    workspace,
  };
}

/** Lee las variables (kind "var") del catálogo de credenciales en un mapa. */
async function loadSubstVarMap() {
  try {
    const creds = await invoke("master_cred_list");
    const map = {};
    for (const c of creds || []) {
      if (c.kind === "var" && typeof c.value === "string") map[c.name] = c.value;
    }
    return map;
  } catch {
    return {};
  }
}

/** Recolecta los `${ask:Etiqueta|op1|op2}` distintos de un texto. */
function collectAskSpecs(text) {
  const specs = [];
  const seen = new Set();
  substituteWith(String(text || ""), (body) => {
    if (body.startsWith("ask:")) {
      const parts = body.slice(4).split("|");
      const label = parts[0];
      if (label && !seen.has(label)) {
        seen.add(label);
        specs.push({ label, options: parts.slice(1) });
      }
    }
    return null;
  });
  return specs;
}

/** Resuelve un cuerpo `${...}` para snippets/comandos. null = dejar literal. */
function resolveCommandBody(body, ctx, varMap, askMap) {
  switch (body) {
    case "host": return ctx.host;
    case "port": return ctx.port;
    case "user": return ctx.user;
    case "profileName": return ctx.profileName;
    case "workspace": return ctx.workspace;
    case "date": return substLocalDate();
    case "time": return substLocalTime();
  }
  const idx = body.indexOf(":");
  if (idx < 0) return null;
  const prefix = body.slice(0, idx);
  const rest = body.slice(idx + 1);
  if (prefix === "var") {
    return Object.prototype.hasOwnProperty.call(varMap, rest) ? varMap[rest] : null;
  }
  if (prefix === "ask") {
    const label = rest.split("|")[0];
    return Object.prototype.hasOwnProperty.call(askMap, label) ? askMap[label] : null;
  }
  // env/secret/master/cmd: no se resuelven en cliente; quedan literales.
  return null;
}

/**
 * Resuelve un texto de snippet/comando: pide los `${ask:}` pendientes y sustituye
 * internos + `${var:}`. Devuelve la cadena resuelta, o `null` si el usuario
 * cancela el diálogo de preguntas.
 */
async function resolveCommandText(text) {
  const specs = collectAskSpecs(text);
  let askMap = {};
  if (specs.length) {
    askMap = await promptAsks(specs);
    if (askMap === null) return null;
  }
  const varMap = await loadSubstVarMap();
  const ctx = activeSubstContext();
  return substituteWith(String(text || ""), (body) => resolveCommandBody(body, ctx, varMap, askMap));
}

/* ── Plantillas de perfil ──────────────────────────────────────────────── */

// Catálogo de plantillas integradas. `defaults` es un perfil parcial que se
// vuelca sobre el formulario de nueva conexión.
const PROFILE_TEMPLATES = [
  { id: "linux-ssh",   nameKey: "templates.linux_ssh",   defaults: { connection_type: "ssh", port: 22, auth_type: "password" } },
  { id: "ssh-key",     nameKey: "templates.ssh_key",     defaults: { connection_type: "ssh", port: 22, auth_type: "public_key" } },
  { id: "bastion",     nameKey: "templates.bastion",     defaults: { connection_type: "ssh", port: 22, auth_type: "public_key", proxy_jump: "usuario@bastion:22" } },
  { id: "ssh-legacy",  nameKey: "templates.ssh_legacy",  defaults: { connection_type: "ssh", port: 22, auth_type: "password", allow_legacy: true } },
  { id: "rdp-windows", nameKey: "templates.rdp_windows", defaults: { connection_type: "rdp", port: 3389, auth_type: "password" } },
  { id: "ftps",        nameKey: "templates.ftps",        defaults: { connection_type: "ftps", port: 21, auth_type: "password" } },
];

function isProfileTemplate(id) {
  return (prefs.templateProfileIds || []).includes(id);
}

function toggleProfileTemplate(id) {
  if (!id) return;
  prefs.templateProfileIds = prefs.templateProfileIds || [];
  const idx = prefs.templateProfileIds.indexOf(id);
  if (idx >= 0) {
    prefs.templateProfileIds.splice(idx, 1);
    toast(t("templates.toast_unmarked"), "info");
  } else {
    prefs.templateProfileIds.push(id);
    toast(t("templates.toast_marked"), "success");
  }
  savePrefs();
}

/** Rellena el `<select>` de plantilla del modal de conexión. */
function populateTemplateSelect() {
  const sel = document.getElementById("f-template");
  if (!sel) return;
  const builtin = PROFILE_TEMPLATES
    .map((tpl) => `<option value="builtin:${escHtml(tpl.id)}">${escHtml(t(tpl.nameKey))}</option>`)
    .join("");
  const userTpls = (prefs.templateProfileIds || [])
    .map((pid) => profiles.find((p) => p.id === pid))
    .filter(Boolean);
  const userOpts = userTpls.length
    ? `<optgroup label="${escHtml(t("templates.from_profiles"))}">` +
        userTpls.map((p) => `<option value="profile:${escHtml(p.id)}">${escHtml(p.name)}</option>`).join("") +
      `</optgroup>`
    : "";
  sel.innerHTML =
    `<option value="">${escHtml(t("templates.field_none"))}</option>` +
    `<optgroup label="${escHtml(t("templates.builtin"))}">${builtin}</optgroup>` +
    userOpts;
  sel.value = "";
}

/** Aplica al formulario los valores de la plantilla elegida. */
function applyProfileTemplate(value) {
  if (!value) return;
  let defaults = null;
  if (value.startsWith("builtin:")) {
    const tpl = PROFILE_TEMPLATES.find((x) => x.id === value.slice(8));
    if (tpl) defaults = tpl.defaults;
  } else if (value.startsWith("profile:")) {
    const p = profiles.find((x) => x.id === value.slice(8));
    if (p) defaults = profileToTemplateDefaults(p);
  }
  if (defaults) applyTemplateDefaultsToForm(defaults);
}

function profileToTemplateDefaults(p) {
  return {
    connection_type: p.connection_type || "ssh",
    port: p.port,
    username: p.username || "",
    domain: p.domain || "",
    auth_type: p.auth_type || "password",
    proxy_jump: p.proxy_jump || "",
    keep_alive_secs: p.keep_alive_secs,
    auto_reconnect: p.auto_reconnect,
    allow_legacy: !!p.allow_legacy_algorithms,
    agent_forwarding: !!p.agent_forwarding,
    x11_forwarding: !!p.x11_forwarding,
    session_log: !!p.session_log,
  };
}

function applyTemplateDefaultsToForm(d) {
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
  if (d.connection_type) {
    const ct = document.getElementById("f-conn-type");
    if (ct) { ct.value = d.connection_type; updateConnTypeFields(d.connection_type); }
  }
  if (d.port != null) setVal("f-port", d.port);
  if (d.username != null) setVal("f-user", d.username);
  if (d.domain != null) setVal("f-domain", d.domain);
  if (d.auth_type) {
    const at = document.getElementById("f-auth-type");
    if (at) { at.value = d.auth_type; updateAuthFields(d.auth_type); }
  }
  if (d.proxy_jump != null) setVal("f-proxy-jump", d.proxy_jump);
  if (d.keep_alive_secs != null) setVal("f-keep-alive", d.keep_alive_secs);
  if (d.auto_reconnect != null) setVal("f-auto-reconnect", d.auto_reconnect);
  setChk("f-allow-legacy", d.allow_legacy);
  document.getElementById("f-allow-legacy")?.dispatchEvent(new Event("change"));
  setChk("f-x11-forwarding", d.x11_forwarding);
  setChk("f-session-log", d.session_log);
  renderConnectionSummary();
}

/** Abre el modal de nueva conexión y enfoca el selector de plantilla. */
function openNewConnectionFromTemplate() {
  openNewConnectionModal();
  setTimeout(() => document.getElementById("f-template")?.focus(), 0);
}

/* ── Snippets remotos ──────────────────────────────────────────────────── */

function loadSnippets() {
  return sync.loadLocalSnippets();
}

function snippetById(id) {
  return loadSnippets().find((s) => s.id === id) || null;
}

function snippetSort(a, b) {
  const ga = (a.group || "").toLowerCase();
  const gb = (b.group || "").toLowerCase();
  if (ga !== gb) return ga < gb ? -1 : 1;
  return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1;
}

function renderSnippetList() {
  const list = document.getElementById("snippet-list");
  if (!list) return;
  const snippets = loadSnippets().slice().sort(snippetSort);
  if (!snippets.length) {
    list.innerHTML = `<div class="tunnel-empty">${escHtml(t("prefs_commands.snippets_empty"))}</div>`;
    return;
  }
  list.innerHTML = snippets.map((s) => {
    const meta = [s.group, s.description].filter(Boolean).join(" · ");
    const sub = meta ? `<span class="cred-desc" title="${escHtml(meta)}">${escHtml(meta)}</span>` : "";
    return `
      <div class="cred-row" data-snippet-id="${escHtml(s.id)}">
        <div class="cred-row-top">
          <span class="cred-name" title="${escHtml(s.name)}">${escHtml(s.name)}</span>
          ${sub}
          <span class="cred-row-actions">
            <button type="button" class="global-tunnel-action" data-snippet-action="run">${escHtml(t("prefs_commands.insert"))}</button>
            <button type="button" class="global-tunnel-action" data-snippet-action="edit">${escHtml(t("prefs_commands.edit"))}</button>
            <button type="button" class="global-tunnel-action danger" data-snippet-action="delete">${escHtml(t("prefs_commands.delete"))}</button>
          </span>
        </div>
        <div class="cmd-row-preview">${escHtml(s.command || "")}</div>
      </div>`;
  }).join("");
}

/** Sesión activa con terminal donde insertar texto (SSH o consola local). */
function activeTerminalSession() {
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  if (s && s.terminal && s.status !== "closed" && s.type !== "rdp") return s;
  return null;
}

async function runSnippet(snippet) {
  if (!snippet) return;
  const target = activeTerminalSession();
  if (!target) {
    toast(t("prefs_commands.toast_no_session"), "warning");
    return;
  }
  if (snippet.confirm) {
    const ok = await confirmThemed({
      title: t("prefs_commands.confirm_insert_title"),
      message: snippet.name,
      submitLabel: t("prefs_commands.insert"),
    });
    if (!ok) return;
  }
  const resolved = await resolveCommandText(snippet.command || "");
  if (resolved === null) return;
  sendTerminalInput(target, snippet.sendEnter ? resolved + "\r" : resolved);
  target.terminal?.focus();
}

let _editingSnippetId = null;

function openSnippetEditor(snippet) {
  _editingSnippetId = snippet ? snippet.id : null;
  document.getElementById("snippet-edit-title").textContent =
    snippet ? t("modal_snippet.title_edit") : t("modal_snippet.title_new");
  document.getElementById("snippet-edit-name").value = snippet?.name || "";
  document.getElementById("snippet-edit-group").value = snippet?.group || "";
  document.getElementById("snippet-edit-desc").value = snippet?.description || "";
  document.getElementById("snippet-edit-command").value = snippet?.command || "";
  document.getElementById("snippet-edit-enter").checked = !!snippet?.sendEnter;
  document.getElementById("snippet-edit-confirm").checked = !!snippet?.confirm;
  document.getElementById("snippet-edit-overlay").classList.remove("hidden");
  setTimeout(() => document.getElementById("snippet-edit-name").focus(), 0);
}

function closeSnippetEditor() {
  document.getElementById("snippet-edit-overlay")?.classList.add("hidden");
  _editingSnippetId = null;
}

function submitSnippetEditor(e) {
  e.preventDefault();
  const name = document.getElementById("snippet-edit-name").value.trim();
  const command = document.getElementById("snippet-edit-command").value;
  if (!name || !command.trim()) return;
  const snippet = {
    id: _editingSnippetId || crypto.randomUUID(),
    name,
    group: document.getElementById("snippet-edit-group").value.trim(),
    description: document.getElementById("snippet-edit-desc").value.trim(),
    command,
    sendEnter: document.getElementById("snippet-edit-enter").checked,
    confirm: document.getElementById("snippet-edit-confirm").checked,
    updated_at: new Date().toISOString(),
  };
  sync.upsertLocalSnippet(snippet);
  closeSnippetEditor();
  renderSnippetList();
  scheduleProfileAutoSync();
}

async function deleteSnippetById(id) {
  const s = snippetById(id);
  const ok = await confirmThemed({
    title: t("prefs_commands.delete_snippet_title"),
    message: s?.name || "",
    submitLabel: t("prefs_commands.delete"),
    danger: true,
  });
  if (!ok) return;
  sync.deleteLocalSnippet(id);
  sync.recordTombstone(prefs, "snippets", id);
  savePrefs();
  renderSnippetList();
  scheduleProfileAutoSync();
}

/* ── Comandos locales (no sincronizados: pueden depender del equipo) ────── */

const LOCAL_CMDS_KEY = "rustty-local-commands";

function loadLocalCommands() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_CMDS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveLocalCommandsList(list) {
  localStorage.setItem(LOCAL_CMDS_KEY, JSON.stringify(list));
}
function localCommandById(id) {
  return loadLocalCommands().find((c) => c.id === id) || null;
}
function upsertLocalCommand(cmd) {
  const list = loadLocalCommands();
  const idx = list.findIndex((c) => c.id === cmd.id);
  if (idx >= 0) list[idx] = cmd;
  else list.push(cmd);
  saveLocalCommandsList(list);
}
function deleteLocalCommandById(id) {
  saveLocalCommandsList(loadLocalCommands().filter((c) => c.id !== id));
}
function localCommandTypeLabel(type) {
  return t("modal_localcmd.type_" + (type || "shell"));
}

function renderLocalCommandList() {
  const list = document.getElementById("localcmd-list");
  if (!list) return;
  const cmds = loadLocalCommands().slice()
    .sort((a, b) => ((a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1));
  if (!cmds.length) {
    list.innerHTML = `<div class="tunnel-empty">${escHtml(t("prefs_commands.localcmds_empty"))}</div>`;
    return;
  }
  list.innerHTML = cmds.map((c) => {
    const meta = c.description ? `<span class="cred-desc" title="${escHtml(c.description)}">${escHtml(c.description)}</span>` : "";
    const badge = `<span class="cred-kind-badge">${escHtml(localCommandTypeLabel(c.type))}</span>`;
    return `
      <div class="cred-row" data-localcmd-id="${escHtml(c.id)}">
        <div class="cred-row-top">
          <span class="cred-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
          ${badge}
          ${meta}
          <span class="cred-row-actions">
            <button type="button" class="global-tunnel-action" data-localcmd-action="run">${escHtml(t("prefs_commands.run"))}</button>
            <button type="button" class="global-tunnel-action" data-localcmd-action="edit">${escHtml(t("prefs_commands.edit"))}</button>
            <button type="button" class="global-tunnel-action danger" data-localcmd-action="delete">${escHtml(t("prefs_commands.delete"))}</button>
          </span>
        </div>
        <div class="cmd-row-preview">${escHtml(c.command || "")}</div>
      </div>`;
  }).join("");
}

async function runLocalCommand(cmd) {
  if (!cmd) return;
  if (cmd.confirm) {
    const ok = await confirmThemed({
      title: t("prefs_commands.confirm_run_title"),
      message: cmd.name,
      submitLabel: t("prefs_commands.run"),
      danger: cmd.type === "shell",
    });
    if (!ok) return;
  }
  const resolved = await resolveCommandText(cmd.command || "");
  if (resolved === null) return;
  const value = resolved.trim();
  if (!value) return;
  try {
    if (cmd.type === "url") {
      await invoke("plugin:opener|open_url", { url: value });
      toast(t("prefs_commands.toast_opened"), "success");
    } else if (cmd.type === "path") {
      await invoke("plugin:opener|open_path", { path: value });
      toast(t("prefs_commands.toast_opened"), "success");
    } else {
      const out = await invoke("run_local_command", { command: value });
      if (out && out.code === 0) {
        toast(t("prefs_commands.toast_ran").replace("{name}", cmd.name), "success");
      } else {
        const detail = (out?.stderr || out?.stdout || "").trim().slice(0, 200);
        toast(
          t("prefs_commands.toast_ran_error").replace("{code}", String(out?.code ?? "?")) +
            (detail ? ": " + detail : ""),
          "error",
          6000
        );
      }
    }
  } catch (err) {
    toast(String(err), "error");
  }
}

let _editingLocalCmdId = null;

function openLocalCmdEditor(cmd) {
  _editingLocalCmdId = cmd ? cmd.id : null;
  document.getElementById("localcmd-edit-title").textContent =
    cmd ? t("modal_localcmd.title_edit") : t("modal_localcmd.title_new");
  document.getElementById("localcmd-edit-name").value = cmd?.name || "";
  document.getElementById("localcmd-edit-type").value = cmd?.type || "shell";
  document.getElementById("localcmd-edit-command").value = cmd?.command || "";
  document.getElementById("localcmd-edit-desc").value = cmd?.description || "";
  document.getElementById("localcmd-edit-confirm").checked = cmd ? !!cmd.confirm : true;
  updateLocalCmdTypeUi();
  document.getElementById("localcmd-edit-overlay").classList.remove("hidden");
  setTimeout(() => document.getElementById("localcmd-edit-name").focus(), 0);
}

function updateLocalCmdTypeUi() {
  const type = document.getElementById("localcmd-edit-type").value;
  const label = document.getElementById("localcmd-edit-command-label");
  const hint = document.getElementById("localcmd-edit-command-hint");
  if (label) label.textContent = t("modal_localcmd.label_" + type);
  if (hint) hint.textContent = t("modal_localcmd.hint_" + type);
}

function closeLocalCmdEditor() {
  document.getElementById("localcmd-edit-overlay")?.classList.add("hidden");
  _editingLocalCmdId = null;
}

function submitLocalCmdEditor(e) {
  e.preventDefault();
  const name = document.getElementById("localcmd-edit-name").value.trim();
  const command = document.getElementById("localcmd-edit-command").value;
  if (!name || !command.trim()) return;
  const cmd = {
    id: _editingLocalCmdId || crypto.randomUUID(),
    name,
    type: document.getElementById("localcmd-edit-type").value,
    command,
    description: document.getElementById("localcmd-edit-desc").value.trim(),
    confirm: document.getElementById("localcmd-edit-confirm").checked,
    updated_at: new Date().toISOString(),
  };
  upsertLocalCommand(cmd);
  closeLocalCmdEditor();
  renderLocalCommandList();
}

async function deleteLocalCmd(id) {
  const c = localCommandById(id);
  const ok = await confirmThemed({
    title: t("prefs_commands.delete_cmd_title"),
    message: c?.name || "",
    submitLabel: t("prefs_commands.delete"),
    danger: true,
  });
  if (!ok) return;
  deleteLocalCommandById(id);
  renderLocalCommandList();
}

/* ── Paleta de comandos global ─────────────────────────────────────────── */

const PALETTE_ICONS = {
  action: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  template: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
  profile: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M2 18h20"/></svg>',
  snippet: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/></svg>',
  localcmd: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
};

let _paletteItems = [];
let _paletteFiltered = [];
let _paletteActive = 0;

/** Construye la lista plana de entradas de la paleta. */
function buildPaletteSources() {
  const items = [];
  items.push({ kind: "action", title: t("palette.action_new_connection"), icon: PALETTE_ICONS.action, run: () => openNewConnectionModal() });
  items.push({ kind: "action", title: t("palette.action_new_template"), icon: PALETTE_ICONS.template, run: () => openNewConnectionFromTemplate() });
  items.push({ kind: "action", title: t("palette.action_local_shell"), icon: PALETTE_ICONS.action, run: () => openLocalShell() });
  items.push({ kind: "action", title: t("palette.action_preferences"), icon: PALETTE_ICONS.action, run: () => openSettingsModal() });
  for (const p of profiles) {
    const sub = `${p.username ? p.username + "@" : ""}${p.host || ""}`;
    items.push({ kind: "profile", title: p.name || p.host || "", sub, icon: PALETTE_ICONS.profile, run: () => connectProfile(p.id) });
  }
  for (const s of loadSnippets()) {
    items.push({ kind: "snippet", title: s.name, sub: [s.group, s.description].filter(Boolean).join(" · "), icon: PALETTE_ICONS.snippet, run: () => runSnippet(s) });
  }
  for (const c of loadLocalCommands()) {
    items.push({ kind: "localcmd", title: c.name, sub: [localCommandTypeLabel(c.type), c.description].filter(Boolean).join(" · "), icon: PALETTE_ICONS.localcmd, run: () => runLocalCommand(c) });
  }
  return items;
}

/** Puntuación simple: subcadena > subsecuencia > -1 (descarte). */
function paletteScore(q, text) {
  if (!q) return 0;
  const hay = (text || "").toLowerCase();
  const needle = q.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx >= 0) return 1000 - idx;
  let ti = 0;
  for (let qi = 0; qi < needle.length; qi++) {
    ti = hay.indexOf(needle[qi], ti);
    if (ti < 0) return -1;
    ti++;
  }
  return 200 - needle.length;
}

function renderPaletteResults(query) {
  const list = document.getElementById("command-palette-list");
  if (!list) return;
  const q = (query || "").trim();
  let results;
  if (!q) {
    results = _paletteItems.slice(0, 50);
  } else {
    results = _paletteItems
      .map((it) => ({ it, score: Math.max(paletteScore(q, it.title), paletteScore(q, it.sub || "") - 50) }))
      .filter((x) => x.score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.it);
  }
  _paletteFiltered = results;
  if (_paletteActive >= results.length) _paletteActive = 0;
  if (!results.length) {
    list.innerHTML = `<div class="palette-empty">${escHtml(t("palette.empty"))}</div>`;
    return;
  }
  list.innerHTML = results.map((it, i) => `
    <div class="palette-item${i === _paletteActive ? " active" : ""}" data-palette-idx="${i}" role="option">
      <span class="palette-item-icon">${it.icon || ""}</span>
      <span class="palette-item-body">
        <span class="palette-item-title">${escHtml(it.title)}</span>
        ${it.sub ? `<span class="palette-item-sub">${escHtml(it.sub)}</span>` : ""}
      </span>
      <span class="palette-item-kind">${escHtml(t("palette.kind_" + it.kind))}</span>
    </div>`).join("");
}

function openCommandPalette() {
  const overlay = document.getElementById("command-palette-overlay");
  const input = document.getElementById("command-palette-input");
  if (!overlay || !input) return;
  _paletteItems = buildPaletteSources();
  _paletteActive = 0;
  input.value = "";
  overlay.classList.remove("hidden");
  renderPaletteResults("");
  setTimeout(() => input.focus(), 0);
}

function closeCommandPalette() {
  document.getElementById("command-palette-overlay")?.classList.add("hidden");
}

function paletteMoveActive(delta) {
  if (!_paletteFiltered.length) return;
  _paletteActive = (_paletteActive + delta + _paletteFiltered.length) % _paletteFiltered.length;
  const list = document.getElementById("command-palette-list");
  list?.querySelectorAll(".palette-item").forEach((el, i) => {
    el.classList.toggle("active", i === _paletteActive);
    if (i === _paletteActive) el.scrollIntoView({ block: "nearest" });
  });
}

function executePaletteIndex(i) {
  const item = _paletteFiltered[i];
  if (!item) return;
  closeCommandPalette();
  try { item.run(); } catch (err) { console.error("[palette]", err); }
}

function paletteInputKeydown(e) {
  if (e.key === "ArrowDown") { e.preventDefault(); paletteMoveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); paletteMoveActive(-1); }
  else if (e.key === "Enter") { e.preventDefault(); executePaletteIndex(_paletteActive); }
  else if (e.key === "Escape") { e.preventDefault(); closeCommandPalette(); }
}

/** Cablea los listeners de snippets, comandos locales, plantilla y paleta. */
function initCommandsAndPalette() {
  document.getElementById("btn-snippet-add")?.addEventListener("click", () => openSnippetEditor(null));
  document.getElementById("snippet-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-snippet-action]");
    if (!btn) return;
    const id = btn.closest("[data-snippet-id]")?.dataset.snippetId;
    if (!id) return;
    const action = btn.dataset.snippetAction;
    if (action === "run") runSnippet(snippetById(id));
    else if (action === "edit") openSnippetEditor(snippetById(id));
    else if (action === "delete") deleteSnippetById(id);
  });
  document.getElementById("snippet-edit-form")?.addEventListener("submit", submitSnippetEditor);
  document.getElementById("btn-snippet-edit-close")?.addEventListener("click", closeSnippetEditor);
  document.getElementById("btn-snippet-edit-cancel")?.addEventListener("click", closeSnippetEditor);
  document.getElementById("snippet-edit-overlay")?.addEventListener("mousedown", (e) => {
    if (e.target.id === "snippet-edit-overlay") closeSnippetEditor();
  });

  document.getElementById("btn-localcmd-add")?.addEventListener("click", () => openLocalCmdEditor(null));
  document.getElementById("localcmd-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-localcmd-action]");
    if (!btn) return;
    const id = btn.closest("[data-localcmd-id]")?.dataset.localcmdId;
    if (!id) return;
    const action = btn.dataset.localcmdAction;
    if (action === "run") runLocalCommand(localCommandById(id));
    else if (action === "edit") openLocalCmdEditor(localCommandById(id));
    else if (action === "delete") deleteLocalCmd(id);
  });
  document.getElementById("localcmd-edit-form")?.addEventListener("submit", submitLocalCmdEditor);
  document.getElementById("localcmd-edit-type")?.addEventListener("change", updateLocalCmdTypeUi);
  document.getElementById("btn-localcmd-edit-close")?.addEventListener("click", closeLocalCmdEditor);
  document.getElementById("btn-localcmd-edit-cancel")?.addEventListener("click", closeLocalCmdEditor);
  document.getElementById("localcmd-edit-overlay")?.addEventListener("mousedown", (e) => {
    if (e.target.id === "localcmd-edit-overlay") closeLocalCmdEditor();
  });

  document.getElementById("f-template")?.addEventListener("change", (e) => applyProfileTemplate(e.target.value));

  const paletteInput = document.getElementById("command-palette-input");
  paletteInput?.addEventListener("keydown", paletteInputKeydown);
  paletteInput?.addEventListener("input", (e) => { _paletteActive = 0; renderPaletteResults(e.target.value); });
  document.getElementById("command-palette-list")?.addEventListener("mousedown", (e) => {
    const item = e.target.closest("[data-palette-idx]");
    if (!item) return;
    e.preventDefault();
    executePaletteIndex(Number(item.dataset.paletteIdx));
  });
  document.getElementById("command-palette-overlay")?.addEventListener("mousedown", (e) => {
    if (e.target.id === "command-palette-overlay") closeCommandPalette();
  });
}

const SHORTCUT_ACTIONS = {
  paste_terminal:    { default: "Ctrl+Alt+V",     run: () => pasteIntoActiveTerminal() },
  copy_terminal:     { default: "Ctrl+Alt+C",     run: () => copyActiveSelection() },
  paste_password:    { default: "Ctrl+P",         run: () => pasteSessionPasswordIntoActiveTerminal() },
  new_local_shell:   { default: "Ctrl+Shift+T",   run: () => openLocalShell() },
  new_connection:    { default: "Ctrl+Shift+N",   run: () => openNewConnectionModal() },
  search_connections:{ default: "Ctrl+K",         run: () => focusConnectionSearch() },
  clear_sidebar_search:{ default: "Escape",       scope: "sidebar-search", run: () => clearSidebarSearch() },
  close_tab:         { default: "Ctrl+W",         run: () => { if (activeSessionId) closeSession(activeSessionId); } },
  next_tab:          { default: "Ctrl+Tab",       run: () => switchTab(1) },
  prev_tab:          { default: "Ctrl+Shift+Tab", run: () => switchTab(-1) },
  next_pane:         { default: "Ctrl+Alt+ArrowRight", run: () => focusPaneByOffset(+1) },
  prev_pane:         { default: "Ctrl+Alt+ArrowLeft",  run: () => focusPaneByOffset(-1) },
  open_preferences:  { default: "Ctrl+,",         run: () => openSettingsModal() },
  zoom_in:           { default: "Ctrl+=",         run: () => adjustTerminalFontSize(+1) },
  zoom_out:          { default: "Ctrl+-",         run: () => adjustTerminalFontSize(-1) },
  zoom_reset:        { default: "Ctrl+0",         run: () => adjustTerminalFontSize("reset") },
  ui_zoom_in:        { default: "Ctrl+Alt+=",     run: () => adjustUiZoom(+1) },
  ui_zoom_out:       { default: "Ctrl+Alt+-",     run: () => adjustUiZoom(-1) },
  ui_zoom_reset:     { default: "Ctrl+Alt+0",     run: () => adjustUiZoom("reset") },
  reconnect_session: { default: "Ctrl+Shift+R",   run: () => { if (activeSessionId) reconnectSession(activeSessionId); } },
  find_in_terminal:  { default: "Ctrl+F",         run: () => toggleTerminalSearch() },
  clear_terminal:    { default: null,             run: () => clearActiveTerminal() },
  sftp_toggle_panel: { default: "Ctrl+Shift+F",   run: () => toggleActiveSftpPanel() },
  sftp_toggle_follow:{ default: null,             run: () => toggleActiveSftpFollow() },
  sftp_toggle_sudo:  { default: null,             run: () => toggleActiveSftpElevated() },
  toggle_zen_mode:   { default: "F11",            run: () => toggleZenMode() },
  disconnect_all:    { default: "",               run: () => disconnectAll() },
  open_command_editor: { default: "Ctrl+Shift+E", run: () => openCommandEditor() },
  open_note_editor:    { default: "Ctrl+Shift+M", run: () => openActiveSessionNote() },
  command_palette:     { default: "Ctrl+Shift+P", run: () => openCommandPalette() },
};

/** Abre el editor de notas del perfil de la sesión activa (atajo). */
function openActiveSessionNote() {
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  if (s?.profileId) {
    openNoteEditor(s.profileId);
    return;
  }
  const pid = activeProfileId();
  if (pid) openNoteEditor(pid);
  else toast(t("notes.toast_no_profile"), "warning");
}

const SHORTCUT_IDS = Object.keys(SHORTCUT_ACTIONS);

/**
 * Presets de atajos. Al aplicar uno, los valores definidos sobreescriben
 * `prefs.shortcuts`; los `id` ausentes se borran (vuelven al default de
 * cada acción). El preset `default` deja el mapa vacío.
 *
 * Sin soporte de chord (Ctrl+B,N estilo tmux), `tmux` aproxima la
 * convención con combos Alt+letra: prefix C-b queda implícito.
 */
const SHORTCUT_PRESETS = {
  default: {},
  vim: {
    next_pane: "Ctrl+Alt+L",
    prev_pane: "Ctrl+Alt+H",
    next_tab:  "Ctrl+Alt+J",
    prev_tab:  "Ctrl+Alt+K",
    new_connection:   "Ctrl+Alt+N",
    new_local_shell:  "Ctrl+Alt+T",
    find_in_terminal: "Ctrl+Alt+F",
    close_tab:        "Ctrl+Alt+Q",
  },
  tmux: {
    next_tab:         "Alt+N",
    prev_tab:         "Alt+P",
    next_pane:        "Alt+O",
    prev_pane:        "Alt+Shift+O",
    new_local_shell:  "Alt+C",
    new_connection:   "Alt+Shift+N",
    close_tab:        "Alt+X",
    find_in_terminal: "Alt+/",
  },
};

// Mapa de códigos "extraños" a etiqueta legible. Las teclas KeyA → A,
// DigitN → N se tratan fuera del map. NumpadAdd/-Subtract/-0 se
// normalizan a =/-/0 para que Ctrl+= también dispare con el numpad.
const CODE_LABEL_MAP = {
  Comma: ",", Period: ".", Semicolon: ";", Quote: "'",
  Minus: "-", Equal: "=", Slash: "/", Backslash: "\\",
  BracketLeft: "[", BracketRight: "]", Backquote: "`",
  NumpadAdd: "=", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/",
  NumpadDecimal: ".", NumpadEnter: "Enter", Numpad0: "0", Numpad1: "1",
  Numpad2: "2", Numpad3: "3", Numpad4: "4", Numpad5: "5", Numpad6: "6",
  Numpad7: "7", Numpad8: "8", Numpad9: "9",
};

function keyLabelFromCode(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (CODE_LABEL_MAP[code]) return CODE_LABEL_MAP[code];
  return code; // "Tab", "Escape", "F1", "ArrowLeft", "Space", ...
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** Devuelve el accelerator canónico del evento, o null si es solo modificador. */
function comboFromEvent(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts = [];
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.altKey)   parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  parts.push(keyLabelFromCode(e.code));
  return parts.join("+");
}

function getShortcut(id) {
  const override = prefs.shortcuts?.[id];
  if (override === null) return null;           // explícitamente desactivado
  if (typeof override === "string") return override;
  return SHORTCUT_ACTIONS[id]?.default ?? null;
}

function handleGlobalShortcut(e) {
  const combo = comboFromEvent(e);
  if (!combo) return;
  // En layouts con +/= compartidos (US, ES…) "Ctrl++" se teclea como
  // Ctrl+Shift+=. Lo aceptamos como alias del combo que tenga el usuario
  // asignado a Ctrl+= (por defecto zoom_in) para que el "Ctrl con +" funcione
  // sin tener que recordar la variante sin Shift.
  const candidates = combo === "Ctrl+Shift+=" ? [combo, "Ctrl+="] : [combo];
  for (const candidate of candidates) {
    for (const id of SHORTCUT_IDS) {
      // Las acciones con `scope` solo se ejecutan desde su contexto local
      // (por ejemplo el input de búsqueda de la sidebar), no como atajo global.
      if (SHORTCUT_ACTIONS[id].scope) continue;
      if (getShortcut(id) === candidate) {
        e.preventDefault();
        e.stopPropagation();
        SHORTCUT_ACTIONS[id].run();
        return;
      }
    }
  }

  // Ctrl/Cmd+1…9 salta a la pestaña N (9 = última, convención de navegadores).
  // Va después del bucle de atajos configurables para no pisar un combo que el
  // usuario haya asignado a Ctrl+<dígito>.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    if (jumpToTabByIndex(Number(e.code.slice(5)))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

/**
 * Activa la N-ésima pestaña de sesión (1-indexada). `n === 9` salta siempre a la
 * última, igual que Ctrl+9 en los navegadores. El tab de inicio queda excluido.
 * Devuelve `true` si se activó alguna pestaña.
 */
function jumpToTabByIndex(n) {
  const tabs = [...document.querySelectorAll("#tabs-container .tab")];
  if (!tabs.length) return false;
  const idx = n === 9 ? tabs.length - 1 : Math.min(n - 1, tabs.length - 1);
  const sid = tabs[idx]?.dataset?.session;
  if (!sid) return false;
  setActiveTab(sid);
  sessions.get(sid)?.terminal?.focus();
  return true;
}

function clearSidebarSearch() {
  const sidebarSearch = document.getElementById("sidebar-search");
  if (sidebarSearch && sidebarSearch.value) {
    sidebarSearch.value = "";
    _sidebarSearchQuery = "";
    renderConnectionList();
    return true;
  }
  if (_sidebarSearchQuery) {
    _sidebarSearchQuery = "";
    renderConnectionList();
    return true;
  }
  toggleSidebarTools(false);
  return false;
}

/**
 * Zoom del terminal con Ctrl+Rueda. Solo cuando el cursor no está sobre un
 * campo editable (input/textarea/contenteditable) para no interferir con la
 * navegación por scroll en el resto de la UI.
 */
function handleZoomWheel(e) {
  if (!e.ctrlKey || e.deltaY === 0) return;
  const target = e.target;
  if (target instanceof HTMLElement) {
    if (target.closest("input, textarea, [contenteditable=\"true\"]")) return;
  }
  e.preventDefault();
  if (e.deltaY < 0) adjustTerminalFontSize(+1);
  else adjustTerminalFontSize(-1);
}

// ─── Editor de atajos ─────────────────────────────────────────

/** Formatea un accelerator para visualización (mostrar "Cmd" en macOS). */
function formatAccelerator(accel) {
  if (!accel) return "";
  const platform = navigator.userAgentData?.platform ?? navigator.userAgent ?? "";
  const mac = /mac/i.test(platform);
  return mac ? accel.replace(/\bCtrl\b/g, "Cmd") : accel;
}

function renderShortcutsList() {
  const root = document.getElementById("shortcuts-list");
  if (!root) return;
  const overrides = prefs.shortcuts || {};
  let html = "";
  for (const id of SHORTCUT_IDS) {
    const current = getShortcut(id);
    const isOverridden = Object.prototype.hasOwnProperty.call(overrides, id);
    const label = t(`prefs_shortcuts.action_${id}`);
    const placeholder = t("prefs_shortcuts.disabled");
    html += `
      <div class="shortcut-row" data-shortcut-id="${id}">
        <div class="shortcut-label">${escHtml(label)}</div>
        <kbd class="shortcut-combo">${current ? escHtml(formatAccelerator(current)) : `<em>${escHtml(placeholder)}</em>`}</kbd>
        <div class="shortcut-row-actions">
          <button type="button" class="btn-secondary btn-shortcut-edit" data-i18n="prefs_shortcuts.edit">Editar</button>
          <button type="button" class="btn-secondary btn-shortcut-clear" data-i18n="prefs_shortcuts.disable">Desactivar</button>
          <button type="button" class="btn-secondary btn-shortcut-reset" ${isOverridden ? "" : "disabled"} data-i18n="prefs_shortcuts.reset">Restablecer</button>
        </div>
      </div>`;
  }
  root.innerHTML = html;
  applyTranslations(root);
}

function normalizeShortcutMap(raw) {
  const input = raw?.shortcuts && typeof raw.shortcuts === "object" ? raw.shortcuts : raw;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid shortcut map");
  }
  const out = {};
  for (const id of SHORTCUT_IDS) {
    if (!Object.prototype.hasOwnProperty.call(input, id)) continue;
    const value = input[id];
    if (value === null || typeof value === "string") {
      out[id] = value;
    }
  }
  return out;
}

async function exportShortcuts() {
  let path;
  try {
    path = await saveDialog({
      title: t("prefs_shortcuts.export_title"),
      defaultPath: "rustty-shortcuts.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) { toast(String(err), "error"); return; }
  if (!path) return;

  try {
    await invoke("write_text_file", {
      path,
      contents: JSON.stringify({
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        shortcuts: prefs.shortcuts || {},
      }, null, 2),
    });
    toast(t("prefs_shortcuts.export_done"), "success");
  } catch (err) {
    toast(String(err), "error");
  }
}

async function importShortcuts() {
  let path;
  try {
    path = await openDialog({
      title: t("prefs_shortcuts.import_title"),
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  } catch (err) { toast(String(err), "error"); return; }
  if (!path) return;

  let imported;
  try {
    const text = await invoke("read_text_file", { path });
    imported = normalizeShortcutMap(JSON.parse(text));
  } catch {
    toast(t("prefs_shortcuts.import_invalid"), "error");
    return;
  }

  const ok = await confirmThemed({
    title: t("prefs_shortcuts.import_title"),
    message: t("prefs_shortcuts.import_confirm"),
    submitLabel: t("prefs_shortcuts.import"),
  });
  if (!ok) return;

  const now = new Date().toISOString();
  prefs.shortcuts = imported;
  prefs._shortcutsTs = Object.fromEntries(Object.keys(imported).map((id) => [id, now]));
  prefs._prefsUpdatedAt = now;
  savePrefs();
  renderShortcutsList();
  scheduleProfileAutoSync();
  toast(t("prefs_shortcuts.import_done"), "success");
}

async function applyShortcutPresetFromUi() {
  const select = document.getElementById("shortcuts-preset-select");
  if (!select) return;
  const presetId = select.value;
  const preset = SHORTCUT_PRESETS[presetId];
  if (!preset) return;

  const ok = await confirmThemed({
    title: t("prefs_shortcuts.preset_apply_title"),
    message: t("prefs_shortcuts.preset_apply_confirm", {
      preset: t(`prefs_shortcuts.preset_${presetId}`),
    }),
    submitLabel: t("prefs_shortcuts.preset_apply"),
    danger: true,
  });
  if (!ok) return;

  const now = new Date().toISOString();
  prefs.shortcuts = { ...preset };
  prefs._shortcutsTs = Object.fromEntries(
    Object.keys(prefs.shortcuts).map((id) => [id, now])
  );
  prefs._prefsUpdatedAt = now;
  savePrefs();
  renderShortcutsList();
  scheduleProfileAutoSync();
  toast(t("prefs_shortcuts.preset_applied", {
    preset: t(`prefs_shortcuts.preset_${presetId}`),
  }), "success");
}

let _captureState = null; // { id, row, comboEl }

function startShortcutCapture(id, rowEl) {
  cancelShortcutCapture();
  const comboEl = rowEl.querySelector(".shortcut-combo");
  comboEl.innerHTML = `<em>${escHtml(t("prefs_shortcuts.press_keys"))}</em>`;
  rowEl.classList.add("capturing");
  _captureState = { id, row: rowEl, comboEl };
  document.addEventListener("keydown", onCaptureKeydown, { capture: true });
}

function cancelShortcutCapture() {
  if (!_captureState) return;
  document.removeEventListener("keydown", onCaptureKeydown, { capture: true });
  _captureState.row.classList.remove("capturing");
  _captureState = null;
  renderShortcutsList();
}

function onCaptureKeydown(e) {
  if (!_captureState) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { cancelShortcutCapture(); return; }
  const combo = comboFromEvent(e);
  if (!combo) return; // solo modificadores: esperar a la tecla final
  // Conflicto: si el combo ya está en uso por otra acción, aviso pero aplico (el usuario elige)
  const conflict = SHORTCUT_IDS.find((other) => other !== _captureState.id && getShortcut(other) === combo);
  setShortcut(_captureState.id, combo);
  if (conflict) {
    toast(
      t("prefs_shortcuts.conflict_warn").replace("{action}", t(`prefs_shortcuts.action_${conflict}`)),
      "warning",
      4000,
    );
  }
  cancelShortcutCapture();
}

function setShortcut(id, accel) {
  const def = SHORTCUT_ACTIONS[id]?.default ?? null;
  prefs.shortcuts = prefs.shortcuts || {};
  if (accel === def) {
    delete prefs.shortcuts[id]; // vuelve al default, no guardamos override
  } else {
    prefs.shortcuts[id] = accel;
  }
  savePrefs();
  renderShortcutsList();
}

function resetShortcut(id) {
  if (!prefs.shortcuts) return;
  delete prefs.shortcuts[id];
  savePrefs();
  renderShortcutsList();
}

/** Ajusta el tamaño de fuente global del terminal y persiste. */
function adjustTerminalFontSize(delta) {
  const MIN = 8, MAX = 32;
  const next = delta === "reset"
    ? DEFAULT_PREFS.fontSize
    : Math.max(MIN, Math.min(MAX, prefs.fontSize + delta));
  if (next !== prefs.fontSize) {
    prefs.fontSize = next;
    savePrefs();
    applyPrefsToAllTerminals();
  }
  // Mostrar siempre el indicador (también al tocar los límites o resetear),
  // para que el usuario tenga referencia del tamaño actual y pueda volver al
  // 100 % (= tamaño por defecto, restablecible con el atajo de reset).
  showFontZoomIndicator();
}

let _fontZoomIndicatorTimer = null;
/** Indicador efímero con el tamaño de fuente actual del terminal en px y %. */
function showFontZoomIndicator() {
  let el = document.getElementById("font-zoom-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "font-zoom-indicator";
    document.body.appendChild(el);
  }
  const pct = Math.round((prefs.fontSize / DEFAULT_PREFS.fontSize) * 100);
  el.textContent = `${prefs.fontSize} px · ${pct}%`;
  el.classList.toggle("at-default", prefs.fontSize === DEFAULT_PREFS.fontSize);
  el.classList.add("visible");
  clearTimeout(_fontZoomIndicatorTimer);
  _fontZoomIndicatorTimer = setTimeout(() => el.classList.remove("visible"), 1200);
}

function buildTerminalSearchBar(sessionId) {
  const bar = document.createElement("div");
  bar.className = "terminal-search hidden";
  bar.innerHTML = `
    <input type="search" class="terminal-search-input" placeholder="Buscar…" spellcheck="false" />
    <span class="terminal-search-summary"></span>
    <button class="terminal-search-btn" data-search="prev" title="Anterior (Shift+Enter)">↑</button>
    <button class="terminal-search-btn" data-search="next" title="Siguiente (Enter)">↓</button>
    <label class="terminal-search-toggle" title="Coincidir mayúsculas/minúsculas">
      <input type="checkbox" data-search-opt="case" /> Aa
    </label>
    <button class="terminal-search-btn" data-search="close" title="Cerrar (Esc)">✕</button>
  `;
  const input = bar.querySelector(".terminal-search-input");
  const search = (dir) => runTerminalSearch(sessionId, dir);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      search(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideTerminalSearch(sessionId);
    }
  });
  input.addEventListener("input", () => search("next"));
  bar.querySelector('[data-search="next"]').addEventListener("click", () => search("next"));
  bar.querySelector('[data-search="prev"]').addEventListener("click", () => search("prev"));
  bar.querySelector('[data-search="close"]').addEventListener("click", () => hideTerminalSearch(sessionId));
  bar.querySelector('[data-search-opt="case"]').addEventListener("change", () => search("next"));
  return bar;
}

function toggleTerminalSearch() {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s?.searchAddon) return;
  const pane = document.querySelector(`.terminal-pane[data-session="${activeSessionId}"]`);
  const bar = pane?.querySelector(".terminal-search");
  if (!bar) return;
  if (bar.classList.contains("hidden")) {
    bar.classList.remove("hidden");
    const input = bar.querySelector(".terminal-search-input");
    input.focus();
    input.select();
  } else {
    hideTerminalSearch(activeSessionId);
  }
}

function hideTerminalSearch(sessionId) {
  const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  const bar = pane?.querySelector(".terminal-search");
  if (!bar) return;
  bar.classList.add("hidden");
  const s = sessions.get(sessionId);
  s?.searchAddon?.clearDecorations?.();
  s?.terminal?.focus();
}

function runTerminalSearch(sessionId, direction) {
  const s = sessions.get(sessionId);
  if (!s?.searchAddon) return;
  const pane = document.querySelector(`.terminal-pane[data-session="${sessionId}"]`);
  const bar = pane?.querySelector(".terminal-search");
  if (!bar) return;
  const term = bar.querySelector(".terminal-search-input").value;
  const summary = bar.querySelector(".terminal-search-summary");
  if (!term) {
    summary.textContent = "";
    s.searchAddon.clearDecorations?.();
    return;
  }
  const opts = {
    caseSensitive: bar.querySelector('[data-search-opt="case"]').checked,
    decorations: {
      matchBackground: "#f9e2af",
      matchOverviewRuler: "#f9e2af",
      activeMatchBackground: "#f38ba8",
      activeMatchColorOverviewRuler: "#f38ba8",
    },
  };
  const found = direction === "prev"
    ? s.searchAddon.findPrevious(term, opts)
    : s.searchAddon.findNext(term, opts);
  summary.textContent = found ? "" : "Sin resultados";
}

async function pasteIntoActiveTerminal() {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  await pasteClipboardIntoSession(s);
}

/**
 * Pega en el terminal SSH activo la contraseña guardada del perfil
 * (KeePass o keyring). Solo aplica a sesiones SSH: en la shell local
 * no hay perfil asociado.
 */
async function pasteSessionPasswordIntoActiveTerminal() {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s) return;
  if (s._closeOverride || s.type === "rdp" || !s.profileId) {
    toast(t("toast.paste_password_ssh_only"), "warning");
    return;
  }
  if (s.status !== "connected") {
    toast(t("toast.paste_password_not_connected"), "warning");
    return;
  }
  if (isBroadcastOn() && viewSelection.includes(activeSessionId) && viewSelection.length > 1) {
    toast(t("toast.paste_password_broadcast_blocked"), "warning");
    return;
  }
  let password;
  try {
    password = await invoke("get_profile_password", {
      profileId: s.profileId,
      credentialId: s.credentialId || null,
    });
  } catch (err) {
    toast(t("toast.paste_password_read_error", { err: String(err) }), "error");
    return;
  }
  if (!password) {
    toast(t("toast.paste_password_no_password"), "warning");
    return;
  }
  const data = Array.from(new TextEncoder().encode(password));
  password = null;
  invoke("ssh_send_input", { sessionId: activeSessionId, data }).catch(() => {});
}

function copyActiveSelection() {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s?.terminal) return;
  const sel = s.terminal.getSelection();
  if (sel) writeSystemClipboardText(sel);
}

function clearActiveTerminal() {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s?.terminal) return;
  s.terminal.clear();
  s.terminal.focus();
}

// ── Notas Markdown por conexión (runbooks) ────────────────────────────────

/** Icono SVG de nota (documento con líneas), monocromo con currentColor. */
const NOTE_ICON_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h4.5L12 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path d="M8.4 2.5V6H12"/><path d="M5.5 8.7h5M5.5 11h3.2"/></svg>`;

/** Índice en memoria de notas: profileId → NoteSummary. */
const notesIndex = new Map();

/** Recarga el índice de notas desde el backend (badge, menú, búsqueda). */
async function refreshNotesIndex() {
  try {
    const list = await invoke("note_list");
    notesIndex.clear();
    for (const s of list || []) {
      if (s?.profile_id) notesIndex.set(s.profile_id, s);
    }
  } catch (err) {
    console.error("[notes] list", err);
  }
}

function profileHasNote(profileId) {
  return notesIndex.has(profileId);
}

/** Contexto de sustitución para el preview a partir de un perfil. */
function noteSubstContext(profile) {
  if (!profile) return {};
  return {
    host: profile.host,
    port: profile.port,
    user: profile.username,
    profileName: profile.name,
    workspace: profile.workspace_id || "default",
  };
}

function recordNoteTombstone(profileId) {
  prefs.tombstones = prefs.tombstones || {};
  prefs.tombstones.notes = prefs.tombstones.notes || {};
  prefs.tombstones.notes[profileId] = new Date().toISOString();
  savePrefs();
}

function clearNoteTombstone(profileId) {
  if (prefs.tombstones?.notes?.[profileId]) {
    delete prefs.tombstones.notes[profileId];
    savePrefs();
  }
}

let _noteEditorProfileId = null;
let _noteEditorDirty = false;
let _notePreviewTimer = null;

function renderNotePreviewInto(el, body, profile) {
  if (!el) return;
  const resolved = substitutePreview(String(body || ""), noteSubstContext(profile));
  el.innerHTML = renderMarkdownMinimal(resolved);
}

async function openNoteEditor(profileId) {
  const overlay = document.getElementById("note-editor-overlay");
  if (!overlay || !profileId) return;
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  _noteEditorProfileId = profileId;
  _noteEditorDirty = false;

  const titleInput = document.getElementById("note-editor-title-input");
  const tagsInput = document.getElementById("note-editor-tags");
  const textarea = document.getElementById("note-editor-textarea");

  document.getElementById("note-editor-title").textContent =
    `${t("notes.editor_title")} · ${profile.name}`;

  let doc = null;
  try {
    doc = await invoke("note_get", { profileId });
  } catch (err) {
    console.error("[notes] get", err);
  }
  titleInput.value = doc?.title || "";
  tagsInput.value = (doc?.tags || []).join(", ");
  textarea.value = doc?.body || "";

  renderNotePreviewInto(document.getElementById("note-editor-preview"), textarea.value, profile);
  overlay.classList.remove("hidden");
  textarea.focus();
}

function scheduleNotePreview() {
  clearTimeout(_notePreviewTimer);
  _notePreviewTimer = setTimeout(() => {
    const textarea = document.getElementById("note-editor-textarea");
    const profile = profiles.find((p) => p.id === _noteEditorProfileId);
    renderNotePreviewInto(document.getElementById("note-editor-preview"), textarea?.value, profile);
  }, 150);
}

async function saveNoteFromEditor({ close = true } = {}) {
  if (!_noteEditorProfileId) return;
  const profileId = _noteEditorProfileId;
  const profile = profiles.find((p) => p.id === profileId);
  const body = document.getElementById("note-editor-textarea").value;
  const title = document.getElementById("note-editor-title-input").value.trim();
  const tags = document.getElementById("note-editor-tags").value
    .split(",").map((s) => s.trim()).filter(Boolean);

  try {
    if (body.trim() === "" && title === "" && tags.length === 0) {
      await invoke("note_delete", { profileId });
      recordNoteTombstone(profileId);
    } else {
      await invoke("note_set", {
        profileId,
        body,
        title,
        connection: profile?.name || "",
        tags,
      });
      clearNoteTombstone(profileId);
    }
    await refreshNotesIndex();
    renderConnectionList();
    updateRunbookForProfile(profileId);
    setupModalNotePane();
    _noteEditorDirty = false;
    scheduleProfileAutoSync();
  } catch (err) {
    toast(t("notes.toast_save_error"), "error");
    console.error("[notes] save", err);
    return;
  }
  if (close) closeNoteEditor();
}

function closeNoteEditor() {
  document.getElementById("note-editor-overlay")?.classList.add("hidden");
  _noteEditorProfileId = null;
  _noteEditorDirty = false;
  if (activeSessionId) sessions.get(activeSessionId)?.terminal?.focus();
}

/** Esc / cancelar: autoguarda si hubo cambios, si no cierra sin más. */
function handleNoteEditorEscape() {
  if (_noteEditorDirty) saveNoteFromEditor({ close: true });
  else closeNoteEditor();
}

async function deleteNote(profileId) {
  if (!profileId || !profileHasNote(profileId)) return;
  const ok = await confirmThemed({
    title: t("notes.delete_title"),
    message: t("notes.delete_confirm"),
    submitLabel: t("modal_destructive.submit"),
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("note_delete", { profileId });
    recordNoteTombstone(profileId);
    await refreshNotesIndex();
    renderConnectionList();
    updateRunbookForProfile(profileId);
    scheduleProfileAutoSync();
    toast(t("notes.toast_deleted"), "success");
  } catch (err) {
    console.error("[notes] delete", err);
  }
}

/** Inserta marcado Markdown alrededor de la selección del textarea. */
function applyNoteToolbar(action) {
  const ta = document.getElementById("note-editor-textarea");
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.slice(start, end);
  let before = "";
  let after = "";
  let placeholder = sel;
  switch (action) {
    case "bold":   before = "**"; after = "**"; placeholder = sel || t("notes.ph_bold"); break;
    case "italic": before = "*";  after = "*";  placeholder = sel || t("notes.ph_italic"); break;
    case "code":   before = "`";  after = "`";  placeholder = sel || t("notes.ph_code"); break;
    case "link":   before = "[";  after = "](https://)"; placeholder = sel || t("notes.ph_link"); break;
    case "h":      before = "## "; placeholder = sel || t("notes.ph_heading"); break;
    case "ul":     before = "- ";  placeholder = sel || t("notes.ph_item"); break;
    case "task":   before = "- [ ] "; placeholder = sel || t("notes.ph_task"); break;
    default: return;
  }
  const insert = before + placeholder + after;
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
  const caret = start + before.length;
  ta.focus();
  ta.setSelectionRange(caret, caret + placeholder.length);
  _noteEditorDirty = true;
  scheduleNotePreview();
}

function initNoteEditor() {
  const overlay = document.getElementById("note-editor-overlay");
  const textarea = document.getElementById("note-editor-textarea");
  if (!overlay || !textarea) return;

  textarea.addEventListener("input", () => {
    _noteEditorDirty = true;
    scheduleNotePreview();
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.key === "s" || e.key === "S") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveNoteFromEditor({ close: false });
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleNoteEditorEscape();
    }
  });
  ["note-editor-title-input", "note-editor-tags"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => { _noteEditorDirty = true; });
  });

  document.getElementById("note-editor-save")?.addEventListener("click", () => saveNoteFromEditor({ close: true }));
  document.getElementById("note-editor-cancel")?.addEventListener("click", () => handleNoteEditorEscape());
  document.getElementById("note-editor-close")?.addEventListener("click", () => handleNoteEditorEscape());
  document.getElementById("note-editor-open-folder")?.addEventListener("click", async () => {
    try {
      const dir = await invoke("notes_dir");
      await invoke("plugin:opener|open_path", { path: dir });
    } catch (err) {
      console.error("[notes] open dir", err);
    }
  });
  document.getElementById("note-editor-toolbar")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".note-tool");
    if (btn) applyNoteToolbar(btn.dataset.md);
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) handleNoteEditorEscape();
  });

  // Botón "Abrir editor de notas" de la pestaña Notas del modal de conexión.
  document.getElementById("modal-note-edit-btn")?.addEventListener("click", () => {
    if (editingProfileId) openNoteEditor(editingProfileId);
  });
}

// ── Panel runbook (nota junto a la sesión) ────────────────────────────────

async function toggleRunbookPanel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.runbookPanel) {
    s.runbookPanel.classList.toggle("hidden");
    if (!s.runbookPanel.classList.contains("hidden")) renderRunbookPanel(sessionId);
    s.fitAddon?.fit();
    return;
  }
  s.runbookPanel = buildRunbookPanel(sessionId);
  s.pane?.appendChild(s.runbookPanel);
  await renderRunbookPanel(sessionId);
  s.fitAddon?.fit();
}

function buildRunbookPanel(sessionId) {
  const panel = document.createElement("div");
  panel.className = "runbook-panel";
  const editSvg = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3l2.5 2.5-7 7-3 .5.5-3z"/><path d="M9.5 4l2.5 2.5"/></svg>`;
  const closeSvg = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
  panel.innerHTML = `
    <div class="runbook-head">
      <div class="runbook-title">${escHtml(t("notes.runbook_title"))}</div>
      <div class="runbook-head-actions">
        <button class="btn-icon runbook-edit" type="button" title="${escHtml(t("notes.open_editor"))}" aria-label="${escHtml(t("notes.open_editor"))}">${editSvg}</button>
        <button class="btn-icon runbook-close" type="button" title="${escHtml(t("notes.close"))}" aria-label="${escHtml(t("notes.close"))}">${closeSvg}</button>
      </div>
    </div>
    <div class="runbook-body markdown-body"></div>`;
  panel.querySelector(".runbook-close").addEventListener("click", () => {
    panel.classList.add("hidden");
    sessions.get(sessionId)?.fitAddon?.fit();
  });
  panel.querySelector(".runbook-edit").addEventListener("click", () => {
    const s = sessions.get(sessionId);
    if (s?.profileId) openNoteEditor(s.profileId);
  });
  return panel;
}

async function renderRunbookPanel(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.runbookPanel) return;
  const bodyEl = s.runbookPanel.querySelector(".runbook-body");
  const profile = profiles.find((p) => p.id === s.profileId);
  if (!profile) {
    bodyEl.innerHTML = `<p class="runbook-empty">${escHtml(t("notes.runbook_empty"))}</p>`;
    return;
  }
  let doc = null;
  try {
    doc = await invoke("note_get", { profileId: s.profileId });
  } catch (err) {
    console.error("[notes] runbook get", err);
  }
  if (!doc || !String(doc.body || "").trim()) {
    bodyEl.innerHTML = `<p class="runbook-empty">${escHtml(t("notes.runbook_empty"))}</p>
      <button class="btn-secondary runbook-add" type="button">${escHtml(t("notes.add_note"))}</button>`;
    bodyEl.querySelector(".runbook-add")?.addEventListener("click", () => openNoteEditor(s.profileId));
    return;
  }
  const resolved = substitutePreview(doc.body, noteSubstContext(profile));
  bodyEl.innerHTML = renderMarkdownMinimal(resolved, { onToggleTask: () => {} });
  // Cablea las casillas interactivas para que persistan en el `.md`.
  bodyEl.querySelectorAll('input[type="checkbox"][data-task-index]').forEach((cb) => {
    cb.addEventListener("change", async () => {
      const idx = Number(cb.dataset.taskIndex);
      try {
        const fresh = await invoke("note_get", { profileId: s.profileId });
        const base = fresh?.body ?? doc.body;
        const newBody = toggleTaskInBody(base, idx, cb.checked);
        await invoke("note_set", {
          profileId: s.profileId,
          body: newBody,
          title: fresh?.title || doc.title || "",
          connection: profile.name,
          tags: fresh?.tags || doc.tags || [],
        });
        await refreshNotesIndex();
        scheduleProfileAutoSync();
        renderRunbookPanel(sessionId);
      } catch (err) {
        console.error("[notes] toggle task", err);
        cb.checked = !cb.checked;
      }
    });
  });
}

/** Refresca cualquier panel runbook abierto que muestre este perfil. */
function updateRunbookForProfile(profileId) {
  for (const [sid, s] of sessions) {
    if (s.profileId === profileId && s.runbookPanel && !s.runbookPanel.classList.contains("hidden")) {
      renderRunbookPanel(sid);
    }
  }
}

/**
 * Sincroniza la pestaña "Notas" del modal de conexión con el estado actual:
 * para una conexión nueva (sin id) deshabilita el editor; para una existente
 * muestra un extracto y abre el editor Markdown del perfil.
 */
function setupModalNotePane() {
  const btn = document.getElementById("modal-note-edit-btn");
  const preview = document.getElementById("modal-note-preview");
  const saveFirst = document.getElementById("modal-note-save-first");
  if (!btn) return;
  const id = editingProfileId;
  if (!id) {
    btn.disabled = true;
    if (saveFirst) saveFirst.hidden = false;
    if (preview) { preview.hidden = true; preview.textContent = ""; }
    return;
  }
  btn.disabled = false;
  if (saveFirst) saveFirst.hidden = true;
  const summary = notesIndex.get(id);
  btn.textContent = summary ? t("notes.edit_note_btn") : t("notes.open_editor");
  if (preview) {
    if (summary?.excerpt) {
      preview.hidden = false;
      preview.textContent = summary.excerpt;
    } else {
      preview.hidden = true;
      preview.textContent = "";
    }
  }
}

// ── Historial de comandos compartido entre pestañas (opt-in) ──────────────
//
// Cuando `prefs.shareCommandHistory` está activo, los comandos tecleados en
// cualquier sesión SSH o consola local se acumulan en un único historial que
// se comparte entre todas las pestañas y se puede reutilizar desde el editor
// multilínea (Ctrl+Shift+E). El contenido vive en localStorage (no se
// sincroniza en la nube). La captura es best-effort: acumula los caracteres
// imprimibles por sesión y cierra la línea al pulsar Enter; un eco desajustado
// en el servidor puede producir alguna entrada imperfecta, aceptable para un
// historial de conveniencia.

const COMMAND_HISTORY_KEY = "rustty-command-history";
const COMMAND_HISTORY_MAX = 200;
let sharedCommandHistory = [];

function loadCommandHistory() {
  try {
    const raw = localStorage.getItem(COMMAND_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    sharedCommandHistory = Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    sharedCommandHistory = [];
  }
}

function persistCommandHistory() {
  try {
    localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(sharedCommandHistory));
  } catch {}
}

function pushCommandHistory(cmd) {
  const c = (cmd || "").trim();
  if (!c || c.length > 2000) return;
  // Evita duplicar el comando inmediatamente anterior.
  if (sharedCommandHistory[sharedCommandHistory.length - 1] === c) return;
  sharedCommandHistory.push(c);
  if (sharedCommandHistory.length > COMMAND_HISTORY_MAX) {
    sharedCommandHistory.splice(0, sharedCommandHistory.length - COMMAND_HISTORY_MAX);
  }
  persistCommandHistory();
}

/**
 * Acumula las pulsaciones de una sesión para reconstruir la línea de comando
 * y empujarla al historial al pulsar Enter. Solo actúa si el historial está
 * activado y la sesión tiene terminal (no RDP).
 */
function captureCommandKeystroke(sessionObj, data) {
  if (!prefs.shareCommandHistory) return;
  if (!sessionObj || sessionObj.type === "rdp") return;
  if (typeof data !== "string" || data.length === 0) return;

  let buf = sessionObj._histBuf || "";
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === "\r" || ch === "\n") {
      pushCommandHistory(buf);
      buf = "";
    } else if (ch === "\x7f" || ch === "\b") {
      buf = buf.slice(0, -1);                 // backspace
    } else if (code === 0x1b) {
      break;                                  // secuencia de escape (flechas…): ignora el resto del chunk
    } else if (code === 0x03 || code === 0x15) {
      buf = "";                               // Ctrl+C / Ctrl+U: descarta la línea
    } else if (code >= 0x20) {
      buf += ch;                              // imprimible
    }
    // otros caracteres de control (Tab, etc.) se ignoran sin romper la línea
  }
  sessionObj._histBuf = buf;
}

// ── Editor multilínea (Ctrl+Shift+E) ──────────────────────────────────────

let _cmdEditorDraftTimer = null;

/** Devuelve la clave de borrador para la sesión: profileId o "local". */
function _cmdEditorDraftKey(session) {
  if (!session) return null;
  // Las sesiones privadas no persisten el borrador de comando.
  if (session.private) return null;
  if (session.type === "ssh" && session.profileId) return session.profileId;
  if (session.type === "local") return "local";
  return null;
}

/**
 * Abre el editor de comandos multilínea para la sesión activa.
 * Si la sesión activa es RDP o no hay sesión, muestra un aviso y no abre.
 */
function openCommandEditor() {
  const overlay = document.getElementById("cmd-editor-overlay");
  if (!overlay) return;

  if (!activeSessionId) {
    toast(t("cmd_editor.toast_no_session"), "warning");
    return;
  }
  const session = sessions.get(activeSessionId);
  if (!session || session.type === "rdp") {
    toast(t("cmd_editor.toast_rdp"), "warning");
    return;
  }
  if (session.status === "closed") {
    toast(t("cmd_editor.toast_no_session"), "warning");
    return;
  }

  // Precarga borrador guardado
  const draftKey = _cmdEditorDraftKey(session);
  const textarea = document.getElementById("cmd-editor-textarea");
  if (textarea) {
    const saved = draftKey && prefs.commandDrafts?.[draftKey];
    textarea.value = saved || "";
  }

  hideCommandHistoryList();
  overlay.classList.remove("hidden");
  textarea?.focus();
}

/** Cierra el editor sin insertar. Guarda el borrador si hay texto. */
function closeCommandEditor(clearDraft = false) {
  const overlay = document.getElementById("cmd-editor-overlay");
  if (!overlay) return;

  // Guarda o limpia borrador
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  const draftKey = _cmdEditorDraftKey(session);
  const textarea = document.getElementById("cmd-editor-textarea");
  const text = textarea?.value ?? "";

  if (draftKey) {
    if (clearDraft || text.trim() === "") {
      if (prefs.commandDrafts) delete prefs.commandDrafts[draftKey];
    } else {
      if (!prefs.commandDrafts) prefs.commandDrafts = {};
      prefs.commandDrafts[draftKey] = text;
    }
    savePrefs();
  }

  overlay.classList.add("hidden");

  // Devuelve el foco al terminal activo
  if (activeSessionId) {
    const s = sessions.get(activeSessionId);
    s?.terminal?.focus();
  }
}

/** Inserta el texto del textarea en la sesión activa y cierra el editor. */
function insertCommandEditor() {
  const textarea = document.getElementById("cmd-editor-textarea");
  const text = textarea?.value ?? "";
  if (!text) { closeCommandEditor(false); return; }

  if (!activeSessionId) {
    toast(t("cmd_editor.toast_no_session"), "warning");
    return;
  }
  const session = sessions.get(activeSessionId);
  if (!session || session.status === "closed") {
    toast(t("cmd_editor.toast_no_session"), "warning");
    return;
  }

  sendTerminalInput(session, text);
  closeCommandEditor(true); // limpia borrador tras insertar
}

/** Inicializa los listeners del overlay del editor de comandos. */
function initCommandEditor() {
  const overlay  = document.getElementById("cmd-editor-overlay");
  const textarea = document.getElementById("cmd-editor-textarea");
  const btnInsert = document.getElementById("cmd-editor-insert");
  const btnCancel = document.getElementById("cmd-editor-cancel");
  const btnClose  = document.getElementById("cmd-editor-close");
  if (!overlay || !textarea) return;

  // Ctrl+Enter = insertar
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      insertCommandEditor();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCommandEditor(false);
    }
  });

  // Debounce al escribir: guarda borrador 800 ms tras parar
  textarea.addEventListener("input", () => {
    clearTimeout(_cmdEditorDraftTimer);
    _cmdEditorDraftTimer = setTimeout(() => {
      const session = activeSessionId ? sessions.get(activeSessionId) : null;
      const draftKey = _cmdEditorDraftKey(session);
      if (draftKey) {
        if (!prefs.commandDrafts) prefs.commandDrafts = {};
        prefs.commandDrafts[draftKey] = textarea.value;
        savePrefs();
      }
    }, 800);
  });

  btnInsert?.addEventListener("click", () => insertCommandEditor());
  btnCancel?.addEventListener("click", () => closeCommandEditor(false));
  btnClose?.addEventListener("click",  () => closeCommandEditor(false));

  // Botón de historial: alterna el desplegable de comandos recientes
  const btnHistory = document.getElementById("cmd-editor-history-btn");
  btnHistory?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCommandHistoryList();
  });

  // Clic en el backdrop cierra sin insertar (y oculta el historial)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeCommandEditor(false);
    hideCommandHistoryList();
  });
}

/** Muestra u oculta el desplegable de historial del editor de comandos. */
function toggleCommandHistoryList() {
  const list = document.getElementById("cmd-editor-history-list");
  if (!list) return;
  if (list.classList.contains("hidden")) renderCommandHistoryList();
  else hideCommandHistoryList();
}

function hideCommandHistoryList() {
  document.getElementById("cmd-editor-history-list")?.classList.add("hidden");
}

/** Rellena el desplegable con los comandos recientes (más reciente arriba). */
function renderCommandHistoryList() {
  const list = document.getElementById("cmd-editor-history-list");
  const textarea = document.getElementById("cmd-editor-textarea");
  if (!list || !textarea) return;
  list.innerHTML = "";

  const items = sharedCommandHistory.slice(-40).reverse();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cmd-editor-history-empty";
    empty.textContent = prefs.shareCommandHistory
      ? t("cmd_editor.history_empty")
      : t("cmd_editor.history_disabled");
    list.appendChild(empty);
  } else {
    for (const cmd of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cmd-editor-history-row";
      row.setAttribute("role", "option");
      row.textContent = cmd;
      row.title = cmd;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        textarea.value = cmd;
        hideCommandHistoryList();
        textarea.focus();
      });
      list.appendChild(row);
    }
  }
  list.classList.remove("hidden");
}

/**
 * Alterna la visibilidad de la barra lateral y persiste el estado.
 * Después del cambio hace `fit` de los terminales visibles porque el
 * área principal cambia de anchura.
 */
/**
 * Modo zen / distraction-free: oculta rail + sidebar + tab-bar y deja solo
 * el área del terminal. Persiste en localStorage para que el atajo recuerde
 * el estado entre sesiones (útil si la app queda en una pantalla secundaria
 * para presentar / grabar).
 */
const ZEN_MODE_KEY = "rustty-zen-mode";

function loadZenMode() {
  return localStorage.getItem(ZEN_MODE_KEY) === "1";
}

function applyZenMode(enabled) {
  document.body.classList.toggle("zen-mode", !!enabled);
  localStorage.setItem(ZEN_MODE_KEY, enabled ? "1" : "0");
  requestAnimationFrame(() => {
    for (const sid of viewSelection) {
      const s = sessions.get(sid);
      if (s?.fitAddon) { try { s.fitAddon.fit(); notifyResize(sid, s.terminal); } catch {} }
    }
  });
}

function toggleZenMode() {
  applyZenMode(!document.body.classList.contains("zen-mode"));
}

const SIDEBAR_MODE_KEY = "rustty-sidebar-mode";
const SIDEBAR_MODES = ["expanded", "hidden"];

function loadSidebarMode() {
  const stored = localStorage.getItem(SIDEBAR_MODE_KEY);
  if (SIDEBAR_MODES.includes(stored)) return stored;
  // Migración del flag binario antiguo.
  if (localStorage.getItem("rustty-sidebar-collapsed") === "1") return "hidden";
  return "expanded";
}

function applySidebarMode(mode) {
  const m = SIDEBAR_MODES.includes(mode) ? mode : "expanded";
  document.body.classList.toggle("sidebar-collapsed", m === "hidden");
  document.body.classList.toggle("sidebar-mode-expanded", m === "expanded");
  document.body.classList.remove("sidebar-mode-rail");
  localStorage.setItem(SIDEBAR_MODE_KEY, m);
}

function initSidebarToggle() {
  const btn = document.getElementById("btn-toggle-sidebar");
  if (!btn) return;

  applySidebarMode(loadSidebarMode());

  btn.addEventListener("click", () => {
    const current = loadSidebarMode();
    const next = current === "hidden" ? "expanded" : "hidden";
    applySidebarMode(next);
    // Los xterms necesitan re-fit cuando cambia la anchura del contenedor
    requestAnimationFrame(() => {
      for (const sid of viewSelection) {
        const s = sessions.get(sid);
        if (s?.fitAddon) { try { s.fitAddon.fit(); notifyResize(sid, s.terminal); } catch {} }
      }
    });
  });
}

const SIDEBAR_WIDTH_KEY = "rustty-sidebar-width";
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 520;

/**
 * Acelera el scroll de la rueda en la lista de conexiones. El scroll nativo de
 * WebKitGTK avanza en pasos pequeños y se siente "atrancado"; aquí tomamos el
 * control del evento `wheel` y desplazamos una cantidad proporcional a la
 * velocidad real del ratón (con un multiplicador), de forma análoga a
 * `scrollSensitivity` en xterm. No se toca el zoom (Ctrl+rueda) ni el scroll
 * horizontal.
 */
const SIDEBAR_SCROLL_MULTIPLIER = 1.8;

function initSidebarScrollSpeed() {
  const list = document.getElementById("connection-list");
  if (!list) return;
  list.addEventListener("wheel", (e) => {
    if (e.ctrlKey) return;                                  // reservado para zoom
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;    // gesto horizontal
    if (list.scrollHeight <= list.clientHeight) return;     // sin overflow: nada que hacer
    // deltaMode 1 = líneas (rueda clásica) → px aproximados; 0 = píxeles (trackpad)
    const pixels = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    list.scrollTop += pixels * SIDEBAR_SCROLL_MULTIPLIER;
    e.preventDefault();
  }, { passive: false });
}

function initSidebarResize() {
  const handle = document.getElementById("sidebar-resize-handle");
  if (!handle) return;

  const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
  if (Number.isFinite(stored) && stored >= SIDEBAR_WIDTH_MIN && stored <= SIDEBAR_WIDTH_MAX) {
    document.documentElement.style.setProperty("--sidebar-width", `${stored}px`);
  }

  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const w = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, startWidth + delta));
    document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sidebar-resizing");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10);
    if (Number.isFinite(current)) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(current));
    requestAnimationFrame(() => {
      for (const sid of viewSelection) {
        const s = sessions.get(sid);
        if (s?.fitAddon) { try { s.fitAddon.fit(); notifyResize(sid, s.terminal); } catch {} }
      }
    });
  };

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (document.body.classList.contains("sidebar-collapsed")) return;
    dragging = true;
    startX = e.clientX;
    const sidebar = document.getElementById("sidebar");
    startWidth = sidebar?.getBoundingClientRect().width || 240;
    document.body.classList.add("sidebar-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  // Doble clic en el handle: restablecer al ancho por defecto.
  handle.addEventListener("dblclick", () => {
    document.documentElement.style.setProperty("--sidebar-width", "240px");
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  });
}

/**
 * Controles de ventana integrados (CSD: decorations:false).
 * En macOS dejamos los traffic lights nativos (titleBarStyle Overlay),
 * así que ocultamos nuestros botones y añadimos un padding a la izquierda
 * del tab-bar vía la clase `platform-macos`.
 */
async function initWindowControls() {
  // Detección de plataforma a partir del UA de la webview.
  const ua = navigator.userAgent || "";
  const cls = /Mac OS X|Macintosh/.test(ua) ? "platform-macos"
            : /Windows/.test(ua)            ? "platform-windows"
            :                                 "platform-linux";
  document.body.classList.add(cls);

  let win;
  try {
    const mod = await import("@tauri-apps/api/window");
    win = mod.getCurrentWindow();
    // Restauramos tamaño/posición/maximizado ANTES de mostrar la ventana.
    // Así el estado del plugin window-state ya está aplicado cuando la ventana
    // se hace visible y evitamos un salto visible tras el primer paint.
    await restoreWindowStateNow(win);
    // Si la app fue lanzada por el autostart del SO con --minimized, no
    // mostramos la ventana: queda oculta y el tray sigue operativo.
    const launchedMinimized = await invoke("is_launched_minimized").catch(() => false);
    if (!launchedMinimized) {
      revealWindowAfterPaint(win);
    }
    initWindowResizeHandles(win);
  } catch {
    return; // fuera de Tauri (p. ej. vite dev puro): no hay ventana
  }

  const btnMin   = document.getElementById("btn-win-min");
  const btnMax   = document.getElementById("btn-win-max");
  const btnClose = document.getElementById("btn-win-close");

  btnMin  ?.addEventListener("click", () => win.minimize());
  btnMax  ?.addEventListener("click", async () => {
    await win.toggleMaximize();
    scheduleWindowStateSave();
  });
  let closeRequested = false;
  btnClose?.addEventListener("click", async () => {
    if (closeRequested) return;
    closeRequested = true;
    btnClose.disabled = true;

    const fallbackTimer = setTimeout(() => {
      forceCloseApp(win);
    }, WINDOW_CLOSE_FALLBACK_MS);

    try {
      await settleWithin(saveWindowStateNow(), WINDOW_STATE_CLOSE_SAVE_TIMEOUT_MS);
      await win.close();
    } catch {
      clearTimeout(fallbackTimer);
      await forceCloseApp(win);
    }
  });

  // El doble clic en data-tauri-drag-region ya maximiza/restaura nativamente;
  // no añadimos listener JS para evitar el doble toggle (maximiza+restaura).

  // Mantener el icono maximizar/restaurar sincronizado con el estado.
  const syncMaximized = async () => {
    try {
      const isMax = await win.isMaximized();
      document.body.classList.toggle("window-maximized", !!isMax);
    } catch {}
  };
  syncMaximized();
  try {
    win.onResized(() => {
      syncMaximized();
      scheduleWindowStateSave();
    });
  } catch {}
  try {
    win.onMoved(() => scheduleWindowStateSave());
  } catch {}
  try {
    win.onCloseRequested(() => saveWindowStateNow());
  } catch {}
}

let _windowStateSaveTimer = null;

function scheduleWindowStateSave() {
  clearTimeout(_windowStateSaveTimer);
  _windowStateSaveTimer = setTimeout(() => saveWindowStateNow(), 400);
}

function settleWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function forceCloseApp(win) {
  try {
    await invoke("close_app");
    return;
  } catch {}

  try {
    await win.destroy();
  } catch {}
}

async function saveWindowStateNow() {
  try {
    await invoke("plugin:window-state|save_window_state", {
      flags: WINDOW_STATE_FLAGS_SIZE_POSITION_MAXIMIZED,
    });
  } catch {}
}

/**
 * Arranque visual sin flash: la ventana nace oculta (`visible:false` en
 * tauri.conf.json) y la revelamos solo tras el primer paint, una vez aplicados
 * tema y estilos. Un doble requestAnimationFrame garantiza que el navegador ha
 * pintado al menos un frame antes de `show()`. Como salvaguarda anti-bloqueo,
 * un setTimeout fuerza el `show()` aunque el rAF no llegara a dispararse (p. ej.
 * pestaña en segundo plano), evitando que la ventana quede oculta para siempre.
 */
function revealWindowAfterPaint(win) {
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    win.show().catch(() => {});
  };
  requestAnimationFrame(() => requestAnimationFrame(show));
  setTimeout(show, 1500);
}

async function restoreWindowStateNow(win) {
  try {
    await invoke("plugin:window-state|restore_state", {
      label: win?.label || "main",
      flags: WINDOW_STATE_FLAGS_SIZE_POSITION_MAXIMIZED,
    });
  } catch {}
}

function initWindowResizeHandles(win) {
  document.querySelectorAll("[data-resize-dir]").forEach((handle) => {
    handle.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        if (await win.isMaximized()) return;
        await win.startResizeDragging(handle.dataset.resizeDir);
      } catch {}
    });
  });
}

function switchTab(delta) {
  const order = [null, ...document.querySelectorAll("#tabs-container .tab")]
    .map((el) => el?.dataset?.session ?? null);
  if (!order.length) return;
  const current = viewSelection.length === 0 ? null : activeSessionId;
  const idx = order.indexOf(current);
  const next = ((idx < 0 ? 0 : idx) + delta + order.length) % order.length;
  if (order[next] === null) selectHomeTab();
  else setActiveTab(order[next]);
}

// ═══════════════════════════════════════════════════════════════
// STEPPERS NUMÉRICOS
// ═══════════════════════════════════════════════════════════════

function enhanceNumberSteppers(root = document) {
  root.querySelectorAll('.settings-control input[type="number"]').forEach((input) => {
    if (input.dataset.stepperEnhanced === "1") return;
    input.dataset.stepperEnhanced = "1";

    const wrapper = document.createElement("div");
    wrapper.className = "number-stepper";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const buttons = document.createElement("div");
    buttons.className = "number-stepper-buttons";
    buttons.innerHTML = `
      <button type="button" class="number-stepper-btn" data-step-dir="up" data-i18n-aria-label="number_stepper.increase" data-i18n-title="number_stepper.increase">▲</button>
      <button type="button" class="number-stepper-btn" data-step-dir="down" data-i18n-aria-label="number_stepper.decrease" data-i18n-title="number_stepper.decrease">▼</button>
    `;
    wrapper.appendChild(buttons);
    applyTranslations(wrapper);

    buttons.addEventListener("mousedown", (e) => e.preventDefault());
    buttons.addEventListener("click", (e) => {
      const btn = e.target.closest(".number-stepper-btn");
      if (!btn || input.disabled || input.readOnly) return;
      input.focus();
      stepNumberInput(input, btn.dataset.stepDir === "up" ? 1 : -1);
    });
  });
}

function stepNumberInput(input, direction) {
  const previous = input.value;

  if (input.value === "") {
    const min = Number.parseFloat(input.min);
    input.value = Number.isFinite(min) ? String(min) : "0";
  }

  try {
    if (direction > 0) input.stepUp();
    else input.stepDown();
  } catch {
    const current = Number.parseFloat(input.value);
    const step = Number.parseFloat(input.step);
    const min = Number.parseFloat(input.min);
    const max = Number.parseFloat(input.max);
    const precision = getStepPrecision(input.step);
    let next = (Number.isFinite(current) ? current : 0) + direction * (Number.isFinite(step) ? step : 1);

    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    input.value = formatSteppedNumber(next, precision);
  }

  if (input.value !== previous) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function getStepPrecision(stepValue) {
  if (!stepValue || stepValue === "any") return 0;
  const decimal = String(stepValue).split(".")[1];
  return decimal ? decimal.length : 0;
}

function formatSteppedNumber(value, precision) {
  return precision > 0
    ? value.toFixed(precision).replace(/\.?0+$/, "")
    : String(Math.round(value));
}

// ═══════════════════════════════════════════════════════════════
// DROPDOWN PERSONALIZADO
// Sustituye los <select> nativos (que en WebKitGTK ignoran el tema
// de la app) por un control con los colores del tema Catppuccin.
// ═══════════════════════════════════════════════════════════════

function enhanceSelect(selectEl) {
  if (selectEl.dataset.enhanced === "1") return;
  selectEl.dataset.enhanced = "1";

  const wrapper = document.createElement("div");
  wrapper.className = "custom-select";
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);

  const display = document.createElement("button");
  display.type = "button";
  display.className = "custom-select-display";
  wrapper.appendChild(display);

  const list = document.createElement("div");
  list.className = "custom-select-list hidden";
  document.body.appendChild(list);

  function refresh() {
    const opt = selectEl.options[selectEl.selectedIndex];
    display.textContent = opt ? opt.textContent : "";
    list.innerHTML = "";
    [...selectEl.options].forEach((o, i) => {
      const item = document.createElement("div");
      item.className = "custom-select-item";
      if (i === selectEl.selectedIndex) item.classList.add("active");
      item.textContent = o.textContent;
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        if (selectEl.value !== o.value) {
          selectEl.value = o.value;
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        close();
      });
      list.appendChild(item);
    });
  }

  function position() {
    const r = display.getBoundingClientRect();
    list.style.left     = r.left + "px";
    list.style.minWidth = r.width + "px";
    list.style.maxWidth = Math.max(r.width, 320) + "px";

    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const maxH = 240;
    if (spaceBelow < 140 && spaceAbove > spaceBelow) {
      list.style.top      = "auto";
      list.style.bottom   = (window.innerHeight - r.top + 4) + "px";
      list.style.maxHeight = Math.min(maxH, spaceAbove - 12) + "px";
    } else {
      list.style.top      = (r.bottom + 4) + "px";
      list.style.bottom   = "auto";
      list.style.maxHeight = Math.min(maxH, spaceBelow - 12) + "px";
    }
  }

  function open() {
    refresh();
    wrapper.classList.add("open");
    list.classList.remove("hidden");
    position();
  }

  function close() {
    wrapper.classList.remove("open");
    list.classList.add("hidden");
  }

  function toggle() {
    list.classList.contains("hidden") ? open() : close();
  }

  display.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  const onDocMouseDown = (e) => {
    if (list.classList.contains("hidden")) return;
    if (wrapper.contains(e.target) || list.contains(e.target)) return;
    close();
  };
  const onResize = () => {
    if (!list.classList.contains("hidden")) position();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape" && !list.classList.contains("hidden")) close();
  };
  document.addEventListener("mousedown", onDocMouseDown);
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKeyDown);

  // Observar cambios en las options (innerHTML = …, appendChild, etc.)
  const observer = new MutationObserver(refresh);
  observer.observe(selectEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["selected", "disabled", "value"],
  });

  // Limpieza para los <select> dinámicos (filas de usuarios extra): al quitar la
  // fila se invoca para no dejar la lista flotante ni los listeners colgando.
  selectEl._destroyEnhanced = () => {
    observer.disconnect();
    list.remove();
    document.removeEventListener("mousedown", onDocMouseDown);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKeyDown);
  };

  // Interceptar asignaciones `selectEl.value = X` para actualizar el display
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(selectEl, "value", {
    configurable: true,
    get() { return proto.get.call(selectEl); },
    set(v) { proto.set.call(selectEl, v); refresh(); },
  });

  refresh();
}

// ═══════════════════════════════════════════════════════════════
// MENÚ CONTEXTUAL DE PESTAÑAS
// ═══════════════════════════════════════════════════════════════

let tabCtxTargetId = null;

function showTabContextMenu(x, y, sessionId) {
  tabCtxTargetId = sessionId;
  const menu = document.getElementById("tab-context-menu");

  const inView     = viewSelection.includes(sessionId);
  const viewSize   = viewSelection.length;
  const canAdd     = !inView && viewSize >= 1;
  const canRemove  = inView && viewSize > 1;
  const canSolo    = !(viewSize === 1 && inView);
  const showLayout = viewSize > 1;

  menu.querySelector(".tabctx-view-add"   ).classList.toggle("hidden", !canAdd);
  menu.querySelector(".tabctx-view-remove").classList.toggle("hidden", !canRemove);
  menu.querySelector(".tabctx-view-solo"  ).classList.toggle("hidden", !canSolo);
  menu.querySelector(".tabctx-view-sep"   ).classList.toggle("hidden",
    !(canAdd || canRemove || canSolo));

  menu.querySelectorAll(".tabctx-layout").forEach((el) => {
    el.classList.toggle("hidden", !showLayout);
    const layout = el.dataset.tabctx.replace("layout-", "");
    el.classList.toggle("active", showLayout && getViewLayout() === layout);
  });
  menu.querySelector(".tabctx-layout-sep").classList.toggle("hidden", !showLayout);

  // "Exportar historial" solo tiene sentido en sesiones con terminal (no RDP).
  const ctxSession = sessions.get(sessionId);
  const canExportHistory = !!ctxSession?.terminal;
  menu.querySelector(".tabctx-export-history")?.classList.toggle("hidden", !canExportHistory);

  // "Duplicar con cambios" solo aplica a sesiones SSH con perfil (no consola
  // local, RDP ni FTP).
  const canDupOverrides = ctxSession?.type === "ssh" && !!ctxSession.profileId
    && !ctxSession._closeOverride;
  menu.querySelector(".tabctx-dup-overrides")?.classList.toggle("hidden", !canDupOverrides);

  const targetTab = document.querySelector(`.tab[data-session="${CSS.escape(sessionId)}"]`);
  const isPinned = !!targetTab?.classList.contains("is-pinned");
  const pinLabel = menu.querySelector(".tabctx-pin-label");
  if (pinLabel) pinLabel.textContent = isPinned ? t("tabctx.unpin") : t("tabctx.pin");

  menu.style.left = "0px";
  menu.style.top  = "0px";
  menu.classList.remove("hidden");
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth  - width  - 6) + "px";
  menu.style.top  = Math.min(y, window.innerHeight - height - 6) + "px";
}

function hideTabContextMenu() {
  document.getElementById("tab-context-menu").classList.add("hidden");
  tabCtxTargetId = null;
}

async function handleTabContextAction(action) {
  const targetId = tabCtxTargetId;
  hideTabContextMenu();
  if (!targetId) return;

  if (action === "pin") {
    const tab = document.querySelector(`.tab[data-session="${CSS.escape(targetId)}"]`);
    if (tab) {
      tab.classList.toggle("is-pinned");
      // Movemos las pestañas ancladas al principio para mantenerlas
      // siempre visibles. Estado solo en runtime; no persiste entre sesiones.
      const container = document.getElementById("tabs-container");
      if (container) {
        const pinned = [...container.querySelectorAll(".tab.is-pinned")];
        const others = [...container.querySelectorAll(".tab:not(.is-pinned)")];
        pinned.forEach((el) => container.appendChild(el));
        others.forEach((el) => container.appendChild(el));
      }
    }
    return;
  }

  if (action === "rename") {
    const s = sessions.get(targetId);
    if (!s) return;
    // El alias es por sesión (runtime): no toca el perfil ni profiles.json.
    const profile = profiles.find((p) => p.id === s.profileId);
    const result = await promptCredential({
      title: t("tab_rename.title"),
      message: t("tab_rename.message"),
      label: t("tab_rename.label"),
      submitLabel: t("tab_rename.submit"),
      inputType: "text",
      initialValue: s.alias || "",
    });
    if (!result) return; // Cancelado: no cambiamos nada.
    const value = (result.value || "").trim();
    if (value) {
      s.alias = value;
    } else {
      // Vaciar = restablecer al nombre del perfil.
      delete s.alias;
    }
    updateTabLabel(targetId);
    return;
  }

  if (action === "export-history") {
    await exportSessionHistory(targetId);
    return;
  }

  if (action === "close") {
    await closeSession(targetId);
    return;
  }
  if (action === "close-all" || action === "close-others" || action === "close-right") {
    let ids;
    if (action === "close-all") {
      ids = [...sessions.keys()];
    } else if (action === "close-others") {
      ids = [...sessions.keys()].filter((sid) => sid !== targetId);
    } else {
      const order = [...document.querySelectorAll("#tabs-container .tab")]
        .map((el) => el.dataset.session);
      const idx = order.indexOf(targetId);
      if (idx < 0) return;
      ids = order.slice(idx + 1);
    }
    // Las pestañas ancladas no se cierran con acciones en lote.
    ids = ids.filter((sid) => {
      const tab = document.querySelector(`.tab[data-session="${CSS.escape(sid)}"]`);
      return !tab?.classList.contains("is-pinned");
    });
    const liveCount = ids.filter((sid) => {
      const s = sessions.get(sid);
      return isSessionLive(s) || sessionHasActiveTransfers(s);
    }).length;
    if (liveCount > 0) {
      const ok = await confirmThemed({
        title: "Cerrar pestañas",
        message: `Hay ${liveCount} ${liveCount === 1 ? "conexión activa" : "conexiones activas"} entre las pestañas a cerrar. ¿Continuar y desconectarlas?`,
        submitLabel: "Cerrar todas",
        danger: true,
      });
      if (!ok) return;
    }
    for (const sid of ids) await closeSession(sid, { skipConfirm: true });
    return;
  }
  if (action === "duplicate") {
    const s = sessions.get(targetId);
    if (!s) return;
    if (s._closeOverride) { openLocalShell(); return; }
    if (s.type === "rdp") { connectRdp(s.profileId); return; }
    if (s.profileId) { connectProfile(s.profileId, { force: true }); return; }
    return;
  }
  if (action === "duplicate-overrides") {
    const s = sessions.get(targetId);
    if (s?.profileId && s.type === "ssh") duplicateSessionWithOverrides(s.profileId);
    return;
  }
  if (action === "view-add") {
    if (!viewSelection.includes(targetId)) {
      selectSession(targetId, true);
    }
    return;
  }
  if (action === "view-remove") {
    const idx = viewSelection.indexOf(targetId);
    if (idx >= 0 && viewSelection.length > 1) {
      viewSelection.splice(idx, 1);
      if (activeSessionId === targetId) activeSessionId = viewSelection[0];
      renderView();
      updateStatusBar();
    }
    return;
  }
  if (action === "view-solo") {
    selectSession(targetId, false);
    return;
  }
  if (action.startsWith("layout-")) {
    setViewLayout(action.slice("layout-".length));
    return;
  }
}

/**
 * Vuelca todo el buffer de la sesión (scrollback incluido) a un fichero `.txt`:
 * tanto los comandos introducidos como lo que el servidor ha devuelto por
 * pantalla. Lee el buffer activo de xterm.js en texto plano (sin secuencias SGR).
 */
async function exportSessionHistory(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.terminal) return;

  const buffer = s.terminal.buffer.active;
  const lines = [];
  // baseY + rows cubre el scrollback completo más la pantalla visible.
  const total = buffer.length;
  for (let i = 0; i < total; i++) {
    const line = buffer.getLine(i);
    // translateToString(true) recorta los espacios finales de cada línea.
    lines.push(line ? line.translateToString(true) : "");
  }
  // Eliminar líneas vacías sobrantes al final del buffer.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  const profile = profiles.find((p) => p.id === s.profileId);
  const baseName = profile?.name || (s._closeOverride ? "consola-local" : (s.type ? s.type.toUpperCase() : "sesion"));
  const safeName = baseName.replace(/[^\w.-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultName = `rustty-${safeName}-${stamp}.txt`;

  let path;
  try {
    path = await saveDialog({
      title: t("tabctx.export_history"),
      defaultPath: defaultName,
      filters: [{ name: "Texto", extensions: ["txt"] }],
    });
  } catch (err) {
    toast(`Error al abrir diálogo: ${err}`, "error");
    return;
  }
  if (!path) return; // usuario canceló

  try {
    await invoke("write_text_file", { path, contents: lines.join("\n") + "\n" });
    toast(t("toast.history_exported") || "Historial exportado", "success");
  } catch (err) {
    toast(`Error al escribir fichero: ${err}`, "error");
  }
}

// ═══════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TOAST_VISIBLE_LIMIT = 3;

/**
 * Categorías que se agrupan (coalescing): si ya hay un toast visible de la
 * misma categoría, en vez de apilar otro se reutiliza el existente, se
 * actualiza con el último mensaje/acción y se muestra un badge "+N más" con
 * los eventos extra agrupados. Las categorías fuera de esta lista (info
 * puntual) se comportan como antes: un toast independiente por llamada.
 */
const TOAST_COALESCE_CATEGORIES = new Set(["transfer", "sync", "error"]);

// Toast vivo por categoría agrupable, para reutilizarlo mientras esté visible.
const activeCategoryToasts = new Map();

/**
 * Deriva la categoría de un toast. Prioriza `options.category` explícito
 * (usado en transferencias/sincronización); si no, la infiere del `type`
 * para no tener que tocar las llamadas existentes: los errores se agrupan
 * bajo "error" y el resto queda como "default" (sin coalescing).
 */
function toastCategory(type, options) {
  if (options && options.category) return options.category;
  if (type === "error") return "error";
  return "default";
}

function toast(message, type = "info", ms = 3500, options = {}) {
  if (typeof ms === "object" && ms !== null) {
    options = ms;
    ms = 3500;
  }
  if (!options.skipActivity) {
    recordActivity({
      kind: "toast",
      status: type,
      title: String(message),
      actionLabel: options.actionLabel || "",
      action: options.onAction || null,
    });
  }
  if (type === "error" && !options.actionLabel) {
    options = {
      ...options,
      actionLabel: t("toast.copy_error"),
      onAction: () => writeSystemClipboardText(String(message)),
    };
  }
  const container = document.getElementById("toast-container");
  const category = toastCategory(type, options);

  // Coalescing: reutiliza el toast vivo de esta categoría, si lo hay.
  if (TOAST_COALESCE_CATEGORIES.has(category)) {
    const existing = activeCategoryToasts.get(category);
    if (existing && existing.el.isConnected) {
      existing.extra += 1;
      updateToastContent(existing.el, message, type, options, existing.extra);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(
        () => dismissToast(existing.el, category),
        ms,
      );
      refreshToastOverflowCounter();
      return;
    }
  }

  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.dataset.category = category;
  updateToastContent(el, message, type, options, 0);
  container.appendChild(el);

  const timer = setTimeout(() => dismissToast(el, category), ms);
  if (TOAST_COALESCE_CATEGORIES.has(category)) {
    activeCategoryToasts.set(category, { el, extra: 0, timer });
  }
  refreshToastOverflowCounter();
}

/**
 * (Re)pinta el contenido de un toast: mensaje, acción y, si procede, el badge
 * "+N más" con los eventos agrupados de su categoría. Se usa tanto al crear el
 * toast como al actualizarlo durante el coalescing, conservando la
 * accionabilidad (p. ej. "Copiar error"/"Ver log") del último evento.
 */
function updateToastContent(el, message, type, options, extra) {
  el.className = `toast ${type}`;
  if (el.dataset.category) el.classList.add(`toast-cat-${el.dataset.category}`);
  el.replaceChildren();

  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  el.appendChild(text);

  if (extra > 0) {
    const badge = document.createElement("span");
    badge.className = "toast-count";
    badge.textContent = t("toast.more", { n: extra });
    el.appendChild(badge);
  }

  if (options.actionLabel && typeof options.onAction === "function") {
    const category = el.dataset.category;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = options.actionLabel;
    btn.addEventListener("click", () => {
      options.onAction();
      dismissToast(el, category);
    });
    el.appendChild(btn);
  }
}

/**
 * Cierra un toast y, si pertenece a una categoría agrupable, resetea el grupo
 * para que el siguiente evento de esa categoría vuelva a crear un toast nuevo.
 */
function dismissToast(el, category) {
  const tracked = category && activeCategoryToasts.get(category);
  if (tracked && tracked.el === el) {
    clearTimeout(tracked.timer);
    activeCategoryToasts.delete(category);
  }
  el.remove();
  refreshToastOverflowCounter();
}

/**
 * Apila los toasts: solo se muestran a la vez `TOAST_VISIBLE_LIMIT`; los
 * demás quedan colapsados detrás de un contador "+N" que abre el centro de
 * actividad (donde queda registrado el histórico). El counter se mantiene
 * sincronizado siempre que un toast aparece o desaparece.
 */
function refreshToastOverflowCounter() {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const all = [...container.querySelectorAll(".toast:not(.toast-overflow)")];
  const overflow = all.length - TOAST_VISIBLE_LIMIT;
  all.forEach((t, idx) => {
    t.classList.toggle("toast-hidden", idx < all.length - TOAST_VISIBLE_LIMIT);
  });
  let counter = container.querySelector(".toast.toast-overflow");
  if (overflow > 0) {
    if (!counter) {
      counter = document.createElement("div");
      counter.className = "toast toast-overflow";
      counter.setAttribute("role", "status");
      counter.addEventListener("click", () => {
        openActivityCenter();
        all.forEach((t) => t.remove());
        counter?.remove();
        activeCategoryToasts.clear();
      });
      container.prepend(counter);
    }
    counter.textContent = t("toast.more", { n: overflow });
  } else if (counter) {
    counter.remove();
  }
}

// ═══════════════════════════════════════════════════════════════
// ARRANQUE
// ═══════════════════════════════════════════════════════════════

init();
