// @ts-check
import { describe, it, expect } from "vitest";
import {
  THEME_FORMAT_VERSION,
  pickThemeTokens,
  buildThemeDocument,
  normalizeThemeDocument,
} from "./document.js";

/**
 * Documento v2 válido y mínimo para partir de él en las pruebas.
 * @param {Record<string, unknown>} [over] campos que sobrescriben el documento base
 */
function validDoc(over = {}) {
  return {
    formatVersion: THEME_FORMAT_VERSION,
    name: "Mi Tema",
    ui: { base: "#1e1e2e", text: "#cdd6f4" },
    terminal: { background: "#1e1e2e", foreground: "#cdd6f4" },
    ...over,
  };
}

describe("pickThemeTokens", () => {
  it("se queda solo con los tokens conocidos, recortados", () => {
    const out = pickThemeTokens(
      { base: "  #111  ", text: "#222", desconocido: "#333" },
      ["base", "text"],
    );
    expect(out).toEqual({ base: "#111", text: "#222" });
  });

  it("descarta valores no-string o vacíos", () => {
    const out = pickThemeTokens({ base: 42, text: "  ", surface0: "#444" }, ["base", "text", "surface0"]);
    expect(out).toEqual({ surface0: "#444" });
  });

  it("devuelve {} si la fuente no es un objeto", () => {
    expect(pickThemeTokens(null, ["base"])).toEqual({});
    expect(pickThemeTokens("x", ["base"])).toEqual({});
  });
});

describe("buildThemeDocument", () => {
  it("etiqueta la versión y filtra los tokens de cada sección", () => {
    const doc = buildThemeDocument({
      id: "mi-tema",
      name: "Mi Tema",
      ui: { base: "#111", pepe: "#000" },
      terminal: { background: "#222", juan: "#000" },
    });
    expect(doc.formatVersion).toBe(THEME_FORMAT_VERSION);
    expect(doc.id).toBe("mi-tema");
    expect(doc.ui).toEqual({ base: "#111" });
    expect(doc.terminal).toEqual({ background: "#222" });
  });
});

describe("normalizeThemeDocument", () => {
  const opts = { slugify: (n) => `slug(${n})`, now: () => "2026-01-01T00:00:00.000Z" };

  it("rechaza una versión de formato distinta", () => {
    expect(() => normalizeThemeDocument(validDoc({ formatVersion: 1 }), opts))
      .toThrow("unsupported_theme_format");
    expect(() => normalizeThemeDocument(null, opts)).toThrow("unsupported_theme_format");
  });

  it("exige nombre", () => {
    expect(() => normalizeThemeDocument(validDoc({ name: "   " }), opts))
      .toThrow("theme_name_required");
  });

  it("exige los cuatro tokens mínimos", () => {
    expect(() => normalizeThemeDocument(validDoc({ ui: { text: "#fff" } }), opts))
      .toThrow("theme_required_tokens_missing");
    expect(() => normalizeThemeDocument(validDoc({ terminal: { background: "#000" } }), opts))
      .toThrow("theme_required_tokens_missing");
  });

  it("normaliza un documento válido inyectando slug y reloj", () => {
    const out = normalizeThemeDocument(validDoc(), opts);
    expect(out).toEqual({
      formatVersion: THEME_FORMAT_VERSION,
      id: "slug(Mi Tema)",
      name: "Mi Tema",
      ui: { base: "#1e1e2e", text: "#cdd6f4" },
      terminal: { background: "#1e1e2e", foreground: "#cdd6f4" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("prefiere el id explícito del documento para el slug y recorta el nombre a 60", () => {
    const largo = "N".repeat(80);
    const out = normalizeThemeDocument(validDoc({ id: "custom-id", name: largo }), opts);
    expect(out.id).toBe("slug(custom-id)");
    expect(out.name).toHaveLength(60);
  });

  it("por defecto usa el slug puro (sin unicidad) si no se inyecta", () => {
    const out = normalizeThemeDocument(validDoc({ id: "Café Oscuro" }));
    expect(out.id).toBe("cafe-oscuro");
  });
});
