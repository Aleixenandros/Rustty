import { describe, expect, it } from "vitest";
import { SHELL_CLOSE_GRACE_MS, createShellCloseGate } from "./shell-close.js";

/** Temporizadores de mentira: `run()` dispara lo pendiente, como si venciera el plazo. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    run() { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } },
    get size() { return pending.size; },
    get lastMs() { return [...pending.values()].at(-1)?.ms; },
  };
}

describe("createShellCloseGate", () => {
  it("con la marca de fin ya vista, el cierre avisa al momento", () => {
    const timers = fakeTimers();
    let ready = 0;
    const gate = createShellCloseGate({ onReady: () => ready++, ...timers });
    gate.markDrained();
    expect(ready).toBe(0);
    gate.markClosed();
    expect(ready).toBe(1);
    expect(timers.size).toBe(0);
  });

  it("si el evento de cierre se adelanta, espera a la marca de fin", () => {
    const timers = fakeTimers();
    let ready = 0;
    const gate = createShellCloseGate({ onReady: () => ready++, ...timers });
    gate.markClosed();
    // Aún puede quedar salida de camino: el aviso NO se pinta todavía.
    expect(ready).toBe(0);
    expect(timers.lastMs).toBe(SHELL_CLOSE_GRACE_MS);
    gate.markDrained();
    expect(ready).toBe(1);
    // El plazo de gracia queda desarmado: no hay segundo aviso.
    expect(timers.size).toBe(0);
    timers.run();
    expect(ready).toBe(1);
  });

  it("sin marca de fin, el plazo de gracia pinta el aviso igualmente", () => {
    const timers = fakeTimers();
    let ready = 0;
    const gate = createShellCloseGate({ onReady: () => ready++, graceMs: 50, ...timers });
    gate.markClosed();
    expect(timers.lastMs).toBe(50);
    timers.run();
    expect(ready).toBe(1);
    // Una marca tardía ya no repite el aviso.
    gate.markDrained();
    expect(ready).toBe(1);
  });

  it("avisa una sola vez aunque las señales se repitan", () => {
    const timers = fakeTimers();
    let ready = 0;
    const gate = createShellCloseGate({ onReady: () => ready++, ...timers });
    gate.markClosed();
    gate.markClosed();
    gate.markDrained();
    gate.markDrained();
    timers.run();
    expect(ready).toBe(1);
  });

  it("cancel descarta la espera: una sesión reabierta no recibe el aviso viejo", () => {
    const timers = fakeTimers();
    let ready = 0;
    const gate = createShellCloseGate({ onReady: () => ready++, ...timers });
    gate.markClosed();
    gate.cancel();
    expect(timers.size).toBe(0);
    gate.markDrained();
    timers.run();
    expect(ready).toBe(0);
  });
});
