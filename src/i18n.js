/**
 * Sistema de internacionalización simple.
 * - Catálogos por idioma en `modules/i18n/{es,en,fr,pt,de}.json`, claves en
 *   notación "a.b.c". Español e inglés viajan en el bundle (son la cadena de
 *   fallback permanente de `t()`); francés, portugués y alemán se cargan bajo
 *   demanda al activarlos, en su propio chunk.
 * - t(key, params) devuelve la cadena localizada (con fallback a EN → ES y a la clave).
 * - applyTranslations(root) recorre el DOM y rellena:
 *     data-i18n             → textContent
 *     data-i18n-title       → atributo title
 *     data-i18n-placeholder → atributo placeholder
 *     data-i18n-aria-label  → atributo aria-label
 *     data-i18n-html        → innerHTML (usar sólo para cadenas con marcado confiable)
 * - setLanguage(lang) cambia el idioma activo, carga su catálogo si hace falta
 *   y actualiza el `<html lang=…>`. Devuelve una promesa: quien quiera repintar
 *   con el catálogo ya cargado encadena `.then(() => applyTranslations())`
 *   (mientras carga, `t()` cae al fallback, así que nunca rompe).
 */

import es from "./modules/i18n/es.json";
import en from "./modules/i18n/en.json";

export const SUPPORTED_LANGS = ["es", "en", "fr", "pt", "de"];

/** Cargadores perezosos de los idiomas que no forman parte del fallback. */
const LAZY_LOADERS = {
  fr: () => import("./modules/i18n/fr.json"),
  pt: () => import("./modules/i18n/pt.json"),
  de: () => import("./modules/i18n/de.json"),
};

/** Catálogos ya disponibles en memoria. */
const loaded = { es, en };

let currentLang = "es";

/** Devuelve un valor anidado por clave con notación "a.b.c" */
function resolve(obj, key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** Traduce una clave. Si falta, cae a inglés, luego a español y finalmente a la clave. */
export function t(key, params = null) {
  let str =
    resolve(loaded[currentLang], key) ??
    (currentLang !== "es" ? resolve(loaded.en, key) : undefined) ??
    resolve(loaded.es, key) ??
    key;
  if (params && typeof str === "string") {
    str = str.replace(/\{(\w+)\}/g, (_, k) => (k in params ? params[k] : `{${k}}`));
  }
  return str;
}

/**
 * Cambia el idioma activo (cargando su catálogo si aún no está) y actualiza el
 * atributo lang del `<html>`. El cambio de `currentLang` es inmediato: hasta
 * que el catálogo llegue, `t()` sirve el fallback EN/ES.
 * @returns {Promise<string>} El idioma efectivamente activado.
 */
export async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = "es";
  currentLang = lang;
  document.documentElement.setAttribute("lang", lang);
  if (!loaded[lang] && LAZY_LOADERS[lang]) {
    const mod = await LAZY_LOADERS[lang]();
    loaded[lang] = mod.default || mod;
  }
  return lang;
}

export function getLanguage() {
  return currentLang;
}

/**
 * Detecta el idioma más cercano a navigator.language entre los soportados.
 * Devuelve "es" si no hay coincidencia.
 */
export function detectLanguage() {
  const nav = (navigator.language || "es").toLowerCase().slice(0, 2);
  return SUPPORTED_LANGS.includes(nav) ? nav : "es";
}

/**
 * Aplica las traducciones a todos los nodos del DOM con atributos data-i18n*.
 * Llamar tras setLanguage o al cargar la página.
 */
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const value = t(el.dataset.i18nTitle);
    // Si el elemento usa el sistema custom de tooltips (marcado con
    // data-tooltip-pos), escribimos también data-tooltip y eliminamos el
    // title nativo para evitar el doble tooltip del navegador.
    if (el.hasAttribute("data-tooltip-pos")) {
      el.setAttribute("data-tooltip", value);
      el.removeAttribute("title");
    } else {
      el.setAttribute("title", value);
    }
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
}
