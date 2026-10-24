import { describe, it, expect } from "vitest";
import { expressionLiterals, templateLiteralText } from "./i18n-template.mjs";

/** Tramo literal de la primera plantilla de `src`. */
const literal = (src) => templateLiteralText(src, src.indexOf("`"));

describe("templateLiteralText", () => {
  it("quita lo interpolado y deja el texto propio de la plantilla", () => {
    expect(literal("toast(`No se pudo mover: ${err}`, 'error')")).toBe("No se pudo mover:");
    expect(literal("toast(`Carpeta \"${name}\" creada`)")).toBe('Carpeta " " creada');
  });

  it("no deja texto cuando todo llega de t() o de una variable", () => {
    expect(literal("toast(`${t(\"key_setup.failed\")}: ${err}`)")).toBe(":");
    expect(literal("toast(`${err}`)")).toBe("");
  });

  it("sigue las cadenas y plantillas anidadas dentro de una interpolación", () => {
    expect(literal("x(`Hay ${n > 1 ? `${n} ficheros` : \"uno}\"} listos`)")).toBe("Hay listos");
    expect(literal("x(`A ${obj({ a: { b: \"}\" } })} B`)")).toBe("A B");
  });

  it("respeta los escapes y las plantillas de varias líneas", () => {
    expect(literal("x(`Precio: \\${no} ${si}\n  segunda línea`)")).toBe("Precio: \\${no} segunda línea");
  });

  it("devuelve lo leído si la plantilla no se cierra", () => {
    expect(literal("x(`Sin cierre ${a}")).toBe("Sin cierre");
  });
});

/** Textos de los literales del valor que sigue a `opener` en `src`. */
const valueLiterals = (src, opener = "toast(") =>
  expressionLiterals(src, src.indexOf(opener) + opener.length).map((l) => l.text);

describe("expressionLiterals", () => {
  it("ve las dos ramas de un ternario y no el segundo argumento", () => {
    expect(valueLiterals('toast(ok ? "SFTP elevado activo" : "SFTP sin privilegios extra",\n  ok ? "success" : "info");'))
      .toEqual(["SFTP elevado activo", "SFTP sin privilegios extra"]);
  });

  it("ve el lado derecho de un || o un ??", () => {
    expect(valueLiterals('el.textContent = msg || "Diagnóstico de conexión";', "= "))
      .toEqual(["Diagnóstico de conexión"]);
    expect(valueLiterals('toast(err?.message ?? "Algo falló", "error")')).toEqual(["Algo falló"]);
  });

  it("no da por hallazgo las claves ni los parámetros de t()", () => {
    expect(valueLiterals('toast(t("sftp.elevated_on"), "success")')).toEqual([]);
    expect(valueLiterals('toast(ok ? t("a.b", { name: "x" }) : t("a.c"))')).toEqual([]);
  });

  it("descarta los lados de una comparación", () => {
    expect(valueLiterals('toast(t(result === "ok-empty" ? "a.b" : "a.c"))')).toEqual([]);
    expect(valueLiterals('toast(kind !== "sync" ? x : y)')).toEqual([]);
  });

  it("lee el tramo literal de las plantillas y salta comentarios", () => {
    expect(valueLiterals("toast(ok ? `Hola ${name}` /* \"no\" */ : \"Adiós\")")).toEqual(["Hola", "Adiós"]);
  });

  it("acaba en el ; de una asignación", () => {
    expect(valueLiterals('a.textContent = found ? "" : "Sin resultados"; b.textContent = "Otro";', "= "))
      .toEqual(["", "Sin resultados"]);
  });
});
