// @ts-check
import { describe, it, expect } from "vitest";
import { keyLabelFromCode, comboFromEvent } from "./combo.js";

/**
 * Crea un evento de teclado mínimo para las pruebas.
 * @param {string} code
 * @param {string} key
 * @param {{ ctrl?: boolean, alt?: boolean, shift?: boolean, meta?: boolean }} [mods]
 */
function ev(code, key, mods = {}) {
  return {
    code,
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
  };
}

describe("keyLabelFromCode", () => {
  it("resuelve letras y dígitos por prefijo", () => {
    expect(keyLabelFromCode("KeyA")).toBe("A");
    expect(keyLabelFromCode("KeyZ")).toBe("Z");
    expect(keyLabelFromCode("Digit5")).toBe("5");
  });

  it("usa el mapa para símbolos y numpad", () => {
    expect(keyLabelFromCode("Comma")).toBe(",");
    expect(keyLabelFromCode("Slash")).toBe("/");
    expect(keyLabelFromCode("Numpad3")).toBe("3");
    expect(keyLabelFromCode("NumpadEnter")).toBe("Enter");
  });

  it("devuelve el propio código para teclas nombradas", () => {
    expect(keyLabelFromCode("Tab")).toBe("Tab");
    expect(keyLabelFromCode("Escape")).toBe("Escape");
    expect(keyLabelFromCode("F1")).toBe("F1");
    expect(keyLabelFromCode("ArrowLeft")).toBe("ArrowLeft");
  });
});

describe("comboFromEvent", () => {
  it("devuelve null si el evento es solo un modificador", () => {
    expect(comboFromEvent(ev("ControlLeft", "Control", { ctrl: true }))).toBeNull();
    expect(comboFromEvent(ev("ShiftLeft", "Shift", { shift: true }))).toBeNull();
    expect(comboFromEvent(ev("MetaLeft", "Meta", { meta: true }))).toBeNull();
  });

  it("compone la tecla sola sin modificadores", () => {
    expect(comboFromEvent(ev("KeyK", "k"))).toBe("K");
    expect(comboFromEvent(ev("Escape", "Escape"))).toBe("Escape");
  });

  it("antepone los modificadores en orden fijo Ctrl+Alt+Shift+Meta", () => {
    expect(comboFromEvent(ev("KeyN", "n", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+N");
    expect(comboFromEvent(ev("KeyP", "p", { ctrl: true }))).toBe("Ctrl+P");
    expect(comboFromEvent(ev("KeyX", "x", { meta: true, alt: true, ctrl: true, shift: true })))
      .toBe("Ctrl+Alt+Shift+Meta+X");
  });

  it("usa el código físico, no la tecla (independiente de la distribución)", () => {
    // Con AltGr una tecla puede producir otro `key`, pero el `code` es estable.
    expect(comboFromEvent(ev("Digit2", "@", { ctrl: true }))).toBe("Ctrl+2");
  });
});
