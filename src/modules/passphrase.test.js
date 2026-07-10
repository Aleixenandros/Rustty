// @ts-check
import { describe, expect, it } from "vitest";
import { generatePassphrase, generatedEntropyBits, passphraseStrength } from "./passphrase.js";

describe("generatePassphrase", () => {
  it("genera el formato palabra-palabra con sílabas CV", () => {
    const pass = generatePassphrase();
    const words = pass.split("-");
    expect(words).toHaveLength(5);
    for (const word of words) {
      expect(word).toMatch(/^([bcdfghjklmnprstvz][aeiou]){3}$/);
    }
  });

  it("respeta el número de palabras con mínimo de 3", () => {
    expect(generatePassphrase(6).split("-")).toHaveLength(6);
    expect(generatePassphrase(1).split("-")).toHaveLength(3);
    expect(generatePassphrase(0).split("-")).toHaveLength(5);
  });

  it("es determinista con un rng inyectado y usa el rango completo", () => {
    const seen = new Set();
    const rng = (/** @type {number} */ max) => {
      seen.add(max);
      return 0;
    };
    const pass = generatePassphrase(3, rng);
    expect(pass).toBe("bababa-bababa-bababa");
    // Pide índices tanto de consonantes (17) como de vocales (5).
    expect([...seen].sort((a, b) => a - b)).toEqual([5, 17]);
  });

  it("el default generado puntúa al menos como buena y declara ≥90 bits", () => {
    expect(generatedEntropyBits()).toBeGreaterThanOrEqual(90);
    const rng = (/** @type {number} */ max) => Math.floor(max / 2);
    const { score } = passphraseStrength(generatePassphrase(5, rng));
    expect(score).toBeGreaterThanOrEqual(3);
  });
});

describe("passphraseStrength", () => {
  it("puntúa vacío y trivial como débil", () => {
    expect(passphraseStrength("").score).toBe(0);
    expect(passphraseStrength("a").score).toBe(0);
    expect(passphraseStrength("1234").score).toBe(0);
    expect(passphraseStrength("aaaaaaaaaaaaaaaaaaaa").score).toBeLessThanOrEqual(1);
  });

  it("crece con longitud y variedad de alfabeto", () => {
    const corta = passphraseStrength("abc123");
    const media = passphraseStrength("abc123XYZ!");
    // 4 palabras de diccionario ≈ 52 bits en la estimación prudente: «justa».
    const cuatro = passphraseStrength("correcto-caballo-grapa-bateria");
    const cinco = passphraseStrength("correcto-caballo-grapa-bateria-nube");
    expect(media.bits).toBeGreaterThan(corta.bits);
    expect(cuatro.score).toBe(2);
    expect(cinco.score).toBeGreaterThanOrEqual(3);
  });

  it("no infla frases de pocas palabras comunes", () => {
    // 3 palabras ≈ 39 bits por la vía de palabras, aunque tenga 20+ chars.
    const tres = passphraseStrength("caballo verde grande");
    expect(tres.score).toBeLessThanOrEqual(2);
  });

  it("una passphrase aleatoria larga puntúa fuerte", () => {
    expect(passphraseStrength("kJ8#pQ2$wN5!zX9m").score).toBe(4);
  });
});
