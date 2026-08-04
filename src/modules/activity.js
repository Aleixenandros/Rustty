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
