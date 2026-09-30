import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./defaults.js";
import { loadPrefs, savePrefs } from "./storage.js";

const deps = { supportedLangs: ["es", "en"], detectLanguage: () => "es" };
/**
 * Almacén en memoria: permite comprobar que cargar no escribe.
 * @param {string|null} [value]
 */
function storageWith(value = null) {
  let text = value;
  return {
    getItem: vi.fn(() => text),
    setItem: vi.fn((_key, value) => { text = value; }),
  };
}

describe("persistencia de preferencias", () => {
  it("el primer arranque detecta idioma sin escribir ni fechar defaults", () => {
    const storage = storageWith();
    const prefs = loadPrefs(storage, deps);
    expect(prefs.lang).toBe("es");
    expect(prefs.workspaces).toEqual([{ id: "default", name: "Default" }]);
    expect(prefs._prefsUpdatedAt).toBeUndefined();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("cada carga aísla los objetos anidados de las otras y de los defaults", () => {
    const first = loadPrefs(storageWith(), deps);
    first.workspaces[0].name = "Personal";
    first.shortcuts.connect = "Ctrl+K";
    first.highlightRules.length = 0;
    const second = loadPrefs(storageWith(), deps);
    expect(second.workspaces[0].name).toBe("Default");
    expect(second.shortcuts).toEqual({});
    expect(second.highlightRules.length).toBeGreaterThan(0);
    expect(DEFAULT_PREFS.workspaces[0].name).toBe("Default");
  });

  it("migra las carpetas legacy al workspace correcto en el orden histórico", () => {
    const events = [];
    const prefs = loadPrefs(storageWith(JSON.stringify({
      workspaces: [{ id: "linux", name: "Trabajo" }], activeWorkspaceId: "missing",
      userFolders: ["Servidores"], _prefsUpdatedAt: "2026-09-01T00:00:00Z",
    })), {
      ...deps,
      migrateFolderColors: (p) => { events.push(p.activeWorkspaceId); p.folderColors = { "linux|Servidores": "blue" }; },
      normalizeWorkspaceColors: (p) => { events.push(p.userFolders[0]); },
    });
    expect(events).toEqual(["linux", "Servidores"]);
    expect(prefs.userFoldersByWorkspace.linux).toEqual(["Servidores"]);
    expect(prefs.folderColors).toEqual({ "linux|Servidores": "blue" });
    expect(prefs._prefsUpdatedAt).toBe("2026-09-01T00:00:00Z");
  });

  it.each(["{", "[]", "12", '"texto"', "null"])("tolera un documento inválido: %s", (raw) => {
    const storage = storageWith(raw);
    expect(loadPrefs(storage, deps).workspaces).toEqual(DEFAULT_PREFS.workspaces);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("conserva ajustes, metadatos y campos ajenos al formulario al guardar y recargar", () => {
    const storage = storageWith();
    const prefs = loadPrefs(storage, deps);
    Object.assign(prefs, { rightClickPaste: true, _prefsUpdatedAt: "2026-09-01T00:00:00Z", _secretsTs: { a: "old" }, syncDeviceName: "Linux" });
    savePrefs(storage, prefs);
    expect(loadPrefs(storage, deps)).toEqual(prefs);
  });

  it("tolera lecturas fallidas, pero propaga un fallo al guardar", () => {
    const storage = { getItem: () => { throw new Error("read"); }, setItem: () => { throw new Error("quota"); } };
    const prefs = loadPrefs(storage, deps);
    expect(prefs._prefsUpdatedAt).toBeUndefined();
    expect(() => savePrefs(storage, prefs)).toThrow("quota");
  });
});
