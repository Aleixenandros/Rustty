import { describe, it, expect } from "vitest";
import { layoutToTree, paneDims, layoutSize } from "./layout-view.js";
import { leafIds } from "../panes/tree.js";

const id = (pane) => `conn-p${pane}`;

/** Layout real: 80x24 partido en 40 y 39 columnas (divisor de por medio). */
const SPLIT_H = {
  width: 80, height: 24, x: 0, y: 0, dir: "row",
  children: [
    { width: 40, height: 24, x: 0, y: 0, pane: 0 },
    { width: 39, height: 24, x: 41, y: 0, pane: 1 },
  ],
};

describe("layoutToTree", () => {
  it("una hoja es un leaf con el id lógico", () => {
    expect(layoutToTree({ width: 80, height: 24, x: 0, y: 0, pane: 3 }, id)).toEqual({
      type: "leaf",
      id: "conn-p3",
    });
  });

  it("un split lado a lado reparte ratios según las celdas", () => {
    const tree = layoutToTree(SPLIT_H, id);
    expect(tree.type).toBe("split");
    expect(tree.dir).toBe("row");
    expect(leafIds(tree)).toEqual(["conn-p0", "conn-p1"]);
    expect(tree.ratios[0]).toBeCloseTo(40 / 79);
    expect(tree.ratios[1]).toBeCloseTo(39 / 79);
  });

  it("anidamiento: columna dentro de fila conserva la estructura", () => {
    const nested = {
      width: 80, height: 24, x: 0, y: 0, dir: "row",
      children: [
        { width: 40, height: 24, x: 0, y: 0, pane: 0 },
        {
          width: 39, height: 24, x: 41, y: 0, dir: "column",
          children: [
            { width: 39, height: 12, x: 41, y: 0, pane: 1 },
            { width: 39, height: 11, x: 41, y: 13, pane: 2 },
          ],
        },
      ],
    };
    const tree = layoutToTree(nested, id);
    expect(leafIds(tree)).toEqual(["conn-p0", "conn-p1", "conn-p2"]);
    expect(tree.children[1].dir).toBe("column");
  });

  it("un nodo ilegible devuelve null, nunca un árbol a medias", () => {
    expect(layoutToTree(null, id)).toBeNull();
    expect(layoutToTree({ width: 80, height: 24, x: 0, y: 0 }, id)).toBeNull();
    expect(
      layoutToTree(
        { width: 80, height: 24, x: 0, y: 0, dir: "row", children: [{ x: 0, y: 0 }] },
        id
      )
    ).toBeNull();
  });
});

describe("paneDims", () => {
  it("devuelve las celdas exactas de cada pane", () => {
    const dims = paneDims(SPLIT_H);
    expect(dims.get(0)).toEqual({ cols: 40, rows: 24 });
    expect(dims.get(1)).toEqual({ cols: 39, rows: 24 });
  });
});

describe("layoutSize", () => {
  it("da el tamaño total de la ventana", () => {
    expect(layoutSize(SPLIT_H)).toEqual({ cols: 80, rows: 24 });
    expect(layoutSize(null)).toBeNull();
  });
});
