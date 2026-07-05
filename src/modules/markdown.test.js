import { describe, it, expect } from "vitest";
import { renderMarkdownMinimal, toggleTaskInBody } from "./markdown.js";

describe("renderMarkdownMinimal", () => {
  it("renderiza encabezados", () => {
    expect(renderMarkdownMinimal("# Hola")).toBe("<h1>Hola</h1>");
  });

  it("renderiza negrita dentro de un párrafo", () => {
    expect(renderMarkdownMinimal("texto **fuerte**")).toBe(
      "<p>texto <strong>fuerte</strong></p>"
    );
  });

  it("escapa HTML de la entrada", () => {
    expect(renderMarkdownMinimal("a < b & c")).toBe("<p>a &lt; b &amp; c</p>");
  });

  it("tolera entradas no-string", () => {
    expect(renderMarkdownMinimal(null)).toBe("");
  });

  it("no doble-escapa `&` en los href con query string", () => {
    expect(renderMarkdownMinimal("[a](https://x.es/p?a=1&b=2)")).toBe(
      '<p><a href="https://x.es/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">a</a></p>'
    );
  });

  it("el texto literal ' CODE0 ' no colisiona con el placeholder de código", () => {
    expect(renderMarkdownMinimal("hay `x` y CODE0 literal")).toBe(
      "<p>hay <code>x</code> y CODE0 literal</p>"
    );
  });
});

describe("toggleTaskInBody", () => {
  it("marca una tarea por índice", () => {
    expect(toggleTaskInBody("- [ ] uno\n- [ ] dos", 1, true)).toBe(
      "- [ ] uno\n- [x] dos"
    );
  });

  it("desmarca una tarea por índice", () => {
    expect(toggleTaskInBody("- [x] uno", 0, false)).toBe("- [ ] uno");
  });

  it("ignora índices fuera de rango y conserva el resto", () => {
    expect(toggleTaskInBody("- [ ] uno", 5, true)).toBe("- [ ] uno");
  });

  it("salta las tareas dentro de bloques cercados, como el render", () => {
    const body = "- [ ] real\n```\n- [ ] en código\n```\n- [ ] otra";
    // El índice 1 es «otra»: la casilla dentro del fence no se pinta ni cuenta.
    expect(toggleTaskInBody(body, 1, true)).toBe(
      "- [ ] real\n```\n- [ ] en código\n```\n- [x] otra"
    );
  });

  it("no cuenta tareas indentadas que el render no pinta como casilla", () => {
    const body = "  - [ ] indentada\n- [ ] real";
    expect(toggleTaskInBody(body, 0, true)).toBe("  - [ ] indentada\n- [x] real");
  });
});
