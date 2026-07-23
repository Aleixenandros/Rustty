// @ts-check
import { describe, it, expect } from "vitest";
import {
  DEFAULT_HIGHLIGHT_RULES,
  defaultHighlightRules,
  compileHighlightRules,
  applyHighlightRules,
} from "./highlight.js";

describe("defaultHighlightRules", () => {
  it("devuelve una copia profunda de los defaults", () => {
    const a = defaultHighlightRules();
    expect(a).toEqual(DEFAULT_HIGHLIGHT_RULES);
    a[0].color = "blue";
    // Mutar la copia no toca la constante ni una segunda copia.
    expect(DEFAULT_HIGHLIGHT_RULES[0].color).toBe("red");
    expect(defaultHighlightRules()[0].color).toBe("red");
  });
});

describe("compileHighlightRules", () => {
  it("compila color y negrita a códigos SGR", () => {
    const [rule] = compileHighlightRules([{ pattern: "ERROR", color: "red", bold: true }]);
    expect(rule.prefix).toBe("\x1b[1;91m");
    expect(rule.suffix).toBe("\x1b[0m");
    expect("ERROR aquí".match(rule.re)?.[0]).toBe("ERROR");
    expect(rule.re.flags).toContain("g");
  });

  it("sin negrita no antepone «1;»", () => {
    const [rule] = compileHighlightRules([{ pattern: "INFO", color: "cyan", bold: false }]);
    expect(rule.prefix).toBe("\x1b[96m");
  });

  it("un color desconocido cae a amarillo", () => {
    const [rule] = compileHighlightRules([{ pattern: "X", color: "chartreuse" }]);
    expect(rule.prefix).toBe("\x1b[93m");
  });

  it("ignora reglas sin patrón o con regex inválida", () => {
    const compiled = compileHighlightRules([
      { pattern: "", color: "red" },
      { color: "red" },
      { pattern: "[", color: "red" }, // regex inválida
      { pattern: "OK", color: "green" },
    ]);
    expect(compiled).toHaveLength(1);
    expect("OK".match(compiled[0].re)?.[0]).toBe("OK");
  });
});

describe("applyHighlightRules", () => {
  it("devuelve el texto intacto si no hay reglas", () => {
    expect(applyHighlightRules("hola", [])).toBe("hola");
  });

  it("envuelve cada coincidencia con sus códigos SGR", () => {
    const compiled = compileHighlightRules([{ pattern: "ERROR", color: "red", bold: true }]);
    expect(applyHighlightRules("log: ERROR y otro ERROR", compiled))
      .toBe("log: \x1b[1;91mERROR\x1b[0m y otro \x1b[1;91mERROR\x1b[0m");
  });

  it("aplica varias reglas en secuencia", () => {
    const compiled = compileHighlightRules([
      { pattern: "ERROR", color: "red", bold: true },
      { pattern: "OK", color: "green", bold: false },
    ]);
    expect(applyHighlightRules("ERROR OK", compiled))
      .toBe("\x1b[1;91mERROR\x1b[0m \x1b[92mOK\x1b[0m");
  });
});
