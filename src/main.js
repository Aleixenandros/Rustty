/**
 * Rustty – Frontend principal
 * Stack: Vite + Vanilla JS + Xterm.js + Tauri 2 API
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import * as sync from "./sync.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
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
  sftpConflictPolicy: "ask",   // "ask" | "overwrite" | "skip" | "rename"
  sftpVerifySize:  false,
  fontSize:        14,
  // Tipografía fina del terminal
  fontFamily:      "",        // "" = usar cadena por defecto con fallback monospace
  lineHeight:      1.0,       // 1.0 = normal; xterm.js admite >0
  letterSpacing:   0,         // píxeles; positivo separa, negativo junta
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
  // Modo de la vista de la sidebar: "current" | "all" | "favorites".
  sidebarViewMode: "current",
  // Color por carpeta. Mapa { folderPath: colorId } donde colorId es uno de
  // los presets en FOLDER_COLOR_PRESETS o null para "sin color".
  folderColors:    {},
  // Reglas de resaltado por regex aplicadas a la salida del terminal.
  // Cada regla: { pattern: string, color: "red"|"yellow"|"green"|"blue"|"magenta"|"cyan"|"white", bold: bool }.
  // Se aplican en orden — la primera coincidencia gana.
  highlightRules:  [],
};

// Paleta de colores predefinidos para las carpetas. Cada entrada es el id que
// se persiste en prefs.folderColors[path] y el color (var CSS) que se usa
// para pintar la franja izquierda del folder-header (--folder-tint).
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

let prefs = { ...DEFAULT_PREFS };

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
  if (!prefs.lang || !SUPPORTED_LANGS.includes(prefs.lang)) {
    prefs.lang = detectLanguage();
  }
  setLanguage(prefs.lang);
  applyTranslations();
  registerAllCustomThemes();
  applyTheme(prefs.theme);
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
  const base = (override && override !== "inherit") ? override : prefs.theme;
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

/** Registra un tema custom en runtime: extiende TERMINAL_THEMES, inyecta
 *  CSS vars bajo `html.theme-<id>` y añade un swatch a los pickers. */
function registerCustomTheme(theme) {
  TERMINAL_THEMES[theme.id] = theme.terminal;
  const cssClass = `theme-${theme.id}`;
  if (!THEME_CLASSES.includes(cssClass)) THEME_CLASSES.push(cssClass);

  let styleEl = document.getElementById("rustty-custom-themes-style");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "rustty-custom-themes-style";
    document.head.appendChild(styleEl);
  }
  const decl = UI_THEME_TOKENS
    .map((token) => theme.ui[token] ? `--${token}: ${theme.ui[token]};` : "")
    .filter(Boolean).join(" ");
  styleEl.appendChild(
    document.createTextNode(`\nhtml.${cssClass} { ${decl} }\n`)
  );

  // Swatches en ambos pickers (UI + terminal)
  appendCustomSwatch("ui", theme);
  appendCustomSwatch("terminal", theme);
}

function registerBundledTheme(theme) {
  BUNDLED_THEME_IDS.add(theme.id);
  registerCustomTheme(theme);
}

function appendCustomSwatch(picker, theme) {
  const root = document.querySelector(`.theme-picker[data-for="${picker}"]`);
  if (!root) return;
  let label = root.querySelector(`.theme-option[data-theme="${CSS.escape(theme.id)}"]`);
  if (!label) {
    label = document.createElement("label");
    label.className = "theme-option";
    label.dataset.theme = theme.id;
    root.appendChild(label);
  }
  label.className = "theme-option";
  label.dataset.theme = theme.id;
  const inputName = picker === "ui" ? "pref-theme" : "pref-terminal-theme";
  label.innerHTML = `
    <input type="radio" name="${inputName}" value="${escHtml(theme.id)}" />
    <div class="theme-preview" style="background:${escHtml(theme.ui.base || "#222")}">
      <div class="theme-preview-sidebar" style="background:${escHtml(theme.ui.mantle || "#1a1a1a")}"></div>
      <div class="theme-preview-main" style="background:${escHtml(theme.ui.base || "#222")}"></div>
    </div>
    <span class="theme-label">${escHtml(theme.name)}</span>`;
  const radio = label.querySelector("input");
  radio.addEventListener("change", () => {
    if (picker === "ui") selectUiTheme(theme.id);
    else selectTerminalTheme(theme.id);
  });
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
      if (BASE_THEME_IDS.has(theme.id)) continue;
      validThemes.push(theme);
      registerCustomTheme(theme);
    } catch (err) {
      console.warn("[theme] invalid custom theme skipped", err);
    }
  }
  prefs.customThemes = validThemes;
}

async function registerBundledThemePacks() {
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
  document.querySelectorAll('input[name="pref-theme"]').forEach((r) => {
    r.checked = (r.value === theme);
  });
  document.querySelectorAll('.theme-picker[data-for="ui"] .theme-option').forEach((o) =>
    o.classList.toggle("selected", o.dataset.theme === theme)
  );
  applyTheme(theme);
}

function selectTerminalTheme(value) {
  document.querySelectorAll('input[name="pref-terminal-theme"]').forEach((r) => {
    r.checked = (r.value === value);
  });
  document.querySelectorAll('.theme-picker[data-for="terminal"] .theme-option').forEach((o) =>
    o.classList.toggle("selected", o.dataset.theme === value)
  );
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
  document.getElementById("pref-sftp-conflict-policy").value = normalizeSftpConflictPolicy(prefs.sftpConflictPolicy);
  document.getElementById("pref-sftp-verify-size").checked = !!prefs.sftpVerifySize;
  populateFontFamilySelect(prefs.fontFamily || "");
  document.getElementById("pref-font-size").value           = prefs.fontSize;
  document.getElementById("pref-line-height").value         = prefs.lineHeight;
  document.getElementById("pref-letter-spacing").value      = prefs.letterSpacing;
  document.getElementById("pref-cursor-style").value        = prefs.cursorStyle;
  document.getElementById("pref-cursor-blink").checked      = prefs.cursorBlink;
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

  // Tema del terminal: si no hay override se marca "inherit"
  const termVal = prefs.terminalTheme || "inherit";
  document.querySelectorAll('input[name="pref-terminal-theme"]').forEach((r) => {
    r.checked = (r.value === termVal);
  });
  document.querySelectorAll('.theme-picker[data-for="terminal"] .theme-option').forEach((opt) =>
    opt.classList.toggle("selected", opt.dataset.theme === termVal)
  );

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

  // Atajos: (re)render con los valores actuales
  renderShortcutsList();

  // Sincronización: cargar config + secretos
  populateSyncTab();

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
  if (!dot || !label || !meta) return;
  const enabled = !!_syncConfigCache?.enabled && _syncConfigCache.backend !== "none";
  const state = enabled ? _syncSidebarState : "idle";
  dot.classList.remove("idle", "busy", "success", "error");
  dot.classList.add(state);
  label.textContent = enabled ? t(_syncSidebarTextKey) : t("prefs_sync.status_disabled");
  const backend = syncBackendLabel(_syncConfigCache?.backend || "none");
  const lastSyncAt = syncLastSyncAt();
  const last = lastSyncAt
    ? new Date(lastSyncAt).toLocaleString()
    : t("prefs_sync.last_never");
  meta.textContent = enabled ? `${backend} · ${last}` : backend;
  renderDashboard();
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
  const sidebarTreeState = captureSidebarTreeState();
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
    applySyncedUserFolders();
    registerAllCustomThemes();
    // Recargar perfiles del backend (puede haber añadidos/borrados)
    profiles = await invoke("get_profiles");
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
    const total = summary.addedProfiles + summary.deletedProfiles
      + summary.themesChanged + summary.shortcutsChanged
      + (summary.secretsChanged || 0)
      + (summary.prefsChanged ? 1 : 0);
    if (announce) {
      toast(t("prefs_sync.done_sync").replace("{n}", total), "success");
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
      toast(t("prefs_sync.no_passphrase"), "warning", 6000);
    } else if (announce) {
      toast(`Sync: ${err}`, "error", 6000);
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

async function syncOpenBackendFolder() {
  await persistSyncConfig().catch((err) => console.error("[sync] save before open backend", err));
  const path = await invoke("sync_get_backend_folder").catch((err) => {
    toast(`Sync: ${err}`, "error", 6000);
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
    applySyncedUserFolders();
    registerAllCustomThemes();
    profiles = await invoke("get_profiles");
    renderConnectionList();
    applyTheme(prefs.theme);
    applyPrefsToAllTerminals();
    savePrefs();
    const total = summary.addedProfiles + summary.deletedProfiles
      + summary.themesChanged + summary.shortcutsChanged
      + (summary.secretsChanged || 0)
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
  if (!window.confirm(t("prefs_sync.snapshots_confirm"))) return;
  try {
    setSyncStatus("busy", "prefs_sync.status_busy");
    const summary = await sync.restoreSnapshot(id, {
      profiles, prefs, deviceId: _syncDeviceIdCache,
    });
    applySyncedUserFolders();
    registerAllCustomThemes();
    profiles = await invoke("get_profiles");
    renderConnectionList();
    applyTheme(prefs.theme);
    applyPrefsToAllTerminals();
    savePrefs();
    setSyncStatus("success", "prefs_sync.status_success");
    const total = (summary?.addedProfiles ?? 0) + (summary?.deletedProfiles ?? 0)
      + (summary?.themesChanged ?? 0) + (summary?.shortcutsChanged ?? 0)
      + (summary?.secretsChanged ?? 0)
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

async function checkForUpdates({ interactive = true } = {}) {
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
      const openRelease = await ask(
        t("prefs_about.open_release", { version: `v${latest}` }),
        { title: t("prefs_about.check_updates"), kind: "info" }
      );
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

function persistActivityHistory() {
  try {
    localStorage.setItem(
      ACTIVITY_HISTORY_STORAGE_KEY,
      JSON.stringify(activityItems.slice(0, ACTIVITY_MAX_ITEMS).map(serializableActivityItem)),
    );
  } catch (err) {
    console.warn("[activity] could not persist history", err);
  }
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
  document.querySelectorAll(".activity-filter").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.activityFilter === _activityFilter);
  });
  const visible = _activityFilter === "all"
    ? activityItems
    : activityItems.filter((item) => item.kind === _activityFilter);
  if (!visible.length) {
    list.innerHTML = `<div class="activity-empty">Sin actividad reciente</div>`;
    return;
  }
  list.innerHTML = visible.map((item) => `
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
    sftpConflictPolicy: normalizeSftpConflictPolicy(
      document.getElementById("pref-sftp-conflict-policy")?.value,
    ),
    sftpVerifySize:  document.getElementById("pref-sftp-verify-size")?.checked ?? false,
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
    scrollback:      parseInt(document.getElementById("pref-scrollback").value, 10) || DEFAULT_PREFS.scrollback,
    bell:            document.getElementById("pref-bell").value,
    keepassPath:     document.getElementById("pref-keepass-path").value.trim(),
    keepassKeyfile:  document.getElementById("pref-keepass-keyfile").value.trim(),
    lang:            newLang === null ? null : (SUPPORTED_LANGS.includes(newLang) ? newLang : "es"),
    checkUpdatesOnStartup: document.getElementById("pref-check-updates-startup")?.checked ?? true,
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
    highlightRules:  readHighlightRulesFromEditor(),
    tombstones:      previousPrefs.tombstones || {},
    _shortcutsTs:    previousPrefs._shortcutsTs || {},
    _lastSyncAt:     previousPrefs._lastSyncAt || null,
    _prefsUpdatedAt: new Date().toISOString(),
  };

  savePrefs();
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
  applyTheme(prefs.theme);
  applyPrefsToAllTerminals();
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

  try {
    profiles = await invoke("get_profiles");
  } catch {
    profiles = [];
  }

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
  const root = { connections: [], folders: {} };

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

  return root;
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

function renderConnectionList() {
  const container = document.getElementById("connection-list");
  persistSidebarOpenFolders();
  scheduleTrayQuickLauncherUpdate();
  renderWorkspaceSwitcher();

  if (prefs.sidebarViewMode === "all") {
    container.innerHTML = renderAllWorkspacesTree();
    bindTreeEvents(container);
    applySidebarSearchFilter();
    renderDashboard();
    return;
  }

  if (prefs.sidebarViewMode === "favorites") {
    container.innerHTML = renderFavoritesTree();
    bindTreeEvents(container);
    applySidebarSearchFilter();
    renderDashboard();
    return;
  }

  const activeProfiles = profiles.filter(profileBelongsToActiveWorkspace);
  if (activeProfiles.length === 0 && userFolders.size === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Sin conexiones guardadas</p>
        <button class="btn-link" id="btn-first-connection">Añadir la primera</button>
      </div>`;
    container.querySelector("#btn-first-connection")
      ?.addEventListener("click", () => openNewConnectionModal());
    renderDashboard();
    return;
  }

  const tree = buildFolderTree();
  container.innerHTML = renderTreeNode(tree, 0);
  bindTreeEvents(container);
  applySidebarSearchFilter();
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
    const inner = renderTreeNode(root, 1);
    const open = openFolders.has(`__ws__/${w.id}`) ? "open" : "";
    const childrenHidden = open ? "" : "hidden";
    const count = wsProfiles.length;
    return `<div class="folder-item ws-folder-item" data-ws-root="${escHtml(w.id)}">
      <div class="folder-header" data-folder-path="__ws__/${escHtml(w.id)}">
        <span class="folder-arrow ${open}">▶</span>
        <span class="folder-icon">📁</span>
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
    return `<div class="empty-state"><p>${escHtml(t("sidebar.favorites_empty"))}</p></div>`;
  }
  favs.sort((a, b) => a.name.localeCompare(b.name));
  return favs.map((p) => renderConnectionItem(p, 0)).join("");
}

function applySidebarSearchFilter() {
  const container = document.getElementById("connection-list");
  if (!container) return;
  const q = _sidebarSearchQuery.trim().toLowerCase();
  // Limpiar estado previo
  container.querySelectorAll(".conn-item.dimmed, .folder-item.dimmed")
    .forEach((el) => el.classList.remove("dimmed"));
  container.querySelectorAll(".sidebar-empty-search")
    .forEach((el) => el.remove());
  if (!q) return;

  const matchedConnIds = new Set();
  for (const p of profiles) {
    if (profileMatchesSidebarQuery(p, q)) matchedConnIds.add(p.id);
  }

  // Atenuar perfiles que no matchean
  container.querySelectorAll(".conn-item").forEach((el) => {
    if (!matchedConnIds.has(el.dataset.id)) {
      el.classList.add("dimmed");
    }
  });

  // Atenuar carpetas sin coincidencias y abrir las que tienen alguna
  container.querySelectorAll(".folder-item").forEach((folder) => {
    const visibleConns = folder.querySelectorAll(".conn-item:not(.dimmed)");
    if (visibleConns.length === 0) {
      folder.classList.add("dimmed");
    } else {
      folder.classList.remove("dimmed");
      const arrow = folder.querySelector(".folder-arrow");
      const children = folder.querySelector(".folder-children");
      if (arrow) arrow.classList.add("open");
      if (children) children.classList.remove("hidden");
    }
  });

  if (matchedConnIds.size === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state sidebar-empty-search";
    empty.textContent = t("sidebar.search_no_results");
    container.appendChild(empty);
  }
}

function renderWorkspaceSwitcher() {
  const ctxLabel = document.getElementById("sidebar-context-label");
  const menu     = document.getElementById("workspace-menu");
  if (ctxLabel) {
    if (prefs.sidebarViewMode === "all") {
      ctxLabel.textContent = t("sidebar.view_all");
    } else if (prefs.sidebarViewMode === "favorites") {
      ctxLabel.textContent = t("sidebar.view_favorites");
    } else {
      const active = prefs.workspaces.find((w) => w.id === getActiveWorkspaceId());
      ctxLabel.textContent = active ? active.name : "Default";
    }
  }

  // Marcar el modo de vista activo
  document.querySelectorAll(".tools-view-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.viewMode === prefs.sidebarViewMode);
  });

  if (!menu) return;
  const items = prefs.workspaces.map((w) => {
    const isActive = w.id === getActiveWorkspaceId() && prefs.sidebarViewMode === "current";
    return `<button class="ws-item${isActive ? " active" : ""}" data-ws-action="select" data-ws-id="${escHtml(w.id)}">
      <span>${isActive ? "● " : "○ "}${escHtml(w.name)}</span>
    </button>`;
  }).join("");
  const canDelete = prefs.workspaces.length > 1;
  menu.innerHTML = `${items}
    <div class="ws-sep"></div>
    <button class="ws-item" data-ws-action="new"><span>＋ ${escHtml(t("sidebar.workspace_new"))}</span></button>
    <button class="ws-item" data-ws-action="rename"><span>✎ ${escHtml(t("sidebar.workspace_rename"))}</span></button>
    <button class="ws-item danger" data-ws-action="delete" ${canDelete ? "" : "disabled"}><span>✕ ${escHtml(t("sidebar.workspace_delete"))}</span></button>`;
}

function toggleSidebarTools(open) {
  const popover = document.getElementById("sidebar-tools-popover");
  if (!popover) return;
  if (open === undefined) popover.classList.toggle("hidden");
  else popover.classList.toggle("hidden", !open);
  if (!popover.classList.contains("hidden")) {
    renderWorkspaceSwitcher();
    positionSidebarToolsPopover();
  }
}

function positionSidebarToolsPopover() {
  const trigger = document.getElementById("btn-sidebar-tools");
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

function handleWorkspaceMenuClick(action, wsId) {
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
    const name = prompt(t("sidebar.workspace_prompt_new"));
    if (name && name.trim()) {
      const id = `ws-${crypto.randomUUID()}`;
      prefs.workspaces.push({ id, name: name.trim() });
      prefs.userFoldersByWorkspace = prefs.userFoldersByWorkspace || {};
      prefs.userFoldersByWorkspace[id] = [];
      prefs.activeWorkspaceId = id;
      userFolders = new Set();
      prefs.sidebarViewMode = "current";
      savePrefs();
      renderConnectionList();
    }
    toggleWorkspaceMenu(false);
    return;
  }
  if (action === "rename") {
    const cur = prefs.workspaces.find((w) => w.id === getActiveWorkspaceId());
    if (!cur) return;
    const name = prompt(t("sidebar.workspace_prompt_rename"), cur.name);
    if (name && name.trim()) {
      cur.name = name.trim();
      savePrefs();
      renderConnectionList();
    }
    toggleWorkspaceMenu(false);
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
      prefs.activeWorkspaceId = prefs.workspaces[0].id;
      userFolders = new Set(getWorkspaceFolders(prefs.activeWorkspaceId));
      savePrefs();
      renderConnectionList();
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
  const haystack = [
    profile.name,
    profile.host,
    profile.username,
    profile.group,
    profile.connection_type || "ssh",
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
  return { favorites, recent, workspaces };
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
  await listen("tray-action", (event) => {
    const payload = event.payload || {};
    if (payload.action === "local-shell") {
      openLocalShell();
    } else if (payload.action === "new-connection") {
      openNewConnectionModal();
    } else if (payload.action === "connect-profile" && payload.profileId) {
      connectProfile(payload.profileId, { force: true });
    } else if (payload.action === "switch-workspace" && payload.workspaceId) {
      switchToWorkspace(payload.workspaceId);
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
  const recent = getRecentProfiles().filter((item) => profileBelongsToActiveWorkspace(item.profile));
  const recentIds = new Set(recent.map((item) => item.profile.id));
  const scoped = profiles.filter(profileBelongsToActiveWorkspace);
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
    const rows = getRecentProfiles().slice(0, 5);
    activity.innerHTML = rows.length
      ? rows.map(({ profile, lastConnectedAt }) => renderDashboardActivityRow(profile, lastConnectedAt)).join("")
      : `<div class="dashboard-empty-line">La actividad aparecerá aquí al conectar perfiles</div>`;
    bindDashboardCards(activity);
  }

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
  let scoped = profiles;
  if (prefs.sidebarViewMode === "favorites") {
    scoped = profiles.filter((profile) => isFavoriteProfile(profile.id));
  } else if (prefs.sidebarViewMode !== "all") {
    scoped = profiles.filter(profileBelongsToActiveWorkspace);
  }
  return scoped
    .filter((profile) => !q || profileMatchesSidebarQuery(profile, q))
    .sort((a, b) => a.name.localeCompare(b.name));
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

  toggleSidebarTools(true);
  requestAnimationFrame(() => {
    const search = document.getElementById("sidebar-search");
    if (!search) return;
    search.focus();
    search.select();
  });
}

function renderTreeNode(node, depth) {
  let html = "";
  for (const p of node.connections) html += renderConnectionItem(p, depth);
  for (const [name, child] of Object.entries(node.folders)) {
    html += renderFolderNode(name, child, depth);
  }
  return html;
}

function renderFolderNode(name, node, depth) {
  const path = node.path;
  const isOpen = openFolders.has(path);
  const count = countConnections(node);
  const indent = 14 + depth * 12;
  const tintAttrs = folderTintAttrs(path);

  return `
    <div class="folder-item" data-folder-path="${escHtml(path)}" draggable="true"${tintAttrs}>
      <div class="folder-header" style="padding-left:${indent}px; padding-right:14px">
        <span class="folder-arrow ${isOpen ? "open" : ""}">▶</span>
        <span class="folder-icon">📁</span>
        <span class="folder-name">${escHtml(name)}</span>
        <span class="folder-count">${count}</span>
      </div>
      <div class="folder-children${isOpen ? "" : " hidden"}">
        ${renderTreeNode(node, depth + 1)}
      </div>
    </div>`;
}

function getFolderColor(path) {
  if (!path || !prefs.folderColors) return null;
  const id = prefs.folderColors[path];
  if (!id) return null;
  return FOLDER_COLOR_PRESETS.find((c) => c.id === id) || null;
}

function folderTintAttrs(path) {
  const c = getFolderColor(path);
  if (!c) return "";
  return ` data-folder-tint="${escHtml(c.id)}" style="--folder-tint:${c.color}"`;
}

function setFolderColor(path, colorId) {
  if (!path) return;
  prefs.folderColors = prefs.folderColors || {};
  if (!colorId) delete prefs.folderColors[path];
  else prefs.folderColors[path] = colorId;
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
}

function renderConnectionItem(p, depth) {
  const isConnected = [...sessions.values()].some(
    (s) => s.profileId === p.id && s.status === "connected"
  );
  const isSelected = activeProfileId() === p.id || sidebarSelectedConnectionIds.has(p.id);
  const connType = p.connection_type || "ssh";
  const proto = connectionProtocolMeta(connType);
  const indent = 14 + depth * 12;
  const notes = String(p.notes || "").trim();
  const notesBadge = notes
    ? `<span class="conn-notes-badge" title="${escHtml(notes)}">ⓘ</span>`
    : "";
  return `
    <div class="conn-item${isConnected ? " active" : ""}${isSelected ? " selected" : ""}"
         data-id="${p.id}"
         draggable="true"
         style="padding-left:${indent}px">
      <div class="conn-item-icon ${escHtml(proto.className)}${isConnected ? " connected" : ""}" title="${escHtml(proto.label)}">
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
    .filter((el) => !el.classList.contains("dimmed"))
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
      connectProfile(el.dataset.id);
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
  if (prefs.folderColors) {
    const remapped = {};
    for (const [path, color] of Object.entries(prefs.folderColors)) {
      if (path === folderPath) remapped[newPath] = color;
      else if (path.startsWith(prefix)) remapped[newPrefix + path.slice(prefix.length)] = color;
      else remapped[path] = color;
    }
    prefs.folderColors = remapped;
    savePrefs();
  }

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
  menu.querySelectorAll(".ctx-ws-only").forEach((el) =>
    el.classList.toggle("hidden", type !== "workspace")
  );
  // "Abrir directorio de datos" solo visible en el clic sobre la zona vacía
  menu.querySelectorAll(".ctx-sidebar-only").forEach((el) =>
    el.classList.toggle("hidden", type !== "sidebar")
  );

  // Posicionar fuera de pantalla para medir, luego ajustar
  menu.style.left = "0px";
  menu.style.top  = "0px";
  menu.classList.remove("hidden");

  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth  - width  - 6) + "px";
  menu.style.top  = Math.min(y, window.innerHeight - height - 6) + "px";
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
    case "delete-folder":
      deleteFolderAndMoveConnections(folderPath, targetWs);
      break;
    case "connect":
      connectProfile(id);
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
    case "toggle-favorite":
      if (id) toggleFavoriteProfile(id);
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

function renameWorkspaceById(wsId) {
  const ws = prefs.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const name = prompt(t("sidebar.workspace_prompt_rename"), ws.name);
  if (!name || !name.trim()) return;
  ws.name = name.trim();
  prefs._prefsUpdatedAt = new Date().toISOString();
  savePrefs();
  renderConnectionList();
}

function deleteWorkspaceById(wsId) {
  if (prefs.workspaces.length <= 1) return;
  const ws = prefs.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const inUse = profiles.some((p) => (p.workspace_id || "default") === ws.id);
  const msg = inUse
    ? t("sidebar.workspace_confirm_delete_full")
    : t("sidebar.workspace_confirm_delete");
  if (!confirm(msg)) return;
  const finalize = () => {
    if (prefs.userFoldersByWorkspace) delete prefs.userFoldersByWorkspace[ws.id];
    prefs.workspaces = prefs.workspaces.filter((w) => w.id !== ws.id);
    if (prefs.activeWorkspaceId === ws.id) {
      prefs.activeWorkspaceId = prefs.workspaces[0].id;
      userFolders = new Set(getWorkspaceFolders(prefs.activeWorkspaceId));
    }
    savePrefs();
    renderConnectionList();
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
    <span class="folder-icon">📁</span>
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
  const newName = window.prompt("Nuevo nombre de carpeta:", currentName);
  if (!newName || newName.trim() === currentName) return;

  const newPath = [...parts.slice(0, -1), newName.trim()].join("/") || newName.trim();
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
  if (prefs.folderColors) {
    const remapped = {};
    for (const [path, color] of Object.entries(prefs.folderColors)) {
      if (path === folderPath) remapped[newPath] = color;
      else if (path.startsWith(prefix)) remapped[newPrefix + path.slice(prefix.length)] = color;
      else remapped[path] = color;
    }
    prefs.folderColors = remapped;
    savePrefs();
  }

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

  const msg = count > 0
    ? `¿Eliminar la carpeta "${folderPath}"?\n${count} conexión(es) se moverán a la raíz.`
    : `¿Eliminar la carpeta vacía "${folderPath}"?`;

  if (!window.confirm(msg)) return;

  const prefix = folderPath + "/";
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
  if (prefs.folderColors) {
    let mutated = false;
    for (const path of Object.keys(prefs.folderColors)) {
      if (path === folderPath || path.startsWith(prefix)) {
        delete prefs.folderColors[path];
        mutated = true;
      }
    }
    if (mutated) savePrefs();
  }

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

function setPasswordVisible(visible) {
  const input = document.getElementById("f-password");
  const btn = document.getElementById("btn-toggle-password");
  if (!input || !btn) return;

  input.type = visible ? "text" : "password";
  btn.setAttribute("aria-pressed", visible ? "true" : "false");
  btn.textContent = visible ? "◎" : "◉";

  const label = t(visible ? "modal_conn.hide_password" : "modal_conn.show_password");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

/**
 * Abre el modal para nueva conexión.
 * @param {string|null} preselectedFolder  Carpeta a preseleccionar en el picker
 * @param {string|null} workspaceId Workspace inicial
 */
function openNewConnectionModal(preselectedFolder = null, workspaceId = getActiveWorkspaceId()) {
  editingProfileId = null;
  resetConnectionTestPanel();
  document.getElementById("modal-title").textContent = "Nueva conexión";
  document.getElementById("form-connection").reset();
  setPasswordVisible(false);
  document.getElementById("f-conn-type").value = "ssh";
  document.getElementById("f-notes").value = "";
  document.getElementById("f-save-password").checked = true;
  document.getElementById("f-save-passphrase").checked = true;
  refreshKeepassStatus().then(() => {
    populateKeepassEntrySelect(null);
    updateConnTypeFields("ssh");
  });
  populateFolderSelect(preselectedFolder, workspaceId);
  populateWorkspaceFormSelect(workspaceId);
  applyConnectionModalSize();
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("f-name").focus();
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

  populateFolderSelect(profile.group || "", profile.workspace_id || getActiveWorkspaceId());
  document.getElementById("f-keep-alive").value = profile.keep_alive_secs ?? "";
  document.getElementById("f-allow-legacy").checked = !!profile.allow_legacy_algorithms;
  document.getElementById("f-agent-forwarding").checked = !!profile.agent_forwarding;
  document.getElementById("f-x11-forwarding").checked = !!profile.x11_forwarding;
  document.getElementById("f-auto-reconnect").value = profile.auto_reconnect ?? "";
  document.getElementById("f-session-log").checked = !!profile.session_log;
  document.getElementById("f-proxy-jump").value = profile.proxy_jump || "";
  document.getElementById("f-mac-address").value = profile.mac_address || "";
  document.getElementById("f-wol-broadcast").value = profile.wol_broadcast || "";
  document.getElementById("f-wol-port").value = profile.wol_port ?? "";
  populateWorkspaceFormSelect(profile.workspace_id || getActiveWorkspaceId());
  refreshKeepassStatus().then(() => {
    document.getElementById("f-use-keepass").checked = !!profile.keepass_entry_uuid;
    populateKeepassEntrySelect(profile.keepass_entry_uuid || null);
    updateConnTypeFields(connType);
  });
  applyConnectionModalSize();
  document.getElementById("modal-overlay").classList.remove("hidden");
}

function populateKeepassEntrySelect(selectedUuid) {
  const sel = document.getElementById("f-keepass-entry");
  if (!sel) return;
  let opts = `<option value="">${escHtml(t("modal_conn.keepass_entry_pick"))}</option>`;
  for (const e of keepassEntries) {
    const label = e.group
      ? `${e.group} / ${e.title || "(sin título)"}`
      : (e.title || "(sin título)");
    const suffix = e.username ? ` — ${e.username}` : "";
    opts += `<option value="${escHtml(e.uuid)}"${e.uuid === selectedUuid ? " selected" : ""}>${escHtml(label + suffix)}</option>`;
  }
  sel.innerHTML = opts;
  updateKeepassEntryValidation();
}

function keepassEntryLabel(entry) {
  if (!entry) return "";
  const title = entry.title || "(sin título)";
  return entry.group ? `${entry.group} / ${title}` : title;
}

function updateKeepassEntryValidation() {
  const status = document.getElementById("keepass-entry-status");
  const sel = document.getElementById("f-keepass-entry");
  const useKp = document.getElementById("f-use-keepass")?.checked;
  const authType = document.getElementById("f-auth-type")?.value;
  if (!status || !sel) return;

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

  const uuid = sel.value;
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

  const user = entry.username
    ? t("modal_conn.keepass_entry_status_user", { username: entry.username })
    : t("modal_conn.keepass_entry_status_no_user");
  const textKey = entry.has_password
    ? "modal_conn.keepass_entry_status_ok"
    : "modal_conn.keepass_entry_status_no_password";
  status.textContent = t(textKey, {
    entry: keepassEntryLabel(entry),
    user,
  });
  status.classList.add(entry.has_password ? "ok" : "error");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  document.getElementById("form-connection").reset();
  setPasswordVisible(false);
  resetConnectionTestPanel();
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

function updateAuthFields(authType) {
  const isPwd = authType === "password";
  if (!isPwd) setPasswordVisible(false);
  document.getElementById("field-password").classList.toggle("hidden", !isPwd);
  document.getElementById("field-save-password").classList.toggle("hidden", !isPwd);
  document.getElementById("field-key-path").classList.toggle("hidden", authType !== "public_key");
  document.getElementById("field-passphrase").classList.toggle("hidden", authType !== "public_key");
  document.getElementById("field-save-passphrase").classList.toggle("hidden", authType !== "public_key");

  // KeePass: sólo aplica a auth=password
  const useKp = document.getElementById("f-use-keepass").checked;
  document.getElementById("field-keepass-toggle").classList.toggle("hidden", !isPwd);
  document.getElementById("field-keepass-entry").classList.toggle("hidden", !isPwd || !useKp);
  // Si KeePass está activo, ocultar los campos de contraseña
  if (isPwd && useKp) {
    setPasswordVisible(false);
    document.getElementById("field-password").classList.add("hidden");
    document.getElementById("field-save-password").classList.add("hidden");
  }
  // Hint cuando DB no está desbloqueada
  const hint = document.getElementById("keepass-hint-locked");
  if (hint) hint.style.display = (isPwd && useKp && !keepassUnlocked) ? "" : "none";
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

  if (isPasswordOnly) {
    document.getElementById("f-auth-type").value = "password";
    const useKp = document.getElementById("f-use-keepass").checked;
    document.getElementById("field-keepass-toggle").classList.remove("hidden");
    document.getElementById("field-keepass-entry").classList.toggle("hidden", !useKp);
    document.getElementById("field-password").classList.toggle("hidden", useKp);
    document.getElementById("field-save-password").classList.toggle("hidden", useKp);
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
          remember: !!remember?.checked,
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

async function promptTextValue({ title, message, label, initialValue = "", submitLabel = "Aceptar" }) {
  const result = await promptCredential({
    title,
    message,
    label,
    submitLabel,
    inputType: "text",
    initialValue,
  });
  if (!result) return null;
  const value = result.value.trim();
  return value || null;
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
  const useKeepass = document.getElementById("f-use-keepass").checked
    && authType === "password";
  const keepassEntryUuid = useKeepass
    ? (document.getElementById("f-keepass-entry").value || null)
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
    follow_cwd: true,
    keep_alive_secs: keepAliveFromInput(document.getElementById("f-keep-alive").value),
    allow_legacy_algorithms: document.getElementById("f-allow-legacy").checked,
    agent_forwarding: document.getElementById("f-agent-forwarding").checked,
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

    _connectionTestUnlisten = await listen(`ssh-log-${testId}`, (event) => {
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

  const useKeepass = document.getElementById("f-use-keepass").checked
    && authType === "password";
  const keepassEntryUuid = useKeepass
    ? (document.getElementById("f-keepass-entry").value || null)
    : null;

  const wsSelect = document.getElementById("f-workspace");
  const wsFromForm = wsSelect && !wsSelect.closest(".form-row").classList.contains("hidden")
    ? wsSelect.value
    : null;
  const fallbackWs = editingProfileId
    ? (profiles.find((p) => p.id === editingProfileId)?.workspace_id || getActiveWorkspaceId())
    : getActiveWorkspaceId();
  const workspaceId = wsFromForm || fallbackWs || "default";

  const profile = {
    id:                  editingProfileId || crypto.randomUUID(),
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
    follow_cwd:          true,
    keep_alive_secs:     keepAliveFromInput(document.getElementById("f-keep-alive").value),
    allow_legacy_algorithms: document.getElementById("f-allow-legacy").checked,
    agent_forwarding:    document.getElementById("f-agent-forwarding").checked,
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

    if (authType === "password" && password && savePassword && !keepassEntryUuid) {
      await saveStoredSecret(passwordKey(profile.id), password, "contraseña");
    }
    if (authType === "public_key" && passphrase && savePassphrase) {
      await saveStoredSecret(passphraseKey(profile.id), passphrase, "passphrase");
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
async function resolveSshCredentials(profile) {
  let password = null, passphrase = null;
  if (profile.auth_type === "password") {
    if (profile.keepass_entry_uuid) {
      if (!keepassUnlocked) {
        toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
        return null;
      }
    } else {
      password = await getStoredSecret(passwordKey(profile.id));
      if (!password) {
        password = await promptProfileSecret(profile, {
          titleKey: "modal_credential.password_title",
          messageKey: "modal_credential.ssh_message",
          labelKey: "modal_credential.password_label",
          rememberKey: "modal_credential.remember_password",
          secretKey: passwordKey(profile.id),
          secretLabel: "contraseña",
        });
        if (password === null) return null;
      }
    }
  } else if (profile.auth_type === "public_key") {
    passphrase = await getStoredSecret(passphraseKey(profile.id));
    if (!passphrase && profile.key_path) {
      passphrase = await promptProfileSecret(profile, {
        titleKey: "modal_credential.passphrase_title",
        messageKey: "modal_credential.passphrase_message",
        labelKey: "modal_credential.passphrase_label",
        rememberKey: "modal_credential.remember_passphrase",
        secretKey: passphraseKey(profile.id),
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
} = {}) {
  if (profile.keepass_entry_uuid) {
    if (!keepassUnlocked) {
      toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
      return null;
    }
    return passwordOverride || null;
  }

  let password = passwordOverride || await getStoredSecret(passwordKey(profile.id));
  if (!password) {
    password = await promptProfileSecret(profile, {
      titleKey,
      messageKey,
      labelKey: "modal_credential.password_label",
      rememberKey: "modal_credential.remember_password",
      secretKey: passwordKey(profile.id),
      secretLabel: "contraseña",
    });
    if (password === null) return null;
  }
  return password;
}

async function connectProfile(profileId, { force = false } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  if (profile.connection_type === "rdp") {
    return connectRdp(profileId);
  }

  if (isFileTransferConnectionType(profile.connection_type)) {
    return connectFileTransferProfile(profileId, { force });
  }

  if (!force) {
    for (const [sid, s] of sessions) {
      if (s.profileId === profileId && s.status !== "closed") { setActiveTab(sid); return; }
    }
  }

  const creds = await resolveSshCredentials(profile);
  if (!creds) return;
  await connectProfileWithCredentials(profileId, creds.password, creds.passphrase, false);
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

async function connectProfileWithCredentials(profileId, password, passphrase, _savePassphrase) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  const sessionId = `ssh-${crypto.randomUUID()}`;
  createTerminalTab(sessionId, profile, "connecting");
  const session = sessions.get(sessionId);
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

async function connectRdp(profileId, { passwordOverride = null } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  // Si ya hay una sesión activa para este perfil, traerla al frente
  for (const [sid, s] of sessions) {
    if (s.profileId === profileId && s.type === "rdp" && s.status !== "closed") {
      setActiveTab(sid);
      return;
    }
  }

  // Obtener contraseña: KeePass (si aplica), si no keyring, si no prompt
  let password = passwordOverride;
  if (profile.keepass_entry_uuid) {
    if (!keepassUnlocked) {
      toast("KeePass bloqueada; desbloquéala en Preferencias", "warning");
      return;
    }
  } else if (!password) {
    password = await getStoredSecret(passwordKey(profileId));
    if (!password) {
      password = await promptProfileSecret(profile, {
        titleKey: "modal_credential.rdp_password_title",
        messageKey: "modal_credential.rdp_message",
        labelKey: "modal_credential.password_label",
        rememberKey: "modal_credential.remember_password",
        secretKey: passwordKey(profileId),
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
    recordRecentConnection(profileId);

    // Escuchar el cierre del proceso externo
    const unlisten = await listen(`rdp-closed-${sessionId}`, () => {
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

async function connectFileTransferProfile(profileId, { passwordOverride = null, force = false } = {}) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;

  for (const [sid, s] of [...sessions]) {
    if (s.profileId === profileId && isFileTransferConnectionType(s.type) && s.status !== "closed") {
      if (!force) {
        setActiveTab(sid);
        return;
      }
      await closeSession(sid, { skipConfirm: true });
    }
  }

  const password = await resolvePasswordOnlyCredentials(profile, {
    passwordOverride,
    titleKey: "modal_credential.sftp_password_title",
    messageKey: "modal_credential.sftp_message",
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
    tunnels: new Map(),
    tunnelPanel: null,
  };
  sessions.set(sessionId, sessionObj);
  createFileTransferTab(sessionId, profile, "connecting");

  try {
    await openSftpPanel(sessionId, { passwordOverride: password, passphraseOverride: null });
    sessionObj.status = "connected";
    updateTabStatus(sessionId, "connected");
    recordRecentConnection(profileId);
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
function createTab(sessionId, profile, initialStatus, { sftp = true } = {}) {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.session = sessionId;
  const sftpBtn = sftp ? `<button class="tab-sftp" title="Panel SFTP">⇅</button>` : "";
  const tunnelBtn = sftp ? `<button class="tab-tunnels" title="Túneles SSH">⇄</button>` : "";
  tab.innerHTML = `
    <span class="tab-dot ${initialStatus}"></span>
    <span class="tab-name">${escHtml(profile.name)}</span>
    ${sftpBtn}
    ${tunnelBtn}
    <button class="tab-close" title="Cerrar">✕</button>`;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) return;
    if (e.target.classList.contains("tab-sftp")) return;
    if (e.target.classList.contains("tab-tunnels")) return;
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
  document.getElementById("tabs-container").appendChild(tab);
  return tab;
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

async function pasteClipboardIntoSession(sessionObj) {
  if (!sessionObj || sessionObj.status === "closed" || !sessionObj.terminal || sessionObj.type === "rdp") return;
  const text = await readSystemClipboardText();
  if (!text) return;
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
  const setup =
    ` { [ -n "$BASH_VERSION" ] && export PROMPT_COMMAND='printf "\\033]7;file://%s%s\\033\\\\" "$HOSTNAME" "$PWD"'"\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; ` +
    `[ -n "$ZSH_VERSION" ] && { _osc7() { printf "\\033]7;file://%s%s\\033\\\\" "$HOST" "$PWD"; }; ` +
    `typeset -ga precmd_functions; precmd_functions+=(_osc7); }; ` +
    `printf "\\033]7;file://%s%s\\033\\\\" "\${HOSTNAME:-$HOST}" "$PWD"; } 2>/dev/null`;
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
  hideReconnectOverlay(sessionId);
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
    const ul = await listen(`shell-data-${sessionId}`, (e) => {
      s.terminal.write(decoder.decode(new Uint8Array(e.payload)));
    });
    const ulClose = await listen(`shell-closed-${sessionId}`, () => {
      s.status = "closed";
      updateTabStatus(sessionId, "error");
      renderDashboard();
      showReconnectOverlay(sessionId, "Consola cerrada");
      s.terminal.writeln(`\r\n\x1b[33m• ${t("terminal.shell_ended")}\x1b[0m \x1b[90m${t("terminal.closed_hint")}\x1b[0m\r\n`);
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

  const creds = await resolveSshCredentials(profile);
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
  renderView();
  updateStatusBar();
  syncSidebarToActiveSession({ scroll: true });
}

function focusPaneByOffset(delta) {
  if (viewSelection.length < 2) return;
  const currentIdx = Math.max(0, viewSelection.indexOf(activeSessionId));
  const nextIdx = (currentIdx + delta + viewSelection.length) % viewSelection.length;
  activeSessionId = viewSelection[nextIdx];
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
  document.querySelectorAll(".terminal-pane").forEach((p) => {
    p.classList.toggle("pane-focused",
      viewSelection.length > 1 && p.dataset.session === activeSessionId);
  });
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
  overlay.querySelector(".terminal-reconnect-title").textContent = title;
  overlay.classList.remove("hidden");
}

function hideReconnectOverlay(sessionId) {
  document
    .querySelector(`.terminal-pane[data-session="${sessionId}"] .terminal-reconnect-overlay`)
    ?.classList.add("hidden");
}

function createTerminalTab(sessionId, profile, initialStatus, opts = {}) {
  const { sftp = true } = opts;

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

  // Crear pestaña
  createTab(sessionId, profile, initialStatus, { sftp });

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
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(searchAddon);
  terminal.open(xtermDiv);
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

  terminal.onResize(({ cols, rows }) => {
    invoke("ssh_resize", { sessionId: sessionObj.id, cols, rows }).catch(() => {});
  });

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
  if (entry.status !== "info") {
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

async function registerSshListeners(sessionId, terminal) {
  const decoder = new TextDecoder();
  const ul = [];

  ul.push(await listen(`ssh-data-${sessionId}`, (e) => {
    const s = sessions.get(sessionId);
    const text = decoder.decode(new Uint8Array(e.payload));
    const filtered = filterSuppressedTerminalOutput(s, text);
    if (filtered) terminal.write(applyHighlightRules(filtered));
  }));

  ul.push(await listen(`ssh-log-${sessionId}`, (e) => {
    appendConnectionLog(sessionId, e.payload || {});
  }));

  ul.push(await listen(`ssh-connected-${sessionId}`, () => {
    const s = sessions.get(sessionId);
    if (s) s.status = "connected";
    appendConnectionLog(sessionId, {
      stage: "connected",
      status: "ok",
      message: "Sesión SSH conectada",
      timestamp: new Date().toISOString(),
    });
    hideReconnectOverlay(sessionId);
    updateTabStatus(sessionId, "connected");
    if (s?.profileId) recordRecentConnection(s.profileId);
    renderConnectionList();
    s?.fitAddon.fit();
    notifyResize(sessionId, terminal);
    startProfileAutoTunnels(sessionId);
  }));

  ul.push(await listen(`ssh-error-${sessionId}`, (e) => {
    const s = sessions.get(sessionId);
    if (s) s.status = "error";
    appendConnectionLog(sessionId, {
      stage: "error",
      status: "error",
      message: String(e.payload || "Error SSH"),
      timestamp: new Date().toISOString(),
    });
    updateTabStatus(sessionId, "error");
    showReconnectOverlay(sessionId, "Error de conexión");
    terminal.writeln(`\r\n\x1b[31m✗ Error: ${e.payload}\x1b[0m\r\n`);
    toast(`Error SSH: ${e.payload}`, "error");
  }));

  ul.push(await listen(`ssh-reconnecting-${sessionId}`, (e) => {
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
    terminal.writeln(`\r\n\x1b[33m↻ Reintentando conexión (${attempt}/${max}) en ${secs}s…\x1b[0m`);
  }));

  ul.push(await listen(`ssh-closed-${sessionId}`, () => {
    const s = sessions.get(sessionId);
    if (s) s.status = "closed";
    appendConnectionLog(sessionId, {
      stage: "closed",
      status: "warning",
      message: "Sesión SSH cerrada",
      timestamp: new Date().toISOString(),
    });
    updateTabStatus(sessionId, "error");
    showReconnectOverlay(sessionId, "Sesión cerrada");
    terminal.writeln(`\r\n\x1b[33m• ${t("terminal.closed")}\x1b[0m \x1b[90m${t("terminal.closed_hint")}\x1b[0m\r\n`);
    renderConnectionList();
  }));

  ul.push(await listen(`ssh-tunnel-traffic-${sessionId}`, (e) => {
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
  if (!isSessionLive(s) && !sessionHasActiveTransfers(s)) return true;
  const profile = profiles.find((p) => p.id === s.profileId);
  const name = profile?.name || s._closeOverride ? "consola local" : (s.type ? s.type.toUpperCase() : "sesión");
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

  // Shell local: usa su propio manejador de cierre
  if (s._closeOverride) {
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
  for (const ul of s.unlisteners) { try { ul(); } catch {} }
  await invoke("ssh_disconnect", { sessionId }).catch(() => {});
  s.terminal.dispose();
  sessions.delete(sessionId);
  removeTab(sessionId);
  renderConnectionList();
}

function removeTab(sessionId) {
  document.querySelector(`.tab[data-session="${sessionId}"]`)?.remove();
  document.querySelector(`.terminal-pane[data-session="${sessionId}"]`)?.remove();

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

function notifyResize(sessionId, terminal) {
  if (!terminal) return;
  invoke("ssh_resize", { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// PERFILES
// ═══════════════════════════════════════════════════════════════

async function deleteProfile(profileId) {
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const confirmed = await ask(
    `¿Eliminar "${profile.name}"?\n\nEsta acción no se puede deshacer.`,
    { title: "Eliminar conexión", kind: "warning" }
  );
  if (!confirmed) return;
  try {
    await invoke("delete_profile", { id: profileId });
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
 * cual; las contraseñas guardadas en el keyring NO se duplican (cada perfil
 * tiene su propia clave `password:<id>`).
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
    profiles = await invoke("get_profiles");
    renderConnectionList();
    scheduleProfileAutoSync();
    openEditConnectionModal(copy.id);
    toast(`Duplicado como "${copy.name}"`, "success");
  } catch (err) {
    toast(`Error al duplicar: ${err}`, "error");
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
  const ok = await ask("¿Borrar este túnel guardado?", { title: "Túneles SSH", kind: "warning" });
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
  try {
    await invoke("local_shell_open", {
      sessionId,
      cols: s.terminal.cols,
      rows: s.terminal.rows,
    });
    s.status = "connected";
    updateTabStatus(sessionId, "connected");

    const decoder = new TextDecoder();
    const ul = await listen(`shell-data-${sessionId}`, (e) => {
      s.terminal.write(decoder.decode(new Uint8Array(e.payload)));
    });
    const ulClose = await listen(`shell-closed-${sessionId}`, () => {
      s.status = "closed";
      updateTabStatus(sessionId, "error");
      showReconnectOverlay(sessionId, "Consola cerrada");
      s.terminal.writeln(`\r\n\x1b[33m• ${t("terminal.shell_ended")}\x1b[0m \x1b[90m${t("terminal.closed_hint")}\x1b[0m\r\n`);
    });
    s.unlisteners.push(ul, ulClose);

    // Nota: el input ya lo enruta `handleTerminalInput` (registrado en createTerminalTab)
    // detectando el tipo de sesión por `_closeOverride`. Solo hace falta el resize aquí.
    s.terminal.onResize(({ cols, rows }) => {
      invoke("local_shell_resize", { sessionId, cols, rows }).catch(() => {});
    });

    // Sobreescribir el cierre de sesión para usar el comando de shell.
    // closeSession llama a removeTab() tras ejecutar este override.
    s._closeOverride = async () => {
      for (const ul of s.unlisteners) { try { ul(); } catch {} }
      await invoke("local_shell_close", { sessionId }).catch(() => {});
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
  if (!s || s.status !== "connected") {
    toast("La sesión debe estar conectada", "warning");
    return;
  }
  if (s.sftp?.panel) {
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
  const ulSftpLog = await listen(`sftp-log-${sftpSessionId}`, (ev) => {
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

  // Resolver credenciales igual que en openSftpPanel (pueden no estar ya cacheadas)
  let password = null, passphrase = null;
  if (profile.auth_type === "password") {
    if (!profile.keepass_entry_uuid) {
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
  } else if (profile.auth_type === "public_key") {
    passphrase = await getStoredSecret(passphraseKey(profile.id));
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
  const ulSftpLog = await listen(`sftp-log-${newSftpSessionId}`, (ev) => {
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
      const ulFallback = await listen(`sftp-log-${fallbackSftpSessionId}`, (ev) => {
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

function getStoredSftpPanelHeightPercent() {
  const raw = Number(localStorage.getItem(SFTP_PANEL_HEIGHT_STORAGE_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SFTP_PANEL_DEFAULT_HEIGHT_PERCENT;
  return Math.min(85, Math.max(20, raw));
}

function applySftpPanelHeight(panel, percent = getStoredSftpPanelHeightPercent()) {
  panel.style.flexBasis = `${percent}%`;
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
  return Math.min(420, Math.max(SFTP_LOG_MIN_HEIGHT, raw));
}

function applySftpLogHeight(panel, height = getStoredSftpLogHeight()) {
  const wrap = panel.querySelector(".sftp-transfers-wrap");
  if (!wrap) return;
  wrap.style.height = `${Math.round(height)}px`;
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
    const panelHeight = panel.getBoundingClientRect().height;
    const maxHeight = Math.max(
      SFTP_LOG_MIN_HEIGHT,
      panelHeight - SFTP_LOG_MIN_FILE_AREA_HEIGHT,
    );

    document.body.classList.add("sftp-log-resizing");

    const onMove = (ev) => {
      const delta = ev.clientY - startY;
      const nextPx = Math.min(maxHeight, Math.max(SFTP_LOG_MIN_HEIGHT, startHeight - delta));
      wrap.style.height = `${nextPx}px`;
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

function buildSftpPanel(sessionId) {
  const panel = document.createElement("div");
  panel.className = "sftp-panel sftp-panel-split";
  panel.innerHTML = `
    <div class="sftp-resize-handle" title="Redimensionar panel SFTP"></div>
    <div class="sftp-side sftp-side-local" data-side="local">
      <div class="sftp-side-title">Local</div>
      <div class="sftp-toolbar">
        <button class="sftp-nav-btn" data-sftp-nav="up" data-side="local" title="Directorio padre">↑</button>
        <button class="sftp-nav-btn" data-sftp-nav="home" data-side="local" title="Inicio">⌂</button>
        <button class="sftp-nav-btn" data-sftp-nav="refresh" data-side="local" title="Refrescar">⟳</button>
        <input class="sftp-path" data-side="local" type="text" spellcheck="false" />
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="mkdir" data-side="local" title="Nueva carpeta">＋</button>
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
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="mkdir" data-side="remote" title="Nueva carpeta">＋</button>
        <button class="sftp-nav-btn sftp-action-btn" data-sftp-act="close" title="Cerrar panel">✕</button>
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

  panel.querySelectorAll("[data-sftp-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.sftpAct;
      const side = btn.dataset.side;
      if (act === "mkdir") {
        promptMkdir(sessionId, side || "remote");
      } else if (act === "close") {
        closeSftpPanel(sessionId);
      }
    });
  });

  panel.querySelectorAll(".sftp-path").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const side = input.dataset.side;
      const path = e.target.value.trim();
      if (!path) return;
      if (side === "local") navigateSftpLocal(sessionId, path);
      else navigateSftpRemote(sessionId, path);
    });
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
  if (entries.length === 0) {
    filesDiv.innerHTML = `<div class="sftp-empty">Carpeta vacía</div>`;
    return;
  }
  filesDiv.innerHTML = entries.map((e) => `
    <div class="sftp-row ${e.is_dir ? "is-dir" : "is-file"}"
         draggable="${e.is_symlink ? "false" : "true"}"
         data-path="${escHtml(e.path)}"
         data-name="${escHtml(e.name)}"
         data-is-dir="${e.is_dir}"
         data-is-symlink="${e.is_symlink}"
         data-permissions="${e.permissions ?? ""}">
      <span class="sftp-icon">${e.is_dir ? "📁" : (e.is_symlink ? "🔗" : "📄")}</span>
      <span class="sftp-name">${escHtml(e.name)}</span>
      <span class="sftp-size">${e.is_dir ? "" : formatSize(e.size)}</span>
      <span class="sftp-modified">${formatTime(e.modified)}</span>
      <span class="sftp-row-actions">
        <button class="sftp-row-btn" data-op="rename" title="Renombrar">✎</button>
        <button class="sftp-row-btn danger" data-op="delete" title="Eliminar">✕</button>
      </span>
    </div>
  `).join("");

  filesDiv.querySelectorAll(".sftp-row").forEach((row) => {
    // Selección con click. Ctrl/Cmd toggle multi.
    row.addEventListener("click", (e) => {
      if (e.target.closest(".sftp-row-btn")) return;
      if (!(e.ctrlKey || e.metaKey)) {
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
  recordActivity({
    kind: "sftp",
    status: status === "ok" || status === "renamed" || status === "overwritten" ? "ok" : status,
    title: label,
    detail,
    actionLabel,
    action: action || (() => revealSftpActivity(panel)),
  });
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
  const ul = await listen(`sftp-progress-${transferId}`, (ev) => {
    updateTransfer(transferEl, ev.payload);
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
        actionLabel: "Ver log",
        onAction: () => revealSftpActivity(panel),
      });
    }
    return canceled ? "canceled" : "error";
  } finally {
    try { ul(); } catch {}
  }
  return "done";
}

async function promptMkdir(sessionId, side) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const name = await promptTextValue({
    title: "Nueva carpeta",
    message: `Crear carpeta en ${side === "local" ? "Local" : "Remoto"}.`,
    label: "Nombre",
    submitLabel: "Crear",
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

async function promptRename(sessionId, side, oldPath, oldName) {
  const s = sessions.get(sessionId);
  if (!s?.sftp) return;
  const newName = await promptTextValue({
    title: "Renombrar",
    message: `Cambiar nombre en ${side === "local" ? "Local" : "Remoto"}.`,
    label: "Nuevo nombre",
    initialValue: oldName,
    submitLabel: "Renombrar",
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
      <button class="sftp-transfer-retry hidden" title="Reintentar">↻</button>
      <button class="sftp-transfer-close" title="Descartar / cancelar">✕</button>
    </div>
  `;
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
    if (job?.status === "running") {
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
  el.classList.remove("queued", "running", "done", "error", "skipped", "canceled");
  el.classList.add(state);
  if (["done", "error", "skipped", "canceled"].includes(state)) el.classList.add("done");
  else el.classList.remove("done");
  el.querySelector(".sftp-transfer-detail").textContent = detail;
  el.querySelector(".sftp-transfer-retry")?.classList.toggle(
    "hidden",
    !["error", "skipped", "canceled"].includes(state),
  );
  if (state === "running") {
    el.dataset.startedAt = String(Date.now());
  }
}

function updateTransfer(el, { transferred, total, done }) {
  const pct = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  el.querySelector(".sftp-transfer-fill").style.width = pct + "%";
  const startedAt = parseInt(el.dataset.startedAt || "0", 10);
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speed = transferred > 0 ? transferred / elapsed : 0;
  const eta = speed > 0 && total > transferred
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
 * Parsea el contenido de un fichero `~/.ssh/config` (formato OpenSSH).
 *
 * Formato resumido: bloques `Host <pattern>` seguidos de líneas indentadas
 * `Key Value`. Las claves son case-insensitive. Ignoramos directivas que no
 * mapean directamente a un perfil de Rustty (Match, Include, etc.) y los
 * patrones con comodines (`*`, `?`).
 *
 * Devuelve un array de objetos `{ alias, host, user, port, identityFile, proxyJump }`.
 */
function parseSshConfig(content) {
  const blocks = [];
  let current = null;
  for (const rawLine of content.split(/\r?\n/)) {
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
      current = { alias: aliases[0], host: aliases[0] };
      blocks.push(current);
    } else if (current) {
      switch (key) {
        case "hostname":      current.host = value; break;
        case "user":          current.user = value; break;
        case "port":          current.port = parseInt(value, 10); break;
        case "identityfile":  current.identityFile = value.replace(/^~/, ""); break;
        case "proxyjump":     current.proxyJump = value; break;
        // Resto: lo ignoramos en MVP.
      }
    }
  }
  return blocks.filter((b) => b.alias && b.host);
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

  let blocks;
  try {
    const text = await invoke("read_text_file", { path });
    blocks = parseSshConfig(text);
  } catch (err) {
    toast(`No se pudo leer ${path}: ${err}`, "error");
    return;
  }

  if (blocks.length === 0) {
    toast("No se encontraron entradas Host válidas en el fichero", "info");
    return;
  }

  const wsId = getActiveWorkspaceId();
  const folder = "SSH Config";
  saveWorkspaceFolders(wsId, [...getWorkspaceFolders(wsId), folder]);

  const existing = new Set(
    profiles
      .filter((p) => (p.workspace_id || "default") === wsId && p.group === folder)
      .map((p) => p.name)
  );

  let added = 0, skipped = 0;
  const now = new Date().toISOString();
  for (const b of blocks) {
    if (existing.has(b.alias)) { skipped++; continue; }
    const hasKey = !!b.identityFile;
    const profile = {
      id: crypto.randomUUID(),
      name: b.alias,
      host: b.host,
      port: Number.isFinite(b.port) ? b.port : 22,
      username: b.user || "",
      connection_type: "ssh",
      domain: null,
      auth_type: hasKey ? "public_key" : "password",
      key_path: hasKey ? b.identityFile : null,
      group: folder,
      notes: null,
      workspace_id: wsId,
      keepass_entry_uuid: null,
      follow_cwd: true,
      keep_alive_secs: null,
      allow_legacy_algorithms: false,
      agent_forwarding: false,
      x11_forwarding: false,
      auto_reconnect: null,
      session_log: false,
      session_log_dir: null,
      proxy_jump: b.proxyJump || null,
      mac_address: null,
      wol_broadcast: null,
      wol_port: null,
      created_at: now,
      updated_at: now,
    };
    try {
      await invoke("save_profile", { profile });
      profiles.push(profile);
      added++;
    } catch (err) {
      console.error("[ssh_config] save_profile failed for", b.alias, err);
    }
  }

  renderConnectionList();
  scheduleProfileAutoSync();
  toast(`SSH Config: ${added} nuevas, ${skipped} ya existían`, "success");
}

// ═══════════════════════════════════════════════════════════════
// ENLACE DE EVENTOS DE LA UI
// ═══════════════════════════════════════════════════════════════

function bindUIEvents() {
  // Bloquear el menú contextual nativo del WebView (Atrás, Recargar, Inspeccionar…).
  // Los menús de la app llaman a showContextMenu() y no dependen del default.
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // Reemplazar todos los <select> nativos por el dropdown personalizado
  document.querySelectorAll("select").forEach(enhanceSelect);
  enhanceNumberSteppers();

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
      const viewBtn = e.target.closest(".tools-view-btn");
      if (viewBtn) {
        setSidebarViewMode(viewBtn.dataset.viewMode);
        renderWorkspaceSwitcher();
        return;
      }
    });
    document.addEventListener("click", (e) => {
      if (!popover.classList.contains("hidden") &&
          !popover.contains(e.target) &&
          !toolsBtn.contains(e.target)) {
        toggleSidebarTools(false);
      }
    });
  }

  // Búsqueda en la sidebar
  const sidebarSearch = document.getElementById("sidebar-search");
  if (sidebarSearch) {
    sidebarSearch.addEventListener("input", () => {
      _sidebarSearchQuery = sidebarSearch.value;
      applySidebarSearchFilter();
    });
    sidebarSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sidebarSearch.value) {
        sidebarSearch.value = "";
        _sidebarSearchQuery = "";
        applySidebarSearchFilter();
        e.preventDefault();
      } else if (e.key === "Enter") {
        const first = sidebarSearchCandidates(sidebarSearch.value)[0];
        if (first) {
          connectProfile(first.id);
          toggleSidebarTools(false);
          e.preventDefault();
        }
      }
    });
  }

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
      else if (action === "settings") openSettingsModal();
      else if (action === "sync") {
        prefsActiveTab = "data";
        openSettingsModal();
      }
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

  // Controles de ventana (CSD): min / max / close + detección de plataforma
  initWindowControls();
  initCredentialModalEvents();

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

  document.getElementById("f-use-keepass").addEventListener("change", () =>
    updateAuthFields(document.getElementById("f-auth-type").value)
  );
  document.getElementById("f-keepass-entry").addEventListener("change", () =>
    updateKeepassEntryValidation()
  );

  document.getElementById("btn-toggle-password").addEventListener("click", () => {
    const input = document.getElementById("f-password");
    setPasswordVisible(input.type === "password");
    input.focus();
  });
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
  document.getElementById("btn-modal-save-only").addEventListener("click", () => {
    if (!document.getElementById("form-connection").checkValidity()) {
      document.getElementById("form-connection").reportValidity();
      return;
    }
    saveAndClose(false);
  });
  document.getElementById("form-connection").addEventListener("submit", (e) => {
    e.preventDefault();
    saveAndClose(true);
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
    if (btn.dataset.ctx === "set-folder-color") {
      const colorId = btn.dataset.colorId || null;
      const path = ctxTarget.folderPath;
      hideContextMenu();
      if (path) setFolderColor(path, colorId === "none" ? null : colorId);
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
}

// ═══════════════════════════════════════════════════════════════
// ATAJOS DE TECLADO
// ═══════════════════════════════════════════════════════════════
//
// Registro central de acciones con atajo. Los defaults se fusionan con
// prefs.shortcuts[id] (null = desactivado, string = accelerator tipo
// "Ctrl+Shift+N"). Las teclas se codifican con keyLabelFromCode() para
// evitar la ambigüedad de e.key por layout/locale.

const SHORTCUT_ACTIONS = {
  paste_terminal:    { default: "Ctrl+Alt+V",     run: () => pasteIntoActiveTerminal() },
  copy_terminal:     { default: "Ctrl+Alt+C",     run: () => copyActiveSelection() },
  paste_password:    { default: "Ctrl+P",         run: () => pasteSessionPasswordIntoActiveTerminal() },
  new_local_shell:   { default: "Ctrl+Shift+T",   run: () => openLocalShell() },
  new_connection:    { default: "Ctrl+Shift+N",   run: () => openNewConnectionModal() },
  search_connections:{ default: "Ctrl+K",         run: () => focusConnectionSearch() },
  close_tab:         { default: "Ctrl+W",         run: () => { if (activeSessionId) closeSession(activeSessionId); } },
  next_tab:          { default: "Ctrl+Tab",       run: () => switchTab(1) },
  prev_tab:          { default: "Ctrl+Shift+Tab", run: () => switchTab(-1) },
  next_pane:         { default: "Ctrl+Alt+ArrowRight", run: () => focusPaneByOffset(+1) },
  prev_pane:         { default: "Ctrl+Alt+ArrowLeft",  run: () => focusPaneByOffset(-1) },
  open_preferences:  { default: "Ctrl+,",         run: () => openSettingsModal() },
  zoom_in:           { default: "Ctrl+=",         run: () => adjustTerminalFontSize(+1) },
  zoom_out:          { default: "Ctrl+-",         run: () => adjustTerminalFontSize(-1) },
  zoom_reset:        { default: "Ctrl+0",         run: () => adjustTerminalFontSize("reset") },
  find_in_terminal:  { default: "Ctrl+F",         run: () => toggleTerminalSearch() },
  clear_terminal:    { default: null,             run: () => clearActiveTerminal() },
  sftp_toggle_panel: { default: "Ctrl+Shift+F",   run: () => toggleActiveSftpPanel() },
  sftp_toggle_follow:{ default: null,             run: () => toggleActiveSftpFollow() },
  sftp_toggle_sudo:  { default: null,             run: () => toggleActiveSftpElevated() },
};

const SHORTCUT_IDS = Object.keys(SHORTCUT_ACTIONS);

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
  for (const id of SHORTCUT_IDS) {
    if (getShortcut(id) === combo) {
      e.preventDefault();
      e.stopPropagation();
      SHORTCUT_ACTIONS[id].run();
      return;
    }
  }
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
  if (next === prefs.fontSize) return;
  prefs.fontSize = next;
  savePrefs();
  applyPrefsToAllTerminals();
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
  if (!s || s.status === "closed") return;
  if (s._closeOverride || s.type === "rdp" || !s.profileId) {
    toast("Ctrl+P solo funciona en sesiones SSH con perfil", "warning");
    return;
  }
  let password;
  try {
    password = await invoke("get_profile_password", { profileId: s.profileId });
  } catch (err) {
    toast(`No se pudo leer la contraseña: ${err}`, "error");
    return;
  }
  if (!password) {
    toast("El perfil no tiene una contraseña guardada", "warning");
    return;
  }
  const data = Array.from(new TextEncoder().encode(password));
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

/**
 * Alterna la visibilidad de la barra lateral y persiste el estado.
 * Después del cambio hace `fit` de los terminales visibles porque el
 * área principal cambia de anchura.
 */
function initSidebarToggle() {
  const btn = document.getElementById("btn-toggle-sidebar");
  if (!btn) return;

  const saved = localStorage.getItem("rustty-sidebar-collapsed") === "1";
  if (saved) document.body.classList.add("sidebar-collapsed");

  btn.addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem("rustty-sidebar-collapsed", collapsed ? "1" : "0");
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
    await restoreWindowStateNow(win);
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

  document.addEventListener("mousedown", (e) => {
    if (list.classList.contains("hidden")) return;
    if (wrapper.contains(e.target) || list.contains(e.target)) return;
    close();
  });

  window.addEventListener("resize", () => {
    if (!list.classList.contains("hidden")) position();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.classList.contains("hidden")) close();
  });

  // Observar cambios en las options (innerHTML = …, appendChild, etc.)
  new MutationObserver(refresh).observe(selectEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["selected", "disabled", "value"],
  });

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

// ═══════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  el.appendChild(text);
  if (options.actionLabel && typeof options.onAction === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = options.actionLabel;
    btn.addEventListener("click", () => {
      options.onAction();
      el.remove();
    });
    el.appendChild(btn);
  }
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ═══════════════════════════════════════════════════════════════
// ARRANQUE
// ═══════════════════════════════════════════════════════════════

init();
