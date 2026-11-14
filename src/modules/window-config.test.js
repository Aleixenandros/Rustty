import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// La ventana se declara dos veces: `tauri.conf.json` (Linux y Windows, sin
// decoraciones porque los botones los pinta la propia interfaz) y
// `tauri.macos.conf.json` (con decoraciones, para que macOS ponga su semáforo).
// Tauri fusiona el segundo sobre el primero y las listas se sustituyen enteras,
// así que la de macOS tiene que repetir la ventana completa. Con
// `decorations: false` en macOS la ventana sale sin ningún botón —ni cerrar ni
// minimizar ni maximizar—, que es como se publicó hasta la 2.29.0.
describe("configuración de la ventana por plataforma", () => {
  const base = readJson("../../src-tauri/tauri.conf.json").app.windows;
  const mac = readJson("../../src-tauri/tauri.macos.conf.json").app.windows;

  it("macOS lleva decoraciones nativas con la barra superpuesta", () => {
    expect(mac).toHaveLength(1);
    expect(mac[0].decorations).toBe(true);
    expect(mac[0].titleBarStyle).toBe("Overlay");
    expect(mac[0].hiddenTitle).toBe(true);
  });

  it("Linux y Windows siguen sin decoraciones", () => {
    expect(base).toHaveLength(1);
    expect(base[0].decorations).toBe(false);
  });

  it("la ventana de macOS no se desvía de la común en nada más", () => {
    const { decorations: _a, ...restBase } = base[0];
    const { decorations: _b, ...restMac } = mac[0];
    expect(restMac).toEqual(restBase);
  });

  it("la configuración de macOS solo toca la ventana", () => {
    const whole = readJson("../../src-tauri/tauri.macos.conf.json");
    expect(Object.keys(whole)).toEqual(["app"]);
    expect(Object.keys(whole.app)).toEqual(["windows"]);
  });

  it("la interfaz reserva el hueco del semáforo y esconde sus propios botones", () => {
    const css = read("../styles.css");
    expect(css).toMatch(/body\.platform-macos #window-controls\s*\{\s*display:\s*none/);
    expect(css).toMatch(/body\.platform-macos \.window-resize-handle\s*\{\s*display:\s*none/);
    expect(css).toContain("--mac-lights-width");
    const html = read("../../index.html");
    expect(html).toMatch(/id="rail-titlebar-gap"[^>]*data-tauri-drag-region/);
  });
});
