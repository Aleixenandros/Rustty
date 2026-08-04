// @ts-check
import { describe, expect, it } from "vitest";
import { tabIndexForKey } from "./tab-navigation.js";

describe("tabIndexForKey", () => {
  it("avanza y retrocede con vuelta circular", () => {
    expect(tabIndexForKey(1, 3, "ArrowRight")).toBe(2);
    expect(tabIndexForKey(2, 3, "ArrowDown")).toBe(0);
    expect(tabIndexForKey(1, 3, "ArrowLeft")).toBe(0);
    expect(tabIndexForKey(0, 3, "ArrowUp")).toBe(2);
  });

  it("salta a los extremos con Home y End", () => {
    expect(tabIndexForKey(2, 4, "Home")).toBe(0);
    expect(tabIndexForKey(1, 4, "End")).toBe(3);
  });

  it("ignora teclas e índices que no representan una navegación válida", () => {
    expect(tabIndexForKey(0, 3, "Enter")).toBe(null);
    expect(tabIndexForKey(-1, 3, "ArrowRight")).toBe(null);
    expect(tabIndexForKey(0, 0, "ArrowRight")).toBe(null);
  });
});
