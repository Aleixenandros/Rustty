// @ts-check
/**
 * Capa de la selección rápida sobre un terminal xterm: pinta las etiquetas
 * que calcula el núcleo puro (`quick-select.js`), escucha el teclado mientras
 * está activa y copia (o copia y pega) lo elegido.
 *
 * Es una capa propia y no `registerDecoration`: xterm no admite decoraciones
 * en el buffer alternativo, que es justo donde viven less, htop, vim o k9s.
 *
 * Mientras está activa ninguna tecla llega al servidor: el teclado se escucha
 * en `window` en fase de captura (antes que los atajos globales y que xterm)
 * y además `disableStdin` corta en xterm lo que pudiera colarse por otro
 * camino (una composición de IME). Un clic, un cambio de tamaño o de buffer
 * la cancelan; el desplazamiento mueve las etiquetas con su texto (un
 * marcador de xterm sigue las líneas aunque el scrollback pode por arriba).
 */
import {
  BUILTIN_QUICK_SELECT_RULES, assignQuickSelectLabels, compileQuickSelectPatterns,
  findQuickSelectMatches, quickSelectHintPlacement, readViewportLines, resolveQuickSelectKey,
} from "./quick-select.js";

/** Caracteres del texto copiado que se enseñan en el aviso. */
const TOAST_PREVIEW = 80;

/**
 * @param {object} deps
 * @param {() => any} deps.getPrefs
 * @param {(text: string) => unknown} deps.copy Escribe en el portapapeles.
 * @param {(session: any, text: string) => void} deps.paste Escribe en la sesión.
 * @param {(message: string, kind?: string, ms?: number) => unknown} deps.toast
 * @param {(key: string, params?: Record<string, unknown>) => string} deps.t
 * @param {(event: KeyboardEvent) => boolean} deps.isToggleKey El atajo que la abre (la cierra).
 * @param {() => boolean} deps.hasModal Un diálogo modal se queda el teclado.
 * @param {(session: any) => void} [deps.restoreInput] Devuelve la entrada del
 *   terminal a su estado real al cerrar (el modo solo lectura pudo cambiar
 *   mientras estaba abierta, p. ej. por un break-pane de tmux); sin él, se
 *   restaura el valor que tenía al abrir.
 */
export function createQuickSelect({ getPrefs, copy, paste, toast, t, isToggleKey, hasModal, restoreInput }) {
  /** @type {any} */
  let active = null;
  /** @type {{ snapshot: string|null, rules: import("./quick-select.js").QsRule[] }} */
  let cache = { snapshot: null, rules: [] };

  /** Patrones propios compilados, con caché por contenido (como el resaltado). */
  function customRules() {
    const raw = getPrefs().quickSelectPatterns;
    const snapshot = JSON.stringify(raw ?? null);
    if (snapshot !== cache.snapshot) cache = { snapshot, rules: compileQuickSelectPatterns(raw) };
    return cache.rules;
  }

  /**
   * Abre la selección rápida sobre el terminal de la sesión (o la cierra si
   * ya estaba abierta en ella). Devuelve `false` si no hay terminal que leer.
   * @param {any} session
   * @returns {boolean}
   */
  function start(session) {
    if (active) {
      const same = active.session === session;
      cancel();
      if (same) return true;
    }
    const terminal = session?.terminal;
    const screen = terminal?.element?.querySelector(".xterm-screen");
    if (!(screen instanceof HTMLElement) || !terminal.rows || !terminal.cols) return false;

    const buffer = terminal.buffer.active;
    const rules = [...customRules(), ...(getPrefs().quickSelectBuiltins === false ? [] : BUILTIN_QUICK_SELECT_RULES)];
    const { matches } = findQuickSelectMatches(readViewportLines(buffer, terminal.rows), { rules, rows: terminal.rows });
    const { targets } = assignQuickSelectLabels(matches);
    if (!targets.length) {
      toast(t("terminal.quick_select_none"), "info");
      return true;
    }

    // Celda en píxeles CSS: xterm fija el tamaño de `.xterm-screen` a
    // columnas × ancho de celda (con el interletrado y el interlineado ya
    // aplicados), así que basta dividir.
    const cellW = (parseFloat(screen.style.width) || screen.offsetWidth) / terminal.cols;
    const cellH = (parseFloat(screen.style.height) || screen.offsetHeight) / terminal.rows;

    const layer = document.createElement("div");
    layer.className = "quick-select-layer";
    layer.style.fontFamily = terminal.options.fontFamily || "";
    layer.style.fontSize = `${terminal.options.fontSize}px`;
    const marks = document.createElement("div");
    marks.className = "quick-select-marks";
    /** @type {HTMLElement[]} */
    const labelEls = [];
    /**
     * @param {HTMLElement} el
     * @param {number} row
     * @param {number} col
     * @param {number} width
     */
    const place = (el, row, col, width) => {
      el.style.left = `${col * cellW}px`;
      el.style.top = `${row * cellH}px`;
      el.style.width = `${width * cellW}px`;
      el.style.height = `${cellH}px`;
      el.style.lineHeight = `${cellH}px`;
    };
    for (const target of targets) {
      for (const occurrence of target.occurrences) {
        for (const segment of occurrence.segments) {
          const hit = document.createElement("div");
          hit.className = "quick-select-match";
          place(hit, segment.row, segment.col, segment.width);
          marks.appendChild(hit);
        }
        const label = document.createElement("span");
        label.className = "quick-select-label";
        label.textContent = target.label;
        label.dataset.label = target.label;
        label.dataset.text = target.text;
        place(label, occurrence.row, occurrence.col, target.label.length);
        marks.appendChild(label);
        labelEls.push(label);
      }
    }
    const hint = document.createElement("div");
    hint.className = "quick-select-hint";
    hint.setAttribute("role", "status");
    hint.textContent = t("terminal.quick_select_hint");
    layer.append(marks, hint);
    screen.appendChild(layer);
    placeHint(hint, labelEls);

    // Ancla en la última fila visible (la última en podarse) para seguir el
    // texto si la pantalla se desplaza: por la rueda, por salida nueva o
    // porque el scrollback lleno descarta líneas por arriba.
    /** @type {any} */
    let marker = null;
    try {
      marker = terminal.registerMarker(buffer.viewportY + terminal.rows - 1 - (buffer.baseY + buffer.cursorY));
    } catch {
      marker = null;
    }

    const prevStdin = terminal.options.disableStdin;
    terminal.options.disableStdin = true;
    active = {
      session, terminal, layer, marks, labelEls, targets,
      labels: targets.map((target) => target.label),
      rows: [...new Set(targets.flatMap((target) => target.occurrences.map((o) => o.row)))],
      typed: "", paste: false, prevStdin, cellH, shift: 0,
      marker, markerLine0: marker?.line ?? 0, viewportY0: buffer.viewportY,
      disposables: [
        terminal.onResize(() => cancel()),
        terminal.buffer.onBufferChange(() => cancel()),
        terminal.onScroll(() => follow()),
        terminal.onRender(() => follow()),
      ],
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    return true;
  }

  /**
   * Pone el aviso donde no tape etiquetas (ver `quickSelectHintPlacement`):
   * se mide en las dos posiciones con el aviso ya en el DOM.
   * @param {HTMLElement} hint
   * @param {HTMLElement[]} labelEls
   */
  function placeHint(hint, labelEls) {
    const labels = labelEls.map((el) => el.getBoundingClientRect());
    hint.classList.remove("is-top");
    const atBottom = hint.getBoundingClientRect();
    hint.classList.add("is-top");
    const atTop = hint.getBoundingClientRect();
    const where = quickSelectHintPlacement(labels, atBottom, atTop);
    hint.classList.toggle("is-top", where === "top");
    hint.hidden = where === "hidden";
  }

  /** Recoloca las etiquetas si el texto se ha movido en pantalla. */
  function follow() {
    if (!active) return;
    const { terminal, marker } = active;
    if (marker && (marker.isDisposed || marker.line < 0)) { cancel(); return; }
    const markerShift = marker ? marker.line - active.markerLine0 : 0;
    const shift = markerShift - (terminal.buffer.active.viewportY - active.viewportY0);
    if (shift === active.shift) return;
    // Si la salida nueva (un `tail -f`) se ha llevado todas las etiquetas, no
    // queda nada que elegir: se cierra y devuelve el teclado.
    if (!active.rows.some((/** @type {number} */ row) => row + shift >= 0 && row + shift < terminal.rows)) {
      cancel();
      return;
    }
    active.shift = shift;
    active.marks.style.transform = shift ? `translateY(${shift * active.cellH}px)` : "";
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (!active) return;
    // Un diálogo que aparece encima (una pregunta del backend) o una pestaña
    // que deja de verse se quedan el teclado: la selección se cierra sola.
    if (hasModal()) {
      cancel();
      return;
    }
    // La capa desapareció sin que el usuario hiciera nada (la pane de tmux se
    // cerró y el foco saltó a otra pestaña): la tecla era una letra de
    // etiqueta y no debe llegar a otro servidor (una «q» cierra less o top).
    if (!active.layer.isConnected || active.layer.offsetParent === null) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.isComposing) return;
    if (isToggleKey(event)) { cancel(); return; }
    const result = resolveQuickSelectKey(active.labels, active, event);
    if (result.type === "cancel") cancel();
    else if (result.type === "pending") {
      active.typed = result.typed;
      active.paste = result.paste;
      for (const el of active.labelEls) {
        el.classList.toggle("is-dimmed", !!result.typed && !el.dataset.label?.startsWith(result.typed));
      }
    } else if (result.type === "select") choose(result.label, result.paste);
  }

  /** Un clic en cualquier sitio cierra la selección (y sigue su camino). */
  function onPointer() {
    cancel();
  }

  /**
   * @param {string} label
   * @param {boolean} alsoPaste
   */
  function choose(label, alsoPaste) {
    const { session, targets } = active;
    const target = targets.find((/** @type {any} */ x) => x.label === label);
    cancel();
    if (!target) return;
    Promise.resolve(copy(target.text)).catch(() => {});
    if (alsoPaste) paste(session, target.text);
    const shown = target.text.length > TOAST_PREVIEW ? `${target.text.slice(0, TOAST_PREVIEW - 1)}…` : target.text;
    toast(t("toast.host_copied", { host: shown }), "success");
  }

  /** Cierra la selección rápida y devuelve el terminal a su estado. */
  function cancel() {
    if (!active) return;
    const state = active;
    active = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onPointer, true);
    for (const disposable of state.disposables) {
      try { disposable.dispose(); } catch { /* terminal ya cerrado */ }
    }
    try { state.marker?.dispose(); } catch { /* terminal ya cerrado */ }
    try {
      if (restoreInput) restoreInput(state.session);
      else state.terminal.options.disableStdin = state.prevStdin;
    } catch { /* terminal ya cerrado */ }
    state.layer.remove();
  }

  return { start, cancel, isActive: () => active !== null };
}
