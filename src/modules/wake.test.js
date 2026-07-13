import { describe, it, expect } from "vitest";
import { detectedWake, staggerDelays } from "./wake.js";

const TICK = 15_000;
const THRESHOLD = 90_000;

describe("detectedWake", () => {
  it("un tick puntual no es una suspensión", () => {
    const last = 1_000_000;
    expect(detectedWake(last + TICK, last, TICK, THRESHOLD)).toBe(false);
  });

  it("un retraso pequeño (equipo cargado) no es una suspensión", () => {
    // Un timer que llega 5 s tarde por carga del sistema NO debe disparar el
    // aviso: un falso positivo aquí molesta al usuario con reconexiones.
    const last = 1_000_000;
    expect(detectedWake(last + TICK + 5_000, last, TICK, THRESHOLD)).toBe(false);
  });

  it("un tick que llega mucho más tarde delata que el equipo durmió", () => {
    const last = 1_000_000;
    // El portátil estuvo 40 minutos cerrado.
    expect(detectedWake(last + 40 * 60_000, last, TICK, THRESHOLD)).toBe(true);
  });

  it("el umbral es inclusivo", () => {
    const last = 1_000_000;
    expect(detectedWake(last + TICK + THRESHOLD, last, TICK, THRESHOLD)).toBe(true);
  });

  it("sin tick previo no se detecta nada (arranque)", () => {
    expect(detectedWake(Date.now(), 0, TICK, THRESHOLD)).toBe(false);
  });

  it("valores no finitos no rompen ni disparan falsos positivos", () => {
    expect(detectedWake(NaN, 1, TICK, THRESHOLD)).toBe(false);
    expect(detectedWake(1, NaN, TICK, THRESHOLD)).toBe(false);
  });
});

describe("staggerDelays", () => {
  it("la primera sesión reconecta ya y las demás se separan", () => {
    const delays = staggerDelays(4, 2000, 0, () => 0);
    expect(delays).toEqual([0, 2000, 4000, 6000]);
  });

  it("el jitter separa a dos equipos que despiertan a la vez", () => {
    // Con la misma secuencia de sesiones, dos fuentes de aleatoriedad distintas
    // dan retardos distintos: no coinciden en el mismo instante.
    const a = staggerDelays(3, 2000, 1000, () => 0.1);
    const b = staggerDelays(3, 2000, 1000, () => 0.9);
    expect(a).toEqual([100, 2100, 4100]);
    expect(b).toEqual([900, 2900, 4900]);
    expect(a).not.toEqual(b);
  });

  it("nunca devuelve retardos negativos ni rompe con entradas raras", () => {
    expect(staggerDelays(0, 2000, 500)).toEqual([]);
    expect(staggerDelays(-3, 2000, 500)).toEqual([]);
    expect(staggerDelays(2, -100, -100, () => 0)).toEqual([0, 0]);
  });
});
