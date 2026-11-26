import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SFTP_SPLIT_DEFAULT, SFTP_SPLIT_MAX, SFTP_SPLIT_MIN,
  normalizeSftpSplit, sftpSplitColumns, sftpSplitForKey, sftpSplitFromPointer,
} from "./split.js";
import { DEFAULT_PREFS } from "../prefs/defaults.js";

describe("normalizeSftpSplit", () => {
  it("deja pasar lo válido y recorta a los topes", () => {
    expect(normalizeSftpSplit(0.6)).toBe(0.6);
    expect(normalizeSftpSplit(0.05)).toBe(SFTP_SPLIT_MIN);
    expect(normalizeSftpSplit(0.99)).toBe(SFTP_SPLIT_MAX);
  });

  it("lo que no es un número vuelve a la mitad", () => {
    for (const bad of [undefined, null, "0.3", Number.NaN, Infinity]) {
      expect(normalizeSftpSplit(bad)).toBe(SFTP_SPLIT_DEFAULT);
    }
  });

  it("el default de las preferencias es la mitad", () => {
    expect(DEFAULT_PREFS.sftpSplitRatio).toBe(SFTP_SPLIT_DEFAULT);
  });
});

describe("sftpSplitFromPointer", () => {
  const panel = { left: 100, width: 1034, divider: 34 };

  it("el centro del divisor en el centro da la mitad", () => {
    expect(sftpSplitFromPointer({ ...panel, x: 100 + 500 + 17 })).toBeCloseTo(0.5);
  });

  it("mide sobre el ancho útil (sin el divisor)", () => {
    expect(sftpSplitFromPointer({ ...panel, x: 100 + 600 + 17 })).toBeCloseTo(0.6);
  });

  it("recorta a los topes y aguanta un panel sin ancho", () => {
    expect(sftpSplitFromPointer({ ...panel, x: 0 })).toBe(SFTP_SPLIT_MIN);
    expect(sftpSplitFromPointer({ ...panel, x: 5000 })).toBe(SFTP_SPLIT_MAX);
    expect(sftpSplitFromPointer({ x: 10, left: 0, width: 20, divider: 34 })).toBe(SFTP_SPLIT_DEFAULT);
  });
});

describe("sftpSplitColumns", () => {
  it("da las dos columnas en fr", () => {
    expect(sftpSplitColumns(0.5)).toEqual({ left: "0.5fr", right: "0.5fr" });
    expect(sftpSplitColumns(0.65)).toEqual({ left: "0.65fr", right: "0.35fr" });
  });

  it("normaliza antes de pintar", () => {
    expect(sftpSplitColumns(2)).toEqual({ left: "0.8fr", right: "0.2fr" });
  });
});

describe("sftpSplitForKey", () => {
  it("las flechas mueven un paso sin arrastrar decimales", () => {
    expect(sftpSplitForKey(0.5, "ArrowLeft")).toBe(0.45);
    expect(sftpSplitForKey(0.5, "ArrowRight")).toBe(0.55);
  });

  it("Inicio, Fin e Intro", () => {
    expect(sftpSplitForKey(0.5, "Home")).toBe(SFTP_SPLIT_MIN);
    expect(sftpSplitForKey(0.5, "End")).toBe(SFTP_SPLIT_MAX);
    expect(sftpSplitForKey(0.7, "Enter")).toBe(SFTP_SPLIT_DEFAULT);
  });

  it("no pasa de los topes ni se queda teclas ajenas", () => {
    expect(sftpSplitForKey(SFTP_SPLIT_MIN, "ArrowLeft")).toBe(SFTP_SPLIT_MIN);
    expect(sftpSplitForKey(0.5, "a")).toBeNull();
  });
});

describe("contrato con la hoja", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

  it("las columnas del panel salen de las variables del reparto", () => {
    expect(css).toMatch(/\.sftp-panel-split\s*\{[^}]*grid-template-columns:\s*minmax\(0, var\(--sftp-col-left, 1fr\)\)[^;]*var\(--sftp-col-right, 1fr\)/);
  });
});
