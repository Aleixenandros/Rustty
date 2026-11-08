import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HIGH_CONTRAST_THEME_ID,
  LIGHT_THEME_ID,
  TONE_LUMINANCE_SPLIT,
  colorLuminance,
  galleryTone,
  isHighContrastThemeId,
  matchesToneFilter,
  parseColor,
  relativeLuminance,
  toneFor,
  toneForId,
} from "./tone.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Fondos y textos reales de styles.css.
const MOCHA = { base: "#1e1e2e", text: "#cdd6f4" };
const LATTE = { base: "#eff1f5", text: "#4c4f69" };
const SOLARIZED_LIGHT = { base: "#fdf6e3", text: "#586e75" };
const XTERM = { base: "#000000", text: "#ffffff" };

describe("parseColor / luminancia", () => {
  it("lee hex corto y largo y las formas rgb() que devuelve getComputedStyle", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor(" #1e1e2e ")).toEqual([30, 30, 46]);
    expect(parseColor("rgb(30, 30, 46)")).toEqual([30, 30, 46]);
    expect(parseColor("rgba(30,30,46,0.5)")).toEqual([30, 30, 46]);
    expect(parseColor("rgb(30 30 46 / 50%)")).toEqual([30, 30, 46]);
  });

  it("no inventa un color con lo que no lo es", () => {
    expect(parseColor("var(--base)")).toBeNull();
    expect(parseColor("rgb(300, 0, 0)")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(colorLuminance("transparent")).toBeNaN();
  });

  it("negro 0, blanco 1 y el umbral está donde negro y blanco contrastan igual", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    const black = (TONE_LUMINANCE_SPLIT + 0.05) / 0.05;
    const white = 1.05 / (TONE_LUMINANCE_SPLIT + 0.05);
    expect(black).toBeCloseTo(white, 2);
  });
});

describe("toneFor", () => {
  it("clasifica los temas de la hoja por sus colores", () => {
    expect(toneFor(MOCHA.base, "dark", MOCHA.text)).toBe("dark");
    expect(toneFor(LATTE.base, "light", LATTE.text)).toBe("light");
    expect(toneFor(SOLARIZED_LIGHT.base, "solarized-light", SOLARIZED_LIGHT.text)).toBe("light");
    expect(toneFor(XTERM.base, "xterm", XTERM.text)).toBe("dark");
  });

  it("el id no manda cuando hay color: un tema claro llamado «dark» es claro", () => {
    expect(toneFor(LATTE.base, "my-dark-theme", LATTE.text)).toBe("light");
    expect(toneFor(MOCHA.base, "github-light", MOCHA.text)).toBe("dark");
  });

  it("con fondo de tono medio decide el texto: blanco encima es oscuro, negro encima es claro", () => {
    const mid = "#777777"; // luminancia ≈ 0,18, justo en el umbral
    expect(toneFor(mid, "x", "#ffffff")).toBe("dark");
    expect(toneFor(mid, "x", "#000000")).toBe("light");
    // Rosa con texto casi negro (tema «1 Shell» del bundle): claro.
    expect(toneFor("#ee79d1", "1-shell", "#3c3938")).toBe("light");
  });

  it("solo con el fondo usa el umbral de luminancia", () => {
    expect(toneFor("#1e1e2e", "x")).toBe("dark");
    expect(toneFor("#eff1f5", "x")).toBe("light");
    expect(toneFor("#1e1e2e", "x", "var(--text)")).toBe("dark");
  });

  it("sin color legible cae al id", () => {
    expect(toneFor("var(--base)", "solarized-light")).toBe("light");
    expect(toneFor("", "dracula")).toBe("dark");
    expect(toneFor(undefined, "tokyo-night-day")).toBe("light");
    expect(toneFor(undefined, "tokyo-night")).toBe("dark");
    expect(toneFor(null, undefined)).toBe("dark");
  });

  it("acepta los valores tal como los devuelve getComputedStyle (con espacio inicial)", () => {
    expect(toneFor(" #eff1f5", "light", " #4c4f69")).toBe("light");
    expect(toneFor("rgb(239, 241, 245)", "light", "rgb(76, 79, 105)")).toBe("light");
  });
});

describe("toneForId / alto contraste", () => {
  it("reconoce los temas claros de la hoja y deja el resto en oscuro", () => {
    expect(toneForId("light")).toBe("light");
    expect(toneForId("solarized-light")).toBe("light");
    for (const id of ["dark", "dracula", "nord", "xterm", "vscode-dark", "tango", "solarized-dark", "gruvbox-dark", "tokyo-night", "monokai"]) {
      expect(toneForId(id)).toBe("dark");
    }
  });

  it("el alto contraste se lee del id o del nombre, no de un umbral", () => {
    expect(isHighContrastThemeId("github-light-high-contrast")).toBe(true);
    expect(isHighContrastThemeId("mi-tema-hc")).toBe(true);
    expect(isHighContrastThemeId("Alto contraste")).toBe(true);
    expect(isHighContrastThemeId("gruvbox-dark-hard-contrast")).toBe(false);
    expect(isHighContrastThemeId("chcolate")).toBe(false);
    expect(isHighContrastThemeId(undefined)).toBe(false);
    expect(HIGH_CONTRAST_THEME_ID.flags).toBe("");
  });
});

describe("temas del bundle", () => {
  const pack = JSON.parse(read("../../../public/themes/bundled-themes.json"));
  const themes = pack.themes;

  it("hay temas y todos traen fondo y texto", () => {
    expect(themes.length).toBeGreaterThan(200);
    for (const theme of themes) {
      expect(parseColor(theme.ui.base), theme.id).not.toBeNull();
      expect(parseColor(theme.ui.text), theme.id).not.toBeNull();
    }
  });

  it("un tema cuyo id anuncia claro lo es de verdad (la reserva de boot.js no miente)", () => {
    const named = themes.filter((theme) => LIGHT_THEME_ID.test(theme.id));
    expect(named.length).toBeGreaterThan(20);
    for (const theme of named) {
      expect(toneFor(theme.ui.base, theme.id, theme.ui.text), theme.id).toBe("light");
    }
  });

  it("en los claros el texto es más oscuro que el fondo y en los oscuros al revés", () => {
    for (const theme of themes) {
      const tone = toneFor(theme.ui.base, theme.id, theme.ui.text);
      const darkerText = colorLuminance(theme.ui.text) < colorLuminance(theme.ui.base);
      expect(tone, theme.id).toBe(darkerText ? "light" : "dark");
    }
  });

  it("los dos temas de alto contraste del bundle se reconocen", () => {
    const hc = themes.filter((theme) => isHighContrastThemeId(theme.id)).map((theme) => theme.id);
    expect(hc).toEqual(["github-dark-high-contrast", "github-light-high-contrast"]);
  });

  it("la galería los clasifica igual que el esquema que se aplica", () => {
    for (const theme of themes) {
      const tone = galleryTone(theme.id, theme.name, theme.ui);
      if (tone === "hc") continue;
      expect(tone, theme.id).toBe(toneFor(theme.ui.base, theme.id, theme.ui.text));
    }
  });
});

describe("galleryTone (filtro de la galería)", () => {
  it("las opciones meta no tienen tono y salen con cualquier filtro", () => {
    expect(galleryTone("system", "Sistema")).toBe("any");
    expect(galleryTone("inherit", "Heredar")).toBe("any");
    for (const filter of ["all", "dark", "light", "hc"]) {
      expect(matchesToneFilter("any", filter)).toBe(true);
    }
  });

  it("alto contraste por id o por nombre, antes que el color", () => {
    expect(galleryTone("mi-tema", "Mi tema high contrast", LATTE)).toBe("hc");
    expect(galleryTone("github-dark-high-contrast", "", XTERM)).toBe("hc");
  });

  it("con paleta manda toneFor; sin ella, el id", () => {
    expect(galleryTone("my-dark-theme", "x", LATTE)).toBe("light");
    expect(galleryTone("solarized-light", "Solarized Light")).toBe("light");
    expect(galleryTone("monokai", "Monokai")).toBe("dark");
  });

  it("el filtro deja pasar solo el tono elegido", () => {
    expect(matchesToneFilter("dark", "all")).toBe(true);
    expect(matchesToneFilter("dark", undefined)).toBe(true);
    expect(matchesToneFilter("dark", "dark")).toBe(true);
    expect(matchesToneFilter("dark", "light")).toBe(false);
    expect(matchesToneFilter("hc", "dark")).toBe(false);
  });

  it("los temas de la hoja: el id da el mismo tono que sus tokens --base/--text", () => {
    // Los doce temas de styles.css no tienen paleta en JS: la galería los
    // clasifica por id. Si un tema de la hoja cambiara de tono sin que su id lo
    // dijera, el filtro y el esquema aplicado dejarían de coincidir.
    const css = read("../../styles.css");
    const block = (selector) => {
      let from = 0;
      for (;;) {
        const start = css.indexOf(`${selector} {`, from);
        if (start === -1) return null;
        const open = css.indexOf("{", start);
        const close = css.indexOf("}", open);
        const body = css.slice(open + 1, close);
        if (/--base\s*:/.test(body)) {
          /** @type {Record<string, string>} */
          const tokens = {};
          for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens[m[1]] = m[2].trim();
          return tokens;
        }
        from = close + 1;
      }
    };
    const root = block(":root");
    expect(root).not.toBeNull();
    expect(galleryTone("dark", "")).toBe(toneFor(root["--base"], "dark", root["--text"]));
    const names = [...new Set([...css.matchAll(/html\.theme-([a-z0-9-]+)\s*[,{]/gi)].map((m) => m[1]))];
    let checked = 0;
    for (const name of names) {
      const tokens = block(`html.theme-${name}`);
      if (!tokens) continue;
      checked++;
      const base = tokens["--base"] ?? root["--base"];
      const text = tokens["--text"] ?? root["--text"];
      expect(galleryTone(name, ""), name).toBe(toneFor(base, name, text));
    }
    expect(checked).toBeGreaterThanOrEqual(11);
  });
});

describe("copia en public/boot.js", () => {
  it("la expresión por id de boot.js es la misma que LIGHT_THEME_ID", () => {
    const boot = read("../../../public/boot.js");
    const m = /var LIGHT_THEME_ID = \/(.+?)\/([a-z]*);/.exec(boot);
    expect(m, "boot.js debe declarar `var LIGHT_THEME_ID = /…/;`").not.toBeNull();
    expect(m[1]).toBe(LIGHT_THEME_ID.source);
    expect(m[2]).toBe(LIGHT_THEME_ID.flags);
  });

  it("boot.js solo acepta el tono guardado para el mismo tema y lo pone en data-tone", () => {
    const boot = read("../../../public/boot.js");
    expect(boot).toMatch(/rustty-theme-tone/);
    expect(boot).toMatch(/saved\.theme === t/);
    expect(boot).toMatch(/html\.dataset\.tone = /);
  });
});
