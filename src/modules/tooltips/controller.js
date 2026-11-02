// @ts-check
import { placeTooltip, preferredSide, tooltipTextFor } from "./placement.js";

/**
 * Tooltips propios: una única burbuja en `<body>` que enseña el `title`, el
 * `data-tooltip` o (en botones de solo icono) el `aria-label` del elemento que
 * hay bajo el puntero o con el foco del teclado.
 *
 * Por qué no basta el `title`: en Linux el webview (WebKitGTK) no pinta su
 * tooltip nativo, y los de CSS (`[data-tooltip]::after`) los recortaban los
 * contenedores con `overflow`. Esta burbuja vive fuera de todo y sale igual en
 * las tres plataformas.
 *
 * Para que en Windows y macOS no salgan dos tooltips (el nativo y este),
 * mientras el puntero está sobre un elemento su atributo `title` se retira y se
 * devuelve al salir. Durante ese rato `el.title` sigue leyendo y escribiendo el
 * valor guardado (una propiedad propia del elemento), y un `setAttribute`
 * ajeno se recoge con un `MutationObserver`: el código de la app que reescribe
 * tooltips en caliente (pestañas, barra de estado) no nota nada.
 */

/** Selector de controles que, al enfocarse con el teclado, enseñan su tooltip. */
const FOCUS_TARGETS = "button, a[href], summary, [role=button], [role=tab], [role=link], [role=switch]";

/**
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {number} [opts.delay] Espera antes de enseñarlo (ms).
 * @param {number} [opts.warmDelay] Espera si se acaba de cerrar otro (ms).
 */
export function createTooltipController({ doc = document, delay = 450, warmDelay = 60 } = {}) {
  const win = doc.defaultView || window;
  /** @type {HTMLElement|null} */
  let bubble = null;
  /** Elemento cuyo tooltip está pedido o visible. */
  /** @type {HTMLElement|null} */
  let current = null;
  /** Elementos a los que se ha retirado el `title`, con su valor. */
  /** @type {Map<HTMLElement, string>} */
  const stashed = new Map();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let showTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let watchTimer = null;
  let lastHiddenAt = 0;
  let enabled = false;
  /** Tras un clic no se vuelve a enseñar hasta salir del elemento. */
  let suppressedFor = /** @type {HTMLElement|null} */ (null);

  const observer = new win.MutationObserver((mutations) => {
    for (const m of mutations) {
      const el = /** @type {HTMLElement} */ (m.target);
      if (!stashed.has(el) || !el.hasAttribute("title")) continue;
      // Alguien ha vuelto a poner el atributo: es el valor nuevo.
      stashed.set(el, el.getAttribute("title") || "");
      el.removeAttribute("title");
      if (el === current) refresh();
    }
  });

  /** La burbuja, creada la primera vez. */
  function ensureBubble() {
    if (bubble?.isConnected) return bubble;
    bubble = doc.createElement("div");
    bubble.id = "app-tooltip";
    bubble.className = "app-tooltip";
    bubble.setAttribute("role", "tooltip");
    bubble.hidden = true;
    doc.body.appendChild(bubble);
    return bubble;
  }

  /** @param {HTMLElement} el */
  function textOf(el) {
    return tooltipTextFor({
      tooltip: el.getAttribute("data-tooltip"),
      title: stashed.has(el) ? stashed.get(el) : el.getAttribute("title"),
      ariaLabel: el.getAttribute("aria-label"),
      tagName: el.tagName,
      role: el.getAttribute("role"),
      visibleText: el.textContent || "",
      optOut: el.hasAttribute("data-no-tooltip"),
    });
  }

  /**
   * El elemento con tooltip más cercano subiendo desde `target`.
   * @param {EventTarget|null} target
   */
  function findTarget(target) {
    let el = target instanceof win.Element ? target : null;
    while (el && el !== doc.body) {
      if (el instanceof win.HTMLElement) {
        if (el.hasAttribute("data-no-tooltip")) return null;
        // El terminal pinta su propio contenido: nada de burbujas encima.
        if (el.classList.contains("xterm")) return null;
        if (textOf(el)) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Retira el `title` del elemento y de sus antepasados (el nativo de un
   * antepasado también saldría encima del nuestro).
   * @param {HTMLElement} el
   */
  function stashChain(el) {
    /** @type {HTMLElement|null} */
    let node = el;
    while (node && node !== doc.body) {
      if (!stashed.has(node) && node.hasAttribute("title")) stash(node);
      node = node.parentElement;
    }
  }

  /** @param {HTMLElement} el */
  function stash(el) {
    stashed.set(el, el.getAttribute("title") || "");
    el.removeAttribute("title");
    Object.defineProperty(el, "title", {
      configurable: true,
      get: () => stashed.get(el) ?? "",
      set: (value) => {
        stashed.set(el, String(value ?? ""));
        if (el === current) refresh();
      },
    });
    observer.observe(el, { attributes: true, attributeFilter: ["title"] });
  }

  /** Devuelve los `title` retirados. */
  function restoreAll() {
    observer.disconnect();
    for (const [el, value] of stashed) {
      // Quitar la propiedad propia deja otra vez la del prototipo (el atributo).
      delete (/** @type {any} */ (el)).title;
      if (value) el.setAttribute("title", value);
    }
    stashed.clear();
  }

  /** Cancela la espera pendiente. */
  function clearTimers() {
    if (showTimer) clearTimeout(showTimer);
    showTimer = null;
  }

  /** Oculta la burbuja sin soltar el elemento. */
  function hide() {
    clearTimers();
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    if (bubble && !bubble.hidden) {
      bubble.hidden = true;
      lastHiddenAt = Date.now();
    }
  }

  /** Cierra y suelta el elemento actual (devuelve sus `title`). */
  function release() {
    hide();
    current = null;
    restoreAll();
  }

  /** Repinta la burbuja visible con el texto actual del elemento. */
  function refresh() {
    if (!current || !bubble || bubble.hidden) return;
    const text = textOf(current);
    if (!text) { hide(); return; }
    show(current);
  }

  /** @param {HTMLElement} el */
  function show(el) {
    if (!enabled || !el.isConnected) return;
    const text = textOf(el);
    if (!text) return;
    const tip = ensureBubble();
    tip.textContent = text;
    tip.classList.toggle("is-multiline", text.includes("\n") || el.classList.contains("tooltip-multiline"));
    // Medir con la burbuja visible pero sin enseñarla aún.
    tip.style.left = "0px";
    tip.style.top = "0px";
    tip.style.visibility = "hidden";
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) { tip.hidden = true; tip.style.visibility = ""; return; }
    const placed = placeTooltip({
      anchor: rect,
      tip: { width: tip.offsetWidth, height: tip.offsetHeight },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      prefer: preferredSide(el.getAttribute("data-tooltip-pos")),
    });
    tip.style.left = `${placed.left}px`;
    tip.style.top = `${placed.top}px`;
    tip.dataset.side = placed.side;
    tip.style.visibility = "";
    // Si el elemento desaparece (la lista se repinta) o deja de verse, fuera.
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!current || !current.isConnected || current.getClientRects().length === 0) release();
    }, 250);
  }

  /** @param {HTMLElement} el */
  function request(el) {
    if (el === current) return;
    release();
    current = el;
    stashChain(el);
    const wait = Date.now() - lastHiddenAt < 400 ? warmDelay : delay;
    showTimer = setTimeout(() => show(el), wait);
  }

  /** @param {PointerEvent} ev */
  function onPointerOver(ev) {
    if (ev.pointerType === "touch") return;
    const el = findTarget(ev.target);
    if (!el) { if (current) release(); return; }
    if (el === suppressedFor) return;
    suppressedFor = null;
    request(el);
  }

  /** @param {PointerEvent} ev */
  function onPointerOut(ev) {
    if (!current) return;
    const to = ev.relatedTarget;
    if (to instanceof win.Node && current.contains(to)) return;
    // Al salir al antepasado con tooltip, `pointerover` no salta: hay que
    // buscarlo desde el destino.
    const next = findTarget(to);
    if (suppressedFor && suppressedFor !== next) suppressedFor = null;
    if (next && next !== suppressedFor) request(next);
    else release();
  }

  /** Un clic cierra la burbuja y no la reabre hasta salir del elemento. */
  function onPointerDown() {
    if (!current) return;
    suppressedFor = current;
    hide();
  }

  /** @param {FocusEvent} ev */
  function onFocusIn(ev) {
    const target = ev.target;
    if (!(target instanceof win.HTMLElement) || !target.matches(FOCUS_TARGETS)) return;
    let visible = false;
    try { visible = target.matches(":focus-visible"); } catch { visible = false; }
    if (!visible || !textOf(target)) return;
    suppressedFor = null;
    request(target);
  }

  /** @param {FocusEvent} ev */
  function onFocusOut(ev) {
    if (current && ev.target === current) release();
  }

  /** @param {KeyboardEvent} ev */
  function onKeyDown(ev) {
    // Escape descarta la burbuja (WCAG 1.4.13) sin quitarle el Escape a nadie.
    if (ev.key === "Escape" && bubble && !bubble.hidden) hide();
  }

  /**
   * Solo cuenta el desplazamiento que mueve el elemento: el terminal hace
   * scroll sin parar mientras llega salida y no debe cerrar la burbuja de un
   * icono de la barra de estado.
   * @param {Event} ev
   */
  function onScroll(ev) {
    if (!current) return;
    const target = ev.target;
    if (target === doc || target === doc.documentElement
      || (target instanceof win.Node && target.contains(current))) release();
  }

  const listeners = /** @type {Array<[string, EventListener, AddEventListenerOptions]>} */ ([
    ["pointerover", /** @type {EventListener} */ (onPointerOver), { capture: true, passive: true }],
    ["pointerout", /** @type {EventListener} */ (onPointerOut), { capture: true, passive: true }],
    ["pointerdown", onPointerDown, { capture: true, passive: true }],
    ["focusin", /** @type {EventListener} */ (onFocusIn), { capture: true }],
    ["focusout", /** @type {EventListener} */ (onFocusOut), { capture: true }],
    ["keydown", /** @type {EventListener} */ (onKeyDown), { capture: true }],
    ["wheel", () => { if (current) release(); }, { capture: true, passive: true }],
    ["scroll", onScroll, { capture: true, passive: true }],
  ]);

  /** La ventana pierde el foco: nada queda flotando. */
  function onBlurWindow() { release(); }

  return {
    /** @param {boolean} on */
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) {
        for (const [type, fn, opts] of listeners) doc.addEventListener(type, fn, opts);
        win.addEventListener("blur", onBlurWindow);
      } else {
        for (const [type, fn, opts] of listeners) doc.removeEventListener(type, fn, opts);
        win.removeEventListener("blur", onBlurWindow);
        release();
      }
    },
    /** Cierra la burbuja visible (p. ej. al abrir un menú). */
    hide: release,
    isEnabled: () => enabled,
  };
}
