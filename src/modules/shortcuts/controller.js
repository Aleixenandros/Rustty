// @ts-check
import { escHtml } from "../html.js";
import { formatAccelerator } from "../platform.js";
import { comboFromEvent } from "./combo.js";
import { SHORTCUT_ACTIONS, SHORTCUT_IDS, SHORTCUT_PRESETS } from "./catalog.js";
import { dispatchShortcut, getShortcut, normalizeShortcutMap, replaceShortcuts, setShortcut } from "./model.js";

/**
 * Editor de atajos. El estado vivo y los efectos de la app llegan del llamador.
 * @param {object} deps
 * @param {() => any} deps.getPrefs
 * @param {() => void} deps.save
 * @param {Record<string, () => unknown>} deps.actions
 * @param {any} deps.toast
 * @param {any} deps.confirm
 * @param {any} deps.files
 * @param {any} deps.t
 * @param {(root: HTMLElement) => void} deps.applyTranslations
 * @param {(err: unknown) => string} deps.fileErrorText
 * @param {number} deps.readLimit
 */
export function createShortcutController({ getPrefs, save, actions, toast, confirm, files, readLimit, t, applyTranslations, fileErrorText }) {
  /** @type {string|null} */
  let capturing = null;
  const get = (/** @type {string} */ id) => getShortcut(getPrefs(), id);

  /** @param {string|null} [focusId] */
  function render(focusId = null) {
    const root = document.getElementById("shortcuts-list");
    if (!root) return;
    const overrides = getPrefs().shortcuts || {};
    root.innerHTML = SHORTCUT_IDS.map((id) => {
      const current = get(id);
      const label = t(`prefs_shortcuts.action_${id}`);
      return `<div class="shortcut-row" data-shortcut-id="${id}">
        <div class="shortcut-label">${escHtml(label)}</div>
        <kbd class="shortcut-combo">${current ? escHtml(formatAccelerator(current)) : `<em>${escHtml(t("prefs_shortcuts.disabled"))}</em>`}</kbd>
        <div class="shortcut-row-actions">
          <button type="button" class="btn-secondary btn-shortcut-edit" data-i18n="prefs_shortcuts.edit"></button>
          <button type="button" class="btn-secondary btn-shortcut-clear" data-i18n="prefs_shortcuts.disable"></button>
          <button type="button" class="btn-secondary btn-shortcut-reset" ${Object.hasOwn(overrides, id) ? "" : "disabled"} data-i18n="prefs_shortcuts.reset"></button>
        </div>
      </div>`;
    }).join("");
    applyTranslations(root);
    if (focusId && SHORTCUT_IDS.includes(focusId)) {
      const button = root.querySelector(`.shortcut-row[data-shortcut-id="${focusId}"] .btn-shortcut-edit`);
      if (button instanceof HTMLElement) button.focus();
    }
  }

  /** Cancela la captura y devuelve el foco a la acción editada. */
  function cancelCapture() {
    if (!capturing) return;
    const id = capturing;
    capturing = null;
    render(id);
  }

  /** @param {string} id */
  function startCapture(id) {
    cancelCapture();
    if (!SHORTCUT_IDS.includes(id)) return;
    const row = document.querySelector(`.shortcut-row[data-shortcut-id="${id}"]`);
    const combo = row?.querySelector(".shortcut-combo");
    if (!row || !combo) return;
    combo.innerHTML = `<em>${escHtml(t("prefs_shortcuts.press_keys"))}</em>`;
    row.classList.add("capturing");
    capturing = id;
  }

  /**
   * Se llama ANTES del dispatcher global, sin otro listener que llegue tarde.
   * @param {KeyboardEvent} event
   */
  function capture(event) {
    if (!capturing) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") { cancelCapture(); return true; }
    const combo = comboFromEvent(event);
    if (!combo) return true;
    const conflict = SHORTCUT_IDS.find((id) => id !== capturing && get(id) === combo);
    if (setShortcut(getPrefs(), capturing, combo)) save();
    if (conflict) toast(t("prefs_shortcuts.conflict_warn", { action: t(`prefs_shortcuts.action_${conflict}`) }), "warning", 4000);
    cancelCapture();
    return true;
  }

  /** Exporta los overrides con el permiso del selector nativo. */
  async function exportShortcuts() {
    try {
      const file = await files.pickFileToSave({
        title: t("prefs_shortcuts.export_title"), defaultPath: "rustty-shortcuts.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!file) return;
      await files.writeTextFile(file, JSON.stringify({
        formatVersion: 1, exportedAt: new Date().toISOString(), shortcuts: getPrefs().shortcuts || {},
      }, null, 2));
      toast(t("prefs_shortcuts.export_done"), "success");
    } catch (err) { toast(fileErrorText(err), "error"); }
  }

  /** Valida el fichero y confirma antes de reemplazar los atajos. */
  async function importShortcuts() {
    let file;
    try {
      file = await files.pickFileToOpen({
        title: t("prefs_shortcuts.import_title"), filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch (err) { toast(fileErrorText(err), "error"); return; }
    if (!file) return;
    let imported;
    try { imported = normalizeShortcutMap(JSON.parse(await files.readTextFile(file, readLimit))); }
    catch { toast(t("prefs_shortcuts.import_invalid"), "error"); return; }
    if (!await confirm({
      title: t("prefs_shortcuts.import_title"), message: t("prefs_shortcuts.import_confirm"),
      submitLabel: t("prefs_shortcuts.import"),
    })) return;
    cancelCapture();
    if (replaceShortcuts(getPrefs(), imported)) save();
    render();
    toast(t("prefs_shortcuts.import_done"), "success");
  }

  /** Aplica el preset elegido con confirmación y metadatos de sync. */
  async function applyPreset() {
    const select = document.getElementById("shortcuts-preset-select");
    if (!(select instanceof HTMLSelectElement)) return;
    const presetId = select.value;
    const preset = SHORTCUT_PRESETS[presetId];
    if (!preset) return;
    if (!await confirm({
      title: t("prefs_shortcuts.preset_apply_title"),
      message: t("prefs_shortcuts.preset_apply_confirm", { preset: t(`prefs_shortcuts.preset_${presetId}`) }),
      submitLabel: t("prefs_shortcuts.preset_apply"), danger: true,
    })) return;
    cancelCapture();
    if (replaceShortcuts(getPrefs(), preset)) save();
    render();
    toast(t("prefs_shortcuts.preset_applied", { preset: t(`prefs_shortcuts.preset_${presetId}`) }), "success");
  }

  /** Conecta una vez las acciones delegadas del editor. */
  function bind() {
    document.getElementById("shortcuts-list")?.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest(".shortcut-row");
      if (!(row instanceof HTMLElement) || !row.dataset.shortcutId) return;
      const id = row.dataset.shortcutId;
      if (event.target.classList.contains("btn-shortcut-edit")) { startCapture(id); return; }
      const clear = event.target.classList.contains("btn-shortcut-clear");
      const reset = event.target.classList.contains("btn-shortcut-reset");
      if (!clear && !reset) return;
      cancelCapture();
      if (setShortcut(getPrefs(), id, clear ? null : SHORTCUT_ACTIONS[id].default)) save();
      render(id);
    });
    document.getElementById("btn-shortcuts-export")?.addEventListener("click", exportShortcuts);
    document.getElementById("btn-shortcuts-import")?.addEventListener("click", importShortcuts);
    document.getElementById("btn-shortcuts-apply-preset")?.addEventListener("click", applyPreset);
  }

  return { get, render, bind, capture, cancelCapture,
    handle: (/** @type {KeyboardEvent} */ event) => dispatchShortcut(event, getPrefs(), actions),
  };
}
