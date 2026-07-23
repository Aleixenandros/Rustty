// @ts-check
import { describe, it, expect } from "vitest";
import { formatSize, formatDuration } from "./format.js";

describe("formatSize", () => {
  it("muestra bytes sin unidad de escala por debajo de 1 KiB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("escala por 1024 y da un decimal hasta 100 de la unidad", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("quita el decimal a partir de 100 de la unidad", () => {
    expect(formatSize(340 * 1024 * 1024)).toBe("340 MB");
    expect(formatSize(150 * 1024)).toBe("150 KB");
  });

  it("se queda en TB, la unidad mayor, sin desbordar", () => {
    expect(formatSize(5 * 1024 ** 4)).toBe("5.0 TB");
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048 TB");
  });
});

describe("formatDuration", () => {
  it("segundos por debajo de un minuto, redondeando hacia arriba", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(0.1)).toBe("1s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59.4)).toBe("60s");
  });

  it("minutos y segundos, y horas y minutos", () => {
    expect(formatDuration(60)).toBe("1m 0s");
    expect(formatDuration(200)).toBe("3m 20s");
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(7500)).toBe("2h 5m");
  });

  it("devuelve «?» para una ETA que aún no se puede estimar", () => {
    expect(formatDuration(-1)).toBe("?");
    expect(formatDuration(Infinity)).toBe("?");
    expect(formatDuration(NaN)).toBe("?");
  });
});
