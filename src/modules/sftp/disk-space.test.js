// @ts-check
import { describe, expect, it } from "vitest";
import { diskLevel, diskUsage, diskUsageLabels, DISK_FULL_PERCENT, DISK_WARN_PERCENT } from "./disk-space.js";

const GIB = 1024 ** 3;

describe("diskUsage", () => {
  it("da lo disponible para el usuario y la ocupación como df", () => {
    // 100 GiB, 40 libres, 35 para el usuario (5 de reserva de root).
    const usage = diskUsage({ total: 100 * GIB, free: 40 * GIB, available: 35 * GIB });
    expect(usage).toEqual({
      total: 100 * GIB,
      available: 35 * GIB,
      used: 60 * GIB,
      // 60 / (60 + 35) = 63,2 % → 64, redondeado hacia arriba como df.
      usedPercent: 64,
      level: "ok",
    });
  });

  it("redondea hacia arriba: un disco casi vacío no dice 0 % si tiene algo", () => {
    expect(diskUsage({ total: 1000, free: 999, available: 999 })?.usedPercent).toBe(1);
    expect(diskUsage({ total: 1000, free: 1000, available: 1000 })?.usedPercent).toBe(0);
  });

  it("un disco lleno marca 100 % aunque quede la reserva de root", () => {
    const usage = diskUsage({ total: 1000, free: 50, available: 0 });
    expect(usage?.usedPercent).toBe(100);
    expect(usage?.available).toBe(0);
    expect(usage?.level).toBe("full");
  });

  it("sin nada usado ni disponible, para el usuario está lleno", () => {
    expect(diskUsage({ total: 1000, free: 1000, available: 0 })?.usedPercent).toBe(100);
  });

  it("sin dato no hay indicador", () => {
    expect(diskUsage(null)).toBeNull();
    expect(diskUsage(undefined)).toBeNull();
    expect(diskUsage("12 GB")).toBeNull();
    expect(diskUsage({})).toBeNull();
    expect(diskUsage({ total: 0, free: 0, available: 0 })).toBeNull();
  });

  it("no se fía de contadores imposibles del servidor", () => {
    expect(diskUsage({ total: 1000, free: -1, available: 10 })).toBeNull();
    expect(diskUsage({ total: Infinity, free: 1, available: 1 })).toBeNull();
    expect(diskUsage({ total: NaN, free: 1, available: 1 })).toBeNull();
    expect(diskUsage({ total: "1000", free: 10, available: 10 })).toBeNull();
    // Más libre que total, o más disponible que libre: se acotan.
    expect(diskUsage({ total: 1000, free: 5000, available: 9000 })).toMatchObject({
      available: 1000,
      used: 0,
      usedPercent: 0,
    });
    expect(diskUsage({ total: 1000, free: 100, available: 900 })).toMatchObject({
      available: 100,
      used: 900,
      usedPercent: 90,
    });
  });
});

describe("diskLevel", () => {
  it("avisa y alarma a partir de sus umbrales", () => {
    expect(diskLevel(0)).toBe("ok");
    expect(diskLevel(DISK_WARN_PERCENT - 1)).toBe("ok");
    expect(diskLevel(DISK_WARN_PERCENT)).toBe("warn");
    expect(diskLevel(DISK_FULL_PERCENT - 1)).toBe("warn");
    expect(diskLevel(DISK_FULL_PERCENT)).toBe("full");
    expect(diskLevel(100)).toBe("full");
  });
});

describe("diskUsageLabels", () => {
  it("formatea con las mismas unidades que la columna de tamaño", () => {
    const usage = diskUsage({ total: 500 * GIB, free: 123.4 * GIB, available: 12.34 * GIB });
    expect(usage).not.toBeNull();
    if (!usage) return;
    expect(diskUsageLabels(usage)).toEqual({ free: "12.3 GB", total: "500 GB", percent: "97" });
  });

  it("vale para discos pequeños y para muy grandes", () => {
    const small = diskUsage({ total: 2048, free: 512, available: 512 });
    const huge = diskUsage({ total: 8 * 1024 * 1024 * GIB, free: 1024 * GIB, available: 1024 * GIB });
    expect(small && diskUsageLabels(small)).toEqual({ free: "512 B", total: "2.0 KB", percent: "75" });
    expect(huge && diskUsageLabels(huge)).toEqual({ free: "1.0 TB", total: "8192 TB", percent: "100" });
  });
});
