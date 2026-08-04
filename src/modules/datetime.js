// @ts-check
/**
 * Formateo de fechas y tiempos relativos. A diferencia de `format.js`, estas
 * funciones dependen del **reloj**, el **locale** y (una de ellas) del
 * traductor `t()`. Para que sean testeables sin ser frágiles en CI, esas
 * dependencias se **inyectan** por parámetro con defaults que preservan el
 * comportamiento que tenían dentro de `main.js`.
 */

/**
 * Marca de tiempo (segundos Unix) a texto legible. Dentro del año en curso
 * muestra día y hora (`15 mar, 12:30`); de otro año, solo la fecha
 * (`15/3/2025`). Devuelve `""` si `secs` es falsy (0, null, undefined).
 *
 * El formateo usa `toLocale*` del entorno: el año se compara contra `now` y el
 * idioma/orden lo fija `locale`. Ambos se inyectan solo para los tests; en la
 * app se llama `formatTime(secs)` y toma el reloj y el locale del sistema, como
 * antes.
 * @param {number} secs
 * @param {{ now?: number, locale?: string }} [opts]
 * @returns {string}
 */
export function formatTime(secs, { now = Date.now(), locale = undefined } = {}) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const yr = d.getFullYear();
  if (yr === new Date(now).getFullYear()) {
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" })
      + " " + d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(locale);
}

/**
 * Antigüedad de una fecha ISO como texto corto y relativo («ahora», «hace 5
 * min», «hace 3 h», «hace 2 d»), tomando las cadenas de `t()`. Devuelve `null`
 * si la fecha no es parseable.
 *
 * El traductor `t` se pasa como argumento (antes era el `t` global de
 * `main.js`); `now` se inyecta solo para los tests.
 * @param {string} iso
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @param {{ now?: number }} [opts]
 * @returns {string|null}
 */
export function formatRelativeTimeShort(iso, t, { now = Date.now() } = {}) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = now - ts;
  if (diff < 60_000) return t("time.now");
  const min = Math.floor(diff / 60_000);
  if (min < 60) return t("time.minutes_ago", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.hours_ago", { n: h });
  const d = Math.floor(h / 24);
  return t("time.days_ago", { n: d });
}

/**
 * Fecha de última conexión para el dashboard. Durante la última semana usa el
 * mismo formato relativo traducido que la sincronización; después muestra una
 * fecha absoluta localizada. Los valores ausentes o corruptos nunca filtran el
 * antiguo literal castellano: pasan por i18n.
 *
 * @param {unknown} value
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @param {{ now?: number, locale?: string }} [opts]
 * @returns {string}
 */
export function formatDashboardTime(
  value,
  t,
  { now = Date.now(), locale = undefined } = {},
) {
  if (!value) return t("dashboard.no_activity");
  const date = new Date(/** @type {string|number|Date} */ (value));
  if (!Number.isFinite(date.getTime())) return t("dashboard.no_activity");
  const diff = now - date.getTime();
  if (diff < 7 * 86_400_000) {
    return formatRelativeTimeShort(date.toISOString(), t, { now })
      || t("dashboard.no_activity");
  }
  return date.toLocaleDateString(locale);
}
