// @ts-check
/**
 * Núcleo **puro** del dominio de atajos de teclado: traducir un evento de
 * teclado a una combinación canónica en texto («Ctrl+Shift+N»). No toca DOM ni
 * estado global —recibe un objeto tipo `KeyboardEvent`—, así que se prueba con
 * un mock plano.
 *
 * Primera pieza extraída del dominio `shortcuts/` en el troceo de `main.js`; el
 * resto (registro de acciones, capturador, editor en Preferencias) llegará
 * cuando se pueda validar en la app, porque toca DOM.
 */

/**
 * Etiquetas legibles para códigos físicos de tecla (`KeyboardEvent.code`) que
 * no se derivan por prefijo. Las letras y dígitos se resuelven por prefijo
 * (`Key*`/`Digit*`) en {@link keyLabelFromCode}.
 * @type {Record<string, string>}
 */
export const CODE_LABEL_MAP = {
  Comma: ",", Period: ".", Semicolon: ";", Quote: "'",
  Minus: "-", Equal: "=", Slash: "/", Backslash: "\\",
  BracketLeft: "[", BracketRight: "]", Backquote: "`",
  NumpadAdd: "=", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/",
  NumpadDecimal: ".", NumpadEnter: "Enter", Numpad0: "0", Numpad1: "1",
  Numpad2: "2", Numpad3: "3", Numpad4: "4", Numpad5: "5", Numpad6: "6",
  Numpad7: "7", Numpad8: "8", Numpad9: "9",
};

/**
 * Teclas que son **solo** modificador: al pulsarlas aisladas no forman combo.
 * Se comparan contra `KeyboardEvent.key`.
 */
export const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/**
 * Etiqueta de una tecla a partir de su código físico (`KeyboardEvent.code`),
 * independiente de la distribución del teclado. Letras (`KeyA`→`A`) y dígitos
 * (`Digit5`→`5`) por prefijo; el resto por {@link CODE_LABEL_MAP}; y si no está,
 * el propio código (`Tab`, `Escape`, `F1`, `ArrowLeft`, `Space`…).
 * @param {string} code
 * @returns {string}
 */
export function keyLabelFromCode(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (CODE_LABEL_MAP[code]) return CODE_LABEL_MAP[code];
  return code; // "Tab", "Escape", "F1", "ArrowLeft", "Space", ...
}

/**
 * Combinación canónica en texto de un evento de teclado, con los modificadores
 * en orden fijo (`Ctrl+Alt+Shift+Meta`) seguidos de la tecla. Devuelve `null`
 * si el evento es solo un modificador (aún no hay combo completo).
 * @param {Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">} e
 * @returns {string|null}
 */
export function comboFromEvent(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts = [];
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.altKey)   parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  parts.push(keyLabelFromCode(e.code));
  return parts.join("+");
}
