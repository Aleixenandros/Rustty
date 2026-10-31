// @ts-check
import { describe, expect, it } from "vitest";
import { menuKey, menuMove } from "./menu-nav.js";

/** Conectar · Abrir en privado · [Conectar con otro usuario ▸] · ─ · Renombrar (desactivado) · Eliminar */
const ENTRIES = [
  {}, {}, { submenu: true }, { separator: true }, { disabled: true }, {},
];

describe("menuMove", () => {
  it("↓ y ↑ saltan separadores y desactivados y dan la vuelta", () => {
    expect(menuMove(ENTRIES, 0, "ArrowDown")).toBe(1);
    expect(menuMove(ENTRIES, 2, "ArrowDown")).toBe(5);
    expect(menuMove(ENTRIES, 5, "ArrowDown")).toBe(0);
    expect(menuMove(ENTRIES, 0, "ArrowUp")).toBe(5);
    expect(menuMove(ENTRIES, 5, "ArrowUp")).toBe(2);
  });

  it("Inicio y Fin van al primer y último ítem elegible", () => {
    expect(menuMove(ENTRIES, 3, "Home")).toBe(0);
    expect(menuMove(ENTRIES, 0, "End")).toBe(5);
    expect(menuMove([{ disabled: true }, {}, { disabled: true }], 0, "End")).toBe(1);
  });

  it("sin foco, ↓ va al primero y ↑ al último", () => {
    expect(menuMove(ENTRIES, -1, "ArrowDown")).toBe(0);
    expect(menuMove(ENTRIES, -1, "ArrowUp")).toBe(5);
  });

  it("devuelve null con teclas ajenas o sin nada enfocable", () => {
    expect(menuMove(ENTRIES, 0, "Enter")).toBe(null);
    expect(menuMove([], 0, "ArrowDown")).toBe(null);
    expect(menuMove([{ separator: true }, { disabled: true }], -1, "ArrowDown")).toBe(null);
  });
});

describe("menuKey", () => {
  it("las flechas verticales piden enfocar la entrada siguiente", () => {
    expect(menuKey("ArrowDown", { entries: ENTRIES, index: 1 })).toEqual({ action: "focus", index: 2 });
    expect(menuKey("Home", { entries: ENTRIES, index: 5 })).toEqual({ action: "focus", index: 0 });
  });

  it("→ abre el submenú solo sobre un ítem padre", () => {
    expect(menuKey("ArrowRight", { entries: ENTRIES, index: 2 })).toEqual({ action: "open" });
    expect(menuKey("ArrowRight", { entries: ENTRIES, index: 0 })).toEqual({ action: "none" });
    expect(menuKey("ArrowRight", { entries: [{ submenu: true, disabled: true }], index: 0 })).toEqual({ action: "none" });
  });

  it("Enter y Espacio abren el submenú del padre y activan los demás ítems", () => {
    expect(menuKey("Enter", { entries: ENTRIES, index: 2 })).toEqual({ action: "open" });
    expect(menuKey(" ", { entries: ENTRIES, index: 0 })).toEqual({ action: "activate" });
    expect(menuKey("Enter", { entries: ENTRIES, index: 4 })).toEqual({ action: "none" });
    expect(menuKey("Enter", { entries: ENTRIES, index: -1 })).toEqual({ action: "none" });
  });

  it("← y Escape vuelven al padre desde un submenú; Escape cierra el menú en el primer nivel", () => {
    expect(menuKey("ArrowLeft", { entries: [{}], index: 0, inSubmenu: true })).toEqual({ action: "parent" });
    expect(menuKey("ArrowLeft", { entries: ENTRIES, index: 0 })).toEqual({ action: "none" });
    expect(menuKey("Escape", { entries: [{}], index: 0, inSubmenu: true })).toEqual({ action: "parent" });
    expect(menuKey("Escape", { entries: ENTRIES, index: 0 })).toEqual({ action: "close" });
  });

  it("Tab cierra el menú y una tecla ajena no hace nada", () => {
    expect(menuKey("Tab", { entries: ENTRIES, index: 0 })).toEqual({ action: "close" });
    expect(menuKey("F2", { entries: ENTRIES, index: 0 })).toEqual({ action: "none" });
  });
});
