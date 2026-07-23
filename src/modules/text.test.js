// @ts-check
import { describe, it, expect } from "vitest";
import { baseSlugifyThemeId } from "./text.js";

describe("baseSlugifyThemeId", () => {
  it("pasa a minúsculas y colapsa lo no alfanumérico a guiones", () => {
    expect(baseSlugifyThemeId("Mi Tema Oscuro")).toBe("mi-tema-oscuro");
    expect(baseSlugifyThemeId("Tema  ///  raro!!!")).toBe("tema-raro");
  });

  it("quita los diacríticos por NFD", () => {
    expect(baseSlugifyThemeId("Café Solânea")).toBe("cafe-solanea");
    expect(baseSlugifyThemeId("Ñandú Über")).toBe("nandu-uber");
  });

  it("recorta guiones sobrantes de los extremos", () => {
    expect(baseSlugifyThemeId("  --hola--  ")).toBe("hola");
    expect(baseSlugifyThemeId("!!!")).toBe("custom");
  });

  it("limita a 40 caracteres", () => {
    const largo = "a".repeat(60);
    expect(baseSlugifyThemeId(largo)).toBe("a".repeat(40));
  });

  it("cae a «custom» para nombre vacío, nulo o solo-símbolos", () => {
    expect(baseSlugifyThemeId("")).toBe("custom");
    expect(baseSlugifyThemeId(null)).toBe("custom");
    expect(baseSlugifyThemeId(undefined)).toBe("custom");
  });
});
