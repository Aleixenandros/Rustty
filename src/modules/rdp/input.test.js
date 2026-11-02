// @ts-check
import { describe, it, expect } from "vitest";
import { InputBatch, wheelUnits } from "./input.js";
import { scancodeForCode, SCANCODES, CTRL_ALT_DEL } from "./scancodes.js";

describe("InputBatch", () => {
  it("codifica el mismo lote que decodifica el backend (input.rs)", () => {
    // Mismo vector que `decodifica_un_lote_mixto` en Rust.
    const b = new InputBatch();
    b.move(16, 32);
    b.button(0, true);
    b.wheel(true, -120);
    b.key(0xe01d, true);
    b.unicode("é", false);
    b.releaseAll();
    b.sync({ num: true, caps: true });
    expect([...b.take()]).toEqual([
      1, 0x10, 0, 0x20, 0,
      2, 0, 1,
      3, 1, 0x88, 0xff,
      4, 0x1d, 0xe0, 1,
      5, 0xe9, 0, 0, 0, 0,
      6,
      7, 0b0110,
    ]);
    expect(b.empty).toBe(true);
  });

  it("acota coordenadas y descarta botones inexistentes", () => {
    const b = new InputBatch();
    b.move(-5, 70000.4);
    b.button(7, true);
    expect([...b.take()]).toEqual([1, 0, 0, 0xff, 0xff]);
  });

  it("codifica caracteres fuera del plano básico", () => {
    const b = new InputBatch();
    b.unicode("😀", true);
    expect([...b.take()]).toEqual([5, 0x00, 0xf6, 0x01, 0x00, 1]);
  });
});

describe("wheelUnits", () => {
  it("invierte el sentido vertical del navegador y escala por modo", () => {
    expect(wheelUnits(100, 0, true)).toBe(-120);
    expect(wheelUnits(-3, 1, true)).toBe(120);
    expect(wheelUnits(100, 0, false)).toBe(120);
  });

  it("acota al máximo del protocolo", () => {
    expect(wheelUnits(10000, 0, true)).toBe(-255);
    expect(wheelUnits(-1, 2, true)).toBe(255);
  });
});

describe("scancodes", () => {
  it("usa la posición física, no el carácter", () => {
    expect(scancodeForCode("KeyA")).toBe(0x1e);
    expect(scancodeForCode("Semicolon")).toBe(0x27);
    expect(scancodeForCode("IntlBackslash")).toBe(0x56);
  });

  it("marca las teclas extendidas con 0xE000", () => {
    expect(scancodeForCode("ArrowLeft")).toBe(0xe04b);
    expect(scancodeForCode("ControlRight")).toBe(0xe01d);
    expect(scancodeForCode("NumpadEnter")).toBe(0xe01c);
    expect(scancodeForCode("MetaLeft")).toBe(0xe05b);
  });

  it("devuelve null para teclas sin equivalente y no hereda del prototipo", () => {
    expect(scancodeForCode("Unidentified")).toBeNull();
    expect(scancodeForCode("toString")).toBeNull();
  });

  it("no repite scancodes", () => {
    const values = Object.values(SCANCODES);
    expect(new Set(values).size).toBe(values.length);
    expect(CTRL_ALT_DEL).toEqual([0x1d, 0x38, 0xe053]);
  });
});
