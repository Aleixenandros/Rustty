// @ts-check
import { describe, it, expect } from "vitest";
import { escHtml } from "./html.js";

describe("escHtml", () => {
  it("escapa los cuatro caracteres peligrosos del marcado", () => {
    expect(escHtml("<b>")).toBe("&lt;b&gt;");
    expect(escHtml('a "b" c')).toBe("a &quot;b&quot; c");
    expect(escHtml("a & b")).toBe("a &amp; b");
  });

  it("escapa el & primero para no doblar las entidades introducidas", () => {
    expect(escHtml("<")).toBe("&lt;");
    expect(escHtml("&lt;")).toBe("&amp;lt;");
  });

  it("neutraliza una inyección típica de script", () => {
    expect(escHtml('<img src=x onerror="alert(1)">'))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("deja intacto el texto sin caracteres especiales", () => {
    expect(escHtml("hola mundo")).toBe("hola mundo");
    expect(escHtml("ruta/con-guiones_y.puntos")).toBe("ruta/con-guiones_y.puntos");
  });

  it("no escapa la comilla simple (atributos siempre con comillas dobles)", () => {
    expect(escHtml("d'Artagnan")).toBe("d'Artagnan");
  });

  it("convierte valores no string con String()", () => {
    expect(escHtml(42)).toBe("42");
    expect(escHtml(null)).toBe("null");
    expect(escHtml(undefined)).toBe("undefined");
  });
});
