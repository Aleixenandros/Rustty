// @ts-check
/**
 * Clasificador **puro** del atajo estándar de deshacer/rehacer: traduce un
 * evento de teclado a `"undo"`, `"redo"` o `null`. No toca DOM ni estado.
 *
 * Existe porque WebKitGTK (el WebView de Tauri en Linux) no liga Ctrl+Z /
 * Ctrl+Shift+Z / Ctrl+Y a los comandos Undo/Redo del editor: su
 * `KeyBindingTranslator` hereda los keybindings de GTK3, que nunca los tuvo
 * (llegaron a las entries con GTK4). El editor de WebKit sí implementa ambos
 * comandos (el menú contextual los ofrece), así que basta con restaurar el
 * atajo desde la app con `document.execCommand`.
 *
 * Se compara contra `e.key` (tecla lógica), no `e.code` (física), porque es lo
 * que hacen los aceleradores nativos de GTK/Chromium: en layouts que recolocan
 * la Z (AZERTY) el deshacer sigue la serigrafía de la tecla.
 */

/**
 * Comando de edición estándar que pide un evento de teclado, si es alguno.
 * `Ctrl+Z` → undo; `Ctrl+Shift+Z` y `Ctrl+Y` → redo. Alt y Meta invalidan
 * (Alt para no comerse AltGr+Z de layouts con tercer nivel; Meta porque esa
 * convención es de macOS, donde el WebView ya trae el atajo nativo).
 * @param {Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">} e
 * @returns {"undo" | "redo" | null}
 */
export function undoRedoCommand(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.shiftKey) return "redo";
  return null;
}
