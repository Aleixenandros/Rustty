import { describe, expect, it, vi } from "vitest";
import { SHORTCUT_PRESETS } from "./catalog.js";
import { dispatchShortcut, getShortcut, normalizeShortcutMap, replaceShortcuts, setShortcut } from "./model.js";

const stamp = "2026-10-02T12:00:00.000Z";
const event = (code, extra = {}) => ({
  code, key: code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
});

describe("atajos persistidos y sincronizables", () => {
  it("distingue el default, desactivar y una combinación vacía", () => {
    expect(getShortcut({}, "new_connection")).toBe("Ctrl+Shift+N");
    expect(getShortcut({ shortcuts: { new_connection: null } }, "new_connection")).toBeNull();
    expect(getShortcut({ shortcuts: { new_connection: "" } }, "new_connection")).toBe("");
  });

  it("editar fecha la acción sin fechar el bundle de preferencias", () => {
    const prefs = { _prefsUpdatedAt: "old", shortcuts: { next_tab: "Alt+N" }, _shortcutsTs: { next_tab: "old" } };
    expect(setShortcut(prefs, "new_connection", "Ctrl+Alt+N", stamp)).toBe(true);
    expect(prefs._shortcutsTs).toEqual({ next_tab: "old", new_connection: stamp });
    expect(prefs._prefsUpdatedAt).toBe("old");
  });

  it("restablecer deja un borrado que el otro equipo puede recibir", () => {
    const prefs = { shortcuts: { new_connection: "Alt+N" }, _shortcutsTs: { new_connection: "old" } };
    expect(setShortcut(prefs, "new_connection", "Ctrl+Shift+N", stamp)).toBe(true);
    expect(prefs.shortcuts).toEqual({});
    expect(prefs._shortcutsTs).toEqual({});
    expect(prefs.tombstones.shortcuts).toEqual({ new_connection: stamp });
  });

  it("reenviar lo mismo o restablecer defaults no inventa modificaciones", () => {
    const prefs = {};
    expect(setShortcut(prefs, "new_connection", "Ctrl+Shift+N", stamp)).toBe(false);
    expect(prefs).toEqual({});
    setShortcut(prefs, "new_connection", null, "old");
    expect(setShortcut(prefs, "new_connection", null, stamp)).toBe(false);
    expect(prefs._shortcutsTs.new_connection).toBe("old");
  });

  it("volver a asignar elimina el borrado anterior", () => {
    const prefs = { tombstones: { shortcuts: { new_connection: "old" } } };
    setShortcut(prefs, "new_connection", null, stamp);
    expect(prefs.shortcuts.new_connection).toBeNull();
    expect(prefs.tombstones.shortcuts).toEqual({});
  });

  it("un preset conserva las fechas sin cambios y borra overrides ausentes", () => {
    const prefs = { shortcuts: { next_tab: "Alt+N", zoom_in: "Alt+Z" }, _shortcutsTs: { next_tab: "old", zoom_in: "old" } };
    replaceShortcuts(prefs, SHORTCUT_PRESETS.tmux, stamp);
    expect(prefs._shortcutsTs.next_tab).toBe("old");
    expect(prefs._shortcutsTs.new_connection).toBe(stamp);
    expect(prefs.tombstones.shortcuts.zoom_in).toBe(stamp);
    expect(getShortcut(prefs, "zoom_in")).toBe("Ctrl+=");
  });

  it("importar descarta ids y valores inválidos, aceptando ambos formatos", () => {
    const map = { new_connection: null, next_tab: "Alt+N", unknown: "F1", close_tab: 3 };
    expect(normalizeShortcutMap(map)).toEqual({ new_connection: null, next_tab: "Alt+N" });
    expect(normalizeShortcutMap({ shortcuts: map })).toEqual(normalizeShortcutMap(map));
    expect(() => normalizeShortcutMap([])).toThrow();
    expect(() => normalizeShortcutMap(null)).toThrow();
  });
});

describe("despacho de teclado", () => {
  it("deja las acciones locales a su contexto", () => {
    const run = vi.fn();
    const key = event("Escape");
    expect(dispatchShortcut(key, {}, { clear_sidebar_search: run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(key.preventDefault).not.toHaveBeenCalled();
  });

  it("no roba a la TUI una navegación sin destino", () => {
    const key = event("ArrowUp", { altKey: true });
    expect(dispatchShortcut(key, {}, { prev_command_block: () => false })).toBe(true);
    expect(key.preventDefault).not.toHaveBeenCalled();
  });

  it("acepta Ctrl++ sin desplazar una asignación exacta del usuario", () => {
    const zoom = vi.fn();
    const custom = vi.fn();
    const actions = { zoom_in: zoom, new_connection: custom };
    const key = event("Equal", { ctrlKey: true, shiftKey: true });
    dispatchShortcut(key, {}, actions);
    expect(zoom).toHaveBeenCalledOnce();
    expect(key.preventDefault).toHaveBeenCalledOnce();
    dispatchShortcut(key, { shortcuts: { new_connection: "Ctrl+Shift+=" } }, actions);
    expect(custom).toHaveBeenCalledOnce();
    expect(zoom).toHaveBeenCalledOnce();
  });

  it("respeta una acción desactivada", () => {
    const run = vi.fn();
    expect(dispatchShortcut(event("KeyN", { ctrlKey: true, shiftKey: true }),
      { shortcuts: { new_connection: null } }, { new_connection: run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
