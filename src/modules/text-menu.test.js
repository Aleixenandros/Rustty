import { describe, expect, it } from "vitest";
import { textMenuEntries, textTargetKind } from "./text-menu.js";

const ids = (entries) => entries.map((e) => ("separator" in e ? "|" : e.id));
const disabled = (entries) => entries.filter((e) => !("separator" in e) && e.disabled).map((e) => e.id);

describe("textTargetKind", () => {
  it("campos de texto editables", () => {
    expect(textTargetKind({ tagName: "TEXTAREA" })).toBe("editable");
    expect(textTargetKind({ tagName: "input", type: "text" })).toBe("editable");
    expect(textTargetKind({ tagName: "INPUT", type: "" })).toBe("editable");
    expect(textTargetKind({ tagName: "INPUT", type: "password" })).toBe("editable");
    expect(textTargetKind({ tagName: "DIV", isContentEditable: true })).toBe("editable");
  });

  it("solo lectura y desactivados", () => {
    expect(textTargetKind({ tagName: "INPUT", type: "text", readOnly: true })).toBe("readonly");
    expect(textTargetKind({ tagName: "TEXTAREA", disabled: true })).toBeNull();
  });

  it("controles que no son texto no llevan menú", () => {
    for (const type of ["checkbox", "radio", "range", "color", "file", "button"]) {
      expect(textTargetKind({ tagName: "INPUT", type })).toBeNull();
    }
    expect(textTargetKind({ tagName: "BUTTON" })).toBeNull();
  });

  it("texto seleccionado fuera de un campo", () => {
    expect(textTargetKind({ tagName: "P", hasDocumentSelection: true })).toBe("selection");
    expect(textTargetKind({ tagName: "P" })).toBeNull();
  });
});

describe("textMenuEntries", () => {
  it("campo editable con selección", () => {
    const e = textMenuEntries({ kind: "editable", hasSelection: true, hasValue: true });
    expect(ids(e)).toEqual(["undo", "redo", "|", "cut", "copy", "paste", "delete", "|", "select-all"]);
    expect(disabled(e)).toEqual([]);
  });

  it("sin selección no se corta, copia ni borra; pegar siempre", () => {
    const e = textMenuEntries({ kind: "editable", hasSelection: false, hasValue: true });
    expect(disabled(e)).toEqual(["cut", "copy", "delete"]);
  });

  it("vacío: seleccionar todo desactivado", () => {
    expect(disabled(textMenuEntries({ kind: "editable" }))).toContain("select-all");
  });

  it("contraseña: ni copiar ni cortar aunque haya selección", () => {
    const e = textMenuEntries({ kind: "editable", hasSelection: true, hasValue: true, secret: true });
    expect(disabled(e)).toEqual(["cut", "copy"]);
  });

  it("deshacer y rehacer según el historial del editor", () => {
    const e = textMenuEntries({ kind: "editable", canUndo: false, canRedo: false, hasValue: true });
    expect(disabled(e)).toEqual(expect.arrayContaining(["undo", "redo"]));
  });

  it("el formato solo cuando se pide, al final", () => {
    expect(ids(textMenuEntries({ kind: "editable" }))).not.toContain("format");
    const e = textMenuEntries({ kind: "editable", formats: true });
    expect(ids(e).slice(-2)).toEqual(["|", "format"]);
  });

  it("solo lectura: copiar y seleccionar todo", () => {
    const e = textMenuEntries({ kind: "readonly", hasSelection: true, hasValue: true });
    expect(ids(e)).toEqual(["copy", "|", "select-all"]);
    expect(disabled(e)).toEqual([]);
  });

  it("selección suelta: solo copiar", () => {
    expect(ids(textMenuEntries({ kind: "selection", hasSelection: true }))).toEqual(["copy"]);
  });
});
