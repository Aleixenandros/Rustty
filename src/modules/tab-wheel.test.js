import { describe, expect, it } from "vitest";
import { TAB_WHEEL_LINE_PX, normalizeTabWheel, tabWheelAction } from "./tab-wheel.js";

describe("normalizeTabWheel", () => {
  it("acepta los tres modos y cae a «scroll» con cualquier otra cosa", () => {
    expect(normalizeTabWheel("scroll")).toBe("scroll");
    expect(normalizeTabWheel("switch")).toBe("switch");
    expect(normalizeTabWheel("off")).toBe("off");
    expect(normalizeTabWheel(undefined)).toBe("scroll");
    expect(normalizeTabWheel("")).toBe("scroll");
    expect(normalizeTabWheel(42)).toBe("scroll");
  });
});

describe("tabWheelAction", () => {
  const over = { mode: "scroll", overflowing: true };

  it("desplaza la tira en píxeles con la rueda (deltaMode 0)", () => {
    expect(tabWheelAction({ deltaY: 40, deltaMode: 0 }, over)).toEqual({ type: "scroll", px: 40 });
    expect(tabWheelAction({ deltaY: -15, deltaMode: 0 }, over)).toEqual({ type: "scroll", px: -15 });
  });

  it("convierte las líneas de la rueda clásica a píxeles", () => {
    expect(tabWheelAction({ deltaY: 3, deltaMode: 1 }, over)).toEqual({ type: "scroll", px: 3 * TAB_WHEEL_LINE_PX });
  });

  it("no hace nada si la tira no desborda", () => {
    expect(tabWheelAction({ deltaY: 40 }, { mode: "scroll", overflowing: false })).toBeNull();
  });

  it("respeta Ctrl/Cmd+rueda (zoom del terminal) y los gestos horizontales", () => {
    expect(tabWheelAction({ deltaY: 40, ctrlKey: true }, over)).toBeNull();
    expect(tabWheelAction({ deltaY: 40, metaKey: true }, over)).toBeNull();
    expect(tabWheelAction({ deltaX: 50, deltaY: 10 }, over)).toBeNull();
    expect(tabWheelAction({ deltaY: 0 }, over)).toBeNull();
  });

  it("en modo «switch» cambia una pestaña por muesca, aunque la tira no desborde", () => {
    const sw = { mode: "switch", overflowing: false };
    expect(tabWheelAction({ deltaY: 100 }, sw)).toEqual({ type: "switch", delta: 1 });
    expect(tabWheelAction({ deltaY: -1 }, sw)).toEqual({ type: "switch", delta: -1 });
    expect(tabWheelAction({ deltaY: 100, ctrlKey: true }, sw)).toBeNull();
  });

  it("en modo «off» no hace nunca nada", () => {
    expect(tabWheelAction({ deltaY: 100 }, { mode: "off", overflowing: true })).toBeNull();
  });
});
