// @ts-check
import { describe, it, expect } from "vitest";
import { createMetricsPoller } from "./metrics-poller.js";

/** Promesa que el test resuelve o rechaza a mano. */
function deferred() {
  /** @type {(v: any) => void} */
  let resolve = () => {};
  /** @type {(e: any) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Deja correr las continuaciones pendientes de las promesas. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Sondeo con muestreo y temporizadores bajo control del test.
 * @param {{ interval?: number }} [opts]
 */
function harness(opts = {}) {
  const interval = opts.interval ?? 1000;
  /** @type {{ fresh: boolean, d: ReturnType<typeof deferred> }[]} */
  const calls = [];
  /** @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const timers = [];
  /** @type {any[]} */
  const samples = [];
  /** @type {any[]} */
  const errors = [];
  let ms = interval;
  const poller = createMetricsPoller({
    sample: (fresh) => {
      const d = deferred();
      calls.push({ fresh, d });
      return d.promise;
    },
    onSample: (v) => samples.push(v),
    onError: (e) => errors.push(e),
    intervalMs: () => ms,
    setTimer: (fn, wait) => {
      const t = { fn, ms: wait, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { /** @type {any} */ (t).cleared = true; },
  });
  const fire = () => {
    const t = timers.find((x) => !x.cleared && !(/** @type {any} */ (x).fired));
    if (!t) throw new Error("no hay temporizador pendiente");
    /** @type {any} */ (t).fired = true;
    t.fn();
  };
  return { poller, calls, timers, samples, errors, fire, setInterval: (/** @type {number} */ v) => { ms = v; } };
}

describe("createMetricsPoller", () => {
  it("la primera muestra va fresca y las siguientes no", async () => {
    const h = harness();
    h.poller.start();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fresh).toBe(true);
    h.calls[0].d.resolve("m0");
    await flush();
    expect(h.samples).toEqual(["m0"]);
    expect(h.timers).toHaveLength(1);
    h.fire();
    expect(h.calls[1].fresh).toBe(false);
  });

  it("nunca pide dos muestras a la vez: la siguiente espera a la anterior", async () => {
    const h = harness();
    h.poller.start();
    // Mientras la primera no vuelve, no hay temporizador ni otra petición.
    expect(h.timers).toHaveLength(0);
    h.poller.start(); // idempotente
    expect(h.calls).toHaveLength(1);
    h.calls[0].d.resolve("m0");
    await flush();
    expect(h.timers).toHaveLength(1);
  });

  it("un error se avisa y el sondeo sigue", async () => {
    const h = harness();
    h.poller.start();
    h.calls[0].d.reject(new Error("timeout"));
    await flush();
    expect(h.errors).toHaveLength(1);
    expect(h.samples).toEqual([]);
    expect(h.timers).toHaveLength(1);
    h.fire();
    h.calls[1].d.resolve("m1");
    await flush();
    expect(h.samples).toEqual(["m1"]);
  });

  it("lo que vuelve tras apagar se descarta, aunque se haya vuelto a encender", async () => {
    const h = harness();
    h.poller.start();
    h.poller.stop();
    h.poller.start(); // generación nueva, también fresca
    expect(h.calls.map((c) => c.fresh)).toEqual([true, true]);
    h.calls[0].d.resolve("vieja");
    await flush();
    expect(h.samples).toEqual([]);
    // La vieja tampoco programa nada: solo la vigente seguirá el ritmo.
    expect(h.timers).toHaveLength(0);
    h.calls[1].d.resolve("nueva");
    await flush();
    expect(h.samples).toEqual(["nueva"]);
    expect(h.timers).toHaveLength(1);
  });

  it("apagar cancela la siguiente vuelta programada", async () => {
    const h = harness();
    h.poller.start();
    h.calls[0].d.resolve("m0");
    await flush();
    expect(h.poller.isRunning()).toBe(true);
    h.poller.stop();
    expect(h.poller.isRunning()).toBe(false);
    expect(h.timers[0].cleared).toBe(true);
    h.poller.stop(); // idempotente
  });

  it("el intervalo se lee en cada vuelta", async () => {
    const h = harness({ interval: 3000 });
    h.poller.start();
    h.calls[0].d.resolve("m0");
    await flush();
    expect(h.timers[0].ms).toBe(3000);
    h.setInterval(1000);
    h.fire();
    h.calls[1].d.resolve("m1");
    await flush();
    expect(h.timers[1].ms).toBe(1000);
  });
});
