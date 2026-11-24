import { describe, it, expect } from "vitest";
import {
  visibleRange,
  filterEntries,
  selectionAfterClick,
  selectionForRowAction,
  selectionAfterRangeClick,
  selectionModifiers,
  pruneSelection,
  OVERSCAN,
  VIRTUAL_THRESHOLD,
  FALLBACK_ROW_HEIGHT,
} from "./list-view.js";

describe("visibleRange", () => {
  it("un listado vacío no pinta nada ni deja relleno", () => {
    expect(visibleRange({ scrollTop: 0, viewportHeight: 400, rowHeight: 28, total: 0 }))
      .toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("desde arriba pinta el viewport más el overscan de abajo", () => {
    const r = visibleRange({
      scrollTop: 0, viewportHeight: 280, rowHeight: 28, total: 10_000, overscan: 5,
    });
    expect(r.start).toBe(0);
    expect(r.end).toBe(10 + 5 * 2 + 1);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((10_000 - r.end) * 28);
  });

  it("a media lista deja arriba el hueco de las filas que no pinta", () => {
    const r = visibleRange({
      scrollTop: 28 * 500, viewportHeight: 280, rowHeight: 28, total: 10_000, overscan: 5,
    });
    expect(r.start).toBe(495);
    expect(r.padTop).toBe(495 * 28);
    expect(r.padTop + (r.end - r.start) * 28 + r.padBottom).toBe(10_000 * 28);
  });

  it("el relleno siempre suma la altura del listado entero", () => {
    for (const scrollTop of [0, 137, 4_000, 279_000, 999_999]) {
      const r = visibleRange({ scrollTop, viewportHeight: 333, rowHeight: 28, total: 10_000 });
      expect(r.padTop + (r.end - r.start) * 28 + r.padBottom).toBe(10_000 * 28);
    }
  });

  it("al final de la lista no se pasa del total ni deja relleno abajo", () => {
    const r = visibleRange({
      scrollTop: 28 * 10_000, viewportHeight: 280, rowHeight: 28, total: 10_000,
    });
    expect(r.end).toBe(10_000);
    expect(r.padBottom).toBe(0);
    expect(r.start).toBeLessThan(r.end);
  });

  it("un scroll negativo o absurdo se acota en vez de dar un rango inválido", () => {
    const r = visibleRange({ scrollTop: -500, viewportHeight: 280, rowHeight: 28, total: 100 });
    expect(r.start).toBe(0);
    expect(r.padTop).toBe(0);
  });

  it("sin altura de fila medible pinta el listado entero", () => {
    const r = visibleRange({ scrollTop: 0, viewportHeight: 0, rowHeight: 0, total: 42 });
    expect(r).toEqual({ start: 0, end: 42, padTop: 0, padBottom: 0 });
  });

  it("el overscan por defecto pinta de más por arriba y por abajo", () => {
    const r = visibleRange({ scrollTop: 28 * 100, viewportHeight: 280, rowHeight: 28, total: 1000 });
    expect(r.start).toBe(100 - OVERSCAN);
    expect(r.end).toBeGreaterThan(100 + 10 + OVERSCAN);
  });

  it("los topes están donde dice el contrato", () => {
    expect(VIRTUAL_THRESHOLD).toBeGreaterThan(0);
    expect(FALLBACK_ROW_HEIGHT).toBeGreaterThan(0);
  });
});

describe("filterEntries", () => {
  const entries = [
    { name: "README.md" }, { name: "informe.pdf" }, { name: "Fotos" }, { name: "notas.txt" },
  ];

  it("un término vacío devuelve el mismo array, sin copiarlo", () => {
    expect(filterEntries(entries, "")).toBe(entries);
    expect(filterEntries(entries, "   ")).toBe(entries);
  });

  it("filtra por subcadena sin distinguir mayúsculas", () => {
    expect(filterEntries(entries, "fot").map((e) => e.name)).toEqual(["Fotos"]);
    expect(filterEntries(entries, "ME").map((e) => e.name)).toEqual(["README.md", "informe.pdf"]);
  });

  it("sin coincidencias devuelve una lista vacía", () => {
    expect(filterEntries(entries, "zzz")).toEqual([]);
  });

  it("aguanta entradas sin nombre y una lista que no lo es", () => {
    expect(filterEntries([{}, { name: null }, { name: "ok" }], "ok").length).toBe(1);
    expect(filterEntries(/** @type {any} */ (null), "ok")).toEqual([]);
  });
});

describe("selección", () => {
  it("un clic sin modificador deja seleccionada solo esa fila", () => {
    expect([...selectionAfterClick(new Set(["a", "b"]), "c", false)]).toEqual(["c"]);
  });

  it("con modificador suma y resta", () => {
    expect([...selectionAfterClick(new Set(["a"]), "b", true)].sort()).toEqual(["a", "b"]);
    expect([...selectionAfterClick(new Set(["a", "b"]), "a", true)]).toEqual(["b"]);
  });

  it("un clic devuelve siempre un conjunto nuevo, sin tocar el anterior", () => {
    const before = new Set(["a"]);
    const after = selectionAfterClick(before, "b", true);
    expect(after).not.toBe(before);
    expect([...before]).toEqual(["a"]);
  });

  it("una acción sobre fila ya seleccionada respeta la selección múltiple", () => {
    const sel = new Set(["a", "b"]);
    expect(selectionForRowAction(sel, "a")).toBe(sel);
  });

  it("una acción sobre fila no seleccionada la deja como única", () => {
    expect([...selectionForRowAction(new Set(["a", "b"]), "c")]).toEqual(["c"]);
  });

  it("la poda deja fuera lo que ya no está en el listado", () => {
    expect([...pruneSelection(new Set(["a", "b", "c"]), ["b", "c", "d"])]).toEqual(["b", "c"]);
    expect([...pruneSelection(new Set(["a"]), new Set())]).toEqual([]);
  });
});

describe("selectionAfterRangeClick", () => {
  const keys = ["a", "b", "c", "d", "e"];
  it("selecciona el tramo entre el anclaje y la fila pulsada, en cualquier sentido", () => {
    expect([...selectionAfterRangeClick(new Set(["b"]), keys, "b", "d", false)]).toEqual(["b", "c", "d"]);
    expect([...selectionAfterRangeClick(new Set(["d"]), keys, "d", "a", false)]).toEqual(["a", "b", "c", "d"]);
  });
  it("sin modificador sustituye lo que había; con él, lo suma", () => {
    expect([...selectionAfterRangeClick(new Set(["e"]), keys, "a", "b", false)]).toEqual(["a", "b"]);
    expect([...selectionAfterRangeClick(new Set(["e"]), keys, "a", "b", true)].sort()).toEqual(["a", "b", "e"]);
  });
  it("sin anclaje (o si ya no está) es un clic normal", () => {
    expect([...selectionAfterRangeClick(new Set(["e"]), keys, null, "c", false)]).toEqual(["c"]);
    expect([...selectionAfterRangeClick(new Set(["e"]), keys, "zz", "c", true)].sort()).toEqual(["c", "e"]);
  });
  it("una fila que no está en el listado no cambia nada", () => {
    const sel = new Set(["a"]);
    expect(selectionAfterRangeClick(sel, keys, "a", "zz", false)).toBe(sel);
  });
});

describe("selectionModifiers", () => {
  it("Ctrl y Cmd suman o restan; Mayús hace tramo", () => {
    expect(selectionModifiers({ ctrlKey: true })).toEqual({ toggle: true, range: false, ignore: false });
    expect(selectionModifiers({ metaKey: true })).toEqual({ toggle: true, range: false, ignore: false });
    expect(selectionModifiers({ shiftKey: true })).toEqual({ toggle: false, range: true, ignore: false });
    expect(selectionModifiers({})).toEqual({ toggle: false, range: false, ignore: false });
  });
  it("Alt y AltGr no seleccionan: el clic se ignora", () => {
    expect(selectionModifiers({ altKey: true })).toEqual({ toggle: false, range: false, ignore: true });
    expect(selectionModifiers({ getModifierState: (k) => k === "AltGraph" }).ignore).toBe(true);
  });
});
