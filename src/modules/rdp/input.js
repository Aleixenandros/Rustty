// @ts-check
/**
 * Entrada del RDP integrado: codificador del lote binario y captura de
 * ratón/teclado sobre el canvas.
 *
 * Espejo de `src-tauri/src/rdp_embedded/input.rs`. Nada de lo que pasa por aquí
 * se registra en consola ni en logs: son pulsaciones de teclado.
 */

import { scancodeForCode } from "./scancodes.js";

const EV_MOVE = 1;
const EV_BUTTON = 2;
const EV_WHEEL = 3;
const EV_KEY = 4;
const EV_UNICODE = 5;
const EV_RELEASE_ALL = 6;
const EV_SYNC = 7;

/** Unidades de rueda por «muesca» (convención de Windows: WHEEL_DELTA). */
const WHEEL_DELTA = 120;
/** Límite por evento del protocolo (9 bits con signo). */
const WHEEL_MAX = 255;

/** Acumula eventos y los vuelca como un único `Uint8Array`. */
export class InputBatch {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
  }

  /** @param {number} v */
  #u16(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  move(x, y) {
    this.bytes.push(EV_MOVE);
    this.#u16(clampU16(x));
    this.#u16(clampU16(y));
  }

  /**
   * @param {number} button `MouseEvent.button` (0..4)
   * @param {boolean} pressed
   */
  button(button, pressed) {
    if (button < 0 || button > 4) return;
    this.bytes.push(EV_BUTTON, button, pressed ? 1 : 0);
  }

  /**
   * @param {boolean} vertical
   * @param {number} units con signo, ya acotadas
   */
  wheel(vertical, units) {
    this.bytes.push(EV_WHEEL, vertical ? 1 : 0);
    this.#u16(units & 0xffff);
  }

  /**
   * @param {number} scancode
   * @param {boolean} pressed
   */
  key(scancode, pressed) {
    this.bytes.push(EV_KEY);
    this.#u16(scancode);
    this.bytes.push(pressed ? 1 : 0);
  }

  /**
   * @param {string} ch un único punto de código
   * @param {boolean} pressed
   */
  unicode(ch, pressed) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return;
    this.bytes.push(EV_UNICODE, cp & 0xff, (cp >> 8) & 0xff, (cp >> 16) & 0xff, (cp >>> 24) & 0xff, pressed ? 1 : 0);
  }

  releaseAll() {
    this.bytes.push(EV_RELEASE_ALL);
  }

  /** @param {{ scroll?: boolean, num?: boolean, caps?: boolean, kana?: boolean }} locks */
  sync({ scroll = false, num = false, caps = false, kana = false }) {
    this.bytes.push(EV_SYNC, (scroll ? 1 : 0) | (num ? 2 : 0) | (caps ? 4 : 0) | (kana ? 8 : 0));
  }

  get empty() {
    return this.bytes.length === 0;
  }

  /** Vacía el lote y lo devuelve como bytes. */
  take() {
    const out = Uint8Array.from(this.bytes);
    this.bytes = [];
    return out;
  }
}

/** @param {number} v */
function clampU16(v) {
  return Math.max(0, Math.min(0xffff, Math.round(v)));
}

/**
 * Convierte el desplazamiento de un `WheelEvent` a unidades RDP. Positivo =
 * hacia arriba / hacia la derecha, al revés que `deltaY` del navegador.
 * @param {number} delta `deltaY` o `deltaX`
 * @param {number} mode `deltaMode` (0 píxeles, 1 líneas, 2 páginas)
 * @param {boolean} vertical
 */
export function wheelUnits(delta, mode, vertical) {
  const perUnit = mode === 1 ? WHEEL_DELTA / 3 : mode === 2 ? WHEEL_DELTA * 3 : WHEEL_DELTA / 100;
  const raw = Math.round(delta * perUnit) * (vertical ? -1 : 1);
  return Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, raw));
}

/**
 * Captura la entrada de un canvas y la manda en lotes, uno por frame.
 *
 * El foco de teclado lo tiene un `<textarea>` invisible encima del canvas: así
 * llegan también los eventos de composición del IME (japonés, chino, teclas
 * muertas), que un `<canvas>` no recibe.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLTextAreaElement} opts.keyTarget
 * @param {(bytes: Uint8Array) => void} opts.send
 * @param {() => boolean} opts.isActive la sesión está conectada
 * @returns {() => void} desengancha todo
 */
export function attachInput({ canvas, keyTarget, send, isActive }) {
  const batch = new InputBatch();
  let scheduled = false;
  /** @type {{ x: number, y: number } | null} */
  let pendingMove = null;
  let composing = false;

  const flush = () => {
    scheduled = false;
    if (pendingMove) {
      batch.move(pendingMove.x, pendingMove.y);
      pendingMove = null;
    }
    if (!batch.empty && isActive()) send(batch.take());
    else batch.take();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  };
  // Los botones y teclas no esperan al frame: su orden respecto al movimiento
  // importa (arrastrar), así que vuelcan el movimiento pendiente antes.
  const pushNow = () => {
    if (pendingMove) {
      batch.move(pendingMove.x, pendingMove.y);
      pendingMove = null;
    }
  };

  /** @param {MouseEvent} e */
  const toRemote = (e) => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - r.left) * canvas.width) / r.width,
      y: ((e.clientY - r.top) * canvas.height) / r.height,
    };
  };

  /** @param {PointerEvent} e */
  const onMove = (e) => {
    if (!isActive()) return;
    pendingMove = toRemote(e);
    schedule();
  };
  /** @param {PointerEvent} e */
  const onDown = (e) => {
    if (!isActive()) return;
    e.preventDefault();
    keyTarget.focus({ preventScroll: true });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    pendingMove = toRemote(e);
    pushNow();
    batch.button(e.button, true);
    schedule();
  };
  /** @param {PointerEvent} e */
  const onUp = (e) => {
    if (!isActive()) return;
    e.preventDefault();
    pendingMove = toRemote(e);
    pushNow();
    batch.button(e.button, false);
    schedule();
  };
  /** @param {WheelEvent} e */
  const onWheel = (e) => {
    if (!isActive()) return;
    e.preventDefault();
    pushNow();
    if (e.deltaY) batch.wheel(true, wheelUnits(e.deltaY, e.deltaMode, true));
    if (e.deltaX) batch.wheel(false, wheelUnits(e.deltaX, e.deltaMode, false));
    schedule();
  };
  /** @param {MouseEvent} e */
  const onContext = (e) => e.preventDefault();

  /**
   * @param {KeyboardEvent} e
   * @param {boolean} pressed
   */
  const onKey = (e, pressed) => {
    if (!isActive() || composing || e.isComposing) return;
    const sc = scancodeForCode(e.code);
    if (sc !== null) {
      e.preventDefault();
      pushNow();
      batch.key(sc, pressed);
      schedule();
      return;
    }
    // Sin posición física conocida: se manda el carácter, si lo hay.
    if (e.key && [...e.key].length === 1) {
      e.preventDefault();
      pushNow();
      batch.unicode(e.key, pressed);
      schedule();
    }
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => onKey(e, true);
  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => onKey(e, false);
  const onCompStart = () => { composing = true; };
  /** @param {CompositionEvent} e */
  const onCompEnd = (e) => {
    composing = false;
    keyTarget.value = "";
    if (!isActive() || !e.data) return;
    pushNow();
    for (const ch of e.data) {
      batch.unicode(ch, true);
      batch.unicode(ch, false);
    }
    schedule();
  };
  const onInput = () => {
    if (!composing) keyTarget.value = "";
  };
  // Al perder el foco se sueltan todas las teclas: si no, un Alt+Tab local
  // dejaría el Alt pulsado en el remoto.
  const onBlur = () => {
    if (!isActive()) return;
    pendingMove = null;
    batch.releaseAll();
    flush();
  };
  /** @param {KeyboardEvent} e */
  const onFocusSync = (e) => {
    if (!isActive() || typeof e.getModifierState !== "function") return;
    batch.sync({
      caps: e.getModifierState("CapsLock"),
      num: e.getModifierState("NumLock"),
      scroll: e.getModifierState("ScrollLock"),
    });
    keyTarget.removeEventListener("keydown", onFocusSync, true);
  };
  const onFocus = () => keyTarget.addEventListener("keydown", onFocusSync, true);

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContext);
  keyTarget.addEventListener("keydown", onKeyDown);
  keyTarget.addEventListener("keyup", onKeyUp);
  keyTarget.addEventListener("compositionstart", onCompStart);
  keyTarget.addEventListener("compositionend", onCompEnd);
  keyTarget.addEventListener("input", onInput);
  keyTarget.addEventListener("blur", onBlur);
  keyTarget.addEventListener("focus", onFocus);

  return () => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContext);
    keyTarget.removeEventListener("keydown", onKeyDown);
    keyTarget.removeEventListener("keyup", onKeyUp);
    keyTarget.removeEventListener("compositionstart", onCompStart);
    keyTarget.removeEventListener("compositionend", onCompEnd);
    keyTarget.removeEventListener("input", onInput);
    keyTarget.removeEventListener("blur", onBlur);
    keyTarget.removeEventListener("focus", onFocus);
    keyTarget.removeEventListener("keydown", onFocusSync, true);
  };
}
