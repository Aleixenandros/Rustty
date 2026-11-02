// @ts-check
import { describe, it, expect } from "vitest";
import { decodeFrame, MSG_RECTS, MSG_DESKTOP_SIZE, MSG_POINTER_BITMAP, MSG_POINTER_HIDDEN } from "./protocol.js";

// Cabecera `tipo, seq` en little endian.
const header = (type, seq) => [type, seq & 0xff, (seq >> 8) & 0xff, (seq >> 16) & 0xff, (seq >>> 24) & 0xff];
const u16 = (v) => [v & 0xff, v >> 8];

describe("decodeFrame", () => {
  it("decodifica RECTS con sus píxeles como vista sin copiar", () => {
    const px = [1, 2, 3, 255, 4, 5, 6, 255];
    const bytes = Uint8Array.from([...header(MSG_RECTS, 7), ...u16(1), ...u16(10), ...u16(20), ...u16(2), ...u16(1), ...px]);
    const f = decodeFrame(bytes);
    expect(f?.type).toBe("rects");
    if (f?.type !== "rects") return;
    expect(f.seq).toBe(7);
    expect(f.rects).toHaveLength(1);
    expect(f.rects[0]).toMatchObject({ x: 10, y: 20, w: 2, h: 1 });
    expect([...f.rects[0].data]).toEqual(px);
    expect(f.rects[0].data.buffer).toBe(bytes.buffer);
  });

  it("decodifica el mensaje igual que lo codifica el backend (frames.rs)", () => {
    // Mismo vector que `codifica_mensajes_de_control` en Rust.
    const f = decodeFrame(Uint8Array.from([2, 1, 0, 0, 0, 0x80, 7, 0x38, 4]));
    expect(f).toEqual({ type: "desktop-size", seq: 1, width: 1920, height: 1080 });
    expect(decodeFrame(Uint8Array.from([5, 3, 0, 0, 0]))).toEqual({ type: "pointer-hidden", seq: 3 });
  });

  it("respeta el byteOffset de una vista", () => {
    const inner = [...header(MSG_DESKTOP_SIZE, 2), ...u16(800), ...u16(600)];
    const buf = Uint8Array.from([9, 9, 9, ...inner]);
    expect(decodeFrame(buf.subarray(3))).toEqual({ type: "desktop-size", seq: 2, width: 800, height: 600 });
  });

  it("decodifica el puntero", () => {
    const bytes = Uint8Array.from([...header(MSG_POINTER_BITMAP, 4), ...u16(1), ...u16(1), ...u16(0), ...u16(0), 9, 9, 9, 9]);
    const f = decodeFrame(bytes.buffer);
    expect(f?.type).toBe("pointer-bitmap");
  });

  it("ignora mensajes truncados o de tipo desconocido sin lanzar", () => {
    expect(decodeFrame(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeFrame(Uint8Array.from([...header(MSG_RECTS, 1), ...u16(1), ...u16(0), ...u16(0), ...u16(2), ...u16(2), 1, 2]))).toBeNull();
    expect(decodeFrame(Uint8Array.from(header(42, 1)))).toBeNull();
    expect(decodeFrame(Uint8Array.from(header(MSG_POINTER_HIDDEN, 1)))?.type).toBe("pointer-hidden");
  });
});
