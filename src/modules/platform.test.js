// @ts-check
import { describe, it, expect } from "vitest";
import { formatAccelerator } from "./platform.js";

describe("formatAccelerator", () => {
  it("devuelve «» si no hay atajo", () => {
    expect(formatAccelerator("", true)).toBe("");
    expect(formatAccelerator("", false)).toBe("");
    // @ts-expect-error entrada defensiva
    expect(formatAccelerator(null, true)).toBe("");
  });

  it("en macOS llama Cmd a Meta y deja Ctrl, que es la tecla Control que lee el despachador", () => {
    expect(formatAccelerator("Meta+K", true)).toBe("Cmd+K");
    expect(formatAccelerator("Ctrl+K", true)).toBe("Ctrl+K");
    expect(formatAccelerator("Ctrl+Shift+P", true)).toBe("Ctrl+Shift+P");
  });

  it("fuera de macOS deja el atajo intacto", () => {
    expect(formatAccelerator("Ctrl+K", false)).toBe("Ctrl+K");
    expect(formatAccelerator("Alt+Shift+P", false)).toBe("Alt+Shift+P");
  });

  it("solo toca la palabra completa «Meta», no subcadenas", () => {
    // \b evita tocar, p. ej., un hipotético «Metax».
    expect(formatAccelerator("Metax+K", true)).toBe("Metax+K");
  });
});
