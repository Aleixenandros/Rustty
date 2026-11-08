// @ts-check
/**
 * Menú contextual de los campos de texto, en **puro**: qué objetivo es y qué
 * entradas ofrece. El DOM (pintar el menú, el portapapeles, `execCommand`) vive
 * en `main.js`.
 *
 * Existe porque la app bloquea el menú nativo del WebView en toda la ventana
 * (ofrecía Atrás, Recargar o Inspeccionar): sin esto, ningún campo de texto
 * tenía Copiar, Pegar o Seleccionar todo con el botón derecho.
 */

/** Tipos de `<input>` que son texto editable (los demás no llevan menú). */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

/**
 * @typedef {object} TextTargetInfo
 * @property {string} tagName
 * @property {string} [type] tipo del `<input>`.
 * @property {boolean} [readOnly]
 * @property {boolean} [disabled]
 * @property {boolean} [isContentEditable]
 * @property {boolean} [hasDocumentSelection] hay texto seleccionado fuera de un campo.
 */

/**
 * Clase de objetivo del clic derecho:
 * - `"editable"`: campo en el que se puede escribir.
 * - `"readonly"`: campo de solo lectura (se puede copiar y seleccionar).
 * - `"selection"`: texto seleccionado fuera de un campo (solo copiar).
 * - `null`: nada que ofrecer.
 * @param {TextTargetInfo} info
 * @returns {"editable" | "readonly" | "selection" | null}
 */
export function textTargetKind(info) {
  const tag = String(info?.tagName || "").toUpperCase();
  const isField = tag === "TEXTAREA"
    || (tag === "INPUT" && TEXT_INPUT_TYPES.has(String(info.type || "").toLowerCase()));
  if (isField) {
    if (info.disabled) return null;
    return info.readOnly ? "readonly" : "editable";
  }
  if (info?.isContentEditable) return "editable";
  return info?.hasDocumentSelection ? "selection" : null;
}

/**
 * @typedef {object} TextMenuState
 * @property {"editable" | "readonly" | "selection"} kind
 * @property {boolean} [hasSelection] hay texto seleccionado en el objetivo.
 * @property {boolean} [hasValue] el campo tiene texto.
 * @property {boolean} [secret] campo de contraseña: no se copia ni se corta.
 * @property {boolean} [canUndo]
 * @property {boolean} [canRedo]
 * @property {boolean} [formats] ofrecer el submenú de formato Markdown.
 */

/**
 * @typedef {{ id: string, disabled?: boolean } | { separator: true }} TextMenuEntry
 */

/**
 * Entradas del menú, en orden, con separadores entre grupos. Las acciones que
 * no aplican salen desactivadas (no ocultas) para que el menú tenga siempre la
 * misma forma en un mismo tipo de campo.
 * @param {TextMenuState} state
 * @returns {TextMenuEntry[]}
 */
export function textMenuEntries(state) {
  const sel = !!state.hasSelection;
  const secret = !!state.secret;
  if (state.kind === "selection") {
    return [{ id: "copy", disabled: !sel }];
  }
  if (state.kind === "readonly") {
    return [
      { id: "copy", disabled: !sel || secret },
      { separator: true },
      { id: "select-all", disabled: !state.hasValue },
    ];
  }
  /** @type {TextMenuEntry[]} */
  const entries = [
    { id: "undo", disabled: state.canUndo === false },
    { id: "redo", disabled: state.canRedo === false },
    { separator: true },
    { id: "cut", disabled: !sel || secret },
    { id: "copy", disabled: !sel || secret },
    { id: "paste" },
    { id: "delete", disabled: !sel },
    { separator: true },
    { id: "select-all", disabled: !state.hasValue },
  ];
  if (state.formats) {
    entries.push({ separator: true }, { id: "format" });
  }
  return entries;
}
