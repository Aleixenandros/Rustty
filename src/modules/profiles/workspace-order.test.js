import { describe, expect, it } from "vitest";
import { moveWorkspace, moveWorkspaceTo, workspaceMoves } from "./workspace-order.js";

const ws = [{ id: "a" }, { id: "b" }, { id: "c" }];
const ids = (list) => list.map((w) => w.id).join("");

describe("moveWorkspace", () => {
  it("sube y baja una posición", () => {
    expect(ids(moveWorkspace(ws, "b", -1))).toBe("bac");
    expect(ids(moveWorkspace(ws, "b", 1))).toBe("acb");
  });

  it("en los extremos o con un id desconocido no cambia nada", () => {
    expect(moveWorkspace(ws, "a", -1)).toBe(ws);
    expect(moveWorkspace(ws, "c", 1)).toBe(ws);
    expect(moveWorkspace(ws, "z", 1)).toBe(ws);
  });

  it("no muta el array original", () => {
    moveWorkspace(ws, "c", -2);
    expect(ids(ws)).toBe("abc");
  });
});

describe("moveWorkspaceTo", () => {
  it("coloca antes o después del destino", () => {
    expect(ids(moveWorkspaceTo(ws, "c", "a", "before"))).toBe("cab");
    expect(ids(moveWorkspaceTo(ws, "a", "c", "after"))).toBe("bca");
    expect(ids(moveWorkspaceTo(ws, "a", "b", "after"))).toBe("bac");
  });

  it("soltar en su propio sitio no cambia nada", () => {
    expect(moveWorkspaceTo(ws, "a", "a", "after")).toBe(ws);
    expect(moveWorkspaceTo(ws, "a", "b", "before")).toBe(ws);
    expect(moveWorkspaceTo(ws, "x", "b", "before")).toBe(ws);
  });
});

describe("workspaceMoves", () => {
  it("dice si puede subir o bajar", () => {
    expect(workspaceMoves(ws, "a")).toEqual({ up: false, down: true });
    expect(workspaceMoves(ws, "b")).toEqual({ up: true, down: true });
    expect(workspaceMoves(ws, "c")).toEqual({ up: true, down: false });
    expect(workspaceMoves([{ id: "a" }], "a")).toEqual({ up: false, down: false });
  });
});
