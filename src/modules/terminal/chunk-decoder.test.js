import { describe, expect, it } from "vitest";
import { createChunkDecoder } from "./chunk-decoder.js";

const bytes = (text) => new TextEncoder().encode(text);

describe("createChunkDecoder", () => {
  it("un carácter partido entre dos bloques sale entero, no como U+FFFD", () => {
    const all = bytes("añó─🦀");
    // Se corta en TODAS las posiciones posibles: ninguna debe romper el texto.
    for (let cut = 1; cut < all.length; cut++) {
      const decode = createChunkDecoder();
      const text = decode(all.slice(0, cut)) + decode(all.slice(cut));
      expect(text, `corte en ${cut}`).toBe("añó─🦀");
    }
  });

  it("el decodificador sin estado es justo lo que falla (la regresión)", () => {
    const all = bytes("ñ");
    const stateless = new TextDecoder();
    expect(stateless.decode(all.slice(0, 1)) + stateless.decode(all.slice(1))).toBe("��");
  });

  it("cada sesión lleva su estado: dos flujos no se mezclan", () => {
    const a = createChunkDecoder();
    const b = createChunkDecoder();
    const enie = bytes("ñ");
    expect(a(enie.slice(0, 1))).toBe("");
    // El otro flujo no hereda el byte suelto de `a`.
    expect(b(bytes("ok"))).toBe("ok");
    expect(a(enie.slice(1))).toBe("ñ");
  });

  it("un bloque vacío no emite nada ni pierde el estado", () => {
    const decode = createChunkDecoder();
    const enie = bytes("ñ");
    expect(decode(enie.slice(0, 1))).toBe("");
    expect(decode(new Uint8Array(0))).toBe("");
    expect(decode(enie.slice(1))).toBe("ñ");
  });
});
