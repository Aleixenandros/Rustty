// @ts-check
/**
 * Serialización de un `Script` a/desde un runbook Markdown legible.
 *
 * Módulo puro (sin DOM ni `invoke`). El Markdown es a la vez documentación
 * legible y formato de intercambio: `fromMarkdown(toMarkdown(s))` reconstruye
 * de forma best-effort el objetivo y los pasos.
 *
 * Formato (estable, pensado para el round-trip):
 *
 *   # <nombre>
 *
 *   <descripción>              (párrafo opcional)
 *
 *   **Objetivo:** <línea de objetivo>
 *
 *   ## Pasos
 *
 *   1. **<type>** — <contenido>
 *   2. **waitPrompt**
 *   ...
 *
 * Decisiones de formato:
 * - El token en negrita de cada paso es el `type` CANÓNICO (`send`,
 *   `waitRegex`, …): garantiza fidelidad en el round-trip sin una tabla de
 *   traducción frágil. El contenido va tras un guion largo `—`.
 * - El objetivo se codifica con tokens fijos separados por `·` y el campo de
 *   longitud variable (ruta / ids) al final para poder capturarlo entero.
 * - Los timestamps y el `id` NO viajan en el Markdown: `fromMarkdown` genera
 *   unos frescos (round-trip conserva nombre, descripción, objetivo y pasos).
 */

import { emptyScript, makeStep } from "./model.js";

/** @typedef {import("./model.js").Script} Script */
/** @typedef {import("./model.js").Step} Step */
/** @typedef {import("./model.js").TargetSpec} TargetSpec */

/**
 * `v` como entero finito; si no, el valor por defecto.
 * @param {unknown} v
 * @param {number} d
 * @returns {number}
 */
function toInt(v, d) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : d;
}

/**
 * Codifica un objetivo en una sola línea parseable.
 * @param {any} target
 * @returns {string}
 */
function targetToLine(target) {
  if (!target || typeof target !== "object") return "selección · ids ";
  switch (target.kind) {
    case "profile":
      return `perfil · id ${target.profileId ?? ""}`;
    case "folder":
      return `carpeta · workspace ${target.workspaceId ?? ""} · recursivo ${target.recursive ? "sí" : "no"} · ruta ${target.folderPath ?? ""}`;
    case "adhoc":
      return `selección · ids ${(Array.isArray(target.profileIds) ? target.profileIds : []).join(", ")}`;
    default:
      return "selección · ids ";
  }
}

/**
 * Codifica un paso como el contenido de un elemento de lista (sin el número).
 * @param {any} step
 * @returns {string}
 */
function stepToLine(step) {
  const s = step || {};
  switch (s.type) {
    case "send":
      return `**send** — ${s.text ?? ""}`;
    case "waitPrompt":
      return "**waitPrompt**";
    case "waitRegex":
      return `**waitRegex** — timeout ${toInt(s.timeoutMs, 0)} ms · patrón: ${s.pattern ?? ""}`;
    case "expectExit":
      return `**expectExit** — código ${toInt(s.code, 0)}`;
    case "sendPasswordFromKeyring":
      return s.profileId == null
        ? "**sendPasswordFromKeyring** — contraseña de keyring"
        : `**sendPasswordFromKeyring** — contraseña de keyring · perfil ${s.profileId}`;
    case "sendPasswordFromKeepass":
      return `**sendPasswordFromKeepass** — contraseña de KeePass · uuid ${s.uuid ?? ""}`;
    case "sleep":
      return `**sleep** — pausa ${toInt(s.ms, 0)} ms`;
    case "disconnect":
      return "**disconnect**";
    default:
      return `**${String(s.type)}**`;
  }
}

/**
 * Serializa un script como runbook Markdown.
 * @param {Script} script
 * @returns {string}
 */
export function toMarkdown(script) {
  const s = /** @type {any} */ (script || {});
  /** @type {string[]} */
  const lines = [];
  lines.push(`# ${s.name ?? ""}`);
  lines.push("");
  const desc = String(s.description ?? "").trim();
  if (desc) {
    lines.push(desc);
    lines.push("");
  }
  lines.push(`**Objetivo:** ${targetToLine(s.target)}`);
  lines.push("");
  lines.push("## Pasos");
  lines.push("");
  const steps = Array.isArray(s.steps) ? s.steps : [];
  steps.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
    lines.push(`${i + 1}. ${stepToLine(step)}`);
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Interpreta la línea de objetivo. `null` si no reconoce el formato.
 * @param {string} line
 * @returns {TargetSpec|null}
 */
function parseTargetLine(line) {
  const s = String(line ?? "").trim();
  let m;
  if ((m = s.match(/^perfil · id(?: (.*))?$/))) {
    const id = (m[1] ?? "").trim();
    return id ? { kind: "profile", profileId: id } : null;
  }
  if ((m = s.match(/^carpeta · workspace (.*?) · recursivo (sí|no) · ruta(?: (.*))?$/))) {
    return {
      kind: "folder",
      workspaceId: m[1].trim(),
      recursive: m[2] === "sí",
      folderPath: m[3] ?? "",
    };
  }
  if ((m = s.match(/^selección · ids ?(.*)$/))) {
    const rest = m[1].trim();
    const ids = rest
      ? rest.split(",").map((x) => x.trim()).filter((x) => x.length > 0)
      : [];
    return { kind: "adhoc", profileIds: ids };
  }
  return null;
}

/**
 * Interpreta el contenido de un paso (sin el número). `null` si no lo reconoce.
 * @param {string} content
 * @returns {Step|null}
 */
function parseStepLine(content) {
  const s = String(content ?? "").trim();
  const m = s.match(/^\*\*([A-Za-z]+)\*\*\s*(?:—\s*(.*))?$/);
  if (!m) return null;
  const type = m[1];
  const payload = m[2] ?? "";
  let p;
  switch (type) {
    case "send":
      return makeStep("send", { text: payload });
    case "waitPrompt":
      return makeStep("waitPrompt", {});
    case "waitRegex":
      if ((p = payload.match(/^timeout (\d+) ms · patrón: (.*)$/))) {
        return makeStep("waitRegex", { timeoutMs: Number(p[1]), pattern: p[2] });
      }
      return null;
    case "expectExit":
      if ((p = payload.match(/^código (-?\d+)$/))) {
        return makeStep("expectExit", { code: Number(p[1]) });
      }
      return null;
    case "sendPasswordFromKeyring":
      if ((p = payload.match(/^contraseña de keyring(?: · perfil (.*))?$/))) {
        return makeStep("sendPasswordFromKeyring", { profileId: p[1] != null ? p[1] : null });
      }
      return null;
    case "sendPasswordFromKeepass":
      if ((p = payload.match(/^contraseña de KeePass · uuid (.*)$/))) {
        return makeStep("sendPasswordFromKeepass", { uuid: p[1] });
      }
      return null;
    case "sleep":
      if ((p = payload.match(/^pausa (\d+) ms$/))) {
        return makeStep("sleep", { ms: Number(p[1]) });
      }
      return null;
    case "disconnect":
      return makeStep("disconnect", {});
    default:
      return null;
  }
}

/**
 * Reconstruye un `Script` a partir de un runbook Markdown (best-effort).
 * Devuelve `null` si no encuentra título u objetivo reconocibles.
 * @param {string} md
 * @returns {Script|null}
 */
export function fromMarkdown(md) {
  if (typeof md !== "string") return null;
  const lines = md.replace(/\r\n?/g, "\n").split("\n");

  /** @type {string|null} */
  let name = null;
  /** @type {string|null} */
  let targetLine = null;
  let sawObjetivo = false;
  let inSteps = false;
  /** @type {string[]} */
  const descParts = [];
  /** @type {string[]} */
  const stepContents = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 1. Buscar el título (h1). Se ignora lo anterior.
    if (name === null) {
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1) name = h1[1];
      continue;
    }

    // 2. Entre el título y el objetivo: descripción.
    if (!sawObjetivo) {
      const obj = line.match(/^\*\*Objetivo:\*\*\s+(.*)$/);
      if (obj) {
        targetLine = obj[1];
        sawObjetivo = true;
        continue;
      }
      if (line.trim() !== "") descParts.push(line.trim());
      continue;
    }

    // 3. Localizar la sección de pasos.
    if (!inSteps) {
      if (/^##\s+Pasos\s*$/.test(line)) inSteps = true;
      continue;
    }

    // 4. Elementos de lista numerada = pasos.
    const item = line.match(/^\d+\.\s+(.*)$/);
    if (item) stepContents.push(item[1]);
  }

  if (name === null || !sawObjetivo) return null;
  const target = parseTargetLine(targetLine ?? "");
  if (!target) return null;

  /** @type {Step[]} */
  const steps = [];
  for (const content of stepContents) {
    const step = parseStepLine(content);
    if (step) steps.push(step);
  }

  const script = emptyScript(target);
  script.name = name;
  script.description = descParts.join("\n");
  script.steps = steps;
  return script;
}
