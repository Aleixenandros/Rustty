// @ts-check
/**
 * Generador y medidor de passphrases para la sincronización.
 *
 * La passphrase protege TODOS los datos sincronizados (age → scrypt), así que
 * el formulario necesita orientar al usuario: un medidor de fortaleza honesto
 * (estimación de entropía, no reglas de composición) y un generador local.
 *
 * El generador produce palabras pronunciables por sílabas consonante+vocal en
 * vez de usar una lista diceware embebida: sin inflar el bundle, cada sílaba
 * aporta ~6,4 bits (17 consonantes × 5 vocales) y el default de 5 palabras de
 * 3 sílabas ronda los 96 bits reales — de sobra contra fuerza bruta offline
 * con el coste de scrypt por intento (el medidor, que no sabe que son
 * aleatorias, las tasa de forma prudente como palabras de diccionario).
 * Todo local: `crypto.getRandomValues`.
 */

const CONSONANTS = "bcdfghjklmnprstvz";
const VOWELS = "aeiou";
const SYLLABLES_PER_WORD = 3;
const DEFAULT_WORDS = 5;

/** Bits de entropía por sílaba CV (17 × 5 = 85 combinaciones). */
const SYLLABLE_BITS = Math.log2(CONSONANTS.length * VOWELS.length);

/**
 * Entero uniforme en [0, max) con `crypto.getRandomValues` y muestreo por
 * rechazo (evita el sesgo del módulo).
 * @param {number} max
 * @returns {number}
 */
function cryptoRandomInt(max) {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/**
 * Genera una passphrase de palabras pronunciables separadas por guiones.
 * @param {number} [words] Número de palabras (mínimo 3).
 * @param {(max: number) => number} [randomInt] Inyectable en tests.
 * @returns {string} p. ej. `"rebota-sanilo-kevuma-dolira-mizapo"`
 */
export function generatePassphrase(words = DEFAULT_WORDS, randomInt = cryptoRandomInt) {
  const count = Math.max(3, Math.floor(words) || DEFAULT_WORDS);
  const parts = [];
  for (let w = 0; w < count; w++) {
    let word = "";
    for (let s = 0; s < SYLLABLES_PER_WORD; s++) {
      word += CONSONANTS[randomInt(CONSONANTS.length)];
      word += VOWELS[randomInt(VOWELS.length)];
    }
    parts.push(word);
  }
  return parts.join("-");
}

/**
 * Bits de entropía de una passphrase generada con `generatePassphrase`.
 * @param {number} [words] Número de palabras (mínimo 3, como el generador).
 */
export function generatedEntropyBits(words = DEFAULT_WORDS) {
  return Math.max(3, Math.floor(words) || DEFAULT_WORDS) * SYLLABLES_PER_WORD * SYLLABLE_BITS;
}

/**
 * Estima la fortaleza de una passphrase arbitraria.
 *
 * Heurística de entropía por tamaño del alfabeto usado × longitud, con dos
 * correcciones conservadoras: los caracteres repetidos consecutivos apenas
 * suman, y las passphrases tipo diceware (palabras + separadores) se evalúan
 * por palabra (~13 bits/palabra, estimación prudente para vocabulario común).
 *
 * @param {string} pass
 * @returns {{score: 0|1|2|3|4, bits: number}} score: 0-1 débil, 2 justa,
 *   3 buena, 4 fuerte.
 */
export function passphraseStrength(pass) {
  const value = String(pass || "");
  if (!value) return { score: 0, bits: 0 };

  let alphabet = 0;
  if (/[a-z]/.test(value)) alphabet += 26;
  if (/[A-Z]/.test(value)) alphabet += 26;
  if (/[0-9]/.test(value)) alphabet += 10;
  if (/[^a-zA-Z0-9]/.test(value)) alphabet += 33;

  // Longitud efectiva: las repeticiones consecutivas cuentan poco.
  let effective = 0;
  let prev = "";
  for (const ch of value) {
    effective += ch === prev ? 0.25 : 1;
    prev = ch;
  }
  let bits = effective * Math.log2(Math.max(2, alphabet));

  // Vía palabras (diceware o el generador propio): n palabras separadas por
  // espacio/guion. Se toma la MENOR de las dos estimaciones para no inflar
  // la puntuación de frases de palabras comunes largas.
  const words = value.split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  if (words.length >= 3) {
    const wordBits = words.length * 13;
    bits = Math.min(bits, Math.max(wordBits, words.length * 4));
  }

  /** @type {0|1|2|3|4} */
  let score;
  if (bits < 28) score = 0;
  else if (bits < 40) score = 1;
  else if (bits < 55) score = 2;
  else if (bits < 75) score = 3;
  else score = 4;
  return { score, bits: Math.round(bits) };
}
