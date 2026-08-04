// @ts-check
import { describe, expect, it } from "vitest";
import { compareVersions, normalizeVersion } from "./version.js";

describe("normalizeVersion", () => {
  it("recorta espacios y el prefijo v", () => {
    expect(normalizeVersion("  v1.66.0 ")).toBe("1.66.0");
    expect(normalizeVersion("V2.0")).toBe("2.0");
  });
});

describe("compareVersions", () => {
  it("compara componentes numéricos, no lexicográficos", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  });

  it("trata componentes omitidos como cero", () => {
    expect(compareVersions("v1.66", "1.66.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBe(-1);
  });

  it("ordena prereleases antes que la versión estable", () => {
    expect(compareVersions("1.67.0-beta.2", "1.67.0")).toBe(-1);
    expect(compareVersions("1.67.0-beta.10", "1.67.0-beta.2")).toBe(1);
    expect(compareVersions("1.67.0-rc.1", "1.67.0-beta.9")).toBe(1);
  });

  it("ignora la metadata de build", () => {
    expect(compareVersions("1.66.0+linux", "1.66.0+windows")).toBe(0);
  });
});
