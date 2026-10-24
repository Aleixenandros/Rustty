// @ts-check
import { describe, expect, it } from "vitest";
import { resolveActiveWorkspaceId, workspaceNameMap, workspacesForExport } from "./workspaces.js";

const list = [{ id: "default", name: "Default" }, { id: "ws-work", name: "Trabajo" }];

describe("resolveActiveWorkspaceId", () => {
  it("conserva el activo si sigue en la lista", () => {
    expect(resolveActiveWorkspaceId(list, "ws-work")).toBe("ws-work");
  });

  it("pasa al primero si otro equipo borró el activo", () => {
    expect(resolveActiveWorkspaceId([{ id: "ws-b", name: "B" }, ...list], "ws-borrado")).toBe("ws-b");
  });

  it("sin lista, cae a default", () => {
    expect(resolveActiveWorkspaceId([], "ws-work")).toBe("default");
    expect(resolveActiveWorkspaceId(null, undefined)).toBe("default");
  });
});

describe("workspaceNameMap", () => {
  it("toma id y nombre de texto y descarta el resto", () => {
    const names = workspaceNameMap([
      { id: "ws-work", name: " Clientes " },
      { id: "ws-x" },
      { id: 3, name: "Número" },
      null,
      { id: "ws-work", name: "Duplicado" },
    ]);
    expect([...names]).toEqual([["ws-work", "Clientes"]]);
  });

  it("un export antiguo sin lista no aporta nombres", () => {
    expect(workspaceNameMap(undefined).size).toBe(0);
  });
});

describe("workspacesForExport", () => {
  it("incluye los workspaces de los perfiles y de las carpetas exportadas", () => {
    const all = [...list, { id: "ws-lab", name: "Lab" }, { id: "ws-otro", name: "Otro" }];
    const profiles = [{ id: "p1" }, { id: "p2", workspace_id: "ws-work" }];
    expect(workspacesForExport(all, profiles, { "ws-lab": ["Pruebas"] })).toEqual([
      { id: "default", name: "Default" },
      { id: "ws-work", name: "Trabajo" },
      { id: "ws-lab", name: "Lab" },
    ]);
  });
});
