import { describe, expect, it, vi } from "vitest";
import { createPausableTimer, toastDurationMs } from "./toast-timer.js";

/** Reloj y planificador manuales: avanzar el tiempo dispara lo vencido. */
function fakeClock() {
  let time = 0;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const tasks = new Map();
  let seq = 0;
  return {
    now: () => time,
    schedule: (fn, ms) => { seq += 1; tasks.set(seq, { at: time + ms, fn }); return seq; },
    unschedule: (id) => { tasks.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, task] of [...tasks]) {
        if (task.at <= time) { tasks.delete(id); task.fn(); }
      }
    },
    pending: () => tasks.size,
  };
}

describe("temporizador de avisos", () => {
  it("caduca a su hora si nadie lo toca", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    createPausableTimer({ ms: 3500, onExpire, ...clock });
    clock.advance(3499);
    expect(onExpire).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("en pausa no caduca y al reanudar sigue donde se quedó", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    const timer = createPausableTimer({ ms: 8000, onExpire, ...clock });
    clock.advance(7000);
    timer.pause("hover");
    clock.advance(60000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(timer.remaining()).toBe(1000);
    timer.resume("hover");
    clock.advance(999);
    expect(onExpire).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("las causas de pausa se acumulan: ratón fuera con el foco dentro sigue parado", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    const timer = createPausableTimer({ ms: 1000, onExpire, ...clock });
    timer.pause("hover");
    timer.pause("focus");
    timer.resume("hover");
    clock.advance(5000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(timer.isPaused()).toBe(true);
    timer.resume("focus");
    clock.advance(1000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("reanudar una causa que no estaba no arranca nada", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    const timer = createPausableTimer({ ms: 1000, onExpire, ...clock });
    timer.pause("focus");
    timer.resume("hover");
    clock.advance(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("reiniciar en pausa conserva la pausa con el tiempo nuevo", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    const timer = createPausableTimer({ ms: 1000, onExpire, ...clock });
    timer.pause("hover");
    timer.restart(4000);
    clock.advance(10000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.resume("hover");
    clock.advance(4000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("parar cancela sin disparar", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    const timer = createPausableTimer({ ms: 1000, onExpire, ...clock });
    timer.stop();
    clock.advance(5000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("un aviso sin caducidad no programa nada", () => {
    const clock = fakeClock();
    const onExpire = vi.fn();
    const timer = createPausableTimer({ ms: Infinity, onExpire, ...clock });
    expect(clock.pending()).toBe(0);
    timer.pause("hover");
    timer.resume("hover");
    expect(clock.pending()).toBe(0);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("duración de los avisos", () => {
  it("normal respeta la duración de cada aviso", () => {
    expect(toastDurationMs(3500, "normal")).toBe(3500);
    expect(toastDurationMs(8000)).toBe(8000);
  });

  it("larga dobla con un mínimo de 10 s", () => {
    expect(toastDurationMs(3500, "long")).toBe(10000);
    expect(toastDurationMs(8000, "long")).toBe(16000);
  });

  it("hasta cerrarlos no caduca", () => {
    expect(toastDurationMs(3500, "sticky")).toBe(Infinity);
  });

  it("pedir 0 es «hasta que se cierre», en cualquier modo", () => {
    expect(toastDurationMs(0, "normal")).toBe(Infinity);
    expect(toastDurationMs(0, "long")).toBe(Infinity);
  });

  it("un modo desconocido o una duración inválida caen al comportamiento de siempre", () => {
    expect(toastDurationMs(3500, "eterno")).toBe(3500);
    expect(toastDurationMs(Number.NaN)).toBe(3500);
    expect(toastDurationMs(-1)).toBe(3500);
  });
});
