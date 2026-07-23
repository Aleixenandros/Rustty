// @ts-check
import { describe, it, expect } from "vitest";
import { formatTime, formatRelativeTimeShort } from "./datetime.js";

// Reloj fijo dentro de 2026 para las comparaciones de año.
const NOW = Date.parse("2026-06-15T12:00:00Z");

describe("formatTime", () => {
  it("devuelve «» para un valor falsy", () => {
    expect(formatTime(0, { now: NOW })).toBe("");
    // @ts-expect-error probando entradas defensivas
    expect(formatTime(null, { now: NOW })).toBe("");
    // @ts-expect-error probando entradas defensivas
    expect(formatTime(undefined, { now: NOW })).toBe("");
  });

  it("dentro del año en curso incluye la hora (lleva «:»)", () => {
    const secs = Date.parse("2026-03-10T09:45:00Z") / 1000;
    const out = formatTime(secs, { now: NOW, locale: "en-US" });
    // La rama de mismo año añade toLocaleTimeString → siempre lleva ':'.
    // No fijamos el texto exacto para no depender de la zona horaria del runner.
    expect(out).toMatch(/:/);
    expect(out).not.toBe("");
  });

  it("de otro año muestra solo la fecha (sin «:»)", () => {
    const secs = Date.parse("2015-03-10T09:45:00Z") / 1000;
    const out = formatTime(secs, { now: NOW, locale: "en-US" });
    // La rama de otro año es solo toLocaleDateString → nunca lleva ':'.
    expect(out).not.toMatch(/:/);
    expect(out).toContain("2015");
  });
});

describe("formatRelativeTimeShort", () => {
  // t de prueba: devuelve la clave, y le pega el número si viene param.
  const t = (key, params) => (params ? `${key}:${params.n}` : key);

  it("devuelve null para una fecha no parseable", () => {
    expect(formatRelativeTimeShort("no-es-fecha", t, { now: NOW })).toBeNull();
    expect(formatRelativeTimeShort("", t, { now: NOW })).toBeNull();
  });

  it("por debajo de un minuto es «ahora»", () => {
    const iso = new Date(NOW - 30_000).toISOString();
    expect(formatRelativeTimeShort(iso, t, { now: NOW })).toBe("time.now");
  });

  it("minutos, horas y días, con el número interpolado", () => {
    expect(formatRelativeTimeShort(new Date(NOW - 5 * 60_000).toISOString(), t, { now: NOW }))
      .toBe("time.minutes_ago:5");
    expect(formatRelativeTimeShort(new Date(NOW - 3 * 3600_000).toISOString(), t, { now: NOW }))
      .toBe("time.hours_ago:3");
    expect(formatRelativeTimeShort(new Date(NOW - 2 * 86_400_000).toISOString(), t, { now: NOW }))
      .toBe("time.days_ago:2");
  });

  it("respeta los umbrales exactos (59 min sigue en minutos, 60 pasa a horas)", () => {
    expect(formatRelativeTimeShort(new Date(NOW - 59 * 60_000).toISOString(), t, { now: NOW }))
      .toBe("time.minutes_ago:59");
    expect(formatRelativeTimeShort(new Date(NOW - 60 * 60_000).toISOString(), t, { now: NOW }))
      .toBe("time.hours_ago:1");
  });
});
