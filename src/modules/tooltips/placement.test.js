import { describe, expect, it } from "vitest";
import { placeTooltip, preferredSide, tooltipTextFor } from "./placement.js";

describe("tooltipTextFor", () => {
  it("prefiere data-tooltip, luego title", () => {
    expect(tooltipTextFor({ tooltip: "Compuesto", title: "Título" })).toBe("Compuesto");
    expect(tooltipTextFor({ tooltip: "  ", title: "Título" })).toBe("Título");
  });

  it("usa el aria-label solo en controles de solo icono", () => {
    expect(tooltipTextFor({ ariaLabel: "Cerrar", tagName: "BUTTON", visibleText: "" })).toBe("Cerrar");
    expect(tooltipTextFor({ ariaLabel: "Cerrar", tagName: "SPAN", role: "button" })).toBe("Cerrar");
    expect(tooltipTextFor({ ariaLabel: "Sección", tagName: "SECTION" })).toBeNull();
    expect(tooltipTextFor({ ariaLabel: "Sección", tagName: "DIV", role: "region" })).toBeNull();
  });

  it("no repite el texto que el botón ya enseña", () => {
    expect(tooltipTextFor({ ariaLabel: "Guardar", tagName: "BUTTON", visibleText: "Guardar" })).toBeNull();
    expect(tooltipTextFor({ ariaLabel: "Guardar cambios", tagName: "BUTTON", visibleText: "Guardar cambios ya" })).toBeNull();
  });

  it("explica un botón cuyo texto es solo un valor corto", () => {
    expect(tooltipTextFor({ ariaLabel: "Túneles abiertos", tagName: "BUTTON", visibleText: "2" })).toBe("Túneles abiertos");
  });

  it("respeta data-no-tooltip y los valores vacíos", () => {
    expect(tooltipTextFor({ title: "Algo", optOut: true })).toBeNull();
    expect(tooltipTextFor({})).toBeNull();
    expect(tooltipTextFor({ title: null, tooltip: undefined })).toBeNull();
  });
});

describe("placeTooltip", () => {
  const viewport = { width: 1000, height: 800 };
  const tip = { width: 100, height: 24 };

  it("centra la burbuja encima del elemento", () => {
    const anchor = { left: 450, right: 550, top: 400, bottom: 420 };
    expect(placeTooltip({ anchor, tip, viewport })).toEqual({ left: 450, top: 370, side: "top" });
  });

  it("le da la vuelta abajo si arriba no cabe", () => {
    const anchor = { left: 450, right: 550, top: 4, bottom: 30 };
    expect(placeTooltip({ anchor, tip, viewport })).toMatchObject({ side: "bottom", top: 36 });
  });

  it("respeta el lado preferido y lo invierte si no cabe", () => {
    const anchor = { left: 0, right: 44, top: 300, bottom: 344 };
    expect(placeTooltip({ anchor, tip, viewport, prefer: "right" })).toMatchObject({ side: "right", left: 50, top: 310 });
    const atRight = { left: 950, right: 1000, top: 300, bottom: 344 };
    expect(placeTooltip({ anchor: atRight, tip, viewport, prefer: "right" })).toMatchObject({ side: "left", left: 844 });
  });

  it("no se sale por los lados", () => {
    const anchor = { left: 0, right: 20, top: 400, bottom: 420 };
    expect(placeTooltip({ anchor, tip, viewport }).left).toBe(6);
    const edge = { left: 980, right: 1000, top: 400, bottom: 420 };
    expect(placeTooltip({ anchor: edge, tip, viewport }).left).toBe(894);
  });

  it("en una ventana diminuta elige el lado con más sitio", () => {
    const small = { width: 300, height: 60 };
    const anchor = { left: 10, right: 40, top: 10, bottom: 50 };
    const placed = placeTooltip({ anchor, tip, viewport: small });
    expect(placed.side).toBe("right");
    expect(placed.top).toBeGreaterThanOrEqual(6);
  });
});

describe("preferredSide", () => {
  it("acepta los lados conocidos y cae arriba", () => {
    expect(preferredSide("right")).toBe("right");
    expect(preferredSide("bottom")).toBe("bottom");
    expect(preferredSide("diagonal")).toBe("top");
    expect(preferredSide(null)).toBe("top");
  });
});
