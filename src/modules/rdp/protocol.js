// @ts-check
/**
 * Decodificador de los fotogramas binarios del RDP integrado.
 *
 * Espejo de `src-tauri/src/rdp_embedded/frames.rs`: cabecera `tipo: u8`,
 * `seq: u32` (little endian) y un cuerpo según el tipo. Los píxeles se
 * devuelven como **vistas** sobre el buffer recibido (sin copiar): el canvas
 * los pinta en el mismo frame y el buffer se suelta después.
 */

export const MSG_RECTS = 1;
export const MSG_DESKTOP_SIZE = 2;
export const MSG_POINTER_BITMAP = 3;
export const MSG_POINTER_DEFAULT = 4;
export const MSG_POINTER_HIDDEN = 5;

/**
 * @typedef {{ x: number, y: number, w: number, h: number, data: Uint8ClampedArray }} FrameRect
 * @typedef {{ type: "rects", seq: number, rects: FrameRect[] }
 *   | { type: "desktop-size", seq: number, width: number, height: number }
 *   | { type: "pointer-bitmap", seq: number, width: number, height: number, hotspotX: number, hotspotY: number, data: Uint8ClampedArray }
 *   | { type: "pointer-default", seq: number }
 *   | { type: "pointer-hidden", seq: number }} Frame
 */

/**
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {Frame | null} `null` si el mensaje está mal formado o es de un tipo
 *   desconocido (versión distinta del backend): se ignora sin romper la sesión.
 */
export function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const seq = view.getUint32(1, true);
  let pos = 5;
  /** @param {number} n */
  const need = (n) => pos + n <= bytes.byteLength;
  const u16 = () => {
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  };
  /**
   * @param {number} w
   * @param {number} h
   */
  const pixels = (w, h) => {
    const len = w * h * 4;
    if (!need(len)) return null;
    const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + pos, len);
    pos += len;
    return data;
  };

  switch (type) {
    case MSG_RECTS: {
      if (!need(2)) return null;
      const count = u16();
      /** @type {FrameRect[]} */
      const rects = [];
      for (let i = 0; i < count; i++) {
        if (!need(8)) return null;
        const x = u16();
        const y = u16();
        const w = u16();
        const h = u16();
        const data = pixels(w, h);
        if (!data) return null;
        if (w > 0 && h > 0) rects.push({ x, y, w, h, data });
      }
      return { type: "rects", seq, rects };
    }
    case MSG_DESKTOP_SIZE: {
      if (!need(4)) return null;
      return { type: "desktop-size", seq, width: u16(), height: u16() };
    }
    case MSG_POINTER_BITMAP: {
      if (!need(8)) return null;
      const width = u16();
      const height = u16();
      const hotspotX = u16();
      const hotspotY = u16();
      const data = pixels(width, height);
      if (!data) return null;
      return { type: "pointer-bitmap", seq, width, height, hotspotX, hotspotY, data };
    }
    case MSG_POINTER_DEFAULT:
      return { type: "pointer-default", seq };
    case MSG_POINTER_HIDDEN:
      return { type: "pointer-hidden", seq };
    default:
      return null;
  }
}
