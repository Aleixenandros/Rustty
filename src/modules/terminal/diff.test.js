// @ts-check
import { describe, it, expect } from "vitest";
import { diffLines, splitDiffLines, pairDiffRows, diffToUnifiedText } from "./diff.js";

const types = (result) => result.rows.map((r) => `${r.type[0]}:${r.text}`);

describe("splitDiffLines", () => {
  it("un texto vacío no tiene líneas", () => {
    expect(splitDiffLines("")).toEqual([]);
    expect(splitDiffLines("\n\n")).toEqual([]);
  });

  it("normaliza CRLF y come el salto final", () => {
    expect(splitDiffLines("a\r\nb\n")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("dos salidas idénticas no tienen cambios", () => {
    const r = diffLines("a\nb\nc", "a\nb\nc");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.unchanged).toBe(3);
  });

  it("detecta línea cambiada conservando el contexto", () => {
    const r = diffLines("a\nb\nc", "a\nB\nc");
    expect(types(r)).toEqual(["s:a", "d:b", "a:B", "s:c"]);
    expect([r.added, r.removed]).toEqual([1, 1]);
  });

  it("numera las líneas de cada lado por separado", () => {
    const r = diffLines("a\nb", "a\nx\nb");
    expect(r.rows.map((row) => [row.type, row.leftLine, row.rightLine])).toEqual([
      ["same", 1, 1],
      ["add", null, 2],
      ["same", 2, 3],
    ]);
  });

  it("un lado vacío es todo adición o todo eliminación", () => {
    expect(types(diffLines("", "a\nb"))).toEqual(["a:a", "a:b"]);
    expect(types(diffLines("a\nb", ""))).toEqual(["d:a", "d:b"]);
  });

  it("el recorte de prefijo/sufijo común no se come líneas repetidas", () => {
    const r = diffLines("x\nx\nx", "x\nx");
    expect(r.removed).toBe(1);
    expect(r.unchanged).toBe(2);
  });

  it("un centro enorme degrada a sustitución en bloque y lo avisa", () => {
    const left = ["cabecera", ...Array.from({ length: 40 }, (_, i) => `l${i}`), "pie"].join("\n");
    const right = ["cabecera", ...Array.from({ length: 40 }, (_, i) => `r${i}`), "pie"].join("\n");
    const r = diffLines(left, right, { maxCells: 100 });
    expect(r.truncated).toBe(true);
    expect(r.removed).toBe(40);
    expect(r.added).toBe(40);
    // El prefijo y el sufijo comunes se conservan aunque el centro degrade.
    expect(r.rows[0]).toMatchObject({ type: "same", text: "cabecera" });
    expect(r.rows.at(-1)).toMatchObject({ type: "same", text: "pie" });
  });

  it("no degrada cuando el centro cabe en el presupuesto", () => {
    const r = diffLines("a\nb\nc", "a\nx\nc", { maxCells: 100 });
    expect(r.truncated).toBe(false);
  });
});

describe("pairDiffRows", () => {
  it("empareja el bloque eliminado con el añadido en la misma fila", () => {
    const r = diffLines("a\nb\nc", "a\nB\nc");
    const pairs = pairDiffRows(r.rows);
    expect(pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", "c"],
    ]);
  });

  it("bloques de distinto tamaño dejan hueco en el lado corto", () => {
    const r = diffLines("a\nb", "A\nB\nC");
    const pairs = pairDiffRows(r.rows);
    expect(pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null])).toEqual([
      ["a", "A"],
      ["b", "B"],
      [null, "C"],
    ]);
  });
});

describe("diffToUnifiedText", () => {
  it("marca cada línea con su signo y cabeceras opcionales", () => {
    const text = diffToUnifiedText(diffLines("a\nb", "a\nc"), {
      leftLabel: "antes",
      rightLabel: "después",
    });
    expect(text).toBe("--- antes\n+++ después\n a\n-b\n+c\n");
  });
});
