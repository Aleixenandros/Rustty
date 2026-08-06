// @ts-check
/**
 * Bundle de diagnóstico **redactado**.
 *
 * Sirve para pegar en un issue lo que hace falta para reproducir un fallo
 * —versión, plataforma, preferencias relevantes, últimos eventos— sin arrastrar
 * nada de lo que la app promete no soltar nunca: contraseñas, passphrases,
 * tokens, contenido del terminal ni rutas del usuario.
 *
 * La redacción es **por defecto**, no un extra: hosts y rutas solo aparecen si
 * quien genera el informe lo autoriza explícitamente (`includeHosts` /
 * `includePaths`), y aun entonces las contraseñas y tokens siguen tachados. El
 * módulo es puro: no lee prefs globales, no toca el DOM y no conoce la hora del
 * sistema salvo la que se le pasa.
 */

/** Versión del formato del informe. Sube si cambia la forma del documento. */
export const DIAGNOSTICS_VERSION = 1;

/**
 * Claves de preferencias que **nunca** entran, ni con consentimiento: son
 * contenido escrito por el usuario o identificadores de sus secretos.
 */
export const PREFS_EXCLUDED_KEYS = Object.freeze([
  "commandDrafts",        // texto que el usuario estaba escribiendo
  "recentKeepassEntries", // UUIDs de entradas de su base de credenciales
  "folderColors",         // se indexa por ruta de carpeta del usuario
  "workspaces",           // nombres propios de su organización
  "customThemes",
  "highlightRules",       // regex propias; pueden llevar hostnames o usuarios
  "syncPassphrase",
  "syncToken",
]);

/** Patrones de secreto tachados en cualquier texto libre del informe. */
const SECRET_PATTERNS = [
  // clave=valor (password, token, secret, api_key…) con o sin comillas
  [/\b(pass(?:word|wd|phrase)?|secret|token|api[_-]?key|auth)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2••••"],
  // Cabeceras Authorization / Bearer
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ••••"],
  // Claves públicas y privadas OpenSSH
  [/\b(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/=]{20,}/g, "$1 ••••"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY----- •••• -----END PRIVATE KEY-----"],
  // URLs con credenciales incrustadas (usuario:clave@host)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1••••:••••@"],
];

/**
 * Tacha secretos de un texto libre (título de un evento, mensaje de error…).
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let value = String(text ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    value = value.replace(/** @type {RegExp} */ (pattern), /** @type {string} */ (replacement));
  }
  return value;
}

/**
 * Etiqueta estable y anónima de un host: dos ejecuciones del informe dan el
 * mismo alias para el mismo host, así que las líneas se pueden correlacionar
 * sin revelar a dónde se conecta nadie.
 * @param {string} host
 * @returns {string}
 */
export function hostAlias(host) {
  const value = String(host ?? "");
  if (!value) return "";
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `host-${(hash >>> 0).toString(36)}`;
}

/**
 * @param {string} host
 * @param {boolean} includeHosts
 * @returns {string}
 */
export function redactHost(host, includeHosts) {
  if (!host) return "";
  return includeHosts ? String(host) : hostAlias(host);
}

/**
 * Ruta apta para el informe. Sin consentimiento se reduce a su forma
 * (extensión y profundidad), que es lo que sirve para diagnosticar, sin decir
 * dónde vive el usuario.
 * @param {string} path
 * @param {{ includePaths?: boolean, home?: string }} [options]
 * @returns {string}
 */
export function redactPath(path, options = {}) {
  const value = String(path ?? "");
  if (!value) return "";
  const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
  if (options.includePaths) {
    const home = options.home ? String(options.home).replace(/[\\/]+$/, "") : "";
    return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  }
  const parts = value.split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) || "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  return `<path:${parts.length}${separator}*${ext}>`;
}

/**
 * Un valor de preferencia parece una ruta si trae separadores de directorio.
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikePath(value) {
  return typeof value === "string" && /(^~?[\\/])|([A-Za-z]:\\)/.test(value);
}

/**
 * Preferencias aptas para el informe: escalares, sin las claves excluidas y con
 * las rutas redactadas. Los objetos y arrays se resumen por tamaño, porque su
 * contenido es del usuario y su forma ya dice lo que hace falta.
 * @param {Record<string, unknown>} prefs
 * @param {{ includePaths?: boolean, home?: string }} [options]
 * @returns {Record<string, unknown>}
 */
export function sanitizePrefsForDiagnostics(prefs, options = {}) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(prefs || {})) {
    if (PREFS_EXCLUDED_KEYS.includes(key)) continue;
    if (value === null || value === undefined) { out[key] = null; continue; }
    if (typeof value === "boolean" || typeof value === "number") { out[key] = value; continue; }
    if (typeof value === "string") {
      out[key] = looksLikePath(value) ? redactPath(value, options) : redactSecrets(value);
      continue;
    }
    if (Array.isArray(value)) { out[key] = `<array:${value.length}>`; continue; }
    if (typeof value === "object") { out[key] = `<object:${Object.keys(value).length}>`; continue; }
  }
  return out;
}

/**
 * @typedef {object} DiagnosticsInput
 * @property {string} appVersion
 * @property {string} [platform] SO (`linux`, `windows`, `macos`).
 * @property {string} [osVersion]
 * @property {string} [arch]
 * @property {string} [locale] Idioma activo de la interfaz.
 * @property {string} [webview] Motor del WebView (user agent recortado).
 * @property {Record<string, unknown>} [prefs]
 * @property {{ profiles?: number, folders?: number, workspaces?: number, credentials?: number, scripts?: number, tunnels?: number }} [counts]
 * @property {{ type?: string, status?: string, host?: string, error?: string }[]} [sessions]
 * @property {{ timestamp?: string, kind?: string, status?: string, title?: string, detail?: string }[]} [activity]
 * @property {string[]} [logs] Líneas de log de la aplicación (se redactan).
 * @property {string} [home] Directorio del usuario, para acortar rutas.
 */

/**
 * @typedef {object} DiagnosticsOptions
 * @property {boolean} [includeHosts] Consentimiento explícito para hosts reales.
 * @property {boolean} [includePaths] Consentimiento explícito para rutas reales.
 * @property {number} [maxActivity] Eventos de actividad incluidos (los más recientes).
 * @property {number} [maxLogs] Líneas de log incluidas (las más recientes).
 * @property {Date} [now]
 */

/**
 * Construye el informe redactado.
 * @param {DiagnosticsInput} input
 * @param {DiagnosticsOptions} [options]
 * @returns {Record<string, unknown>}
 */
export function buildDiagnosticsReport(input, options = {}) {
  const includeHosts = !!options.includeHosts;
  const includePaths = !!options.includePaths;
  const maxActivity = options.maxActivity ?? 50;
  const maxLogs = options.maxLogs ?? 200;
  const pathOptions = { includePaths, home: input.home };
  const now = options.now ?? new Date();

  return {
    kind: "rustty-diagnostics",
    version: DIAGNOSTICS_VERSION,
    generatedAt: now.toISOString(),
    redaction: {
      hosts: includeHosts ? "included" : "aliased",
      paths: includePaths ? "included" : "shape-only",
      secrets: "always-redacted",
      terminalOutput: "never-included",
    },
    app: {
      version: input.appVersion || "",
      locale: input.locale || "",
    },
    platform: {
      os: input.platform || "",
      osVersion: input.osVersion || "",
      arch: input.arch || "",
      webview: input.webview || "",
    },
    counts: { ...(input.counts || {}) },
    prefs: sanitizePrefsForDiagnostics(input.prefs || {}, pathOptions),
    sessions: (input.sessions || []).map((s) => ({
      type: s.type || "",
      status: s.status || "",
      host: redactHost(s.host || "", includeHosts),
      error: s.error ? redactSecrets(s.error) : null,
    })),
    activity: (input.activity || []).slice(-maxActivity).map((item) => ({
      timestamp: item.timestamp || "",
      kind: item.kind || "",
      status: item.status || "",
      title: redactSecrets(item.title || ""),
      detail: redactSecrets(item.detail || ""),
    })),
    logs: (input.logs || []).slice(-maxLogs).map((line) => redactSecrets(line)),
  };
}

/**
 * Resumen legible del informe, para pegar en un issue. El JSON completo va
 * aparte; esto es la portada.
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function diagnosticsToMarkdown(report) {
  const lines = [];
  lines.push("## Rustty — diagnostics");
  lines.push("");
  lines.push(`- **App version:** ${report.app?.version || "?"}`);
  lines.push(`- **Platform:** ${[report.platform?.os, report.platform?.osVersion, report.platform?.arch].filter(Boolean).join(" ") || "?"}`);
  if (report.platform?.webview) lines.push(`- **WebView:** ${report.platform.webview}`);
  lines.push(`- **UI language:** ${report.app?.locale || "?"}`);
  lines.push(`- **Generated:** ${report.generatedAt || "?"}`);
  lines.push(`- **Redaction:** hosts ${report.redaction?.hosts}, paths ${report.redaction?.paths}, secrets ${report.redaction?.secrets}`);
  const counts = Object.entries(report.counts || {});
  if (counts.length) {
    lines.push(`- **Items:** ${counts.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const sessions = report.sessions || [];
  if (sessions.length) {
    lines.push("");
    lines.push("### Sessions");
    for (const s of sessions) {
      lines.push(`- ${s.type || "?"} · ${s.status || "?"} · ${s.host || "-"}${s.error ? ` · ${s.error}` : ""}`);
    }
  }
  const activity = report.activity || [];
  if (activity.length) {
    lines.push("");
    lines.push("### Recent activity");
    for (const item of activity) {
      lines.push(`- \`${item.timestamp}\` [${item.status || "info"}] ${item.title}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
