// @ts-check
import { describe, it, expect } from "vitest";
import {
  formatBytesPerSec,
  formatKib,
  usagePct,
  summaryDisk,
  sparklinePath,
  pushHistory,
} from "./metrics-view.js";

describe("formatBytesPerSec", () => {
  it("formatea la tasa con sufijo /s", () => {
    expect(formatBytesPerSec(0)).toBe("0 B/s");
    expect(formatBytesPerSec(1536)).toBe("1.5 KB/s");
    expect(formatBytesPerSec(1024 * 1024)).toBe("1.0 MB/s");
  });

  it("devuelve «—» sin tasa (primera muestra) o valor inválido", () => {
    expect(formatBytesPerSec(null)).toBe("—");
    expect(formatBytesPerSec(undefined)).toBe("—");
    expect(formatBytesPerSec(-1)).toBe("—");
    expect(formatBytesPerSec(NaN)).toBe("—");
  });
});

describe("formatKib", () => {
  it("interpreta la entrada como kiB", () => {
    expect(formatKib(1024)).toBe("1.0 MB"); // 1024 kiB = 1 MiB
    expect(formatKib(0)).toBe("0 B");
  });
});

describe("usagePct", () => {
  it("da el porcentaje acotado con un decimal", () => {
    expect(usagePct(50, 100)).toBe(50);
    expect(usagePct(1, 3)).toBe(33.3);
    expect(usagePct(200, 100)).toBe(100);
  });

  it("0 si el total no es válido", () => {
    expect(usagePct(5, 0)).toBe(0);
    expect(usagePct(5, -1)).toBe(0);
    expect(usagePct(5, NaN)).toBe(0);
  });
});

describe("summaryDisk", () => {
  const disk = (mount, usedKb, sizeKb) => ({ mount, usedKb, sizeKb });

  it("prefiere el montado en /", () => {
    const disks = [disk("/boot", 90, 100), disk("/", 10, 100)];
    expect(summaryDisk(disks)?.mount).toBe("/");
  });

  it("sin /, elige el más lleno", () => {
    const disks = [disk("/a", 10, 100), disk("/b", 80, 100), disk("/c", 50, 100)];
    expect(summaryDisk(disks)?.mount).toBe("/b");
  });

  it("null si no hay discos", () => {
    expect(summaryDisk([])).toBeNull();
    expect(summaryDisk(undefined)).toBeNull();
  });
});

describe("sparklinePath", () => {
  it("«» con menos de dos puntos", () => {
    expect(sparklinePath([], 100, 20)).toBe("");
    expect(sparklinePath([5], 100, 20)).toBe("");
  });

  it("normaliza al máximo y encaja en el alto (Y hacia abajo)", () => {
    // [0, max] en ancho 100, alto 20 → sube de abajo (y=20) a arriba (y=0).
    const d = sparklinePath([0, 10], 100, 20);
    expect(d).toBe("M0.00,20.00 L100.00,0.00");
  });

  it("todo ceros → línea plana abajo", () => {
    expect(sparklinePath([0, 0, 0], 100, 20)).toBe("M0.00,20.00 L50.00,20.00 L100.00,20.00");
  });
});

describe("pushHistory", () => {
  it("añade sin mutar la entrada", () => {
    const a = [1, 2];
    const b = pushHistory(a, 3, 10);
    expect(b).toEqual([1, 2, 3]);
    expect(a).toEqual([1, 2]); // intacto
  });

  it("descarta los más viejos al superar el tope", () => {
    expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushHistory([], 1, 3)).toEqual([1]);
  });
});
