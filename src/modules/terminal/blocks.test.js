// @ts-check
import { describe, it, expect } from "vitest";
import {
  createBlockTracker,
  handleOsc133,
  blockAt,
  nextBlock,
  pruneBlocksBefore,
  removeBlock,
} from "./blocks.js";

describe("handleOsc133", () => {
  it("un ciclo completo A→B→C→D construye el bloque", () => {
    const s = createBlockTracker();
    expect(handleOsc133(s, "A", 10)).toBe(true);
    expect(handleOsc133(s, "B", 11)).toBe(true);
    expect(handleOsc133(s, "C", 12)).toBe(true);
    expect(handleOsc133(s, "D;0", 20)).toBe(true);
    expect(s.blocks).toEqual([
      {
        id: 1,
        promptLine: 10, promptCol: 0,
        commandLine: 11, commandCol: 0,
        outputLine: 12, outputCol: 0,
        endLine: 20, endCol: 0,
        exitCode: 0,
      },
    ]);
  });

  it("registra la columna de cada marcador (recorte del prompt)", () => {
    const s = createBlockTracker();
    handleOsc133(s, "A", 4, 0);
    handleOsc133(s, "B", 4, 13);
    handleOsc133(s, "C", 5, 0);
    handleOsc133(s, "D;0", 9, 2);
    expect(s.blocks[0]).toMatchObject({
      promptCol: 0, commandCol: 13, outputCol: 0, endCol: 2,
    });
  });

  it("una columna ausente o inválida queda en 0, nunca en NaN", () => {
    const s = createBlockTracker();
    handleOsc133(s, "A", 0);
    handleOsc133(s, "B", 0, NaN);
    handleOsc133(s, "C", 1, -3);
    expect(s.blocks[0]).toMatchObject({ promptCol: 0, commandCol: 0, outputCol: 0 });
  });

  it("captura el código de salida distinto de cero y el D sin código", () => {
    const s = createBlockTracker();
    handleOsc133(s, "A", 0);
    handleOsc133(s, "D;127", 3);
    handleOsc133(s, "A", 4);
    handleOsc133(s, "D", 6);
    expect(s.blocks[0].exitCode).toBe(127);
    expect(s.blocks[1].exitCode).toBe(null);
    expect(s.blocks[1].endLine).toBe(6);
  });

  it("un A con bloque abierto lo cierra implícitamente (comando interrumpido)", () => {
    const s = createBlockTracker();
    handleOsc133(s, "A", 0);
    handleOsc133(s, "B", 1);
    // Nunca llegó el D (Ctrl+C, shell sin hook de fin): el prompt nuevo cierra.
    handleOsc133(s, "A", 8);
    expect(s.blocks[0].endLine).toBe(7);
    expect(s.blocks[0].exitCode).toBe(null);
    expect(s.blocks[1].promptLine).toBe(8);
  });

  it("B/C/D sin bloque abierto y payloads desconocidos se ignoran", () => {
    const s = createBlockTracker();
    expect(handleOsc133(s, "B", 1)).toBe(false);
    expect(handleOsc133(s, "C", 2)).toBe(false);
    expect(handleOsc133(s, "D;0", 3)).toBe(false);
    expect(handleOsc133(s, "Z", 4)).toBe(false);
    expect(handleOsc133(s, "", 5)).toBe(false);
    expect(s.blocks).toEqual([]);
  });

  it("el tope de bloques desaloja el más antiguo", () => {
    const s = createBlockTracker(2);
    handleOsc133(s, "A", 0);
    handleOsc133(s, "D;0", 1);
    handleOsc133(s, "A", 2);
    handleOsc133(s, "D;0", 3);
    handleOsc133(s, "A", 4);
    expect(s.blocks.map((b) => b.id)).toEqual([2, 3]);
  });
});

describe("consultas", () => {
  /** Tres bloques: [0..4], [5..9] y abierto desde 10. */
  function tracker() {
    const s = createBlockTracker();
    handleOsc133(s, "A", 0);
    handleOsc133(s, "D;0", 4);
    handleOsc133(s, "A", 5);
    handleOsc133(s, "D;1", 9);
    handleOsc133(s, "A", 10);
    return s;
  }

  it("blockAt localiza por línea, incluido el bloque abierto", () => {
    const s = tracker();
    expect(blockAt(s, 0)?.id).toBe(1);
    expect(blockAt(s, 4)?.id).toBe(1);
    expect(blockAt(s, 7)?.id).toBe(2);
    expect(blockAt(s, 999)?.id).toBe(3);
    expect(blockAt(createBlockTracker(), 3)).toBe(null);
  });

  it("nextBlock navega en ambas direcciones sin vuelta circular", () => {
    const s = tracker();
    expect(nextBlock(s, 0, 1)?.id).toBe(2);
    expect(nextBlock(s, 7, 1)?.id).toBe(3);
    expect(nextBlock(s, 10, 1)).toBe(null);
    expect(nextBlock(s, 10, -1)?.id).toBe(2);
    expect(nextBlock(s, 5, -1)?.id).toBe(1);
    expect(nextBlock(s, 0, -1)).toBe(null);
  });

  it("pruneBlocksBefore poda lo expulsado del scrollback pero nunca el abierto", () => {
    const s = tracker();
    expect(pruneBlocksBefore(s, 5)).toBe(1);
    expect(s.blocks.map((b) => b.id)).toEqual([2, 3]);
    // El bloque abierto sobrevive aunque su prompt quede por encima.
    expect(pruneBlocksBefore(s, 9999)).toBe(1);
    expect(s.blocks.map((b) => b.id)).toEqual([3]);
  });

  it("removeBlock retira por id y comunica si existía", () => {
    const s = tracker();
    expect(removeBlock(s, 2)).toBe(true);
    expect(s.blocks.map((b) => b.id)).toEqual([1, 3]);
    expect(removeBlock(s, 2)).toBe(false);
  });
});
