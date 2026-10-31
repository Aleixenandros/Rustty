import { describe, expect, it } from "vitest";
import {
  NAMED_COLORS,
  NEUTRAL_TOLERANCE,
  isNeutralHslArgs,
  isNeutralRgb,
  parseRgbArgs,
  scanTokens,
  stripComments,
} from "./tokens-css.mjs";

/** Solo tipo y valor, para comparar sin depender del texto. */
const found = (css, options) => scanTokens(css, options).map((f) => `${f.kind}|${f.value}`);

describe("stripComments", () => {
  it("vacía los comentarios sin mover las líneas", () => {
    const css = "a {\n  color: var(--x); /* #fff */\n}\n/* red\n   white */\nb { color: var(--x); }";
    const out = stripComments(css);
    expect(out.split("\n").length).toBe(css.split("\n").length);
    expect(out).not.toMatch(/#fff|red|white/);
    expect(out.split("\n")[5]).toBe("b { color: var(--x); }");
  });
});

describe("neutralidad", () => {
  it("negro, blanco y gris son neutros; un tinte no", () => {
    expect(isNeutralRgb(0, 0, 0)).toBe(true);
    expect(isNeutralRgb(255, 255, 255)).toBe(true);
    expect(isNeutralRgb(120, 124, 128)).toBe(true);
    expect(isNeutralRgb(15, 23, 42)).toBe(false);
    expect(isNeutralRgb(137, 180, 250)).toBe(false);
    expect(NEUTRAL_TOLERANCE).toBeLessThan(16);
  });

  it("lee comas, espacios, barra de alfa y porcentajes", () => {
    expect(parseRgbArgs("0, 0, 0, 0.3")).toEqual([0, 0, 0]);
    expect(parseRgbArgs("137 180 250 / 28%")).toEqual([137, 180, 250]);
    for (const c of parseRgbArgs("50%, 50%, 50%")) expect(c).toBeCloseTo(127.5, 6);
    expect(parseRgbArgs("var(--r), 0, 0")).toBeNull();
    expect(parseRgbArgs("1, 2")).toBeNull();
  });

  it("un hsl es neutro solo con saturación cero", () => {
    expect(isNeutralHslArgs("0 0% 50%")).toBe(true);
    expect(isNeutralHslArgs("210, 40%, 50%")).toBe(false);
    expect(isNeutralHslArgs("var(--h) 40% 50%")).toBe(false);
    expect(isNeutralHslArgs("210")).toBeNull();
  });
});

describe("scanTokens · hex", () => {
  it("caza un hex suelto y respeta la definición de un token", () => {
    expect(found(":root {\n  --blue: #89b4fa;\n}\n.a {\n  color: #89b4fa;\n}")).toEqual(["hex|#89b4fa"]);
    expect(scanTokens(".a {\n  color: #89b4fa;\n}")[0].line).toBe(2);
  });

  it("no mira comentarios ni selectores", () => {
    expect(found("/* #fff */\n.a { color: var(--x); } /* #000 */\n:root { --x: #000; }")).toEqual([]);
  });

  it("exime los selectores de muestras de la galería", () => {
    const css = ".theme-preview.light .theme-preview-main { background: #eff1f5; }\n.other { background: #eff1f5; }";
    expect(found(css, { exemptSelector: /^\.theme-preview\b/ })).toEqual(["hex|#eff1f5"]);
  });
});

describe("scanTokens · rgb y hsl", () => {
  it("una sombra o un velo negros o blancos translúcidos son neutros y no avisan", () => {
    const css = [
      ".a { box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); }",
      ".b { background: rgba(255,255,255,0.02); }",
      ".c { color: rgb(128 128 128 / 50%); }",
      ".d { border-color: rgb(50%, 50%, 50%); }",
    ].join("\n");
    expect(found(css)).toEqual([]);
  });

  it("un rgb con tinte sí, también con la sintaxis moderna", () => {
    const css = ".a { background: rgba(137, 180, 250, 0.28); }\n.b { color: rgb(15 23 42 / 10%); }";
    expect(found(css)).toEqual(["rgb|rgba(137, 180, 250, 0.28)", "rgb|rgb(15 23 42 / 10%)"]);
  });

  it("la definición de un token puede llevar un tinte, también en varias líneas", () => {
    const css = [
      ":root {",
      "  --shadow-2:",
      "    0 0 0 1px rgba(15, 23, 42, 0.05),",
      "    0 4px 10px rgba(15, 23, 42, 0.10);",
      "  --sel: rgba(137, 180, 250, 0.28);",
      "  color: rgba(15, 23, 42, 0.5);",
      "}",
    ].join("\n");
    expect(found(css)).toEqual(["rgb|rgba(15, 23, 42, 0.5)"]);
    expect(scanTokens(css)[0].line).toBe(6);
  });

  it("hsl: gris neutro pasa, color no", () => {
    expect(found(".a { color: hsl(0 0% 40%); }\n.b { color: hsl(210, 40%, 50%); }")).toEqual(["hsl|hsl(210, 40%, 50%)"]);
  });
});

describe("scanTokens · colores con nombre", () => {
  it("caza red, white y orange y permite transparent, currentColor e inherit", () => {
    const css = [
      ".a { color: red; }",
      ".b { background: white; }",
      ".c { border: 1px solid orange; }",
      ".d { color: transparent; fill: currentColor; stroke: inherit; outline-color: initial; }",
    ].join("\n");
    expect(found(css)).toEqual(["named|red", "named|white", "named|orange"]);
  });

  it("no confunde propiedades, variables, clases, cadenas ni funciones", () => {
    const css = [
      ".red:hover,",
      ".tone-red { white-space: nowrap; color: var(--white); }",
      ".c { content: \"red\"; font-family: 'Pink Sans', monospace; }",
      ".d { background: url(red.png); animation: pulse-red 1s; }",
      ".e { color: color-mix(in srgb, var(--red) 55%, var(--mauve)); }",
      "@media (prefers-color-scheme: light) { .f { color: var(--x); } }",
      ":root { --x: red; --white: #fff; --red: #f00; --mauve: #c0f; --pink: color-mix(in srgb, var(--red) 55%, var(--mauve)); }",
    ].join("\n");
    expect(found(css)).toEqual([]);
  });

  it("dentro de color-mix o un degradado sí avisa", () => {
    const css = ":root { --x: #000; }\n.a { background: color-mix(in srgb, white 20%, transparent); }\n.b { background: linear-gradient(to right, Red, var(--x)); }";
    expect(found(css)).toEqual(["named|white", "named|Red"]);
  });

  it("conoce los 148 nombres de CSS Color 4", () => {
    expect(NAMED_COLORS.size).toBe(148);
    for (const name of ["rebeccapurple", "gray", "grey", "tan", "navy"]) expect(NAMED_COLORS.has(name)).toBe(true);
  });
});

describe("scanTokens · capas, variables y transiciones", () => {
  it("una capa en literal es hallazgo; dentro de un componente, no", () => {
    const css = ".a { z-index: 1000; }\n.b { z-index: 20; }\n.c { z-index: var(--z-modal); }\n:root { --z-modal: 1000; }";
    expect(found(css)).toEqual(["z-index|z-index 1000"]);
    expect(found(css, { zLayerMin: 10 })).toEqual(["z-index|z-index 1000", "z-index|z-index 20"]);
  });

  it("una variable sin definir avisa salvo que la ponga el código", () => {
    const css = ":root { --a: 1px; }\n.x { width: var(--a); height: var(--b); margin: var(--c, 0); }";
    expect(found(css)).toEqual(["undefined-var|--b", "undefined-var|--c"]);
    expect(found(css, { runtimeVars: ["--c"] })).toEqual(["undefined-var|--b"]);
  });

  it("una transición con duración literal o `all` avisa; con tokens, no", () => {
    const css = [
      ":root { --motion-fast: 120ms; --motion-ease: ease; }",
      ".a { transition: background 0.12s, color .15s; }",
      ".b { transition: all 120ms; }",
      ".c { transition: opacity var(--motion-fast) var(--motion-ease); }",
      ".d { transition: none; }",
      ".e { transition-duration: 0s; }",
      ".g { transition-duration: 0.001ms !important; }",
      ".f { animation: shimmer 1.2s infinite; }",
    ].join("\n");
    expect(found(css)).toEqual(["transition|0.12s", "transition|.15s", "transition|transition: all", "transition|120ms"]);
  });
});
