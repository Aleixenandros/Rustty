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

/**
 * Umbrales de alerta del monitor, con disparo por flanco e histéresis: cada
 * métrica avisa **una vez** al cruzar su umbral hacia arriba y no se rearma
 * hasta caer por debajo de `umbral - rearmMargin` (sin histéresis, una métrica
 * oscilando sobre el umbral dispararía un aviso por muestra).
 *
 * `prevActive` es el estado devuelto por la llamada anterior (`{}` al empezar).
 * Umbral `0`/ausente = métrica desactivada; valor `null`/no finito (primera
 * muestra, fuente «n/d») nunca dispara.
 * @param {Record<string, boolean>} prevActive
 * @param {Record<string, number|null|undefined>} values
 * @param {Record<string, number>} thresholds
 * @param {number} [rearmMargin]
 * @returns {{ active: Record<string, boolean>, fired: string[] }}
 */
export function computeMetricAlerts(prevActive, values, thresholds, rearmMargin = 5) {
  /** @type {Record<string, boolean>} */
  const active = {};
  /** @type {string[]} */
  const fired = [];
  for (const key of Object.keys(thresholds || {})) {
    const th = Number(thresholds[key]) || 0;
    const v = values?.[key];
    if (th <= 0 || v == null || !Number.isFinite(v)) {
      active[key] = false;
      continue;
    }
    if (prevActive?.[key]) {
      active[key] = v > th - rearmMargin;
    } else {
      active[key] = v >= th;
      if (active[key]) fired.push(key);
    }
  }
  return { active, fired };
}

/**
 * @typedef {{ pid: number, cpuPct: number, memPct: number, command: string, user?: string }} ProcRow
 * @typedef {"pid"|"user"|"command"|"cpu"|"mem"} ProcSortKey
 * @typedef {"asc"|"desc"} SortDir
 * @typedef {{ filter: string, sortKey: ProcSortKey, sortDir: SortDir }} ProcView
 */

/** Columnas ordenables de la tabla de procesos, en orden de presentación. */
export const PROC_SORT_KEYS = /** @type {const} */ (["pid", "user", "command", "cpu", "mem"]);

/**
 * Sentido con que empieza cada columna al elegirla: los porcentajes, de mayor a
 * menor (lo que interesa es quién gasta más); el resto, alfabético o creciente.
 * @type {Record<ProcSortKey, SortDir>}
 */
const FIRST_DIR = { pid: "asc", user: "asc", command: "asc", cpu: "desc", mem: "desc" };

/**
 * @param {unknown} key
 * @returns {key is ProcSortKey}
 */
function isProcSortKey(key) {
  return /** @type {readonly unknown[]} */ (PROC_SORT_KEYS).includes(key);
}

/**
 * Vista inicial de la tabla: sin filtro y por %CPU descendente, el mismo orden
 * en que la manda el servidor (`ps --sort=-pcpu`).
 * @returns {ProcView}
 */
export function defaultProcView() {
  return { filter: "", sortKey: "cpu", sortDir: "desc" };
}

/**
 * Filtra por nombre del comando, PID o usuario, sin distinguir mayúsculas.
 * Varias palabras se exigen todas (cada una puede casar con cualquier campo):
 * `root nginx` deja los nginx de root. Consulta vacía → todos.
 * @param {ProcRow[]} procs
 * @param {string} query
 * @returns {ProcRow[]}
 */
export function filterProcs(procs, query) {
  const list = Array.isArray(procs) ? procs : [];
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list.slice();
  return list.filter((p) => {
    const fields = [
      String(p.command ?? "").toLowerCase(),
      String(p.user ?? "").toLowerCase(),
      String(Number(p.pid) || 0),
    ];
    return terms.every((term) => fields.some((f) => f.includes(term)));
  });
}

/**
 * @param {ProcRow} p
 * @param {ProcSortKey} key
 * @returns {number|string}
 */
function sortValue(p, key) {
  switch (key) {
    case "pid": return Number(p.pid) || 0;
    case "cpu": return Number(p.cpuPct) || 0;
    case "mem": return Number(p.memPct) || 0;
    case "user": return String(p.user ?? "");
    default: return String(p.command ?? "");
  }
}

/**
 * Ordena (sin mutar la entrada) por la columna y el sentido pedidos. Los
 * empates se deshacen por PID creciente, para que dos filas iguales no se
 * crucen de una muestra a la siguiente. Una clave desconocida ordena por %CPU.
 * @param {ProcRow[]} procs
 * @param {string} key
 * @param {string} dir
 * @returns {ProcRow[]}
 */
export function sortProcs(procs, key, dir) {
  const k = isProcSortKey(key) ? key : "cpu";
  const sign = dir === "asc" ? 1 : -1;
  return (Array.isArray(procs) ? procs : []).slice().sort((a, b) => {
    const va = sortValue(a, k);
    const vb = sortValue(b, k);
    const cmp = typeof va === "number" && typeof vb === "number"
      ? va - vb
      : String(va).localeCompare(String(vb), undefined, { sensitivity: "base", numeric: true });
    if (cmp !== 0) return cmp * sign;
    return (Number(a.pid) || 0) - (Number(b.pid) || 0);
  });
}

/**
 * Filas a pintar: filtradas y ordenadas según la vista de la sesión.
 * @param {ProcRow[]} procs
 * @param {ProcView|null|undefined} view
 * @returns {ProcRow[]}
 */
export function procTableRows(procs, view) {
  const v = view || defaultProcView();
  return sortProcs(filterProcs(procs, v.filter), v.sortKey, v.sortDir);
}

/**
 * Orden tras pulsar una cabecera: la misma columna invierte el sentido; otra
 * empieza en su sentido natural ({@link FIRST_DIR}). Una clave desconocida
 * deja el orden como estaba.
 * @param {ProcView|null|undefined} view
 * @param {string} key
 * @returns {{ sortKey: ProcSortKey, sortDir: SortDir }}
 */
export function nextProcSort(view, key) {
  if (!isProcSortKey(key)) {
    return { sortKey: view?.sortKey || "cpu", sortDir: view?.sortDir || "desc" };
  }
  if (view?.sortKey === key) return { sortKey: key, sortDir: view.sortDir === "asc" ? "desc" : "asc" };
  return { sortKey: key, sortDir: FIRST_DIR[key] };
}

/**
 * Valor de `aria-sort` de una cabecera: el sentido en la columna activa y
 * `none` en las demás.
 * @param {ProcView|null|undefined} view
 * @param {string} key
 * @returns {"ascending"|"descending"|"none"}
 */
export function procSortAria(view, key) {
  if (!view || view.sortKey !== key) return "none";
  return view.sortDir === "asc" ? "ascending" : "descending";
}
