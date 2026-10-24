import { describe, expect, it } from "vitest";
import { createPromptQueue } from "./prompt-queue.js";

/** Macrotareas de mentira: `flush()` ejecuta lo diferido, como el `setTimeout(…, 0)`. */
function fakeSchedule() {
  const tasks = [];
  return {
    schedule: (fn) => { tasks.push(fn); },
    flush() { while (tasks.length) tasks.shift()(); },
    get size() { return tasks.length; },
  };
}

/** Deja correr las microtareas (los `.then` de las promesas resueltas). */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createPromptQueue", () => {
  it("un segundo diálogo espera: no resuelve el primero ni se pinta hasta cerrarlo", async () => {
    const sched = fakeSchedule();
    const q = createPromptQueue({ schedule: sched.schedule });
    const shown = [];
    let firstResult = "pendiente";
    q.request(() => { shown.push("A"); }).then((r) => { firstResult = r; });
    const second = q.request(() => { shown.push("B"); });

    await tick();
    expect(shown).toEqual(["A"]);
    expect(firstResult).toBe("pendiente");
    expect(q.pending()).toBe(1);

    q.close({ value: "secreto-A" });
    await tick();
    expect(firstResult).toEqual({ value: "secreto-A" });
    // El siguiente se abre en una macrotarea, no en el mismo tick.
    expect(shown).toEqual(["A"]);
    sched.flush();
    expect(shown).toEqual(["A", "B"]);

    q.close(true);
    expect(await second).toBe(true);
    expect(q.isOpen()).toBe(false);
  });

  it("respeta el orden FIFO y un paso nuevo del recién resuelto va detrás", async () => {
    const sched = fakeSchedule();
    const q = createPromptQueue({ schedule: sched.schedule });
    const shown = [];
    const mfa = q.request(() => { shown.push("mfa-1"); }).then(() =>
      q.request(() => { shown.push("mfa-2"); }));
    q.request(() => { shown.push("hostkey"); });
    q.request(() => { shown.push("password"); });

    q.close({ value: "123456" });
    await tick();
    sched.flush();
    q.close(true);
    await tick();
    sched.flush();
    q.close({ value: "pw" });
    await tick();
    sched.flush();
    expect(shown).toEqual(["mfa-1", "hostkey", "password", "mfa-2"]);
    q.close({ value: "654321" });
    expect(await mfa).toEqual({ value: "654321" });
  });

  it("pinta al tocarle, no al pedirse, y limpia antes de resolver y de abrir el siguiente", async () => {
    const sched = fakeSchedule();
    const q = createPromptQueue({ schedule: sched.schedule });
    const log = [];
    q.request(() => { log.push("show A"); return () => log.push("clean A"); })
      .then(() => log.push("resolved A"));
    q.request(() => { log.push("show B"); return () => log.push("clean B"); });
    expect(log).toEqual(["show A"]);

    q.close(null);
    expect(log).toEqual(["show A", "clean A"]);
    await tick();
    sched.flush();
    expect(log).toEqual(["show A", "clean A", "resolved A", "show B"]);
  });

  it("si pintar falla, esa petición se resuelve null y la cola sigue", async () => {
    const q = createPromptQueue({ schedule: (fn) => fn() });
    const shown = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      q.request(() => { shown.push("A"); });
      const broken = q.request(() => { throw new Error("sin modal"); });
      q.request(() => { shown.push("C"); });
      q.close(true);
      expect(await broken).toBe(null);
      expect(shown).toEqual(["A", "C"]);
      expect(q.isOpen()).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  it("una pregunta que caduca esperando turno no se muestra y deja pasar a la vigente", async () => {
    const sched = fakeSchedule();
    let clock = 1000;
    const q = createPromptQueue({ schedule: sched.schedule, now: () => clock });
    const shown = [];
    q.request(() => { shown.push("visible"); });
    const caducada = q.request(() => { shown.push("caducada"); }, { expiresAt: 1500 });
    const vigente = q.request(() => { shown.push("vigente"); }, { expiresAt: 5000 });
    clock = 2000; // la segunda caducó mientras la primera seguía a la vista
    q.close(true);
    sched.flush();
    expect(await caducada).toBeNull();
    expect(shown).toEqual(["visible", "vigente"]);
    q.close("ok");
    expect(await vigente).toBe("ok");
  });

  it("ignora el envío mientras el diálogo recién mostrado no está armado", () => {
    let clock = 1000;
    const q = createPromptQueue({ schedule: (fn) => fn(), now: () => clock });
    expect(q.canSubmit()).toBe(false); // sin diálogo no hay nada que enviar
    q.request(() => {}, { armMs: 400 });
    expect(q.canSubmit()).toBe(false);
    clock += 399;
    expect(q.canSubmit()).toBe(false);
    clock += 1;
    expect(q.canSubmit()).toBe(true);
    q.close(true);
    // El siguiente se arma desde que se muestra, no desde que se pidió.
    q.request(() => {}, { armMs: 400 });
    expect(q.canSubmit()).toBe(false);
    q.close(null);
    q.request(() => {});
    expect(q.canSubmit()).toBe(true);
  });

  it("cerrar sin diálogo visible no hace nada", () => {
    const q = createPromptQueue();
    expect(q.close(true)).toBe(false);
  });
});
