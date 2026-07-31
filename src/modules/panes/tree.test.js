// @ts-check
import { describe, it, expect } from "vitest";
import {
  leaf,
  leafIds,
  normalizeRatios,
  splitLeaf,
  removeLeaf,
  nextLeaf,
  pathToLeaf,
  setRatiosAt,
  normalizeTree,
} from "./tree.js";

describe("splitLeaf", () => {
  it("una hoja sola se convierte en un split 50/50", () => {
    const tree = splitLeaf(leaf("a"), "a", "row", "b");
    expect(tree).toEqual({
      type: "split",
      dir: "row",
      ratios: [0.5, 0.5],
      children: [leaf("a"), leaf("b")],
    });
  });

  it("dividir en la misma dirección inserta una hermana, sin anidar", () => {
    const base = splitLeaf(leaf("a"), "a", "row", "b");
    const tree = splitLeaf(base, "a", "row", "c");
    expect(tree).toEqual({
      type: "split",
      dir: "row",
      ratios: [0.25, 0.25, 0.5],
      children: [leaf("a"), leaf("c"), leaf("b")],
    });
  });

  it("dividir en la otra dirección anida un split nuevo", () => {
    const base = splitLeaf(leaf("a"), "a", "row", "b");
    const tree = splitLeaf(base, "b", "column", "c");
    expect(tree).toEqual({
      type: "split",
      dir: "row",
      ratios: [0.5, 0.5],
      children: [
        leaf("a"),
        { type: "split", dir: "column", ratios: [0.5, 0.5], children: [leaf("b"), leaf("c")] },
      ],
    });
  });

  it("no muta el árbol original y comparte lo no tocado", () => {
    const base = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c");
    const before = JSON.parse(JSON.stringify(base));
    const tree = splitLeaf(base, "c", "column", "d");
    expect(base).toEqual(before);
    // La rama izquierda no cambió: misma referencia.
    expect(/** @type {any} */ (tree).children[0]).toBe(/** @type {any} */ (base).children[0]);
  });

  it("id inexistente o árbol vacío: sin cambios", () => {
    const base = splitLeaf(leaf("a"), "a", "row", "b");
    expect(splitLeaf(base, "zz", "row", "c")).toBe(base);
    expect(splitLeaf(null, "a", "row", "b")).toBe(null);
  });
});

describe("removeLeaf", () => {
  it("un split que queda con un hijo colapsa a ese hijo", () => {
    const base = splitLeaf(leaf("a"), "a", "row", "b");
    expect(removeLeaf(base, "b")).toEqual(leaf("a"));
  });

  it("con tres hermanas reparte los ratios restantes", () => {
    const base = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "a", "row", "c");
    const tree = removeLeaf(base, "c");
    expect(tree).toEqual({
      type: "split",
      dir: "row",
      ratios: [1 / 3, 2 / 3],
      children: [leaf("a"), leaf("b")],
    });
  });

  it("el colapso fusiona un split anidado de la misma dirección", () => {
    // row[a, column[b, row[c, d]]] — quitar b deja row[c,d] dentro de un row.
    let tree = splitLeaf(leaf("a"), "a", "row", "b");
    tree = splitLeaf(tree, "b", "column", "c");
    tree = splitLeaf(tree, "c", "row", "d");
    const after = removeLeaf(tree, "b");
    expect(after).toEqual({
      type: "split",
      dir: "row",
      ratios: [0.5, 0.25, 0.25],
      children: [leaf("a"), leaf("c"), leaf("d")],
    });
  });

  it("última hoja → null; id inexistente → sin cambios", () => {
    const base = splitLeaf(leaf("a"), "a", "row", "b");
    expect(removeLeaf(leaf("a"), "a")).toBe(null);
    expect(removeLeaf(base, "zz")).toBe(base);
    expect(removeLeaf(null, "a")).toBe(null);
  });
});

describe("nextLeaf y pathToLeaf", () => {
  const tree = splitLeaf(splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c"), "c", "row", "d");
  // row[a, column[b, row[c, d]]]

  it("recorre las hojas en orden de lectura con vuelta circular", () => {
    expect(leafIds(tree)).toEqual(["a", "b", "c", "d"]);
    expect(nextLeaf(tree, "a")).toBe("b");
    expect(nextLeaf(tree, "d")).toBe("a");
    expect(nextLeaf(tree, "a", -1)).toBe("d");
    expect(nextLeaf(tree, "zz")).toBe("a");
    expect(nextLeaf(null, "a")).toBe(null);
  });

  it("pathToLeaf da el camino de índices hasta la hoja", () => {
    expect(pathToLeaf(tree, "a")).toEqual([0]);
    expect(pathToLeaf(tree, "c")).toEqual([1, 1, 0]);
    expect(pathToLeaf(leaf("solo"), "solo")).toEqual([]);
    expect(pathToLeaf(tree, "zz")).toBe(null);
  });
});

describe("ratios", () => {
  it("normalizeRatios reescala y cae a uniforme ante entrada inválida", () => {
    expect(normalizeRatios([2, 2], 2)).toEqual([0.5, 0.5]);
    expect(normalizeRatios([1, 3], 2)).toEqual([0.25, 0.75]);
    expect(normalizeRatios([1, 0], 2)).toEqual([0.5, 0.5]);
    expect(normalizeRatios(undefined, 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(normalizeRatios([1, 2, 3], 2)).toEqual([0.5, 0.5]);
    expect(normalizeRatios([1], 0)).toEqual([]);
  });

  it("setRatiosAt actualiza el split del camino sin tocar el resto", () => {
    const base = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c");
    const tree = setRatiosAt(base, [1], [3, 1]);
    expect(tree).toEqual({
      type: "split",
      dir: "row",
      ratios: [0.5, 0.5],
      children: [
        leaf("a"),
        { type: "split", dir: "column", ratios: [0.75, 0.25], children: [leaf("b"), leaf("c")] },
      ],
    });
    // Raíz con camino vacío; camino inválido → sin cambios.
    expect(/** @type {any} */ (setRatiosAt(base, [], [1, 4])).ratios).toEqual([0.2, 0.8]);
    expect(setRatiosAt(base, [7], [1, 1])).toBe(base);
  });
});

describe("normalizeTree", () => {
  it("repara un árbol externo: colapsos, fusiones y ratios", () => {
    /** @type {any} */
    const dirty = {
      type: "split",
      dir: "row",
      ratios: [1, 1],
      children: [
        // Split de un solo hijo → colapsa a la hoja.
        { type: "split", dir: "column", ratios: [1], children: [leaf("a")] },
        // Split anidado de la misma dirección → se fusiona.
        {
          type: "split",
          dir: "row",
          ratios: [0.5, 0.5],
          children: [leaf("b"), leaf("c")],
        },
      ],
    };
    expect(normalizeTree(dirty)).toEqual({
      type: "split",
      dir: "row",
      ratios: [0.5, 0.25, 0.25],
      children: [leaf("a"), leaf("b"), leaf("c")],
    });
  });

  it("hoja y vacío pasan tal cual", () => {
    expect(normalizeTree(leaf("a"))).toEqual(leaf("a"));
    expect(normalizeTree(null)).toBe(null);
  });
});
