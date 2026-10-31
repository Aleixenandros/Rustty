// @ts-check
/**
 * Núcleo **puro** de la chuleta de atajos: agrupa por contexto las acciones
 * del catálogo que tienen combinación vigente (la de fábrica, la de un preset
 * o la personalizada: lo resuelve el `get` del llamador) y las filtra por
 * texto. Sin DOM: el modal de `main.js` solo pinta lo que sale de aquí.
 */
import { foldSearchText } from "../connection-search.js";

/**
 * Contextos de la chuleta, en orden de presentación. Cada acción del catálogo
 * vive en uno solo; un test lo exige, para que una acción nueva no se quede
 * fuera de la chuleta sin que nadie lo note.
 * @type {readonly {id: string, actions: readonly string[]}[]}
 */
export const SHORTCUT_GROUPS = [
  { id: "general", actions: [
    "command_palette", "show_shortcuts", "search_connections", "clear_sidebar_search",
    "new_connection", "open_preferences", "toggle_zen_mode",
    "ui_zoom_in", "ui_zoom_out", "ui_zoom_reset", "disconnect_all", "pick_active_jump",
    "focus_last_toast",
  ] },
  { id: "tabs", actions: [
    "new_local_shell", "close_tab", "next_tab", "prev_tab", "next_pane", "prev_pane", "reconnect_session",
    "toggle_read_only",
  ] },
  { id: "terminal", actions: [
    "copy_terminal", "paste_terminal", "paste_password", "find_in_terminal", "quick_select", "clear_terminal",
    "clear_prompt_line", "zoom_in", "zoom_out", "zoom_reset", "open_command_editor", "open_note_editor",
  ] },
  { id: "blocks", actions: [
    "prev_command_block", "next_command_block", "copy_block_command", "copy_block_output",
    "copy_block_markdown", "export_block_markdown", "diff_block_previous", "show_blocks_panel",
  ] },
  { id: "files", actions: ["sftp_toggle_panel", "sftp_toggle_follow", "sftp_toggle_sudo"] },
];

/**
 * @typedef {{ id: string, label: string, combo: string, keys: string[] }} CheatsheetItem
 * @typedef {{ id: string, label: string, items: CheatsheetItem[] }} CheatsheetGroup
 */

/**
 * Chuleta con los atajos asignados, agrupada por contexto. Las acciones sin
 * combinación (desactivadas o sin default) no aparecen: la chuleta enseña lo
 * que se puede pulsar, y el enlace a Preferencias lleva a todo lo demás.
 * @param {object} deps
 * @param {(id: string) => string|null} deps.get Combinación vigente de la acción.
 * @param {(id: string) => string} deps.label Nombre visible de la acción.
 * @param {(groupId: string) => string} deps.groupLabel Nombre visible del contexto.
 * @param {(combo: string) => string} [deps.format] Presentación por plataforma.
 * @returns {CheatsheetGroup[]}
 */
export function buildCheatsheet({ get, label, groupLabel, format = (combo) => combo }) {
  return SHORTCUT_GROUPS.map((group) => ({
    id: group.id,
    label: groupLabel(group.id),
    items: group.actions.flatMap((id) => {
      const combo = get(id);
      if (!combo) return [];
      const shown = format(combo);
      return [{ id, label: label(id), combo: shown, keys: splitCombo(shown) }];
    }),
  })).filter((group) => group.items.length);
}

/**
 * Teclas de una combinación para pintarlas una a una. El «+» de «Ctrl++» (o
 * de cualquier combinación que acabe en la tecla «+») es la última tecla, no
 * un separador.
 * @param {string} combo
 * @returns {string[]}
 */
export function splitCombo(combo) {
  if (!combo) return [];
  if (combo === "+") return ["+"];
  const trailingPlus = combo.endsWith("++");
  const keys = (trailingPlus ? combo.slice(0, -2) : combo).split("+").filter(Boolean);
  if (trailingPlus) keys.push("+");
  return keys;
}

/**
 * Filtra la chuleta: cada palabra de la consulta (sin distinguir mayúsculas
 * ni acentos) debe aparecer en el nombre de la acción, en su combinación o en
 * el nombre del contexto; «terminal» enseña el grupo entero y «ctrl+shift»
 * las combinaciones con esos modificadores. Los grupos vacíos desaparecen.
 * @param {CheatsheetGroup[]} groups
 * @param {unknown} query
 * @returns {CheatsheetGroup[]}
 */
export function filterCheatsheet(groups, query) {
  const tokens = foldSearchText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return groups;
  return groups.map((group) => {
    const groupText = foldSearchText(group.label);
    return {
      ...group,
      items: group.items.filter((item) => {
        const hay = `${foldSearchText(item.label)}\n${foldSearchText(item.combo)}\n${groupText}`;
        return tokens.every((token) => hay.includes(token));
      }),
    };
  }).filter((group) => group.items.length);
}
