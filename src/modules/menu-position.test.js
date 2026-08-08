import { describe, it, expect } from "vitest";
import { clampMenuPosition, menuNeedsScroll, MENU_VIEWPORT_MARGIN } from "./menu-position.js";

describe("clampMenuPosition", () => {
  it("respeta la posición pedida cuando el menú cabe", () => {
    expect(clampMenuPosition(100, 80, 200, 300, 1200, 800)).toEqual({ left: 100, top: 80 });
  });

  it("desplaza el menú a la izquierda cuando se sale por la derecha", () => {
    const { left } = clampMenuPosition(1150, 80, 200, 300, 1200, 800);
    expect(left).toBe(1200 - 200 - MENU_VIEWPORT_MARGIN);
  });

  it("sube el menú cuando se sale por abajo", () => {
    const { top } = clampMenuPosition(100, 780, 200, 300, 1200, 800);
    expect(top).toBe(800 - 300 - MENU_VIEWPORT_MARGIN);
  });

  it("nunca coloca el menú por encima del margen aunque sea más alto que la ventana", () => {
    // Ventana de 400px con un menú de 600px: el clamp inferior daría top negativo
    // (el bug original: el menú quedaba cortado por arriba y por abajo a la vez).
    const { top } = clampMenuPosition(100, 350, 200, 600, 1200, 400);
    expect(top).toBe(MENU_VIEWPORT_MARGIN);
  });

  it("nunca coloca el menú fuera por la izquierda en ventanas muy estrechas", () => {
    const { left } = clampMenuPosition(10, 10, 250, 300, 200, 800);
    expect(left).toBe(MENU_VIEWPORT_MARGIN);
  });

  it("admite un margen personalizado", () => {
    expect(clampMenuPosition(0, 0, 100, 100, 500, 500, 12)).toEqual({ left: 12, top: 12 });
  });
});

describe("menuNeedsScroll", () => {
  it("no pide scroll cuando el menú cabe con sus márgenes", () => {
    expect(menuNeedsScroll(300, 800)).toBe(false);
    expect(menuNeedsScroll(788, 800)).toBe(false);
  });

  it("pide scroll cuando el menú más los márgenes desborda el viewport", () => {
    expect(menuNeedsScroll(789, 800)).toBe(true);
    expect(menuNeedsScroll(600, 400)).toBe(true);
  });
});
