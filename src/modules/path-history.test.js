// @ts-check
import { describe, it, expect } from "vitest";
import {
  MAX_HISTORY,
  canGoBack,
  canGoForward,
  createPathHistory,
  currentPath,
  dropPath,
  goBack,
  goForward,
  pathSegments,
  pushPath,
} from "./path-history.js";

describe("pila de navegación", () => {
  it("empieza vacía y sin sitio a donde ir", () => {
    const h = createPathHistory();
    expect(currentPath(h)).toBe(null);
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
    // Con ruta inicial hay dónde estar, pero todavía no dónde volver.
    const h2 = createPathHistory("/home/ada");
    expect(currentPath(h2)).toBe("/home/ada");
    expect(canGoBack(h2)).toBe(false);
  });

  it("recorre atrás y adelante sin perder el sitio", () => {
    let h = createPathHistory("/");
    h = pushPath(h, "/home");
    h = pushPath(h, "/home/ada");
    expect(currentPath(h)).toBe("/home/ada");

    const atras = goBack(h);
    expect(atras.path).toBe("/home");
    const atras2 = goBack(atras.history);
    expect(atras2.path).toBe("/");
    expect(canGoBack(atras2.history)).toBe(false);

    const alante = goForward(atras2.history);
    expect(alante.path).toBe("/home");
    expect(goForward(alante.history).path).toBe("/home/ada");
  });

  it("no apila al refrescar la carpeta actual", () => {
    // El requisito del backlog: refrescar no debe llenar el historial de
    // duplicados ni dejar el botón Atrás sin efecto visible.
    let h = createPathHistory("/var");
    h = pushPath(h, "/var");
    h = pushPath(h, "/var");
    expect(h.entries).toEqual(["/var"]);
    expect(canGoBack(h)).toBe(false);
  });

  it("navegar desde el medio descarta el camino de vuelta", () => {
    let h = createPathHistory("/");
    h = pushPath(h, "/etc");
    h = pushPath(h, "/etc/ssh");
    const atras = goBack(goBack(h).history); // de vuelta en "/"
    const nueva = pushPath(atras.history, "/opt");
    expect(nueva.entries).toEqual(["/", "/opt"]);
    expect(canGoForward(nueva)).toBe(false);
  });

  it("olvida las rutas más antiguas al llegar al tope", () => {
    let h = createPathHistory("/0");
    for (let i = 1; i <= MAX_HISTORY + 20; i++) h = pushPath(h, `/${i}`);
    expect(h.entries.length).toBe(MAX_HISTORY);
    expect(currentPath(h)).toBe(`/${MAX_HISTORY + 20}`);
    // La posición sigue apuntando a la última, no se desfasó al recortar.
    expect(h.index).toBe(MAX_HISTORY - 1);
    expect(h.entries[0]).toBe(`/${21}`);
  });

  it("retira una ruta que ya no existe", () => {
    let h = createPathHistory("/");
    h = pushPath(h, "/mnt/usb");
    h = pushPath(h, "/mnt/usb/fotos");
    // El USB se desconecta: sus dos rutas dejan de ser visitables.
    h = dropPath(h, "/mnt/usb/fotos");
    expect(h.entries).toEqual(["/", "/mnt/usb"]);
    expect(currentPath(h)).toBe("/mnt/usb");
    h = dropPath(h, "/mnt/usb");
    expect(h.entries).toEqual(["/"]);
    expect(currentPath(h)).toBe("/");
    // Retirar algo que no está no cambia nada.
    expect(dropPath(h, "/no/estaba")).toBe(h);
    // Y vaciarlo del todo deja un historial válido, no uno roto.
    expect(dropPath(h, "/")).toEqual(createPathHistory());
  });

  it("no muta el historial que recibe", () => {
    const h = createPathHistory("/");
    const antes = JSON.stringify(h);
    pushPath(h, "/tmp");
    goBack(h);
    dropPath(h, "/");
    expect(JSON.stringify(h)).toBe(antes);
  });
});

describe("segmentos de la ruta", () => {
  it("parte una ruta POSIX en migas navegables", () => {
    expect(pathSegments("/home/ada/docs")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "ada", path: "/home/ada" },
      { label: "docs", path: "/home/ada/docs" },
    ]);
    expect(pathSegments("/")).toEqual([{ label: "/", path: "/" }]);
    expect(pathSegments("")).toEqual([]);
  });

  it("tolera separadores repetidos y barra final", () => {
    expect(pathSegments("//var///log/")).toEqual([
      { label: "/", path: "/" },
      { label: "var", path: "/var" },
      { label: "log", path: "/var/log" },
    ]);
  });

  it("parte una ruta de Windows, que es la del lado local", () => {
    expect(pathSegments("C:\\Users\\Ada")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "Ada", path: "C:\\Users\\Ada" },
    ]);
    // Barras al estilo POSIX en una ruta con unidad: mismo resultado.
    expect(pathSegments("C:/Users")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
    ]);
  });
});
