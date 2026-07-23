// @ts-check
import { describe, it, expect } from "vitest";
import {
  formatSize,
  formatDuration,
  formatSftpPermissions,
  formatSftpPermissionsOctal,
  formatOctalMode,
  formatSteppedNumber,
} from "./format.js";

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

describe("formatSftpPermissions", () => {
  it("traduce los 9 bits rwx al estilo de ls", () => {
    expect(formatSftpPermissions(0o755)).toBe("rwxr-xr-x");
    expect(formatSftpPermissions(0o644)).toBe("rw-r--r--");
    expect(formatSftpPermissions(0o750)).toBe("rwxr-x---");
    expect(formatSftpPermissions(0o000)).toBe("---------");
    expect(formatSftpPermissions(0o777)).toBe("rwxrwxrwx");
  });

  it("enmascara a 0o777, ignorando setuid/setgid/sticky y el tipo", () => {
    expect(formatSftpPermissions(0o4755)).toBe("rwxr-xr-x");
    expect(formatSftpPermissions(0o104644)).toBe("rw-r--r--");
  });

  it("devuelve «» para un modo nulo o indefinido", () => {
    expect(formatSftpPermissions(null)).toBe("");
    expect(formatSftpPermissions(undefined)).toBe("");
  });

  it("NaN cae a 0 por el enmascarado de bits (---------)", () => {
    // `NaN & 0o777` es 0 en JS: el guard de finitud tras la máscara nunca salta.
    expect(formatSftpPermissions(NaN)).toBe("---------");
  });
});

describe("formatSftpPermissionsOctal", () => {
  it("da los tres dígitos octales con el cero de cabeza", () => {
    expect(formatSftpPermissionsOctal(0o755)).toBe("0755");
    expect(formatSftpPermissionsOctal(0o644)).toBe("0644");
    expect(formatSftpPermissionsOctal(0o7)).toBe("0007");
    expect(formatSftpPermissionsOctal(0o000)).toBe("0000");
  });

  it("enmascara a 0o777 igual que la variante simbólica", () => {
    expect(formatSftpPermissionsOctal(0o4755)).toBe("0755");
  });

  it("devuelve «» para un modo nulo o indefinido", () => {
    expect(formatSftpPermissionsOctal(null)).toBe("");
    expect(formatSftpPermissionsOctal(undefined)).toBe("");
  });

  it("NaN cae a 0 por el enmascarado de bits (0000)", () => {
    // Mismo motivo que en la variante simbólica: `NaN & 0o777` es 0.
    expect(formatSftpPermissionsOctal(NaN)).toBe("0000");
  });
});

describe("formatOctalMode", () => {
  it("da tres dígitos octales sin el cero de cabeza", () => {
    expect(formatOctalMode(0o750)).toBe("750");
    expect(formatOctalMode(0o644)).toBe("644");
    expect(formatOctalMode(0o7)).toBe("007");
    expect(formatOctalMode(0o000)).toBe("000");
  });

  it("enmascara a 0o777, descartando bits altos", () => {
    expect(formatOctalMode(0o4755)).toBe("755");
  });

  it("filtra el no finito ANTES de enmascarar, así que NaN sí da «»", () => {
    // A diferencia de formatSftpPermissionsOctal, aquí el guard va antes de la
    // máscara: el NaN no llega a colapsar a 0.
    expect(formatOctalMode(NaN)).toBe("");
    expect(formatOctalMode(Infinity)).toBe("");
  });
});

describe("formatSteppedNumber", () => {
  it("fija los decimales pero quita los ceros de cola", () => {
    expect(formatSteppedNumber(3.14, 2)).toBe("3.14");
    expect(formatSteppedNumber(3.1, 2)).toBe("3.1");
    expect(formatSteppedNumber(3.0, 2)).toBe("3");
    expect(formatSteppedNumber(3.14, 3)).toBe("3.14");
  });

  it("redondea a entero cuando la precisión es 0", () => {
    expect(formatSteppedNumber(2.6, 0)).toBe("3");
    expect(formatSteppedNumber(2.4, 0)).toBe("2");
    expect(formatSteppedNumber(100, 0)).toBe("100");
  });

  it("un valor entero con precisión pierde la parte decimal entera", () => {
    expect(formatSteppedNumber(10, 1)).toBe("10");
    expect(formatSteppedNumber(0, 2)).toBe("0");
  });
});
