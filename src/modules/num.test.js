// @ts-check
import { describe, it, expect } from "vitest";
import { clampUiZoom } from "./num.js";

describe("clampUiZoom", () => {
  it("deja pasar los valores dentro del rango, redondeados a centésimas", () => {
    expect(clampUiZoom(1)).toBe(1);
    expect(clampUiZoom(1.25)).toBe(1.25);
    expect(clampUiZoom(1.234)).toBe(1.23);
    expect(clampUiZoom(0.876)).toBe(0.88);
  });

  it("acota a los extremos [0.6, 1.6]", () => {
    expect(clampUiZoom(0.1)).toBe(0.6);
    expect(clampUiZoom(5)).toBe(1.6);
    expect(clampUiZoom(0.6)).toBe(0.6);
    expect(clampUiZoom(1.6)).toBe(1.6);
  });

  it("cae al 1 neutro para valores no finitos", () => {
    expect(clampUiZoom(NaN)).toBe(1);
    expect(clampUiZoom(Infinity)).toBe(1);
    expect(clampUiZoom(-Infinity)).toBe(1);
  });
});
