// @ts-check
/**
 * Núcleo **puro** de presentación del monitor de recursos: formateo de tasas,
 * generación del trazo SVG de los sparklines y selección del disco resumen. Sin
 * DOM ni estado; la instantánea la produce el backend (`metrics::Metrics`) y
 * aquí solo se transforma para pintar.
 */

import { formatSize } from "./format.js";

/**
 * Tasa de transferencia legible (`1.5 MB/s`). Reutiliza {@link formatSize} sobre
 * bytes. `null`/no finito → `"—"` (la primera muestra aún no tiene tasa).
 * @param {number|null|undefined} bps
 * @returns {string}
 */
export function formatBytesPerSec(bps) {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return "—";
  return `${formatSize(Math.round(bps))}/s`;
}

/**
 * Tamaño en kiB a texto legible (lo que dan `/proc/meminfo` y `df`). Pasa a
 * bytes y delega en {@link formatSize}.
 * @param {number} kb
 * @returns {string}
 */
export function formatKib(kb) {
  return formatSize(Math.max(0, Math.round(kb)) * 1024);
}

/**
 * Porcentaje de uso `used/total` acotado a 0..100, con un decimal. `0` si el
 * total no es válido.
 * @param {number} used
 * @param {number} total
 * @returns {number}
 */
export function usagePct(used, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const pct = (used / total) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

/**
 * Disco a mostrar en la barra compacta: el montado en `/` si existe; si no, el
 * **más lleno** (mayor % de uso). `null` si la lista está vacía.
 * @param {Array<{ mount: string, usedKb: number, sizeKb: number }>} disks
 * @returns {{ mount: string, usedKb: number, sizeKb: number }|null}
 */
export function summaryDisk(disks) {
  if (!Array.isArray(disks) || disks.length === 0) return null;
  const root = disks.find((d) => d.mount === "/");
  if (root) return root;
  return disks.reduce((fullest, d) =>
    usagePct(d.usedKb, d.sizeKb) > usagePct(fullest.usedKb, fullest.sizeKb) ? d : fullest
  );
}

/**
 * Trazo SVG (`d` de un `<path>`) de un sparkline a partir de una serie de
 * valores, normalizado al máximo de la propia serie y encajado en `width`×
 * `height` (coordenadas SVG, con el eje Y hacia abajo). Devuelve `""` con menos
 * de dos puntos. Si todos los valores son 0, dibuja una línea plana abajo.
 * @param {number[]} values
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function sparklinePath(values, width, height) {
  const pts = (values || []).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return "";
  const max = Math.max(...pts, 0);
  const denom = max > 0 ? max : 1;
  const stepX = width / (pts.length - 1);
  return pts
    .map((v, i) => {
      const x = i * stepX;
      const y = height - (v / denom) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * Empuja `value` al final de una serie de historia acotada a `cap` puntos,
 * devolviendo una **nueva** serie (no muta la entrada). Descarta los más viejos
 * al superar el tope.
 * @param {number[]} series
 * @param {number} value
 * @param {number} cap
 * @returns {number[]}
 */
export function pushHistory(series, value, cap) {
  const next = [...(series || []), value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
