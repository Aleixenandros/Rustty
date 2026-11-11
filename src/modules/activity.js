// @ts-check
/** Núcleo puro del historial y la agrupación del centro de actividad. */

/**
 * @typedef {object} ActivityItem
 * @property {string} id
 * @property {string} kind
 * @property {string} status
 * @property {string} title
 * @property {string} detail
 * @property {string} actionLabel
 * @property {(() => void)|null} action
 * @property {string} timestamp
 */

/**
 * Sanea una entrada leída de almacenamiento o creada por la UI.
 *
 * @param {unknown} item
 * @param {{ createId?: () => string, now?: number }} [options]
 * @returns {ActivityItem|null}
 */
export function normalizeActivityItem(
  item,
  { createId = () => crypto.randomUUID(), now = Date.now() } = {},
) {
  if (!item || typeof item !== "object" || !("title" in item) || !item.title) return null;
  const value = /** @type {Record<string, unknown>} */ (item);
  const timestamp = new Date(/** @type {string|number|Date} */ (value.timestamp));
  return {
    id: String(value.id || createId()),
    kind: String(value.kind || "toast").slice(0, 40),
    status: String(value.status || "info").slice(0, 40),
    title: String(value.title).slice(0, 500),
    detail: value.detail ? String(value.detail).slice(0, 2000) : "",
    actionLabel: value.actionLabel ? String(value.actionLabel).slice(0, 80) : "",
    action: typeof value.action === "function"
      ? /** @type {() => void} */ (value.action)
      : null,
    timestamp: Number.isFinite(timestamp.getTime())
      ? timestamp.toISOString()
      : new Date(now).toISOString(),
  };
}

/**
 * Elimina callbacks antes de persistir el historial.
 * @param {ActivityItem} item
 * @returns {Omit<ActivityItem, "action">}
 */
export function serializableActivityItem(item) {
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

/**
 * Agrupa entradas por hoy, ayer, esta semana y fecha absoluta.
 *
 * @param {ActivityItem[]} items
 * @param {{ now?: number, locale?: string, t?: (key: string) => string }} [options]
 * @returns {{ label: string, sort: number, items: ActivityItem[] }[]}
 */
export function groupActivityByDay(
  items,
  { now = Date.now(), locale = undefined, t = (key) => key } = {},
) {
  const dayMs = 24 * 60 * 60 * 1000;
  const nowDate = new Date(now);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  /** @type {Map<string, { label: string, sort: number, items: ActivityItem[] }>} */
  const groups = new Map();
  for (const item of items) {
    const parsed = item.timestamp ? new Date(item.timestamp) : nowDate;
    const date = Number.isFinite(parsed.getTime()) ? parsed : nowDate;
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.round((startOfToday - dayStart) / dayMs);
    let key;
    let label;
    if (diffDays <= 0) {
      key = "today";
      label = t("activity.today");
    } else if (diffDays === 1) {
      key = "yesterday";
      label = t("activity.yesterday");
    } else if (diffDays < 7) {
      key = "week";
      label = t("activity.this_week");
    } else {
      key = `d${dayStart}`;
      label = new Date(dayStart).toLocaleDateString(locale);
    }
    if (!groups.has(key)) groups.set(key, { label, sort: dayStart, items: [] });
    groups.get(key)?.items.push(item);
  }
  return [...groups.values()].sort((a, b) => b.sort - a.sort);
}

/**
 * Filtros del centro de actividad. Los cuatro centrales van por tipo de
 * entrada; «error» es transversal: cualquier entrada que terminó en error.
 */
export const ACTIVITY_FILTERS = /** @type {const} */ (["all", "connection", "sftp", "sync", "update", "error"]);

/**
 * @param {Pick<ActivityItem, "kind"|"status">} item
 * @param {string} filter
 */
export function matchesActivityFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "error") return item.status === "error";
  return item.kind === filter;
}

/**
 * @template {Pick<ActivityItem, "kind"|"status">} T
 * @param {T[]} items
 * @param {string} filter
 * @returns {T[]}
 */
export function filterActivityItems(items, filter) {
  return filter === "all" ? items : items.filter((item) => matchesActivityFilter(item, filter));
}

/**
 * Cuántas entradas caen en cada filtro, para rotular los chips.
 * @param {Pick<ActivityItem, "kind"|"status">[]} items
 * @returns {Record<string, number>}
 */
export function activityFilterCounts(items) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const filter of ACTIVITY_FILTERS) counts[filter] = 0;
  for (const item of items) {
    for (const filter of ACTIVITY_FILTERS) {
      if (matchesActivityFilter(item, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/**
 * ¿La entrada es posterior a la última vez que se miró el centro de actividad?
 * Sin marca guardada no hay nada «nuevo»: al estrenar la función, el historial
 * antiguo no puede aparecer de golpe como pendiente.
 *
 * @param {Pick<ActivityItem, "timestamp">} item
 * @param {string|null|undefined} seenAt ISO de la última apertura
 */
export function isActivityUnseen(item, seenAt) {
  if (!seenAt) return false;
  const seen = Date.parse(seenAt);
  const at = Date.parse(item.timestamp);
  return Number.isFinite(seen) && Number.isFinite(at) && at > seen;
}

/**
 * Errores registrados desde la última apertura: el número del distintivo del
 * botón «Historial y logs».
 *
 * @param {Pick<ActivityItem, "status"|"timestamp">[]} items
 * @param {string|null|undefined} seenAt
 */
export function countUnseenErrors(items, seenAt) {
  return items.reduce(
    (n, item) => n + (item.status === "error" && isActivityUnseen(item, seenAt) ? 1 : 0),
    0,
  );
}
