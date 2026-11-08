import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TAB_BUTTONS_MODES, normalizeTabButtons } from "./tab-buttons.js";
import { DEFAULT_PREFS } from "./prefs/defaults.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("normalizeTabButtons", () => {
  it("acepta los tres modos", () => {
    for (const mode of TAB_BUTTONS_MODES) expect(normalizeTabButtons(mode)).toBe(mode);
  });

  it("lo desconocido o ausente vuelve al de serie («always», el comportamiento de antes)", () => {
    expect(normalizeTabButtons(undefined)).toBe("always");
    expect(normalizeTabButtons(null)).toBe("always");
    expect(normalizeTabButtons("hover")).toBe("always");
    expect(normalizeTabButtons(1)).toBe("always");
  });

  it("el default de las preferencias es «always»", () => {
    expect(DEFAULT_PREFS.tabButtons).toBe("always");
  });
});

describe("contrato con la hoja y el HTML", () => {
  const css = read("../styles.css");
  const html = read("../../index.html");

  it("la hoja oculta los botones en «active» y «never»", () => {
    expect(css).toMatch(/body\[data-tab-buttons="active"\][^{]*\.tab:not\(\.active\)/);
    expect(css).toMatch(/body\[data-tab-buttons="never"\][^{]*\.tab-sftp/);
  });

  it("el selector de Preferencias ofrece exactamente los modos", () => {
    const select = /<select id="pref-tab-buttons">([\s\S]*?)<\/select>/.exec(html);
    expect(select).not.toBeNull();
    const values = [...select[1].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual([...TAB_BUTTONS_MODES]);
  });

  it("el menú contextual de la pestaña ofrece los tres paneles (nada queda inaccesible con «never»)", () => {
    for (const action of ["panel-sftp", "panel-tunnels", "panel-runbook"]) {
      expect(html).toContain(`data-tabctx="${action}"`);
    }
  });
});
