import { describe, expect, it } from "vitest";
import { clampFrame, moveFrame, parseStoredFrame, resizeFrame } from "./frame-geometry.js";

const viewport = { width: 1200, height: 800 };
const limits = { minWidth: 400, minHeight: 300, margin: 8 };
const centered = { width: 800, height: 600, dx: 0, dy: 0 };

describe("clampFrame", () => {
  it("deja un marco que cabe tal cual", () => {
    expect(clampFrame(centered, viewport, limits)).toEqual(centered);
  });

  it("encoge lo que no cabe y respeta el mínimo", () => {
    expect(clampFrame({ width: 5000, height: 5000, dx: 0, dy: 0 }, viewport, limits))
      .toEqual({ width: 1184, height: 784, dx: 0, dy: 0 });
    expect(clampFrame({ width: 10, height: 10, dx: 0, dy: 0 }, viewport, limits))
      .toEqual({ width: 400, height: 300, dx: 0, dy: 0 });
  });

  it("devuelve a la vista un diálogo desplazado fuera", () => {
    expect(clampFrame({ ...centered, dx: 900, dy: -900 }, viewport, limits))
      .toEqual({ ...centered, dx: 192, dy: -92 });
  });

  it("en una ventana menor que el mínimo, ocupa lo que hay", () => {
    expect(clampFrame(centered, { width: 300, height: 200 }, limits))
      .toEqual({ width: 284, height: 184, dx: 0, dy: 0 });
  });
});

describe("moveFrame", () => {
  it("suma el desplazamiento y no deja salir el diálogo", () => {
    expect(moveFrame(centered, 50, -20, viewport, limits)).toEqual({ ...centered, dx: 50, dy: -20 });
    expect(moveFrame(centered, 1000, 1000, viewport, limits)).toEqual({ ...centered, dx: 192, dy: 92 });
  });
});

describe("resizeFrame", () => {
  it("por la derecha deja quieto el borde izquierdo", () => {
    const out = resizeFrame(centered, "e", 100, 0, viewport, limits);
    expect(out).toEqual({ width: 900, height: 600, dx: 50, dy: 0 });
    // Borde izquierdo: antes -400, después 50 - 450 = -400.
    expect(out.dx - out.width / 2).toBe(-400);
  });

  it("por la izquierda deja quieto el borde derecho", () => {
    const out = resizeFrame(centered, "w", -100, 0, viewport, limits);
    expect(out).toEqual({ width: 900, height: 600, dx: -50, dy: 0 });
    expect(out.dx + out.width / 2).toBe(400);
  });

  it("en esquina cambia los dos ejes", () => {
    expect(resizeFrame(centered, "se", 40, 60, viewport, limits))
      .toEqual({ width: 840, height: 660, dx: 20, dy: 30 });
    expect(resizeFrame(centered, "nw", 40, 60, viewport, limits))
      .toEqual({ width: 760, height: 540, dx: 20, dy: 30 });
  });

  it("no baja del mínimo ni pasa del borde de la ventana", () => {
    const small = resizeFrame(centered, "e", -1000, 0, viewport, limits);
    expect(small.width).toBe(400);
    expect(small.dx - small.width / 2).toBe(-400);
    const big = resizeFrame(centered, "s", 0, 1000, viewport, limits);
    expect(big.dy + big.height / 2).toBe(392);
    expect(big.dy - big.height / 2).toBe(-300);
  });
});

describe("parseStoredFrame", () => {
  it("acepta un marco válido, en objeto o en JSON", () => {
    expect(parseStoredFrame(centered)).toEqual(centered);
    expect(parseStoredFrame(JSON.stringify(centered))).toEqual(centered);
  });

  it("descarta lo que no es un marco", () => {
    expect(parseStoredFrame(null)).toBeNull();
    expect(parseStoredFrame("{roto")).toBeNull();
    expect(parseStoredFrame({ width: "800", height: 600, dx: 0, dy: 0 })).toBeNull();
    expect(parseStoredFrame({ width: 800, height: 600, dx: Number.NaN, dy: 0 })).toBeNull();
    expect(parseStoredFrame({ width: 10, height: 600, dx: 0, dy: 0 })).toBeNull();
  });
});
