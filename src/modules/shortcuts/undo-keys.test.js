import { describe, it, expect } from "vitest";
import { undoRedoCommand } from "./undo-keys.js";

// Evento de teclado mínimo con los modificadores en false por defecto.
const ev = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("undoRedoCommand", () => {
  it("Ctrl+Z es undo (mayúscula o minúscula en e.key)", () => {
    expect(undoRedoCommand(ev("z", { ctrlKey: true }))).toBe("undo");
    expect(undoRedoCommand(ev("Z", { ctrlKey: true }))).toBe("undo");
  });

  it("Ctrl+Shift+Z y Ctrl+Y son redo", () => {
    expect(undoRedoCommand(ev("Z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(undoRedoCommand(ev("y", { ctrlKey: true }))).toBe("redo");
  });

  it("sin Ctrl no hay comando", () => {
    expect(undoRedoCommand(ev("z"))).toBeNull();
    expect(undoRedoCommand(ev("z", { shiftKey: true }))).toBeNull();
  });

  it("Alt o Meta invalidan (AltGr de tercer nivel, convención Cmd de macOS)", () => {
    expect(undoRedoCommand(ev("z", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(undoRedoCommand(ev("z", { ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it("Ctrl+Shift+Y no es nada (solo Ctrl+Y pelado es redo)", () => {
    expect(undoRedoCommand(ev("y", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("otras teclas con Ctrl no son nada", () => {
    expect(undoRedoCommand(ev("a", { ctrlKey: true }))).toBeNull();
    expect(undoRedoCommand(ev("Control", { ctrlKey: true }))).toBeNull();
  });
});
