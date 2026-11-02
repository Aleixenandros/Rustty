// @ts-check
/**
 * Vista de una sesión RDP integrada: un `<canvas>` del tamaño del escritorio
 * remoto que pinta los rectángulos que cambian.
 *
 * Los mensajes llegan por un `Channel` de Tauri como bytes crudos. No se pintan
 * al llegar sino en el siguiente `requestAnimationFrame` (varios mensajes en un
 * mismo frame se pintan juntos), y tras pintar se confirma al backend el último
 * `seq`: sin esa confirmación el backend deja de enviar y acumula los cambios,
 * de modo que un webview lento no hace crecer la memoria.
 */

import { decodeFrame } from "./protocol.js";
import { attachInput } from "./input.js";

/**
 * @typedef {object} RdpCanvasView
 * @property {any} channel `Channel` para `rdp_embed_connect` (`onFrame`)
 * @property {HTMLElement} element contenedor del canvas
 * @property {() => void} focus
 * @property {(connected: boolean) => void} setActive
 * @property {() => { width: number, height: number, scale: number }} measure
 *   tamaño en píxeles físicos del hueco disponible y escala en %
 * @property {() => void} dispose
 */

/**
 * @param {object} deps
 * @param {string} deps.sessionId
 * @param {(cmd: string, args?: any, opts?: any) => Promise<any>} deps.invoke
 * @param {new () => any} deps.Channel
 * @param {(size: { width: number, height: number }) => void} [deps.onDesktopSize]
 * @returns {RdpCanvasView}
 */
export function createRdpCanvasView({ sessionId, invoke, Channel, onDesktopSize }) {
  const element = document.createElement("div");
  element.className = "rdp-canvas-host";
  const canvas = document.createElement("canvas");
  canvas.className = "rdp-canvas";
  canvas.width = 1;
  canvas.height = 1;
  const keyTarget = document.createElement("textarea");
  keyTarget.className = "rdp-key-target";
  keyTarget.setAttribute("aria-hidden", "true");
  keyTarget.setAttribute("autocomplete", "off");
  keyTarget.setAttribute("autocapitalize", "off");
  keyTarget.spellcheck = false;
  keyTarget.tabIndex = -1;
  element.append(canvas, keyTarget);

  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { alpha: false }));
  let active = false;
  let disposed = false;

  /** @type {Uint8Array[]} */
  let queue = [];
  let scheduled = false;
  let lastSeq = 0;
  /** @type {Map<string, string>} cursores ya convertidos a PNG */
  const cursorCache = new Map();
  const stats = { since: performance.now(), frames: 0, messages: 0, bytes: 0, paintMs: 0, worstMs: 0 };

  const draw = () => {
    scheduled = false;
    if (disposed) return;
    const pending = queue;
    queue = [];
    const started = performance.now();
    let maxSeq = lastSeq;
    for (const bytes of pending) {
      // El `seq` se confirma aunque el mensaje no se entienda: si no, un
      // mensaje raro dejaría al backend esperando para siempre.
      if (bytes.byteLength >= 5) {
        maxSeq = new DataView(bytes.buffer, bytes.byteOffset, 5).getUint32(1, true);
      }
      const frame = decodeFrame(bytes);
      if (!frame) continue;
      switch (frame.type) {
        case "rects":
          for (const r of frame.rects) {
            ctx.putImageData(new ImageData(/** @type {any} */ (r.data), r.w, r.h), r.x, r.y);
          }
          break;
        case "desktop-size":
          // Cambiar el tamaño del canvas lo borra: el servidor repinta entero
          // tras una reactivación, así que no hace falta conservar nada.
          canvas.width = frame.width;
          canvas.height = frame.height;
          onDesktopSize?.({ width: frame.width, height: frame.height });
          break;
        case "pointer-bitmap":
          setCursorBitmap(canvas, frame, cursorCache);
          break;
        case "pointer-default":
          canvas.style.cursor = "default";
          break;
        case "pointer-hidden":
          canvas.style.cursor = "none";
          break;
      }
    }
    if (maxSeq !== lastSeq) {
      lastSeq = maxSeq;
      invoke("rdp_embed_ack", { sessionId, seq: maxSeq }).catch(() => {});
    }
    recordPaint(stats, pending, performance.now() - started);
  };

  const channel = new Channel();
  channel.onmessage = (/** @type {ArrayBuffer | Uint8Array | number[]} */ msg) => {
    if (disposed) return;
    const bytes = msg instanceof Uint8Array
      ? msg
      : msg instanceof ArrayBuffer
        ? new Uint8Array(msg)
        : Uint8Array.from(msg);
    queue.push(bytes);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(draw);
    }
  };

  // Portapapeles: lo copiado en local se anuncia al remoto al entrar en el
  // escritorio y justo antes de un atajo de pegar (el backend no hace nada si
  // no cambió desde lo último anunciado). El aviso sale antes que la tecla:
  // la entrada se agrupa y se envía en el siguiente frame.
  const syncClipboard = () => {
    if (!active || disposed) return;
    invoke("rdp_embed_clipboard_sync", { sessionId }).catch(() => {});
  };
  const onPasteKey = (/** @type {KeyboardEvent} */ e) => {
    const k = e.key.toLowerCase();
    if (((e.ctrlKey || e.metaKey) && k === "v") || (e.shiftKey && k === "insert")) syncClipboard();
  };
  const onWindowFocus = () => {
    if (document.activeElement === keyTarget) syncClipboard();
  };
  keyTarget.addEventListener("focus", syncClipboard);
  keyTarget.addEventListener("keydown", onPasteKey, true);
  window.addEventListener("focus", onWindowFocus);

  const detachInput = attachInput({
    canvas,
    keyTarget,
    isActive: () => active && !disposed,
    send: (bytes) => {
      invoke("rdp_embed_input", bytes, { headers: { "x-session": sessionId } }).catch(() => {});
    },
  });

  return {
    channel,
    element,
    focus: () => keyTarget.focus({ preventScroll: true }),
    setActive: (connected) => {
      active = connected;
      element.classList.toggle("is-active", connected);
    },
    measure: () => {
      const dpr = window.devicePixelRatio || 1;
      // El hueco es el del panel: el contenedor del canvas está oculto hasta
      // que la sesión conecta.
      const r = (element.parentElement ?? element).getBoundingClientRect();
      return {
        width: Math.max(200, Math.floor(r.width * dpr)),
        height: Math.max(200, Math.floor(r.height * dpr)),
        scale: Math.round(dpr * 100),
      };
    },
    dispose: () => {
      disposed = true;
      active = false;
      queue = [];
      detachInput();
      keyTarget.removeEventListener("focus", syncClipboard);
      keyTarget.removeEventListener("keydown", onPasteKey, true);
      window.removeEventListener("focus", onWindowFocus);
      channel.onmessage = () => {};
      element.remove();
    },
  };
}

const STATS_INTERVAL_MS = 5000;
const CURSOR_CACHE_MAX = 64;

/**
 * Acumula el coste de pintar y lo escribe en la consola (nivel debug) cada
 * pocos segundos: junto con las estadísticas del backend dice si el cuello de
 * botella está en el canvas o antes.
 * @param {{ since: number, frames: number, messages: number, bytes: number, paintMs: number, worstMs: number }} stats
 * @param {Uint8Array[]} batch
 * @param {number} ms
 */
function recordPaint(stats, batch, ms) {
  stats.frames += 1;
  stats.messages += batch.length;
  for (const b of batch) stats.bytes += b.byteLength;
  stats.paintMs += ms;
  stats.worstMs = Math.max(stats.worstMs, ms);
  const now = performance.now();
  const elapsed = now - stats.since;
  if (elapsed < STATS_INTERVAL_MS) return;
  const secs = elapsed / 1000;
  console.debug(
    `[rdp] ${(stats.frames / secs).toFixed(1)} pintados/s, ${(stats.messages / secs).toFixed(1)} msg/s, `
      + `${(stats.bytes / secs / 1048576).toFixed(1)} MiB/s, pintar ${(stats.paintMs / stats.frames).toFixed(2)} ms `
      + `(peor ${stats.worstMs.toFixed(1)} ms)`,
  );
  Object.assign(stats, { since: now, frames: 0, messages: 0, bytes: 0, paintMs: 0, worstMs: 0 });
}

/**
 * Clave de un cursor: tamaño, punto activo y un FNV-1a de sus píxeles (unos
 * pocos KB): el servidor repite las mismas formas a menudo.
 * @param {{ width: number, height: number, hotspotX: number, hotspotY: number, data: Uint8ClampedArray }} p
 */
function cursorKey(p) {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.data.length; i++) {
    h ^= p.data[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${p.width}x${p.height}@${p.hotspotX},${p.hotspotY}#${(h >>> 0).toString(16)}`;
}

/**
 * Pone el puntero remoto como cursor CSS del canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {{ width: number, height: number, hotspotX: number, hotspotY: number, data: Uint8ClampedArray }} p
 * @param {Map<string, string>} cache
 */
function setCursorBitmap(canvas, p, cache) {
  if (p.width === 0 || p.height === 0) {
    canvas.style.cursor = "none";
    return;
  }
  const key = cursorKey(p);
  const cached = cache.get(key);
  if (cached) {
    canvas.style.cursor = cached;
    return;
  }
  const c = document.createElement("canvas");
  c.width = p.width;
  c.height = p.height;
  const cctx = c.getContext("2d");
  if (!cctx) return;
  // Copia: el buffer del mensaje se recicla tras pintar.
  cctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  const css = `url(${c.toDataURL("image/png")}) ${p.hotspotX} ${p.hotspotY}, default`;
  if (cache.size >= CURSOR_CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
  cache.set(key, css);
  canvas.style.cursor = css;
}
