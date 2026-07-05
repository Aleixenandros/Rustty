import { describe, it, expect } from "vitest";
import { resolveTarget, describeTarget } from "./targets.js";

/** Perfiles de prueba: mezcla de workspaces, carpetas anidadas y raíz. */
const profiles = [
  { id: "a", workspace_id: "default", group: "PROD", name: "web-01", host: "10.0.0.1" },
  { id: "b", workspace_id: "default", group: "PROD/db", name: "db-01", host: "10.0.0.2" },
  { id: "c", workspace_id: "default", group: null, name: "raiz-01", host: "10.0.0.3" },
  { id: "d", workspace_id: "default", group: "", name: "raiz-02", host: "10.0.0.4" },
  { id: "e", workspace_id: "otro", group: "PROD", name: "otro-prod", host: "10.0.0.5" },
  { id: "f", group: "PROD/db/replica", name: "sin-ws", host: "10.0.0.6" }, // workspace_id ausente → default
];

describe("resolveTarget · profile", () => {
  it("devuelve el id si el perfil existe", () => {
    expect(resolveTarget({ kind: "profile", profileId: "a" }, profiles)).toEqual(["a"]);
  });
  it("devuelve vacío si no existe", () => {
    expect(resolveTarget({ kind: "profile", profileId: "zzz" }, profiles)).toEqual([]);
  });
});

describe("resolveTarget · folder", () => {
  it("coincidencia exacta (no recursiva)", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "PROD", recursive: false };
    expect(resolveTarget(t, profiles)).toEqual(["a"]);
  });

  it("recursiva incluye subcarpetas", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "PROD", recursive: true };
    // a (PROD), b (PROD/db) y f (PROD/db/replica, workspace_id ausente = default)
    expect(resolveTarget(t, profiles).sort()).toEqual(["a", "b", "f"]);
  });

  it("no confunde prefijos parciales (PROD vs PRODUCCION)", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "PROD", recursive: true };
    const extra = [...profiles, { id: "g", workspace_id: "default", group: "PRODUCCION" }];
    expect(resolveTarget(t, extra)).not.toContain("g");
  });

  it("raíz no recursiva: solo perfiles con group null/vacío", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "", recursive: false };
    expect(resolveTarget(t, profiles).sort()).toEqual(["c", "d"]);
  });

  it("raíz recursiva: todos los del workspace", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "", recursive: true };
    expect(resolveTarget(t, profiles).sort()).toEqual(["a", "b", "c", "d", "f"]);
  });

  it("normaliza barras finales del folderPath", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "PROD/", recursive: false };
    expect(resolveTarget(t, profiles)).toEqual(["a"]);
  });

  it("filtra por workspace", () => {
    const t = { kind: "folder", workspaceId: "otro", folderPath: "PROD", recursive: false };
    expect(resolveTarget(t, profiles)).toEqual(["e"]);
  });

  it("workspaceId ausente en el target se trata como default", () => {
    const t = { kind: "folder", folderPath: "PROD", recursive: false };
    // @ts-expect-error target sin workspaceId a propósito
    expect(resolveTarget(t, profiles)).toEqual(["a"]);
  });
});

describe("resolveTarget · adhoc", () => {
  it("filtra a los ids existentes conservando el orden", () => {
    const t = { kind: "adhoc", profileIds: ["b", "zzz", "a"] };
    expect(resolveTarget(t, profiles)).toEqual(["b", "a"]);
  });
  it("todos inexistentes → vacío", () => {
    expect(resolveTarget({ kind: "adhoc", profileIds: ["x", "y"] }, profiles)).toEqual([]);
  });
});

describe("resolveTarget · robustez", () => {
  it("tolera perfiles no-array y targets inválidos", () => {
    // @ts-expect-error perfiles no-array
    expect(resolveTarget({ kind: "profile", profileId: "a" }, null)).toEqual([]);
    // @ts-expect-error target inválido
    expect(resolveTarget(null, profiles)).toEqual([]);
  });
});

describe("describeTarget", () => {
  it("carpeta: etiqueta con cuenta pluralizada", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "PROD", recursive: true };
    expect(describeTarget(t, profiles)).toEqual({
      count: 3,
      label: "Carpeta PROD · 3 conexiones",
    });
  });

  it("carpeta raíz muestra 'raíz'", () => {
    const t = { kind: "folder", workspaceId: "default", folderPath: "", recursive: false };
    expect(describeTarget(t, profiles).label).toBe("Carpeta raíz · 2 conexiones");
  });

  it("perfil: etiqueta con el nombre", () => {
    expect(describeTarget({ kind: "profile", profileId: "a" }, profiles)).toEqual({
      count: 1,
      label: "Conexión web-01",
    });
  });

  it("adhoc: una sola conexión usa el singular", () => {
    expect(describeTarget({ kind: "adhoc", profileIds: ["a"] }, profiles)).toEqual({
      count: 1,
      label: "Selección · 1 conexión",
    });
  });
});
