// @ts-check

/**
 * Fechas de edición POR CLAVE de las preferencias sincronizadas.
 *
 * Antes todas viajaban en un único item `prefs:bundle` con una sola fecha
 * (`_prefsUpdatedAt`): si el equipo A cambiaba un ajuste del terminal y el B
 * uno de carpetas antes de sincronizar, el LWW del backend descartaba el
 * bundle entero del más viejo y una de las dos ediciones se perdía. Ahora cada
 * clave viaja además como item `pref:<clave>` con su propia fecha, y el merge
 * del backend (LWW por item) las resuelve por separado.
 *
 * Las fechas no se marcan en los ~30 sitios que editan preferencias (siguen
 * marcando `_prefsUpdatedAt`, como siempre): se DERIVAN al construir el estado.
 * Se guarda una huella del valor de cada clave; si la huella cambió desde la
 * última vez, la clave se editó y toma la fecha del bundle, que es la de la
 * última edición. Las mismas reglas que el bundle, por tanto, incluida la de
 * oro de una instalación nueva: sin `_prefsUpdatedAt` la fecha es 1970 y la
 * nube gana (ver `bug_sync_fresh_device_prefs_clobber`).
 */

import { SYNCED_PREF_KEYS } from "./sync.js";

export const PREF_ITEM_PREFIX = "pref:";
const FALLBACK_TS = "1970-01-01T00:00:00.000Z";

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Huella estable del valor de una preferencia (FNV-1a de 32 bits sobre el
 * JSON canónico). Solo detecta cambios locales: no viaja ni se compara entre
 * equipos, así que una colisión costaría, como mucho, no fechar una edición.
 * @param {unknown} value
 */
export function prefValueHash(value) {
  const text = value === undefined ? "u" : JSON.stringify(canonical(value));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + text.length.toString(36);
}

/**
 * Pone al día `_prefsKeyTs` a partir de las huellas: cada clave cuyo valor
 * cambió desde la última vez toma la fecha del bundle. Idempotente.
 * @param {Record<string, any>} prefs
 */
export function refreshPrefKeyStamps(prefs) {
  const bundleTs = typeof prefs._prefsUpdatedAt === "string" && prefs._prefsUpdatedAt.trim()
    ? prefs._prefsUpdatedAt
    : FALLBACK_TS;
  const stamps = (prefs._prefsKeyTs ||= {});
  const hashes = (prefs._prefsKeyHash ||= {});
  for (const key of SYNCED_PREF_KEYS) {
    const hash = prefValueHash(prefs[key]);
    if (hashes[key] === hash && typeof stamps[key] === "string") continue;
    hashes[key] = hash;
    stamps[key] = bundleTs;
  }
}

/**
 * Registra que una clave tomó un valor llegado de otro equipo (o de una
 * restauración) con esa fecha, para que la siguiente construcción no lo
 * confunda con una edición local.
 * @param {Record<string, any>} prefs
 * @param {string} key
 * @param {string} ts
 */
export function markPrefKeyApplied(prefs, key, ts) {
  (prefs._prefsKeyTs ||= {})[key] = ts;
  (prefs._prefsKeyHash ||= {})[key] = prefValueHash(prefs[key]);
}

/**
 * Huellas vivas de todas las claves sincronizadas: la foto con la que se lanza
 * una sync, para no revertir al aplicar una clave editada con la sync en vuelo.
 * @param {Record<string, any>} prefs
 * @returns {Record<string, string>}
 */
export function capturePrefKeyHashes(prefs) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of SYNCED_PREF_KEYS) out[key] = prefValueHash(prefs?.[key]);
  return out;
}

/** @param {string} itemKey */
export function isPrefItemKey(itemKey) {
  return itemKey.startsWith(PREF_ITEM_PREFIX);
}
