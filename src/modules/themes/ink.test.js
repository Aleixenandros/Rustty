import { describe, expect, it } from "vitest";
import { INK_FILLS, INK_MIN_RATIO, RING_MIN_RATIO, contrastRatio, inkTokens, parseHex, pickInk, ringColor } from "./ink.js";

// Paletas reales de styles.css: Mocha (oscuro, por defecto) y Latte (claro).
const MOCHA = {
  crust: "#11111b", base: "#1e1e2e", text: "#cdd6f4",
  blue: "#89b4fa", green: "#a6e3a1", yellow: "#f9e2af", red: "#f38ba8", peach: "#fab387",
};
const LATTE = {
  crust: "#dce0e8", base: "#eff1f5", text: "#4c4f69",
  blue: "#1e66f5", green: "#40a02b", yellow: "#df8e1d", red: "#d20f39", peach: "#fe640b",
};

describe("contraste", () => {
  it("negro sobre blanco es 21:1 y un color consigo mismo 1:1", () => {
    expect(contrastRatio("#000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#89b4fa", "#89b4fa")).toBeCloseTo(1, 5);
  });

  it("no inventa un ratio con valores que no son hex", () => {
    expect(contrastRatio("var(--crust)", "#fff")).toBeNull();
    expect(parseHex("rgb(0,0,0)")).toBeNull();
    expect(parseHex("#abc")).toEqual([170, 187, 204]);
  });
});

describe("tinta sobre rellenos de acento", () => {
  it("en un tema oscuro conserva --crust (el aspecto de siempre)", () => {
    const inks = inkTokens(MOCHA);
    for (const fill of INK_FILLS) expect(inks[fill]).toBe(MOCHA.crust);
  });

  it("en el tema claro deja de usar --crust donde no llegaba a AA", () => {
    // Antes: azul 3,71 · verde 2,53 · amarillo 1,98 · rojo 4,10 · melocotón 2,25.
    const inks = inkTokens(LATTE);
    for (const fill of INK_FILLS) {
      expect(contrastRatio(LATTE.crust, LATTE[fill])).toBeLessThan(INK_MIN_RATIO);
      expect(inks[fill]).not.toBe(LATTE.crust);
      expect(contrastRatio(inks[fill], LATTE[fill])).toBeGreaterThanOrEqual(INK_MIN_RATIO);
    }
  });

  it("prefiere los colores del tema antes que negro o blanco puros", () => {
    // El rojo de Latte admite su `base`: no hace falta saltar al blanco.
    expect(inkTokens(LATTE).red).toBe(LATTE.base);
  });

  it("si nada llega al mínimo, elige la de más contraste", () => {
    expect(pickInk("#777777", ["#888888", "#ffffff"])).toBe("#ffffff");
    expect(pickInk("#777777", [undefined, "nope"])).toBeNull();
  });

  it("ignora los acentos que el tema no define o no son hex", () => {
    expect(inkTokens({ crust: "#000000", blue: "var(--x)" })).toEqual({});
  });
});

describe("anillo de foco", () => {
  it("se queda en el azul del tema si se distingue del fondo", () => {
    expect(ringColor({ ...MOCHA, mantle: "#181825" })).toBe(MOCHA.blue);
  });

  it("salta a otro acento si el azul no llega a 3:1 con el fondo", () => {
    const ui = { base: "#2b2b2b", mantle: "#262626", blue: "#3a4a6b", lavender: "#b4befe", text: "#eeeeee" };
    expect(contrastRatio(ui.blue, ui.base)).toBeLessThan(RING_MIN_RATIO);
    const ring = ringColor(ui);
    expect(ring).toBe(ui.lavender);
    expect(contrastRatio(ring, ui.base)).toBeGreaterThanOrEqual(RING_MIN_RATIO);
    expect(contrastRatio(ring, ui.mantle)).toBeGreaterThanOrEqual(RING_MIN_RATIO);
  });

  it("sin fondo válido no decide nada", () => {
    expect(ringColor({ blue: "#89b4fa" })).toBeNull();
  });
});
