import { describe, it, expect } from "vitest";
import { SUPPORTED_LANGS, matchLanguage } from "./i18n.js";
import es from "./modules/i18n/es.json";
import en from "./modules/i18n/en.json";
import fr from "./modules/i18n/fr.json";
import pt from "./modules/i18n/pt.json";
import de from "./modules/i18n/de.json";
import zhTW from "./modules/i18n/zh-TW.json";
import id from "./modules/i18n/id.json";

const DICTIONARIES = { es, en, fr, pt, de, "zh-TW": zhTW, id };

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
  it("expone los 7 idiomas soportados", () => {
    expect(SUPPORTED_LANGS).toEqual(["es", "en", "fr", "pt", "de", "zh-TW", "id"]);
    for (const lang of SUPPORTED_LANGS) {
      expect(DICTIONARIES[lang], `falta el diccionario ${lang}`).toBeTruthy();
    }
  });

  it("matchLanguage mapea etiquetas del navegador al idioma soportado", () => {
    expect(matchLanguage("zh-TW")).toBe("zh-TW");
    expect(matchLanguage("zh-Hant-HK")).toBe("zh-TW");
    expect(matchLanguage("zh-hant")).toBe("zh-TW");
    expect(matchLanguage("zh-CN")).toBeNull(); // simplificado: no soportado
    expect(matchLanguage("zh")).toBeNull();
    expect(matchLanguage("id-ID")).toBe("id");
    expect(matchLanguage("in-ID")).toBe("id"); // código antiguo de indonesio
    expect(matchLanguage("pt-BR")).toBe("pt");
    expect(matchLanguage("de_DE")).toBe("de");
    expect(matchLanguage("ja-JP")).toBeNull();
    expect(matchLanguage("")).toBeNull();
    expect(matchLanguage(undefined)).toBeNull();
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

  it("todos los idiomas están completos respecto a es (paridad total)", () => {
    // Desde que se completaron fr/pt (2026-07-09), NINGÚN idioma puede perder
    // claves respecto al castellano: si esto falla, se ha añadido una clave a
    // `es` sin traducirla en algún idioma. Junto con el test de huérfanas, esto
    // garantiza que los 5 diccionarios tengan exactamente el mismo juego de claves.
    for (const lang of SUPPORTED_LANGS) {
      if (lang === "es") continue;
      const missing = esKeys.filter((k) => !keySets[lang].has(k));
      expect(missing, `faltan en ${lang}: ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("los mensajes de UI (sección toast) existen en todos los idiomas", () => {
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
