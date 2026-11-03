// @ts-check
/**
 * Resolución del escritorio del RDP integrado: «Ajustar a la pestaña» (por
 * defecto) o un tamaño fijo elegido en el menú de la pestaña.
 *
 * Todo lo de aquí es puro (sin DOM ni IPC) para poder probarlo:
 *
 * - `desiredDesktopSize` traduce la elección y el hueco del panel a la
 *   petición que va al backend (píxeles físicos, mismas reglas que
 *   `MonitorLayoutEntry::adjust_display_size`).
 * - `fitCanvasCss` dice a qué tamaño CSS se pinta el canvas: el escritorio
 *   cabe entero en el panel, centrado y sin deformar (con bandas si hace
 *   falta). La entrada mapea con el rectángulo del canvas, así que las
 *   coordenadas siguen bien a cualquier escala.
 * - `createResizeController` decide cuándo pedir el tamaño nuevo: con
 *   antirrebote, solo conectada y visible, sin repetir la misma petición y,
 *   si el servidor no admite Display Control, escalando (ajuste automático) o
 *   reconectando (elección explícita del menú).
 */

/** Tamaños fijos del menú (los habituales de monitor y portátil). */
export const RDP_FIXED_RESOLUTIONS = Object.freeze([
  [1024, 768],
  [1280, 720],
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
]);

/** Espera tras el último cambio del panel antes de pedir el tamaño nuevo. */
export const RESIZE_DEBOUNCE_MS = 400;

/**
 * @typedef {{ mode: "fit" } | { mode: "fixed", width: number, height: number }} RdpResolution
 * @typedef {{ width: number, height: number, scale: number|null }} DesktopRequest
 * @typedef {{ width: number, height: number, dpr: number }} PaneBox
 *   hueco del panel en píxeles CSS y `devicePixelRatio`
 */

/** @type {RdpResolution} */
export const FIT = Object.freeze({ mode: "fit" });

/**
 * Espejo de `MonitorLayoutEntry::adjust_display_size` (MS-RDPEDISP 2.2.2.2.1):
 * ancho par, ambos lados en 200..=8192.
 * @param {number} width
 * @param {number} height
 */
export function adjustDisplaySize(width, height) {
  let w = Math.max(0, Math.floor(width));
  if (w % 2 !== 0) w -= 1;
  const clamp = (/** @type {number} */ v) => Math.min(8192, Math.max(200, v));
  return { width: clamp(w), height: clamp(Math.max(0, Math.floor(height))) };
}

/**
 * Escala del escritorio en % a partir del `devicePixelRatio` (válida 100..=500).
 * @param {number} dpr
 * @returns {number|null}
 */
export function scaleFromDpr(dpr) {
  const s = Math.round((Number(dpr) || 1) * 100);
  return s >= 100 && s <= 500 ? s : null;
}

/**
 * Clave estable de una elección (`fit` o `1280x720`): el `data-*` del menú y
 * lo que se compara para marcarla.
 * @param {RdpResolution} res
 */
export function resolutionKey(res) {
  return res.mode === "fixed" ? `${res.width}x${res.height}` : "fit";
}

/**
 * Elección a partir de su clave; `null` si no es ninguna conocida.
 * @param {unknown} key
 * @returns {RdpResolution|null}
 */
export function parseResolution(key) {
  if (key === "fit") return FIT;
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(key ?? ""));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return RDP_FIXED_RESOLUTIONS.some(([w, h]) => w === width && h === height)
    ? { mode: "fixed", width, height }
    : null;
}

/**
 * Entradas del submenú «Resolución», con la marca en la elegida.
 * @param {RdpResolution} current
 * @returns {{ key: string, fit: boolean, width?: number, height?: number, checked: boolean }[]}
 */
export function resolutionMenuModel(current) {
  const active = resolutionKey(current);
  return [
    { key: "fit", fit: true, checked: active === "fit" },
    ...RDP_FIXED_RESOLUTIONS.map(([width, height]) => {
      const key = `${width}x${height}`;
      return { key, fit: false, width, height, checked: active === key };
    }),
  ];
}

/**
 * Tamaño a pedir al servidor. `null` si el panel no se ve (pestaña oculta:
 * mide 0) y la elección depende de él.
 * @param {RdpResolution} res
 * @param {PaneBox|null} box
 * @returns {DesktopRequest|null}
 */
export function desiredDesktopSize(res, box) {
  const dpr = box?.dpr || 1;
  if (res.mode === "fixed") {
    return { ...adjustDisplaySize(res.width, res.height), scale: scaleFromDpr(dpr) };
  }
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  return {
    ...adjustDisplaySize(box.width * dpr, box.height * dpr),
    scale: scaleFromDpr(dpr),
  };
}

/** Margen dentro del cual un escritorio algo menor que el panel se pinta 1:1. */
const SNAP_RATIO = 1.02;

/**
 * Tamaño CSS del canvas: el escritorio entero dentro del panel, centrado y sin
 * deformar. Un escritorio que casi coincide con el panel (el ancho par del
 * protocolo le quita un píxel) se pinta 1:1 en píxeles físicos, sin difuminar.
 * @param {{ width: number, height: number }} desktop píxeles del escritorio
 * @param {PaneBox|null} box
 * @returns {{ width: number, height: number }|null}
 */
export function fitCanvasCss(desktop, box) {
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  if (!(desktop.width > 0) || !(desktop.height > 0)) return null;
  const dpr = box.dpr || 1;
  const natW = desktop.width / dpr;
  const natH = desktop.height / dpr;
  let s = Math.min(box.width / natW, box.height / natH);
  if (s >= 1 && s <= SNAP_RATIO) s = 1;
  return { width: natW * s, height: natH * s };
}

/**
 * @param {{ width: number, height: number }|null|undefined} a
 * @param {{ width: number, height: number }|null|undefined} b
 */
function sameSize(a, b) {
  return !!a && !!b && a.width === b.width && a.height === b.height;
}

/**
 * Controlador del tamaño de una sesión.
 *
 * - `paneChanged()`: el panel cambió (ventana, barra lateral, división, zoom,
 *   `devicePixelRatio`, pestaña que vuelve a verse). Antirrebote y evaluar.
 * - `setConnected(v)`: sin conexión no se pide nada.
 * - `setDisplayControl(v)`: lo que dijo el backend (`null` = aún no se sabe).
 * - `choose(res)`: elección del menú; se evalúa en el acto.
 * - `desktopChanged()`: llegó un tamaño nuevo del escritorio.
 *
 * Sin Display Control, el ajuste automático solo escala el canvas; una
 * elección del menú (fija o «Ajustar») que no coincide con el escritorio
 * reconecta la sesión a ese tamaño (`reconnect`). Una petición hecha mientras
 * aún no se sabe se manda igual (el backend la guarda) y, si luego resulta que
 * no hay Display Control, se reconecta si venía del menú.
 *
 * @param {object} deps
 * @param {RdpResolution} [deps.resolution]
 * @param {() => PaneBox|null} deps.measure hueco del panel (`null`/0 si no se ve)
 * @param {() => { width: number, height: number }|null} deps.desktopSize
 * @param {(req: DesktopRequest) => void} deps.sendResize
 * @param {(req: DesktopRequest, res: RdpResolution) => void} deps.reconnect
 * @param {number} [deps.debounceMs]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(id: any) => void} [deps.clearTimer]
 */
export function createResizeController({
  resolution = FIT,
  measure,
  desktopSize,
  sendResize,
  reconnect,
  debounceMs = RESIZE_DEBOUNCE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  /** @type {RdpResolution} */
  let res = resolution;
  let connected = false;
  /** @type {boolean|null} */
  let displayControl = null;
  /** Clave de la última petición mandada (no se repite). */
  let lastRequested = "";
  /** Hay una elección del menú sin cumplir. */
  let userPending = false;
  let timer = /** @type {any} */ (null);
  let disposed = false;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const evaluate = () => {
    if (disposed || !connected) return;
    const desired = desiredDesktopSize(res, measure());
    if (!desired) return; // oculta: se vuelve a mirar al verse
    if (sameSize(desired, desktopSize())) {
      userPending = false;
      lastRequested = `${desired.width}x${desired.height}`;
      return;
    }
    const key = `${desired.width}x${desired.height}`;
    if (displayControl === false) {
      if (userPending) {
        userPending = false;
        reconnect(desired, res);
      }
      return;
    }
    if (key === lastRequested) return;
    lastRequested = key;
    if (displayControl === true) userPending = false;
    sendResize(desired);
  };

  const schedule = () => {
    if (disposed) return;
    cancel();
    timer = setTimer(() => {
      timer = null;
      evaluate();
    }, debounceMs);
  };

  return {
    paneChanged: schedule,
    /** @param {boolean} v */
    setConnected(v) {
      connected = v;
      if (v) schedule();
      else cancel();
    },
    /** @param {boolean|null} v */
    setDisplayControl(v) {
      displayControl = v;
      // Sin Display Control el backend descarta lo que tenía guardado; si
      // llega más tarde, ya no hay nada pendiente y se puede volver a pedir.
      // Con `true`, lo guardado ya salió: no se repite.
      if (v === false) lastRequested = "";
      if (v !== null) evaluate();
    },
    /** @param {RdpResolution} next */
    choose(next) {
      res = next;
      lastRequested = "";
      userPending = true;
      cancel();
      evaluate();
    },
    desktopChanged() {
      const desired = desiredDesktopSize(res, measure());
      if (sameSize(desired, desktopSize())) userPending = false;
    },
    get resolution() {
      return res;
    },
    get displayControl() {
      return displayControl;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
