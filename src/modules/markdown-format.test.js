import { describe, expect, it } from "vitest";
import { applyFormatEdit, markdownFormatEdit, MARKDOWN_FORMATS } from "./markdown-format.js";

const PH = { bold: "negrita", italic: "cursiva", code: "codigo", link: "texto", heading: "Título", item: "elemento", task: "tarea", quote: "cita" };

/**
 * Aplica la acción y devuelve el texto resultante y lo seleccionado.
 * @param {string} value
 * @param {number} s
 * @param {number} e
 * @param {string} action
 */
function run(value, s, e, action) {
  const edit = markdownFormatEdit(value, s, e, action, PH);
  if (!edit) return null;
  const out = applyFormatEdit(value, edit);
  return { out, sel: out.slice(edit.selStart, edit.selEnd), edit };
}

describe("markdownFormatEdit · en línea", () => {
  it("envuelve la selección en negrita y la deja seleccionada", () => {
    const r = run("hola mundo", 5, 10, "bold");
    expect(r.out).toBe("hola **mundo**");
    expect(r.sel).toBe("mundo");
  });

  it("sin selección inserta el texto de ejemplo seleccionado", () => {
    const r = run("ab", 1, 1, "italic");
    expect(r.out).toBe("a*cursiva*b");
    expect(r.sel).toBe("cursiva");
  });

  it("quitar la negrita si ya la tiene", () => {
    const r = run("hola **mundo**", 7, 12, "bold");
    expect(r.out).toBe("hola mundo");
    expect(r.sel).toBe("mundo");
  });

  it("la cursiva sobre una negrita la suma, no la confunde", () => {
    expect(run("**x**", 2, 3, "italic").out).toBe("***x***");
    expect(run("***x***", 3, 4, "italic").out).toBe("**x**");
    expect(run("***x***", 3, 4, "bold").out).toBe("*x*");
    expect(run("*x*", 1, 2, "bold").out).toBe("***x***");
  });

  it("código en línea: pone y quita", () => {
    expect(run("ls -la", 0, 6, "code").out).toBe("`ls -la`");
    expect(run("`ls -la`", 1, 7, "code").out).toBe("ls -la");
  });

  it("enlace con texto: deja seleccionada la dirección", () => {
    const r = run("ver docs", 4, 8, "link");
    expect(r.out).toBe("ver [docs](https://)");
    expect(r.sel).toBe("https://");
  });

  it("enlace sobre una dirección: la usa de destino", () => {
    const r = run("https://rustty.es", 0, 17, "link");
    expect(r.out).toBe("[texto](https://rustty.es)");
    expect(r.sel).toBe("texto");
  });
});

describe("markdownFormatEdit · de línea", () => {
  it("encabezado con el cursor a mitad de línea marca la línea entera", () => {
    const r = run("uno\ndos tres\ncuatro", 6, 6, "h");
    expect(r.out).toBe("uno\n## dos tres\ncuatro");
    // El cursor queda al final de la línea.
    expect(r.edit.selStart).toBe("uno\n## dos tres".length);
  });

  it("lista sobre varias líneas, saltando las vacías", () => {
    const r = run("a\n\nb", 0, 4, "ul");
    expect(r.out).toBe("- a\n\n- b");
    expect(r.sel).toBe("- a\n\n- b");
  });

  it("numerada cuenta solo las líneas con texto", () => {
    expect(run("a\nb\n\nc", 0, 6, "ol").out).toBe("1. a\n2. b\n\n3. c");
  });

  it("si todas las líneas ya lo tienen, lo quita", () => {
    expect(run("- a\n- b", 0, 7, "ul").out).toBe("a\nb");
    expect(run("## Título", 3, 3, "h").out).toBe("Título");
    expect(run("> a\n> b", 0, 7, "quote").out).toBe("a\nb");
  });

  it("cambia una marca de lista por otra en vez de apilarlas", () => {
    expect(run("- a", 0, 3, "task").out).toBe("- [ ] a");
    expect(run("- [x] a", 0, 7, "ul").out).toBe("- a");
    expect(run("1. a", 0, 4, "ul").out).toBe("- a");
    expect(run("### a", 0, 5, "h").out).toBe("## a");
  });

  it("la cita respeta la lista de dentro", () => {
    expect(run("- a", 0, 3, "quote").out).toBe("> - a");
  });

  it("una casilla no cuenta como lista simple", () => {
    // Pedir lista sobre una casilla la convierte, no la quita.
    expect(run("- [ ] a", 0, 7, "ul").out).toBe("- a");
  });

  it("línea vacía: marca y texto de ejemplo seleccionado", () => {
    const r = run("a\n", 2, 2, "task");
    expect(r.out).toBe("a\n- [ ] tarea");
    expect(r.sel).toBe("tarea");
  });

  it("una selección que acaba al principio de una línea no la incluye", () => {
    expect(run("a\nb\nc", 0, 4, "ul").out).toBe("- a\n- b\nc");
  });
});

describe("markdownFormatEdit · bloque de código", () => {
  it("cerca las líneas seleccionadas", () => {
    const r = run("x\nls\npwd\ny", 2, 8, "codeblock");
    expect(r.out).toBe("x\n```\nls\npwd\n```\ny");
    expect(r.sel).toBe("ls\npwd");
  });

  it("a mitad de línea abre línea nueva antes y después", () => {
    const r = run("abcd", 2, 2, "codeblock");
    expect(r.out).toBe("ab\n```\ncodigo\n```\ncd");
    expect(r.sel).toBe("codigo");
  });
});

describe("markdownFormatEdit · límites", () => {
  it("acción desconocida → null", () => {
    expect(markdownFormatEdit("a", 0, 1, "nada")).toBeNull();
  });

  it("selección invertida o fuera de rango se normaliza", () => {
    expect(run("hola", 4, 0, "bold").out).toBe("**hola**");
    expect(run("hola", 0, 99, "code").out).toBe("`hola`");
  });

  it("todas las acciones publicadas producen una edición", () => {
    for (const a of MARKDOWN_FORMATS) {
      expect(markdownFormatEdit("texto", 0, 5, a, PH)).not.toBeNull();
    }
  });
});
