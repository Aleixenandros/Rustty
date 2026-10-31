import { describe, expect, it } from "vitest";
import { isToastExitKey, pickToastToFocus, shouldReturnToastFocus } from "./toast-focus.js";

describe("pickToastToFocus", () => {
  it("sin avisos no elige nada", () => {
    expect(pickToastToFocus([])).toBe(-1);
  });

  it("prefiere el último aviso visible con acción", () => {
    const toasts = [
      { hasAction: true },
      { hasAction: false },
      { hasAction: true },
      { hasAction: false },
    ];
    expect(pickToastToFocus(toasts)).toBe(2);
  });

  it("sin acciones cae al último visible, para cerrarlo", () => {
    expect(pickToastToFocus([{ hasAction: false }, { hasAction: false }])).toBe(1);
  });

  it("ignora los avisos colapsados tras el contador «+N»", () => {
    const toasts = [
      { hasAction: true, hidden: true },
      { hasAction: false },
      { hasAction: false },
    ];
    expect(pickToastToFocus(toasts)).toBe(2);
    expect(pickToastToFocus([{ hasAction: true, hidden: true }])).toBe(-1);
  });
});

describe("isToastExitKey", () => {
  it("Escape sale siempre", () => {
    expect(isToastExitKey({ key: "Escape" }, 0, 2)).toBe(true);
    expect(isToastExitKey({ key: "Escape" }, 1, 2)).toBe(true);
  });

  it("Tab sale solo por los extremos del aviso", () => {
    expect(isToastExitKey({ key: "Tab" }, 0, 2)).toBe(false);
    expect(isToastExitKey({ key: "Tab" }, 1, 2)).toBe(true);
    expect(isToastExitKey({ key: "Tab", shiftKey: true }, 0, 2)).toBe(true);
    expect(isToastExitKey({ key: "Tab", shiftKey: true }, 1, 2)).toBe(false);
  });

  it("con un solo control, Tab en cualquier sentido sale", () => {
    expect(isToastExitKey({ key: "Tab" }, 0, 1)).toBe(true);
    expect(isToastExitKey({ key: "Tab", shiftKey: true }, 0, 1)).toBe(true);
  });

  it("otras teclas y Tab con modificadores no salen", () => {
    expect(isToastExitKey({ key: "Enter" }, 1, 2)).toBe(false);
    expect(isToastExitKey({ key: "Tab", ctrlKey: true }, 1, 2)).toBe(false);
    expect(isToastExitKey({ key: "Tab", altKey: true }, 1, 2)).toBe(false);
  });
});

describe("shouldReturnToastFocus", () => {
  it("devuelve el foco si sigue en el aviso o se perdió en el documento", () => {
    expect(shouldReturnToastFocus({ activeInsideToast: true, activeIsBody: false })).toBe(true);
    expect(shouldReturnToastFocus({ activeInsideToast: false, activeIsBody: true })).toBe(true);
  });

  it("respeta un foco que la acción ya movió a otro sitio", () => {
    expect(shouldReturnToastFocus({ activeInsideToast: false, activeIsBody: false })).toBe(false);
  });
});
