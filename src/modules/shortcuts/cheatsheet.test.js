import { describe, expect, it } from "vitest";
import { SHORTCUT_ACTIONS, SHORTCUT_IDS, SHORTCUT_PRESETS } from "./catalog.js";
import { comboFromEvent } from "./combo.js";
import { getShortcut } from "./model.js";
import { SHORTCUT_GROUPS, buildCheatsheet, filterCheatsheet, splitCombo } from "./cheatsheet.js";

const labels = { general: "General", tabs: "Pestañas y paneles", terminal: "Terminal", blocks: "Bloques de comando", files: "Panel de archivos" };

/**
 * Chuleta con las preferencias dadas, con nombres legibles de prueba.
 * @param {any} prefs
 * @param {(combo: string) => string} [format]
 */
function sheet(prefs, format) {
  return buildCheatsheet({
    get: (id) => getShortcut(prefs, id),
    label: (id) => `acción ${id}`,
    groupLabel: (id) => labels[id],
    format,
  });
}

describe("SHORTCUT_GROUPS", () => {
  it("cada acción del catálogo está en un solo contexto", () => {
    const grouped = SHORTCUT_GROUPS.flatMap((g) => g.actions);
    expect([...grouped].sort()).toEqual([...SHORTCUT_IDS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

describe("show_shortcuts", () => {
  it("se abre con Ctrl+Shift+H por tecla física, también en un teclado AZERTY", () => {
    expect(SHORTCUT_ACTIONS.show_shortcuts.default).toBe("Ctrl+Shift+H");
    const event = { key: "H", code: "KeyH", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
    expect(comboFromEvent(event)).toBe("Ctrl+Shift+H");
  });

  it("no choca con ningún otro atajo de fábrica ni de los presets", () => {
    for (const preset of Object.values(SHORTCUT_PRESETS)) {
      const prefs = { shortcuts: preset };
      const owners = SHORTCUT_IDS.filter((id) => getShortcut(prefs, id) === "Ctrl+Shift+H");
      expect(owners).toEqual(["show_shortcuts"]);
    }
  });
});

describe("buildCheatsheet", () => {
  it("agrupa los atajos vigentes y omite los desactivados o sin combinación", () => {
    const groups = sheet({ shortcuts: { close_tab: null } });
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain("command_palette");
    expect(ids).not.toContain("close_tab");
    expect(ids).not.toContain("clear_terminal"); // sin combinación de fábrica
    expect(ids).not.toContain("copy_block_command"); // default vacío
    expect(groups.map((g) => g.id)).toEqual(["general", "tabs", "terminal", "blocks", "files"]);
  });

  it("refleja los personalizados y los presets", () => {
    const custom = sheet({ shortcuts: { ...SHORTCUT_PRESETS.tmux, clear_terminal: "Ctrl+Alt+L" } });
    const items = custom.flatMap((g) => g.items);
    expect(items.find((i) => i.id === "next_tab")?.combo).toBe("Alt+N");
    expect(items.find((i) => i.id === "clear_terminal")?.combo).toBe("Ctrl+Alt+L");
  });

  it("presenta la combinación por plataforma y la parte en teclas", () => {
    const mac = sheet({}, (combo) => combo.replace(/\bCtrl\b/g, "Cmd"));
    const palette = mac[0].items.find((i) => i.id === "command_palette");
    expect(palette).toMatchObject({ combo: "Cmd+Shift+P", keys: ["Cmd", "Shift", "P"] });
  });

  it("un contexto sin ningún atajo asignado no aparece", () => {
    const groups = sheet({ shortcuts: { sftp_toggle_panel: null } });
    expect(groups.some((g) => g.id === "files")).toBe(false);
  });
});

describe("splitCombo", () => {
  it("separa por «+» salvo cuando la tecla final es el propio «+»", () => {
    expect(splitCombo("Ctrl+Alt+ArrowRight")).toEqual(["Ctrl", "Alt", "ArrowRight"]);
    expect(splitCombo("Ctrl+-")).toEqual(["Ctrl", "-"]);
    expect(splitCombo("Ctrl++")).toEqual(["Ctrl", "+"]);
    expect(splitCombo("F11")).toEqual(["F11"]);
    expect(splitCombo("")).toEqual([]);
  });
});

describe("filterCheatsheet", () => {
  const groups = buildCheatsheet({
    get: (id) => getShortcut({}, id),
    label: (id) => ({ find_in_terminal: "Buscar en el terminal", command_palette: "Paleta de comandos" })[id] || id,
    groupLabel: (id) => labels[id],
  });

  it("sin consulta lo devuelve todo", () => {
    expect(filterCheatsheet(groups, "  ")).toBe(groups);
  });

  it("busca por nombre sin distinguir mayúsculas ni acentos", () => {
    const found = filterCheatsheet(groups, "PALETA").flatMap((g) => g.items.map((i) => i.id));
    expect(found).toEqual(["command_palette"]);
    expect(filterCheatsheet(groups, "pestanas").map((g) => g.id)).toEqual(["tabs"]);
  });

  it("busca por combinación y exige todas las palabras", () => {
    const found = filterCheatsheet(groups, "ctrl+f terminal").flatMap((g) => g.items.map((i) => i.id));
    expect(found).toEqual(["find_in_terminal"]);
  });

  it("sin coincidencias no deja grupos vacíos", () => {
    expect(filterCheatsheet(groups, "zzz")).toEqual([]);
  });
});
