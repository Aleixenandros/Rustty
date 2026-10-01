// @ts-check
import { SHORTCUT_ACTIONS, SHORTCUT_IDS } from "./catalog.js";
import { comboFromEvent } from "./combo.js";

/**
 * @param {any} prefs
 * @param {string} id
 */
export function getShortcut(prefs, id) {
  const override = prefs.shortcuts?.[id];
  if (override === null || typeof override === "string") return override;
  return SHORTCUT_ACTIONS[id]?.default ?? null;
}

/**
 * Acepta el mapa antiguo o el documento exportado; solo ids conocidos.
 * @param {any} raw
 * @returns {Record<string, string|null>}
 */
export function normalizeShortcutMap(raw) {
  const input = raw?.shortcuts && typeof raw.shortcuts === "object" ? raw.shortcuts : raw;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid shortcut map");
  }
  return Object.fromEntries(SHORTCUT_IDS
    .filter((id) => Object.hasOwn(input, id) && (input[id] === null || typeof input[id] === "string"))
    .map((id) => [id, input[id]]));
}

/**
 * Fecha solo la acción editada; restablecer necesita un tombstone para viajar.
 * @param {any} prefs
 * @param {string} id
 * @param {string|null} value
 * @param {string} [now]
 */
export function setShortcut(prefs, id, value, now = new Date().toISOString()) {
  if (!Object.hasOwn(SHORTCUT_ACTIONS, id)) return false;
  const reset = value === SHORTCUT_ACTIONS[id].default;
  const exists = Object.hasOwn(prefs.shortcuts || {}, id);
  if (reset ? !exists : exists && prefs.shortcuts[id] === value) return false;
  prefs.shortcuts ??= {};
  prefs._shortcutsTs ??= {};
  prefs.tombstones ??= {};
  prefs.tombstones.shortcuts ??= {};
  if (reset) {
    delete prefs.shortcuts[id];
    delete prefs._shortcutsTs[id];
    prefs.tombstones.shortcuts[id] = now;
  } else {
    prefs.shortcuts[id] = value;
    prefs._shortcutsTs[id] = now;
    delete prefs.tombstones.shortcuts[id];
  }
  return true;
}

/**
 * Presets/importación reemplazan las acciones conocidas, con una fecha común.
 * @param {any} prefs
 * @param {any} raw
 * @param {string} [now]
 */
export function replaceShortcuts(prefs, raw, now = new Date().toISOString()) {
  const next = normalizeShortcutMap(raw);
  let changed = false;
  for (const id of SHORTCUT_IDS) {
    const value = Object.hasOwn(next, id) ? next[id] : SHORTCUT_ACTIONS[id].default;
    changed = setShortcut(prefs, id, value, now) || changed;
  }
  return changed;
}

/**
 * Una acción puede rechazar la tecla (OSC 133 sin destino): la TUI la recibe.
 * @param {KeyboardEvent} event
 * @param {any} prefs
 * @param {Record<string, () => unknown>} actions
 */
export function dispatchShortcut(event, prefs, actions) {
  const combo = comboFromEvent(event);
  if (!combo) return false;
  const candidates = combo === "Ctrl+Shift+=" ? [combo, "Ctrl+="] : [combo];
  for (const candidate of candidates) {
    for (const id of SHORTCUT_IDS) {
      if (SHORTCUT_ACTIONS[id].scope || !actions[id] || getShortcut(prefs, id) !== candidate) continue;
      if (actions[id]() !== false) {
        event.preventDefault();
        event.stopPropagation();
      }
      return true;
    }
  }
  return false;
}
