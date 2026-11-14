// @ts-check
/**
 * Cuentas del indicador de espacio en disco del panel SFTP remoto.
 *
 * El backend manda los tres contadores de `statvfs@openssh.com` ya en bytes
 * (`total`, `free`, `available`); aquí se deciden, sin DOM ni estado, las dos
 * cosas que se pintan: cuánto queda para el usuario y qué porcentaje está
 * ocupado. Los números son **del servidor**: se validan antes de usarlos y un
 * dato imposible no pinta nada (el indicador es de cortesía, nunca un error).
 *
 * El porcentaje sigue la cuenta de `df`: lo usado sobre lo que el usuario puede
 * llegar a usar (usado + disponible), redondeado hacia arriba. Así coincide con
 * lo que el usuario ve si ejecuta `df` en el terminal de al lado; contar sobre
 * el total daría menos en un disco con reserva para root.
 */

import { formatSize } from "../format.js";

/** Desde qué porcentaje ocupado el indicador avisa, y desde cuál alarma. */
export const DISK_WARN_PERCENT = 85;
export const DISK_FULL_PERCENT = 95;

/**
 * @typedef {object} DiskUsage
 * @property {number} total Tamaño del sistema de ficheros, en bytes.
 * @property {number} available Lo que el usuario puede escribir aún, en bytes.
 * @property {number} used Lo ocupado, en bytes.
 * @property {number} usedPercent Ocupación de 0 a 100, entera, como `df`.
 * @property {"ok"|"warn"|"full"} level
 */

/** @param {unknown} value */
function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Convierte la respuesta de `sftp_disk_space` en lo que se pinta. `null` si no
 * hay dato (servidor sin la extensión, FTP) o si no es creíble.
 * @param {unknown} raw
 * @returns {DiskUsage|null}
 */
export function diskUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { total, free, available } = /** @type {Record<string, unknown>} */ (raw);
  if (!isCount(total) || !isCount(free) || !isCount(available)) return null;
  const size = /** @type {number} */ (total);
  if (size <= 0) return null;
  // El backend ya los acota; aquí se repite para no depender de ello.
  const freeBytes = Math.min(/** @type {number} */ (free), size);
  const availableBytes = Math.min(/** @type {number} */ (available), freeBytes);
  const used = size - freeBytes;
  const reachable = used + availableBytes;
  // Sin nada usado ni disponible (todo es reserva de root), para el usuario
  // el disco está lleno.
  const usedPercent = reachable > 0
    ? Math.min(100, Math.max(0, Math.ceil((used * 100) / reachable)))
    : 100;
  return {
    total: size,
    available: availableBytes,
    used,
    usedPercent,
    level: diskLevel(usedPercent),
  };
}

/**
 * @param {number} usedPercent
 * @returns {"ok"|"warn"|"full"}
 */
export function diskLevel(usedPercent) {
  if (usedPercent >= DISK_FULL_PERCENT) return "full";
  if (usedPercent >= DISK_WARN_PERCENT) return "warn";
  return "ok";
}

/**
 * Los textos del indicador, listos para las cadenas traducidas
 * (`{free} libres de {total}`, `{percent} % ocupado`).
 * @param {DiskUsage} usage
 * @returns {{ free: string, total: string, percent: string }}
 */
export function diskUsageLabels(usage) {
  return {
    free: formatSize(usage.available),
    total: formatSize(usage.total),
    percent: String(usage.usedPercent),
  };
}
