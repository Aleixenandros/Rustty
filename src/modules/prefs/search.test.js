import { describe, expect, it } from "vitest";
import { highlightOffsets, matchesAllTokens, planPrefsSearch, prefsSearchTokens } from "./search.js";

describe("prefsSearchTokens", () => {
  it("pliega mayúsculas y acentos y trocea por espacios y barras", () => {
    expect(prefsSearchTokens("  Fuénte  FTP/SFTP ")).toEqual(["fuente", "ftp", "sftp"]);
  });

  it("una consulta vacía no da tokens", () => {
    expect(prefsSearchTokens("   ")).toEqual([]);
    expect(prefsSearchTokens(null)).toEqual([]);
  });
});

describe("matchesAllTokens", () => {
  it("exige todos los tokens, en cualquier orden", () => {
    const tokens = prefsSearchTokens("fuente terminal");
    expect(matchesAllTokens("Terminal · Familia de fuente", tokens)).toBe(true);
    expect(matchesAllTokens("Apariencia · Familia de fuente", tokens)).toBe(false);
  });

  it("no distingue acentos en ninguno de los dos lados", () => {
    expect(matchesAllTokens("Contraseña del proxy", prefsSearchTokens("CONTRASENA"))).toBe(true);
    expect(matchesAllTokens("Contrasena", prefsSearchTokens("contraseña"))).toBe(true);
  });

  it("sin tokens no coincide nada", () => {
    expect(matchesAllTokens("lo que sea", [])).toBe(false);
  });
});

describe("planPrefsSearch", () => {
  const units = [
    { panel: "terminal", text: "Terminal Copiar al seleccionar texto" },
    { panel: "terminal", text: "Terminal Familia de fuente" },
    { panel: "appearance", text: "Apariencia Fuente de la interfaz" },
    { panel: "security", text: "Seguridad Pegar contraseña con broadcast" },
  ];

  it("marca cada unidad y cuenta por sección", () => {
    const plan = planPrefsSearch(units, "fuente");
    expect(plan.hits).toEqual([false, true, true, false]);
    expect(plan.total).toBe(2);
    expect([...plan.perPanel]).toEqual([["terminal", 1], ["appearance", 1]]);
  });

  it("el nombre de la sección a secas enseña todas sus filas", () => {
    const plan = planPrefsSearch(units, "terminal");
    expect(plan.hits).toEqual([true, true, false, false]);
    expect(plan.perPanel.get("terminal")).toBe(2);
  });

  it("sin coincidencias, total cero y ninguna sección", () => {
    const plan = planPrefsSearch(units, "inexistente");
    expect(plan.total).toBe(0);
    expect(plan.perPanel.size).toBe(0);
  });

  it("una consulta vacía no marca nada", () => {
    const plan = planPrefsSearch(units, "");
    expect(plan.hits.every((hit) => !hit)).toBe(true);
    expect(plan.tokens).toEqual([]);
  });
});

describe("highlightOffsets", () => {
  it("devuelve tramos sobre el texto original, con acentos", () => {
    expect(highlightOffsets("Contraseña maestra", prefsSearchTokens("contrasena"))).toEqual([[0, 10]]);
  });

  it("cuenta en unidades UTF-16 (un emoji ocupa dos)", () => {
    const text = "😀 Fuente";
    const [[start, end]] = highlightOffsets(text, prefsSearchTokens("fuente"));
    expect(text.slice(start, end)).toBe("Fuente");
  });

  it("varios tokens dan varios tramos", () => {
    const text = "Familia de fuente del terminal";
    const ranges = highlightOffsets(text, prefsSearchTokens("fuente terminal"));
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(["fuente", "terminal"]);
  });

  it("sin tokens o sin texto, nada", () => {
    expect(highlightOffsets("algo", [])).toEqual([]);
    expect(highlightOffsets("", ["algo"])).toEqual([]);
  });
});
