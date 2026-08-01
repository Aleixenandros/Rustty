// @ts-check
import { describe, it, expect } from "vitest";
import { normalizePrefs } from "./normalize.js";

const deps = {
  defaultHighlightRules: () => [{ pattern: "error", color: "red" }],
  supportedLangs: ["es", "en"],
  detectLanguage: () => "es",
};

describe("normalizePrefs", () => {
  it("crea el workspace default y corrige el activo inválido", () => {
    const p = normalizePrefs({ workspaces: [], activeWorkspaceId: "zz" }, null, deps);
    expect(p.workspaces).toEqual([{ id: "default", name: "Default" }]);
    expect(p.activeWorkspaceId).toBe("default");
  });

  it("migra las carpetas legacy al workspace activo, una sola vez", () => {
    const stored = { userFolders: ["Prod", " ", "Lab"] };
    const p = normalizePrefs(
      { workspaces: [{ id: "w1", name: "Uno" }], activeWorkspaceId: "w1" },
      stored,
      deps
    );
    expect(p.userFoldersByWorkspace.w1).toEqual(["Prod", "Lab"]);
    expect(p.userFolders).toEqual([]);
    // Si el destino ya existe, la migración NO pisa.
    const p2 = normalizePrefs(
      {
        workspaces: [{ id: "w1", name: "Uno" }],
        activeWorkspaceId: "w1",
        userFoldersByWorkspace: { w1: ["Mías"] },
      },
      stored,
      deps
    );
    expect(p2.userFoldersByWorkspace.w1).toEqual(["Mías"]);
  });

  it("todo workspace tiene su array de carpetas", () => {
    const p = normalizePrefs(
      { workspaces: [{ id: "a" }, { id: "b" }], activeWorkspaceId: "a" },
      null,
      deps
    );
    expect(p.userFoldersByWorkspace.a).toEqual([]);
    expect(p.userFoldersByWorkspace.b).toEqual([]);
  });

  it("sanea listas, modos y booleanos", () => {
    const p = normalizePrefs(
      { favorites: "no", sidebarViewMode: "zzz", sidebarCompact: 1, searchAllWorkspaces: false },
      null,
      deps
    );
    expect(p.favorites).toEqual([]);
    expect(p.sidebarViewMode).toBe("current");
    expect(p.sidebarCompact).toBe(true);
    expect(p.searchAllWorkspaces).toBe(false);
    expect(p.foldersFirst).toBe(true);
  });

  it("siembra las reglas de highlight solo cuando toca", () => {
    // Sin array → defaults.
    const p1 = normalizePrefs({}, null, deps);
    expect(p1.highlightRules).toHaveLength(1);
    // Usuario que las vació a propósito (ya sembradas antes) → se respeta.
    const p2 = normalizePrefs(
      { highlightRules: [] },
      { _highlightRulesSeeded: true },
      deps
    );
    expect(p2.highlightRules).toEqual([]);
    // Store antiguo sin marca de siembra y vacías → se siembran.
    const p3 = normalizePrefs({ highlightRules: [] }, {}, deps);
    expect(p3.highlightRules).toHaveLength(1);
    expect(p3._highlightRulesSeeded).toBe(true);
  });

  it("idioma inválido cae al detectado y jamás toca _prefsUpdatedAt", () => {
    const p = normalizePrefs({ lang: "xx" }, null, deps);
    expect(p.lang).toBe("es");
    expect(p._prefsUpdatedAt).toBeUndefined();
  });

  it("respeta el orden histórico de migraciones (colores entre workspaces y carpetas)", () => {
    /** @type {string[]} */
    const orden = [];
    normalizePrefs({}, null, {
      ...deps,
      migrateFolderColors: () => orden.push("colores"),
      normalizeWorkspaceColors: () => orden.push("ws-colores"),
    });
    expect(orden).toEqual(["colores", "ws-colores"]);
  });
});
