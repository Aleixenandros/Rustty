// @ts-check
/**
 * Buscador de Preferencias: la parte que toca el DOM.
 *
 * Mientras hay consulta, el diálogo deja de enseñar una sola sección y pasa a
 * enseñar, una debajo de otra, las secciones con alguna fila que coincide;
 * dentro de cada una solo esas filas (con su explicación y el subtítulo bajo el
 * que caen). La barra de secciones marca cuántas coincidencias tiene cada una y
 * atenúa las que no tienen ninguna. Al vaciar la consulta, `onExit` devuelve la
 * vista normal por secciones.
 *
 * Nunca quita la clase `hidden` ni el atributo `hidden` de una fila: lo que
 * otra parte de la app oculta (opciones de otra plataforma, vistas alternativas
 * de Credenciales…) no cuenta como coincidencia ni aparece al buscar. Lo que
 * oculta el buscador lleva su propia clase y se retira entero al salir.
 *
 * El resaltado usa la API de resaltados de CSS (`CSS.highlights`), que no toca
 * el texto de las filas (sus `data-i18n` siguen intactos); si el motor no la
 * tiene, se busca igual, sin resaltar.
 */

import { highlightOffsets, planPrefsSearch } from "./search.js";

/** Una fila de ajuste. Las filas de atajos las pinta `shortcuts/` al abrir. */
const UNIT_SELECTOR = ".settings-row, .shortcut-row";
/** Subtítulos que agrupan filas dentro de una sección. */
const HEADING_SELECTOR = ".prefs-subhead, .prefs-subsection-title";
/** Explicaciones que van como hermanas justo detrás de su fila. */
const HINT_SELECTOR = ".settings-hint, .form-hint";
/** Texto que no se pinta tal cual (opciones de un desplegable cerrado…). */
const NO_HIGHLIGHT = "select, option, script, style, textarea, input";

const MISS_CLASS = "prefs-search-miss";
const SHOWN_CLASS = "search-shown";
const SEARCHING_CLASS = "prefs-searching";
const HIGHLIGHT_NAME = "prefs-search";

/**
 * @typedef {object} Unit
 * @property {string} panel
 * @property {Element} el
 * @property {Element|null} heading
 * @property {Element[]} hints
 * @property {string} text
 */

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root `#modal-prefs`: recibe la clase de búsqueda.
 * @param {HTMLElement} opts.nav Barra de secciones (`.prefs-nav`).
 * @param {HTMLElement} opts.content Contenedor de las secciones (`.prefs-content`).
 * @param {HTMLInputElement} opts.input Campo de búsqueda.
 * @param {HTMLElement} opts.empty Aviso «sin resultados».
 * @param {HTMLElement} opts.status Región `aria-live` con el recuento.
 * @param {(key: string, params?: Record<string, unknown>) => string} opts.t
 * @param {() => void} opts.onExit Vuelve a la vista por secciones.
 * @param {() => void} [opts.onFocus] Al entrar en el campo (p. ej. cancelar
 *   la captura de un atajo, que si no se tragaría lo tecleado).
 */
export function createPrefsSearch({ root, nav, content, input, empty, status, t, onExit, onFocus }) {
  const doc = root.ownerDocument;
  let active = false;
  /** @type {Set<Element>} */
  const marked = new Set();

  /** @param {string} name */
  function navItem(name) {
    return nav.querySelector(`.prefs-nav-item[data-prefs-tab="${CSS.escape(name)}"]`);
  }

  /** @returns {HTMLElement[]} */
  function panels() {
    return /** @type {HTMLElement[]} */ ([...content.querySelectorAll(".prefs-panel[data-prefs-panel]")]);
  }

  /**
   * Oculta por la app (no por el buscador) entre `el` y su sección, ambos
   * incluidos salvo la sección, que en la vista normal lleva `hidden` si no es
   * la activa.
   * @param {Element} el
   * @param {Element} panel
   */
  function hiddenByApp(el, panel) {
    for (let node = /** @type {Element|null} */ (el); node && node !== panel; node = node.parentElement) {
      if (node.classList.contains("hidden") || node.hasAttribute("hidden")) return true;
    }
    return false;
  }

  /** @param {Element} el */
  function followingHints(el) {
    /** @type {Element[]} */
    const hints = [];
    for (let next = el.nextElementSibling; next && next.matches(HINT_SELECTOR); next = next.nextElementSibling) {
      hints.push(next);
    }
    return hints;
  }

  /** @returns {Unit[]} */
  function collectUnits() {
    /** @type {Unit[]} */
    const units = [];
    for (const panel of panels()) {
      const name = panel.dataset.prefsPanel || "";
      const label = [
        navItem(name)?.querySelector(".prefs-nav-label")?.textContent || "",
        panel.querySelector(".prefs-panel-title")?.textContent || "",
      ].join(" ");
      /** @type {Element|null} */
      let heading = null;
      for (const el of panel.querySelectorAll(`${UNIT_SELECTOR}, ${HEADING_SELECTOR}`)) {
        if (el.matches(HEADING_SELECTOR)) {
          heading = hiddenByApp(el, panel) ? null : el;
          continue;
        }
        // Una fila dentro de otra cuenta como la de fuera.
        if (el.parentElement?.closest(UNIT_SELECTOR)) continue;
        if (hiddenByApp(el, panel)) continue;
        const hints = followingHints(el);
        const text = [label, heading?.textContent || "", el.textContent || "", ...hints.map((h) => h.textContent || "")]
          .join(" ");
        units.push({ panel: name, el, heading, hints, text });
      }
    }
    return units;
  }

  /** Retira todo lo que puso la búsqueda anterior (clases, recuentos, resaltado). */
  function resetMarks() {
    for (const el of marked) el.classList.remove(MISS_CLASS);
    marked.clear();
    for (const panel of panels()) panel.classList.remove(SHOWN_CLASS);
    for (const item of nav.querySelectorAll(".prefs-nav-item")) {
      item.classList.remove("is-search-miss", "has-search-hit");
      const badge = item.querySelector(".prefs-nav-count");
      if (badge) badge.textContent = "";
    }
    clearHighlights();
  }

  /** La API de resaltados de CSS, o `null` si el motor no la tiene. */
  function highlightsApi() {
    const css = /** @type {any} */ (doc.defaultView?.CSS);
    const Ctor = /** @type {any} */ (doc.defaultView)?.Highlight;
    return css?.highlights && typeof Ctor === "function" ? { registry: css.highlights, Ctor } : null;
  }

  /** Quita el resaltado de la búsqueda. */
  function clearHighlights() {
    highlightsApi()?.registry.delete(HIGHLIGHT_NAME);
  }

  /**
   * @param {Element[]} elements
   * @param {string[]} tokens
   */
  function paintHighlights(elements, tokens) {
    const api = highlightsApi();
    if (!api) return;
    /** @type {Range[]} */
    const ranges = [];
    for (const el of elements) {
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = /** @type {Text} */ (node);
        if (text.parentElement?.closest(NO_HIGHLIGHT)) continue;
        for (const [start, end] of highlightOffsets(text.data, tokens)) {
          const range = doc.createRange();
          range.setStart(text, start);
          range.setEnd(text, end);
          ranges.push(range);
        }
      }
    }
    if (ranges.length) api.registry.set(HIGHLIGHT_NAME, new api.Ctor(...ranges));
  }

  /**
   * Esconde dentro de `parent` todo lo que ni se enseña ni contiene algo que
   * se enseñe.
   * @param {Element} parent
   * @param {Set<Element>} keep
   * @param {Set<Element>} ancestors
   */
  function prune(parent, keep, ancestors) {
    for (const child of parent.children) {
      if (keep.has(child)) continue;
      if (ancestors.has(child)) {
        prune(child, keep, ancestors);
        continue;
      }
      child.classList.add(MISS_CLASS);
      marked.add(child);
    }
  }

  /** Aplica la consulta del campo (o sale de la búsqueda si está vacía). */
  function run() {
    const query = input.value;
    if (!query.trim()) {
      clear();
      return;
    }
    resetMarks();
    const units = collectUnits();
    const plan = planPrefsSearch(units, query);
    if (!plan.tokens.length) {
      clear();
      return;
    }
    active = true;
    root.classList.add(SEARCHING_CLASS);

    /** @type {Set<Element>} */
    const keep = new Set();
    units.forEach((unit, index) => {
      if (!plan.hits[index]) return;
      keep.add(unit.el);
      for (const hint of unit.hints) keep.add(hint);
      if (unit.heading) keep.add(unit.heading);
    });
    for (const panel of panels()) {
      const name = panel.dataset.prefsPanel || "";
      const shown = plan.perPanel.has(name);
      panel.classList.toggle(SHOWN_CLASS, shown);
      panel.hidden = !shown;
      if (!shown) continue;
      const title = panel.querySelector(".prefs-panel-title");
      if (title) keep.add(title);
    }
    /** @type {Set<Element>} */
    const ancestors = new Set();
    for (const el of keep) {
      for (let node = el.parentElement; node && !node.matches(".prefs-panel"); node = node.parentElement) {
        ancestors.add(node);
      }
    }
    for (const panel of panels()) {
      if (panel.classList.contains(SHOWN_CLASS)) prune(panel, keep, ancestors);
    }

    for (const item of nav.querySelectorAll(".prefs-nav-item")) {
      const count = plan.perPanel.get(/** @type {HTMLElement} */ (item).dataset.prefsTab || "") || 0;
      item.classList.toggle("has-search-hit", count > 0);
      item.classList.toggle("is-search-miss", count === 0);
      let badge = item.querySelector(".prefs-nav-count");
      if (!badge) {
        badge = doc.createElement("span");
        badge.className = "prefs-nav-count";
        item.appendChild(badge);
      }
      badge.textContent = count ? String(count) : "";
    }

    empty.classList.toggle("hidden", plan.total > 0);
    if (!plan.total) empty.textContent = t("modal_prefs.search_empty", { query: query.trim() });
    status.textContent = plan.total
      ? t("modal_prefs.search_results", { count: plan.total })
      : t("modal_prefs.search_empty", { query: query.trim() });
    content.scrollTop = 0;
    paintHighlights([...keep].filter((el) => !el.matches(".prefs-panel-title")), plan.tokens);
  }

  /**
   * Sale de la búsqueda y vacía el campo.
   * @param {{ restore?: boolean }} [opts] `restore: false` cuando quien llama
   *   va a pintar él mismo la sección (cambio de pestaña, abrir el diálogo).
   */
  function clear({ restore = true } = {}) {
    input.value = "";
    if (!active) return;
    active = false;
    resetMarks();
    root.classList.remove(SEARCHING_CLASS);
    empty.classList.add("hidden");
    empty.textContent = "";
    status.textContent = "";
    if (restore) onExit();
  }

  /**
   * Con una búsqueda en curso, lleva la vista a la sección `name` si tiene
   * coincidencias. Devuelve si lo ha hecho (si no, quien llama sale de la
   * búsqueda y abre la sección normal).
   * @param {string} name
   */
  function reveal(name) {
    if (!active) return false;
    const panel = content.querySelector(`.prefs-panel.${SHOWN_CLASS}[data-prefs-panel="${CSS.escape(name)}"]`);
    if (!panel) return false;
    panel.scrollIntoView({ block: "start" });
    return true;
  }

  /** Primer control de la primera coincidencia, para Intro desde el campo. */
  function firstResultControl() {
    const hit = content.querySelector(`.prefs-panel.${SHOWN_CLASS} :is(${UNIT_SELECTOR}):not(.${MISS_CLASS})`);
    return /** @type {HTMLElement|null} */ (
      hit?.querySelector("input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex='-1'])") || null
    );
  }

  input.addEventListener("input", run);
  input.addEventListener("focus", () => onFocus?.());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      // Primero se limpia la búsqueda; el siguiente Escape cierra el diálogo.
      e.preventDefault();
      clear();
      return;
    }
    if (e.key === "Enter" && active) {
      const control = firstResultControl();
      if (control) {
        e.preventDefault();
        control.focus();
      }
    }
  });

  return {
    run,
    clear,
    reveal,
    isActive: () => active,
    /** Vuelve a aplicar la consulta (tras repintar una lista de la sección). */
    refresh: () => {
      if (active) run();
    },
  };
}
