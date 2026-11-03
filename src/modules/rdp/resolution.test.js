// @ts-check
import { describe, it, expect } from "vitest";
import {
  FIT,
  adjustDisplaySize,
  createResizeController,
  desiredDesktopSize,
  fitCanvasCss,
  parseResolution,
  resolutionKey,
  resolutionMenuModel,
  scaleFromDpr,
} from "./resolution.js";

describe("tamaños del protocolo", () => {
  it("ajusta como adjust_display_size del backend", () => {
    // Mismos vectores que `tamano_ajustado_al_protocolo` en Rust.
    expect(adjustDisplaySize(1921, 100)).toEqual({ width: 1920, height: 200 });
    expect(adjustDisplaySize(9000, 9000)).toEqual({ width: 8192, height: 8192 });
    expect(adjustDisplaySize(1365.7, 767.9)).toEqual({ width: 1364, height: 767 });
  });

  it("escala desde el devicePixelRatio solo en 100..=500", () => {
    expect(scaleFromDpr(1)).toBe(100);
    expect(scaleFromDpr(1.25)).toBe(125);
    expect(scaleFromDpr(0.9)).toBeNull();
    expect(scaleFromDpr(6)).toBeNull();
  });

  it("pide el hueco del panel en píxeles físicos", () => {
    expect(desiredDesktopSize(FIT, { width: 1000.5, height: 600, dpr: 1.5 }))
      .toEqual({ width: 1500, height: 900, scale: 150 });
    // Pestaña oculta: no hay nada que pedir.
    expect(desiredDesktopSize(FIT, { width: 0, height: 0, dpr: 1 })).toBeNull();
    expect(desiredDesktopSize(FIT, null)).toBeNull();
    // Un tamaño fijo no depende del panel.
    expect(desiredDesktopSize({ mode: "fixed", width: 1280, height: 720 }, null))
      .toEqual({ width: 1280, height: 720, scale: 100 });
  });
});

describe("canvas dentro del panel", () => {
  it("encaja sin deformar, hacia arriba y hacia abajo", () => {
    // 1280×720 en un panel de 1000×1000: bandas arriba y abajo.
    expect(fitCanvasCss({ width: 1280, height: 720 }, { width: 1000, height: 1000, dpr: 1 }))
      .toEqual({ width: 1000, height: 562.5 });
    // 1024×768 en 2048×2048: se amplía hasta el ancho.
    expect(fitCanvasCss({ width: 1024, height: 768 }, { width: 2048, height: 2048, dpr: 1 }))
      .toEqual({ width: 2048, height: 1536 });
  });

  it("cuenta en píxeles físicos y pinta 1:1 lo que casi coincide", () => {
    // Escritorio del tamaño del panel a 2x: ocupa el panel en CSS.
    expect(fitCanvasCss({ width: 2000, height: 1200 }, { width: 1000, height: 600, dpr: 2 }))
      .toEqual({ width: 1000, height: 600 });
    // El ancho par le quitó un píxel: 1:1, no un 0,1 % de ampliación borrosa.
    expect(fitCanvasCss({ width: 1000, height: 701 }, { width: 1001, height: 701, dpr: 1 }))
      .toEqual({ width: 1000, height: 701 });
  });

  it("no hace nada sin tamaño", () => {
    expect(fitCanvasCss({ width: 1, height: 1 }, { width: 0, height: 10, dpr: 1 })).toBeNull();
    expect(fitCanvasCss({ width: 0, height: 0 }, { width: 10, height: 10, dpr: 1 })).toBeNull();
  });
});

describe("menú de resolución", () => {
  it("ida y vuelta de las claves", () => {
    expect(resolutionKey(FIT)).toBe("fit");
    expect(parseResolution("fit")).toEqual(FIT);
    expect(parseResolution("1920x1080")).toEqual({ mode: "fixed", width: 1920, height: 1080 });
    expect(resolutionKey(/** @type {any} */ (parseResolution("1366x768")))).toBe("1366x768");
    // Solo los tamaños del menú.
    expect(parseResolution("1234x567")).toBeNull();
    expect(parseResolution("x")).toBeNull();
    expect(parseResolution(undefined)).toBeNull();
  });

  it("marca la elección actual", () => {
    const fit = resolutionMenuModel(FIT);
    expect(fit[0]).toMatchObject({ key: "fit", fit: true, checked: true });
    expect(fit.filter((e) => e.checked)).toHaveLength(1);
    const fixed = resolutionMenuModel({ mode: "fixed", width: 1280, height: 800 });
    expect(fixed.filter((e) => e.checked).map((e) => e.key)).toEqual(["1280x800"]);
    expect(fixed.map((e) => e.key)).toEqual([
      "fit", "1024x768", "1280x720", "1280x800", "1366x768", "1440x900", "1600x900", "1920x1080", "2560x1440",
    ]);
  });
});

/**
 * Controlador con temporizador manual y escritorio simulado.
 * @param {object} [opts]
 * @param {any} [opts.resolution]
 * @param {any} [opts.box]
 * @param {any} [opts.desktop]
 */
function harness({ resolution = FIT, box = { width: 1000, height: 700, dpr: 1 }, desktop = { width: 1000, height: 700 } } = {}) {
  const env = {
    box: /** @type {any} */ (box),
    desktop: /** @type {any} */ (desktop),
    sent: /** @type {any[]} */ ([]),
    reconnects: /** @type {any[]} */ ([]),
    /** @type {(() => void)|null} */
    timer: null,
  };
  const ctl = createResizeController({
    resolution,
    measure: () => env.box,
    desktopSize: () => env.desktop,
    sendResize: (req) => env.sent.push(req),
    reconnect: (req, res) => env.reconnects.push({ req, res }),
    setTimer: (fn) => { env.timer = fn; return 1; },
    clearTimer: () => { env.timer = null; },
  });
  const flush = () => { const fn = env.timer; env.timer = null; fn?.(); };
  return { ctl, env, flush };
}

describe("controlador de tamaño", () => {
  it("con antirrebote, pide el último tamaño una sola vez", () => {
    const { ctl, env, flush } = harness();
    ctl.setConnected(true);
    ctl.setDisplayControl(true);
    flush();
    expect(env.sent).toEqual([]); // ya coincide
    env.box = { width: 1200, height: 700, dpr: 1 };
    ctl.paneChanged();
    env.box = { width: 1300, height: 801, dpr: 1 };
    ctl.paneChanged();
    flush();
    expect(env.sent).toEqual([{ width: 1300, height: 801, scale: 100 }]);
    // El servidor lo recortó a otra cosa: no se insiste con lo mismo.
    env.desktop = { width: 1280, height: 800 };
    ctl.desktopChanged();
    ctl.paneChanged();
    flush();
    expect(env.sent).toHaveLength(1);
  });

  it("no pide nada desconectada ni con la pestaña oculta", () => {
    const { ctl, env, flush } = harness();
    env.box = { width: 1400, height: 900, dpr: 1 };
    ctl.paneChanged();
    flush();
    expect(env.sent).toEqual([]);
    env.box = { width: 0, height: 0, dpr: 1 };
    ctl.setConnected(true);
    ctl.setDisplayControl(true);
    ctl.paneChanged();
    flush();
    expect(env.sent).toEqual([]);
    // Al volver a verse.
    env.box = { width: 1400, height: 900, dpr: 1 };
    ctl.paneChanged();
    flush();
    expect(env.sent).toEqual([{ width: 1400, height: 900, scale: 100 }]);
  });

  it("sin Display Control el ajuste automático solo escala", () => {
    const { ctl, env, flush } = harness();
    ctl.setConnected(true);
    ctl.setDisplayControl(false);
    env.box = { width: 1400, height: 900, dpr: 1 };
    ctl.paneChanged();
    flush();
    expect(env.sent).toEqual([]);
    expect(env.reconnects).toEqual([]);
  });

  it("sin Display Control una elección del menú reconecta, una vez", () => {
    const { ctl, env } = harness();
    ctl.setConnected(true);
    ctl.setDisplayControl(false);
    ctl.choose({ mode: "fixed", width: 1280, height: 720 });
    expect(env.reconnects).toEqual([{
      req: { width: 1280, height: 720, scale: 100 },
      res: { mode: "fixed", width: 1280, height: 720 },
    }]);
    ctl.paneChanged();
    expect(env.reconnects).toHaveLength(1);
    // «Ajustar a la pestaña» con el escritorio de otro tamaño, también.
    env.desktop = { width: 1280, height: 720 };
    ctl.choose(FIT);
    expect(env.reconnects[1].req).toEqual({ width: 1000, height: 700, scale: 100 });
  });

  it("con Display Control la elección del menú se pide sin reconectar", () => {
    const { ctl, env } = harness();
    ctl.setConnected(true);
    ctl.setDisplayControl(true);
    ctl.choose({ mode: "fixed", width: 1920, height: 1080 });
    expect(env.sent).toEqual([{ width: 1920, height: 1080, scale: 100 }]);
    expect(env.reconnects).toEqual([]);
    // Fijo: los cambios del panel ya no piden nada.
    env.desktop = { width: 1920, height: 1080 };
    env.box = { width: 500, height: 400, dpr: 1 };
    ctl.paneChanged();
    expect(env.sent).toHaveLength(1);
  });

  it("antes de saberlo se pide igual y, si no hay canal, reconecta lo del menú", () => {
    const { ctl, env } = harness();
    ctl.setConnected(true);
    ctl.choose({ mode: "fixed", width: 1600, height: 900 });
    expect(env.sent).toEqual([{ width: 1600, height: 900, scale: 100 }]);
    ctl.setDisplayControl(false);
    expect(env.reconnects.map((r) => r.req)).toEqual([{ width: 1600, height: 900, scale: 100 }]);
  });

  it("si el canal llega listo, lo ya pedido no se repite", () => {
    const { ctl, env } = harness();
    ctl.setConnected(true);
    ctl.choose({ mode: "fixed", width: 1600, height: 900 });
    ctl.setDisplayControl(true);
    expect(env.sent).toHaveLength(1);
    expect(env.reconnects).toEqual([]);
  });

  it("tras dispose no hace nada", () => {
    const { ctl, env, flush } = harness();
    ctl.setConnected(true);
    ctl.setDisplayControl(true);
    ctl.dispose();
    env.box = { width: 1400, height: 900, dpr: 1 };
    ctl.paneChanged();
    flush();
    ctl.choose({ mode: "fixed", width: 1024, height: 768 });
    expect(env.sent).toEqual([]);
  });
});
