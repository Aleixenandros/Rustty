import { describe, it, expect } from "vitest";
import { createRecorder, feedInput, feedOutput, finish, stepCount } from "./recorder.js";
import { MAX_STEPS } from "./model.js";

// Escribe un comando completo (texto + Intro) en la grabadora.
const typeCommand = (state, text) => {
  feedInput(state, text);
  feedInput(state, "\r");
};

describe("recorder", () => {
  it("un comando genera send + waitPrompt final", () => {
    const r = createRecorder();
    typeCommand(r, "uptime");
    expect(finish(r)).toEqual([
      { type: "send", text: "uptime" },
      { type: "waitPrompt" },
    ]);
  });

  it("varios comandos intercalan waitPrompt entre ellos", () => {
    const r = createRecorder();
    typeCommand(r, "uptime");
    typeCommand(r, "df -h");
    expect(finish(r)).toEqual([
      { type: "send", text: "uptime" },
      { type: "waitPrompt" },
      { type: "send", text: "df -h" },
      { type: "waitPrompt" },
    ]);
  });

  it("ignora líneas vacías (Intro en un prompt vacío)", () => {
    const r = createRecorder();
    feedInput(r, "\r");
    typeCommand(r, "ls");
    feedInput(r, "\r\r");
    expect(finish(r)).toEqual([
      { type: "send", text: "ls" },
      { type: "waitPrompt" },
    ]);
  });

  it("prompt de contraseña: emite sendPasswordFromKeyring sin guardar el texto", () => {
    const r = createRecorder();
    typeCommand(r, "sudo systemctl restart nginx");
    // El servidor pide la contraseña (eco apagado).
    feedOutput(r, "[sudo] password for ada: ");
    // El usuario teclea su contraseña; NO debe aparecer en ningún paso.
    typeCommand(r, "s3cr3t-no-guardar");
    typeCommand(r, "systemctl status nginx");

    const steps = finish(r);
    expect(steps).toEqual([
      { type: "send", text: "sudo systemctl restart nginx" },
      { type: "sendPasswordFromKeyring", profileId: null },
      { type: "waitPrompt" },
      { type: "send", text: "systemctl status nginx" },
      { type: "waitPrompt" },
    ]);
    // Ningún paso contiene la contraseña literal.
    expect(JSON.stringify(steps)).not.toContain("s3cr3t");
  });

  it("detecta el prompt de contraseña aunque venga coloreado (ANSI)", () => {
    const r = createRecorder();
    typeCommand(r, "ssh root@host");
    feedOutput(r, "\x1b[0;32mroot@host's password:\x1b[0m ");
    typeCommand(r, "otra-clave");
    const steps = finish(r);
    expect(steps).toContainEqual({ type: "sendPasswordFromKeyring", profileId: null });
    expect(JSON.stringify(steps)).not.toContain("otra-clave");
  });

  it("un «password:» en mitad de la salida no dispara el modo contraseña", () => {
    const r = createRecorder();
    typeCommand(r, "cat config");
    // La salida menciona password pero NO termina en el prompt: sigue habiendo
    // más contenido después.
    feedOutput(r, "db_password: hunter2\nconexión establecida\n$ ");
    typeCommand(r, "exit");
    const steps = finish(r);
    expect(steps).toContainEqual({ type: "send", text: "exit" });
    expect(steps).not.toContainEqual({ type: "sendPasswordFromKeyring", profileId: null });
  });

  it("backspace y Ctrl+U corrigen la línea antes de Intro", () => {
    const r = createRecorder();
    feedInput(r, "lls");
    feedInput(r, "\x7f"); // borra la 's' → "ll"
    feedInput(r, "\x7f"); // borra una 'l' → "l"
    feedInput(r, "s -la");
    feedInput(r, "\r"); // "ls -la"
    feedInput(r, "basura");
    feedInput(r, "\x15"); // Ctrl+U descarta la línea
    feedInput(r, "pwd\r");
    expect(finish(r)).toEqual([
      { type: "send", text: "ls -la" },
      { type: "waitPrompt" },
      { type: "send", text: "pwd" },
      { type: "waitPrompt" },
    ]);
  });

  it("ignora las secuencias de escape (flechas de historial)", () => {
    const r = createRecorder();
    feedInput(r, "who");
    feedInput(r, "\x1b[A"); // flecha arriba: se ignora el resto del chunk
    feedInput(r, "ami\r"); // se retoma tras la secuencia
    expect(finish(r)).toEqual([
      { type: "send", text: "whoami" },
      { type: "waitPrompt" },
    ]);
  });

  it("stepCount cuenta el waitPrompt de cierre pendiente", () => {
    const r = createRecorder();
    expect(stepCount(r)).toBe(0);
    typeCommand(r, "ls");
    // send + waitPrompt de cierre aún no materializado.
    expect(stepCount(r)).toBe(2);
    typeCommand(r, "pwd");
    expect(stepCount(r)).toBe(4);
  });

  it("respeta el tope MAX_STEPS", () => {
    const r = createRecorder();
    for (let i = 0; i < MAX_STEPS + 20; i++) typeCommand(r, `cmd${i}`);
    const steps = finish(r);
    expect(steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(r.truncated).toBe(true);
  });
});
