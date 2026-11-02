// @ts-check
import { RESIZE_DIRECTIONS, clampFrame, moveFrame, parseStoredFrame, resizeFrame } from "./frame-geometry.js";

/**
 * Diálogo movible (arrastrando su cabecera) y, si se pide, redimensionable
 * desde bordes y esquinas. Recuerda posición y tamaño en este equipo
 * (`localStorage`: depende de la pantalla, no se sincroniza). Doble clic en la
 * cabecera lo devuelve al tamaño y sitio de fábrica.
 *
 * El diálogo sigue centrado por su overlay; el marco solo añade un
 * desplazamiento (`position: relative` + `left`/`top`) y, redimensionable, un
 * ancho y alto explícitos. Sin marco guardado no se toca su estilo: manda el
 * CSS de siempre.
 */

/** Lo que no arrastra: los controles de la cabecera siguen siendo controles. */
const NO_DRAG = "button, a, input, select, textarea, label, [role=tab], [role=button], [contenteditable=\"true\"]";

/**
 * @typedef {import("./frame-geometry.js").Frame} Frame
 * @typedef {import("./frame-geometry.js").Limits} Limits
 * @typedef {import("./frame-geometry.js").Direction} Direction
 */

/**
 * @param {HTMLElement} dialog
 * @param {object} opts
 * @param {HTMLElement} opts.handle Zona de arrastre (la cabecera).
 * @param {string} opts.storageKey
 * @param {Limits} opts.limits
 * @param {boolean} [opts.resizable] Añade tiradores en bordes y esquinas.
 * @param {() => number} [opts.zoom] Zoom de la interfaz que escala el diálogo.
 * @param {Pick<Storage, "getItem"|"setItem"|"removeItem">} [opts.storage]
 * @param {(frame: Frame|null) => void} [opts.onChange] Tras mover, redimensionar o restablecer.
 */
export function attachDialogFrame(dialog, {
  handle, storageKey, limits, resizable = true, zoom = () => 1,
  storage = globalThis.localStorage, onChange = () => {},
}) {
  const win = dialog.ownerDocument.defaultView || window;
  /** @type {Frame|null} */
  let frame = null;

  dialog.classList.add("dialog-framed");
  if (resizable) dialog.classList.add("dialog-resizable");
  handle.classList.add("dialog-drag-handle");

  const z = () => {
    const value = Number(zoom());
    return Number.isFinite(value) && value > 0 ? value : 1;
  };
  const viewport = () => ({ width: win.innerWidth / z(), height: win.innerHeight / z() });

  /** Marco actual: el guardado o, sin él, el que tiene ahora en pantalla. */
  function measured() {
    const rect = dialog.getBoundingClientRect();
    const k = z();
    return {
      width: rect.width / k,
      height: rect.height / k,
      dx: (rect.left + rect.width / 2 - win.innerWidth / 2) / k,
      dy: (rect.top + rect.height / 2 - win.innerHeight / 2) / k,
    };
  }

  /** @param {Frame|null} next */
  function write(next) {
    frame = next;
    const style = dialog.style;
    if (!next) {
      for (const prop of ["position", "left", "top"]) style.removeProperty(prop);
      if (resizable) {
        for (const prop of ["width", "height", "max-width", "max-height", "min-width", "min-height"]) style.removeProperty(prop);
      }
      return;
    }
    style.position = "relative";
    style.left = `${next.dx}px`;
    style.top = `${next.dy}px`;
    if (resizable) {
      style.width = `${next.width}px`;
      style.height = `${next.height}px`;
      style.maxWidth = "none";
      style.maxHeight = "none";
      style.minWidth = "0";
      style.minHeight = "0";
    }
  }

  /** Guarda el marco actual en este equipo. */
  function persist() {
    if (!frame) return;
    try { storage?.setItem(storageKey, JSON.stringify(frame)); } catch { /* sin almacenamiento: solo esta vez */ }
  }

  /**
   * Coloca el diálogo según lo guardado (al abrirlo y al cambiar la ventana).
   * Sin marco guardado deja el CSS de fábrica.
   */
  function apply() {
    // Manda lo guardado; solo sin almacenamiento disponible se conserva el
    // marco de esta sesión.
    let base = frame;
    try { base = parseStoredFrame(storage?.getItem(storageKey) ?? null); } catch { base = frame; }
    if (!base) { write(null); return; }
    // Sin redimensionar (lo hace el CSS), el tamaño es el que tenga ahora.
    const size = resizable ? base : { ...base, width: measured().width, height: measured().height };
    write(clampFrame(size, viewport(), limits));
  }

  /** Vuelve al tamaño y sitio de fábrica y olvida lo guardado. */
  function reset() {
    try { storage?.removeItem(storageKey); } catch { /* nada que borrar */ }
    write(null);
    onChange(null);
  }

  /**
   * Bucle común de arrastre: captura el puntero y aplica `step` a cada
   * movimiento con el desplazamiento acumulado (en píxeles del diálogo).
   * @param {PointerEvent} ev
   * @param {(start: Frame, dx: number, dy: number) => Frame} step
   * @param {HTMLElement} captureEl
   */
  function track(ev, step, captureEl) {
    const start = clampFrame(frame ?? measured(), viewport(), limits);
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const k = z();
    let moved = false;
    try { captureEl.setPointerCapture(ev.pointerId); } catch { /* sin captura: sigue funcionando dentro */ }
    dialog.classList.add("dialog-dragging");
    /** @param {PointerEvent} e */
    const onMove = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      const dx = (e.clientX - x0) / k;
      const dy = (e.clientY - y0) / k;
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      moved = true;
      write(step(start, dx, dy));
    };
    /** @param {PointerEvent} e */
    const onUp = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      captureEl.removeEventListener("pointermove", onMove);
      captureEl.removeEventListener("pointerup", onUp);
      captureEl.removeEventListener("pointercancel", onUp);
      dialog.classList.remove("dialog-dragging");
      if (moved) { persist(); onChange(frame); }
    };
    captureEl.addEventListener("pointermove", onMove);
    captureEl.addEventListener("pointerup", onUp);
    captureEl.addEventListener("pointercancel", onUp);
  }

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !(ev.target instanceof win.Element) || ev.target.closest(NO_DRAG)) return;
    ev.preventDefault();
    track(ev, (start, dx, dy) => moveFrame(start, dx, dy, viewport(), limits), handle);
  });

  handle.addEventListener("dblclick", (ev) => {
    if (!(ev.target instanceof win.Element) || ev.target.closest(NO_DRAG)) return;
    reset();
  });

  if (resizable) {
    for (const dir of RESIZE_DIRECTIONS) {
      const grip = dialog.ownerDocument.createElement("div");
      grip.className = "dialog-resize-handle";
      grip.dataset.dir = dir;
      grip.setAttribute("aria-hidden", "true");
      grip.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        track(ev, (start, dx, dy) => resizeFrame(start, /** @type {Direction} */ (dir), dx, dy, viewport(), limits), grip);
      });
      grip.addEventListener("dblclick", () => reset());
      dialog.appendChild(grip);
    }
  }

  return { apply, reset, current: () => frame };
}
