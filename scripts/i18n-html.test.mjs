import { describe, it, expect } from "vitest";
import { untranslatedHtmlTexts } from "./i18n-html.mjs";

/** Solo los textos, para comparar sin depender de las líneas. */
const texts = (html) => untranslatedHtmlTexts(html).map((f) => `${f.context}|${f.text}`);

describe("untranslatedHtmlTexts", () => {
  it("da el texto entre etiquetas que no lleva data-i18n", () => {
    expect(texts('<p class="kicker">Acceso rápido</p>')).toEqual(["texto|Acceso rápido"]);
    expect(texts('<p data-i18n="dashboard.quick_title">Acceso rápido</p>')).toEqual([]);
  });

  it("un data-i18n, data-i18n-html o translate=\"no\" cubre también a los descendientes", () => {
    expect(texts('<button data-i18n="a.b"><span>Hola</span></button>')).toEqual([]);
    expect(texts('<div data-i18n-html="a.b"><strong>Hola</strong> mundo</div>')).toEqual([]);
    expect(texts('<dd translate="no">Apache-2.0</dd>')).toEqual([]);
  });

  it("cierra bien los elementos: el hermano de uno traducido sí cuenta", () => {
    expect(texts('<p data-i18n="a.b">Uno</p><p>Dos</p>')).toEqual(["texto|Dos"]);
    // Un elemento vacío (`<input>`) no se queda abierto en la pila.
    expect(texts('<label><input type="checkbox" /> Guardar</label><span data-i18n="x.y">Z</span>'))
      .toEqual(["texto|Guardar"]);
  });

  it("exige a cada atributo visible su propio data-i18n-*", () => {
    expect(texts('<button title="Cerrar"></button>')).toEqual(["attr title=|Cerrar"]);
    expect(texts('<button data-i18n-title="window.close" title="Cerrar"></button>')).toEqual([]);
    // `data-i18n-title` NO traduce el `aria-label`: era el fallo de los 31 botones.
    expect(texts('<button data-i18n-title="window.close" title="Cerrar" aria-label="Cerrar"></button>'))
      .toEqual(["attr aria-label=|Cerrar"]);
    expect(texts('<button data-i18n-title="w.c" aria-label="Cerrar" data-i18n-aria-label="w.c"></button>'))
      .toEqual([]);
    expect(texts('<input placeholder="Buscar…" />')).toEqual(["attr placeholder=|Buscar…"]);
    expect(texts('<button data-tooltip="Historial" data-tooltip-pos="right"></button>'))
      .toEqual(["attr data-tooltip=|Historial"]);
  });

  it("no mira comentarios, scripts ni estilos, y decodifica las entidades", () => {
    expect(texts("<!-- Texto de un comentario --><script>const a = '<b>no</b>';</script><style>p{}</style>"))
      .toEqual([]);
    expect(texts("<p>Copiar &amp; pegar&hellip;</p>")).toEqual(["texto|Copiar & pegar…"]);
  });

  it("apunta a la línea del texto o del atributo", () => {
    const found = untranslatedHtmlTexts('<div>\n  <button\n    title="Cerrar">\n    Hola\n  </button>\n</div>');
    expect(found).toEqual([
      { line: 3, context: "attr title=", text: "Cerrar" },
      { line: 4, context: "texto", text: "Hola" },
    ]);
  });
});
