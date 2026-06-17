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
});
