import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contrato de la densidad de la interfaz (Preferencias → Apariencia →
// Densidad): los tokens semánticos se definen en `:root` con el valor de la
// densidad normal y las dos densidades los redefinen. Si un token nuevo se
// queda sin redefinir, ese componente no cambia de densidad y nadie lo nota.
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const TOKENS = ["--row-py", "--cell-py", "--menu-item-py", "--list-item-py", "--toolbar-pad", "--panel-py", "--card-pad"];

/** Cuerpo de la primera regla cuyo selector es exactamente `selector`. */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : "";
}

describe("tokens de densidad", () => {
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf("--card-pad")));

  it.each(TOKENS)("%s se define en :root y en las dos densidades", (token) => {
    expect(root).toContain(`${token}:`);
    expect(ruleBody("body.density-compact")).toContain(`${token}:`);
    expect(ruleBody("body.density-spacious")).toContain(`${token}:`);
  });

  it.each(TOKENS)("%s lo consume algún componente", (token) => {
    expect(css).toContain(`var(${token})`);
  });

  it("los componentes de la auditoría siguen la densidad", () => {
    expect(ruleBody(".sftp-row")).toContain("var(--row-py)");
    expect(ruleBody(".sftp-toolbar")).toContain("var(--toolbar-pad)");
    expect(ruleBody(".ctx-item")).toContain("var(--menu-item-py)");
    expect(ruleBody(".palette-item")).toContain("var(--list-item-py)");
    expect(ruleBody(".activity-item")).toContain("var(--list-item-py)");
    expect(css).toMatch(/\.metrics-proc-table td \{[^}]*var\(--cell-py\)/);
    expect(css).toMatch(/\.dashboard-card \{\s*padding: var\(--card-pad\)/);
    expect(ruleBody(".dashboard-result-row")).toContain("var(--list-item-py)");
    expect(ruleBody(".global-tunnel-row")).toContain("var(--list-item-py)");
    expect(ruleBody(".tab-overflow-item")).toContain("var(--menu-item-py)");
    expect(ruleBody(".custom-select-item")).toContain("var(--menu-item-py)");
  });
});
