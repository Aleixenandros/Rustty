import { describe, it, expect } from "vitest";
import { DICTIONARIES, SUPPORTED_LANGS } from "./i18n.js";

/** Aplana un diccionario anidado a claves con puntos (`toast.close`, …). */
function flatten(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flatten(v, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

const keySets = Object.fromEntries(
  SUPPORTED_LANGS.map((l) => [l, new Set(flatten(DICTIONARIES[l]))]),
);
const esKeys = [...keySets.es].sort();

describe("i18n · paridad de claves", () => {
  it("expone los 5 idiomas soportados", () => {
    expect(SUPPORTED_LANGS).toEqual(["es", "en", "fr", "pt", "de"]);
    for (const lang of SUPPORTED_LANGS) {
      expect(DICTIONARIES[lang], `falta el diccionario ${lang}`).toBeTruthy();
    }
  });

  it("ningún idioma tiene claves huérfanas (ausentes en es)", () => {
    // Una clave presente en otro idioma pero no en `es` es basura (typo o clave
    // renombrada): nunca se resolvería, porque `es` es la fuente canónica.
    for (const lang of SUPPORTED_LANGS) {
      if (lang === "es") continue;
      const orphans = [...keySets[lang]].filter((k) => !keySets.es.has(k)).sort();
      expect(orphans, `claves huérfanas en ${lang}: ${orphans.join(", ")}`).toEqual([]);
    }
  });

  it("en y de están completos respecto a es", () => {
    // Los idiomas «completos» (inglés y alemán) no deben perder ninguna clave
    // respecto al castellano; si esto falla, se ha añadido una clave a `es` sin
    // traducirla en el resto.
    for (const lang of ["en", "de"]) {
      const missing = esKeys.filter((k) => !keySets[lang].has(k));
      expect(missing, `faltan en ${lang}: ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("los mensajes de UI (sección toast) existen en los 5 idiomas", () => {
    // Garantiza que el barrido de literales hardcodeados quedó localizado en
    // todos los idiomas, francés y portugués incluidos.
    const swept = esKeys.filter((k) => k.startsWith("toast."));
    expect(swept.length).toBeGreaterThan(0);
    for (const lang of SUPPORTED_LANGS) {
      const missing = swept.filter((k) => !keySets[lang].has(k));
      expect(missing, `faltan claves toast.* en ${lang}: ${missing.join(", ")}`).toEqual([]);
    }
  });
});
