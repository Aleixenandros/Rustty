// @ts-check
import {
  allowShortcutInDialog, backgroundPlan, closeDialog, escapeTarget, initialFocusKind,
  openDialog, pickRestore, topDialog, trapIndex,
} from "./stack.js";

/**
 * Adaptador DOM de la pila de diálogos (`stack.js`). Los diálogos de la app
 * siguen teniendo su propia función de abrir y de cerrar; este controlador
 * solo se ocupa de lo común: foco inicial, vuelta del foco a quien abrió el
 * diálogo, trampa de Tab, fondo inerte y Escape dirigido a la cima.
 *
 * Regla: el controlador NUNCA oculta un diálogo por su cuenta. Con Escape
 * llama al `close` registrado, que conserva los efectos de cada cierre
 * (revertir la vista previa de Preferencias, resolver la promesa de una
 * credencial, autoguardar la nota…).
 *
 * Además observa la clase `hidden` de cada overlay registrado: si algún
 * camino lo muestra u oculta sin pasar por `show`/`hide`, la pila se
 * reconcilia sola. Una entrada huérfana dejaría la app entera inerte.
 */

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex=\"-1\"])",
  "[contenteditable=\"true\"]",
].join(",");

/** Clase del overlay que encabeza una pila de dos o más diálogos (`--z-modal-top`). */
const TOP_LAYER_CLASS = "dialog-layer-top";

const FIELD = [
  "input:not([disabled]):not([readonly]):not([type=\"hidden\"]):not([type=\"checkbox\"]):not([type=\"radio\"]):not([type=\"button\"]):not([type=\"submit\"]):not([type=\"reset\"])",
  "textarea:not([disabled]):not([readonly])",
].join(",");

/**
 * @typedef {object} DialogSpec
 * @property {string|HTMLElement} overlay Overlay que se muestra/oculta con la clase `hidden`.
 * @property {string|HTMLElement} [dialog] Caja del diálogo (por defecto, el `[role=dialog]` del overlay).
 * @property {() => void} close Cierre propio del diálogo (lo que hace hoy su botón ×).
 * @property {string|(() => Element|null)} [initialFocus] Selector o función del control inicial.
 * @property {() => { confirm?: boolean, danger?: boolean }} [confirm] Si ahora es una confirmación (y si es destructiva).
 * @property {string} [cancel] Selector del botón «Cancelar» (foco inicial de una confirmación destructiva).
 * @property {boolean} [escape] `false` si Escape no debe cerrarlo.
 * @property {boolean} [modal] `false` para paneles que no bloquean el fondo.
 */

/**
 * @param {object} deps
 * @param {Document} [deps.doc]
 * @param {() => Element[]} deps.background Capas de la app que quedan inertes tras un modal.
 * @param {(active: Element|null) => Element|null} [deps.resolveOpener] Traduce el foco actual al disparador real (p. ej. un menú contextual ya cerrado).
 * @param {() => Array<Element|null|undefined>} [deps.fallbackFocus] Reservas por orden si el disparador ya no existe.
 * @param {boolean} [deps.supportsInert]
 * @param {() => boolean} [deps.hasOpenPopover] Un menú flotante abierto se queda su Escape.
 */
export function createDialogController({
  doc = document, background, resolveOpener = (active) => active, fallbackFocus = () => [],
  supportsInert = typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype,
  hasOpenPopover = () => false,
}) {
  /** @type {import("./stack.js").DialogEntry[]} */
  let stack = [];
  /** @type {Map<string, DialogSpec>} */
  const registry = new Map();
  /** @type {{ target: unknown, token: object }|null} */
  let pendingRestore = null;
  /** Los dos últimos focos, para saber quién abrió un diálogo que ya se enfocó a sí mismo. */
  /** @type {Element|null} */
  let currentFocus = null;
  /** @type {Element|null} */
  let previousFocus = null;
  /** Elementos que este controlador ha dejado inertes (para no tocar otros). */
  /** @type {Set<Element>} */
  const inertByUs = new Set();
  /** @type {MutationObserver|null} */
  let observer = null;
  let reconciling = false;

  /** @param {string|HTMLElement|undefined} ref */
  const resolveEl = (ref) => (typeof ref === "string" ? doc.getElementById(ref) : ref ?? null);

  /** @param {string} id */
  function overlayOf(id) {
    const spec = registry.get(id);
    return spec ? resolveEl(spec.overlay) : null;
  }

  /** @param {string} id */
  function dialogOf(id) {
    const spec = registry.get(id);
    if (!spec) return null;
    const own = resolveEl(spec.dialog);
    if (own) return own;
    const overlay = resolveEl(spec.overlay);
    return overlay?.querySelector("[role=dialog],[role=alertdialog]") ?? overlay;
  }

  /** @param {Element|null|undefined} el */
  function isVisible(el) {
    if (!(el instanceof HTMLElement) || !el.isConnected) return false;
    if (el.closest(".hidden")) return false;
    return el.getClientRects().length > 0;
  }

  /** @param {Element|null|undefined} el */
  function isInert(el) {
    if (!el) return false;
    if (el.closest("[inert]")) return true;
    for (const layer of inertByUs) if (layer.contains(el)) return true;
    return false;
  }

  /** @param {Element} root */
  function focusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(
      (el) => el instanceof HTMLElement && el.tabIndex >= 0 && isVisible(el) && !isInert(el),
    );
  }

  /** @param {Element|null|undefined} el */
  function focusEl(el) {
    if (!(el instanceof HTMLElement)) return false;
    el.focus({ preventScroll: false });
    return doc.activeElement === el;
  }

  /** @param {HTMLElement} box */
  function focusContainer(box) {
    if (!box.hasAttribute("tabindex")) box.setAttribute("tabindex", "-1");
    box.focus();
  }

  /**
   * @param {string} id
   * @param {string|(() => Element|null)|undefined} explicit
   */
  function focusInitial(id, explicit) {
    const box = dialogOf(id);
    if (!(box instanceof HTMLElement)) return;
    const spec = registry.get(id);
    const wanted = explicit ?? spec?.initialFocus;
    /** @type {Element|null} */
    let target = null;
    if (typeof wanted === "function") target = wanted();
    else if (typeof wanted === "string") target = box.querySelector(wanted);
    if (target && isVisible(target) && focusEl(target)) return;
    const all = focusables(box);
    const fields = all.filter((el) => el.matches(FIELD));
    const confirm = spec?.confirm?.() ?? {};
    const kind = initialFocusKind({
      confirm: !!confirm.confirm, danger: !!confirm.danger,
      hasField: fields.length > 0, hasFocusable: all.length > 0,
    });
    if (kind === "cancel" && focusEl(box.querySelector(spec?.cancel ?? "[data-dialog-cancel]"))) return;
    if (kind === "submit" && focusEl(box.querySelector("[type=submit]:not([disabled])"))) return;
    if (kind === "field" && focusEl(fields[0])) return;
    // El botón de cerrar (×) de la cabecera es mal sitio para empezar: un
    // Enter cerraría. Se prefiere el primer control del cuerpo.
    const body = all.filter((el) => !el.closest(".modal-header") && !el.classList.contains("modal-close"));
    if ((kind === "first" || kind === "cancel" || kind === "submit") && focusEl(body[0] ?? all[0])) return;
    focusContainer(box);
  }

  /** Aplica `inert` (o `aria-hidden` si no hay soporte) según la pila. */
  function applyBackground() {
    const plan = backgroundPlan(stack);
    /** @type {Set<Element>} */
    const wanted = new Set();
    if (plan.background) for (const el of background()) if (el) wanted.add(el);
    for (const id of plan.dialogs) {
      const overlay = overlayOf(id);
      if (overlay) wanted.add(overlay);
    }
    for (const el of [...inertByUs]) {
      if (wanted.has(el)) continue;
      if (supportsInert) /** @type {HTMLElement} */ (el).inert = false;
      else el.removeAttribute("aria-hidden");
      inertByUs.delete(el);
    }
    for (const el of wanted) {
      if (inertByUs.has(el)) continue;
      if (supportsInert) /** @type {HTMLElement} */ (el).inert = true;
      else el.setAttribute("aria-hidden", "true");
      inertByUs.add(el);
    }
    // Con varios diálogos, el de arriba de la pila se pinta encima aunque su
    // capa fija sea menor (el centro de actividad abierto desde un aviso con
    // un modal secundario debajo): el que recibe el teclado debe verse.
    const top = topDialog(stack);
    for (const id of registry.keys()) {
      overlayOf(id)?.classList.toggle(TOP_LAYER_CLASS, stack.length > 1 && top?.id === id);
    }
  }

  /** @param {Element|null} active */
  function openerFor(active) {
    return resolveOpener(active && active !== doc.body ? active : null) ?? active;
  }

  /**
   * Muestra un diálogo (o lo sube a la cima) y le da el foco.
   * @param {string} id
   * @param {{ opener?: Element|null, initialFocus?: string|(() => Element|null), focus?: boolean }} [opts]
   */
  function show(id, opts = {}) {
    const spec = registry.get(id);
    const overlay = overlayOf(id);
    if (!spec || !overlay) return;
    overlay.classList.remove("hidden");
    const wasOpen = stack.some((item) => item.id === id);
    if (!wasOpen) {
      let opener = opts.opener ?? null;
      if (!opener && pendingRestore) {
        // Un diálogo que se cierra para dar paso a otro (la paleta que ejecuta,
        // una credencial que se reabre): el nuevo hereda a dónde volver.
        opener = /** @type {Element|null} */ (pendingRestore.target);
      }
      if (!opener) {
        const active = doc.activeElement;
        opener = active && overlay.contains(active) ? previousFocus : openerFor(active);
      }
      pendingRestore = null;
      stack = openDialog(stack, { id, opener, modal: spec.modal !== false });
    } else {
      stack = openDialog(stack, { id, modal: spec.modal !== false });
    }
    applyBackground();
    const box = dialogOf(id);
    const alreadyInside = box && doc.activeElement && box.contains(doc.activeElement) && doc.activeElement !== box;
    if (opts.focus !== false && (opts.initialFocus || !alreadyInside)) focusInitial(id, opts.initialFocus);
  }

  /** @param {unknown} target */
  function restoreTo(target) {
    const active = doc.activeElement;
    // Si el cierre ya ha colocado el foco en un sitio válido (p. ej. el
    // terminal tras el editor de comandos), no se le corrige.
    if (active && active !== doc.body && isVisible(active) && !isInert(active)) return;
    const top = topDialog(stack);
    let candidates = [target, ...(top ? [] : fallbackFocus())]
      .filter(Boolean)
      .map((el) => ({
        target: /** @type {Element} */ (el),
        connected: el instanceof Element && el.isConnected,
        visible: isVisible(/** @type {Element} */ (el)),
        inert: isInert(/** @type {Element} */ (el)),
      }));
    // Por orden: el disparador; si ya no existe (la sidebar se repinta), el
    // terminal activo; después la búsqueda de conexiones.
    for (let chosen = pickRestore(candidates); chosen; chosen = pickRestore(candidates)) {
      if (focusEl(chosen)) return;
      const tried = chosen;
      candidates = candidates.filter((c) => c.target !== tried);
    }
    if (top) focusInitial(top.id, undefined);
  }

  /**
   * Oculta un diálogo y, en una microtarea, devuelve el foco a quien lo abrió.
   * La vuelta se cancela si mientras tanto se abre otro diálogo (que la hereda).
   * @param {string} id
   * @param {{ restoreFocus?: boolean }} [opts]
   */
  function hide(id, { restoreFocus = true } = {}) {
    const overlay = overlayOf(id);
    if (overlay && !overlay.classList.contains("hidden")) overlay.classList.add("hidden");
    const res = closeDialog(stack, id);
    if (!res.found) return;
    stack = res.stack;
    applyBackground();
    if (!restoreFocus || !res.wasTop) return;
    const token = {};
    pendingRestore = { target: res.restore, token };
    queueMicrotask(() => {
      if (pendingRestore?.token !== token) return;
      pendingRestore = null;
      restoreTo(res.restore);
    });
  }

  /** Reconcilia la pila con lo que de verdad se ve (red de seguridad). */
  function reconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const id of registry.keys()) {
        const overlay = overlayOf(id);
        const visible = !!overlay && overlay.isConnected && !overlay.classList.contains("hidden");
        const inStack = stack.some((item) => item.id === id);
        if (visible && !inStack) show(id);
        else if (!visible && inStack) hide(id);
      }
    } finally {
      reconciling = false;
    }
  }

  /**
   * @param {string} id
   * @param {DialogSpec} spec
   */
  function register(id, spec) {
    registry.set(id, spec);
    const overlay = overlayOf(id);
    if (overlay && typeof MutationObserver !== "undefined") {
      observer ??= new MutationObserver(() => reconcile());
      observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
    }
    if (overlay && !overlay.classList.contains("hidden")) reconcile();
  }

  /** @param {KeyboardEvent} e */
  function handleTab(e) {
    const top = topDialog(stack);
    if (!top) return;
    const box = dialogOf(top.id);
    if (!(box instanceof HTMLElement)) return;
    const active = doc.activeElement;
    const inside = !!active && box.contains(active);
    // Fuera del diálogo pero en una capa permitida (lista de un desplegable,
    // un aviso): el navegador sabe hacerlo.
    if (!inside && active && active !== doc.body && !isInert(active)) return;
    const list = focusables(box);
    const index = inside && active ? list.indexOf(/** @type {HTMLElement} */ (active)) : -1;
    const next = trapIndex(index, list.length, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    if (next === -1) focusContainer(box);
    else focusEl(list[next]);
  }

  /** @param {KeyboardEvent} e */
  function handleKeydown(e) {
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (!e.defaultPrevented) handleTab(e);
      return;
    }
    if (e.key !== "Escape") return;
    if (hasOpenPopover()) return;
    const target = escapeTarget(stack, e);
    if (!target) return;
    const spec = registry.get(target);
    if (!spec || spec.escape === false) return;
    e.preventDefault();
    spec.close();
  }

  /**
   * Guardia de foco: con un modal abierto, nada de lo de detrás puede
   * recibirlo (renderView o un `terminal.focus()` pendiente). Con `inert` no
   * llega a pasar; sin soporte, esto lo corrige.
   * @param {FocusEvent} e
   */
  function handleFocusIn(e) {
    const el = e.target instanceof Element ? e.target : null;
    previousFocus = currentFocus;
    currentFocus = el;
    const top = topDialog(stack);
    if (!top || !el || !isInert(el)) return;
    const box = dialogOf(top.id);
    if (!(box instanceof HTMLElement) || box.contains(el)) return;
    const prev = previousFocus;
    if (prev && box.contains(prev) && focusEl(prev)) return;
    focusInitial(top.id, undefined);
  }

  /**
   * Engancha los escuchadores (una vez, en el arranque). El teclado va en
   * `window` y en burbuja: así corre después de cualquier componente del
   * documento (desplegables, selector de carpeta, editor de notas) que haya
   * consumido su Escape o su Tab con `preventDefault`.
   */
  function bind() {
    (doc.defaultView ?? window).addEventListener("keydown", handleKeydown);
    doc.addEventListener("focusin", handleFocusIn, true);
  }

  return {
    register, show, hide, bind, reconcile, handleKeydown, handleFocusIn,
    /** @param {string} [id] */
    isOpen: (id) => (id ? stack.some((item) => item.id === id) : stack.length > 0),
    hasModal: () => stack.some((item) => item.modal),
    top: () => topDialog(stack)?.id ?? null,
    /** @param {string} shortcutId */
    allowShortcut: (shortcutId) => allowShortcutInDialog(shortcutId, stack),
  };
}
