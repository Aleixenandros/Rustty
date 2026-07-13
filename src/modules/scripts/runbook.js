// @ts-check
/**
 * Serialización de un `Script` a/desde un runbook Markdown legible.
 *
 * Módulo puro (sin DOM ni `invoke`). El Markdown es a la vez documentación
 * legible y formato de intercambio: `fromMarkdown(toMarkdown(s))` reconstruye
 * el objetivo y los pasos.
 *
 * Formato canónico (v2):
 *
 *   # <nombre>
 *
 *   <descripción>              (párrafo opcional)
 *
 *   **Target:** profile id=<id>
 *
 *   ## Steps
 *
 *   1. **send** — <texto>
 *   2. **waitPrompt**
 *   ...
 *
 * Decisiones de formato:
 * - **Los tokens estructurales son neutros (inglés), no castellano.** El runbook
 *   es un formato de intercambio: con tokens en castellano (`**Objetivo:**`,
 *   `## Pasos`, `recursivo sí/no`) un usuario fr/de/pt exportaba un fichero con
 *   etiquetas en un idioma que no es el suyo, y localizarlas habría roto el
 *   round-trip entre equipos con distinto idioma. Los `type` de paso ya eran
 *   canónicos en inglés (`send`, `waitPrompt`), así que el resto se alinea con
 *   ellos. Lo que el usuario escribe (nombre, descripción, comandos) no se toca.
 * - **Los runbooks antiguos (tokens en castellano) se siguen leyendo.** El
 *   parser acepta las dos gramáticas; solo la escritura usa la nueva.
 * - El token en negrita de cada paso es el `type` CANÓNICO: garantiza fidelidad
 *   en el round-trip sin una tabla de traducción frágil. El contenido va tras un
 *   guion largo `—`.
 * - Los campos de longitud variable (patrón, ruta, ids) van al final de su línea
 *   para poder capturarlos enteros.
 * - Los timestamps y el `id` NO viajan en el Markdown: `fromMarkdown` genera
 *   unos frescos (round-trip conserva nombre, descripción, objetivo y pasos).
 */

import { emptyScript, makeStep } from "./model.js";

/** @typedef {import("./model.js").Script} Script */
/** @typedef {import("./model.js").Step} Step */
/** @typedef {import("./model.js").TargetSpec} TargetSpec */

/**
 * Línea que el parser no supo interpretar.
 * @typedef {{ line: number, text: string }} IgnoredLine
 */

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
  if (!target || typeof target !== "object") return "selection ids=";
  switch (target.kind) {
    case "profile":
      return `profile id=${target.profileId ?? ""}`;
    case "folder":
      return `folder workspace=${target.workspaceId ?? ""} recursive=${target.recursive ? "yes" : "no"} path=${target.folderPath ?? ""}`;
    case "adhoc":
      return `selection ids=${(Array.isArray(target.profileIds) ? target.profileIds : []).join(", ")}`;
    default:
      return "selection ids=";
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
      return `**waitRegex** — timeout=${toInt(s.timeoutMs, 0)}ms pattern=${s.pattern ?? ""}`;
    case "expectExit":
      return `**expectExit** — code=${toInt(s.code, 0)}`;
    case "sendPasswordFromKeyring":
      return s.profileId == null
        ? "**sendPasswordFromKeyring** — keyring"
        : `**sendPasswordFromKeyring** — keyring profile=${s.profileId}`;
    case "sendPasswordFromKeepass":
      return `**sendPasswordFromKeepass** — keepass uuid=${s.uuid ?? ""}`;
    case "sleep":
      return `**sleep** — ${toInt(s.ms, 0)}ms`;
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
  lines.push(`**Target:** ${targetToLine(s.target)}`);
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  const steps = Array.isArray(s.steps) ? s.steps : [];
  steps.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
    lines.push(`${i + 1}. ${stepToLine(step)}`);
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Interpreta la línea de objetivo, en la gramática canónica o en la legada
 * (castellano). `null` si no reconoce el formato.
 * @param {string} line
 * @returns {TargetSpec|null}
 */
function parseTargetLine(line) {
  const s = String(line ?? "").trim();
  let m;

  // Canónico (v2).
  if ((m = s.match(/^profile id=(.*)$/))) {
    const id = m[1].trim();
    return id ? { kind: "profile", profileId: id } : null;
  }
  if ((m = s.match(/^folder workspace=(.*?) recursive=(yes|no) path=(.*)$/))) {
    return {
      kind: "folder",
      workspaceId: m[1].trim(),
      recursive: m[2] === "yes",
      folderPath: m[3] ?? "",
    };
  }
  if ((m = s.match(/^selection ids=(.*)$/))) {
    return { kind: "adhoc", profileIds: splitIds(m[1]) };
  }

  // Legado (v1, tokens en castellano).
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
    return { kind: "adhoc", profileIds: splitIds(m[1]) };
  }
  return null;
}

/**
 * Lista de ids separada por comas.
 * @param {string} rest
 * @returns {string[]}
 */
function splitIds(rest) {
  const trimmed = String(rest ?? "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Interpreta el contenido de un paso (sin el número), en la gramática canónica
 * o en la legada. `null` si no lo reconoce.
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
      if ((p = payload.match(/^timeout=(\d+)ms pattern=(.*)$/))) {
        return makeStep("waitRegex", { timeoutMs: Number(p[1]), pattern: p[2] });
      }
      if ((p = payload.match(/^timeout (\d+) ms · patrón: (.*)$/))) {
        return makeStep("waitRegex", { timeoutMs: Number(p[1]), pattern: p[2] });
      }
      return null;
    case "expectExit":
      if ((p = payload.match(/^code=(-?\d+)$/)) || (p = payload.match(/^código (-?\d+)$/))) {
        return makeStep("expectExit", { code: Number(p[1]) });
      }
      return null;
    case "sendPasswordFromKeyring":
      if ((p = payload.match(/^keyring(?: profile=(.*))?$/))) {
        return makeStep("sendPasswordFromKeyring", { profileId: p[1] != null ? p[1] : null });
      }
      if ((p = payload.match(/^contraseña de keyring(?: · perfil (.*))?$/))) {
        return makeStep("sendPasswordFromKeyring", { profileId: p[1] != null ? p[1] : null });
      }
      return null;
    case "sendPasswordFromKeepass":
      if ((p = payload.match(/^keepass uuid=(.*)$/)) ||
          (p = payload.match(/^contraseña de KeePass · uuid (.*)$/))) {
        return makeStep("sendPasswordFromKeepass", { uuid: p[1] });
      }
      return null;
    case "sleep":
      if ((p = payload.match(/^(\d+)ms$/)) || (p = payload.match(/^pausa (\d+) ms$/))) {
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
 * Reconstruye un `Script` a partir de un runbook Markdown y **informa de lo que
 * no ha entendido**.
 *
 * El parseo es tolerante por diseño (el runbook se puede editar a mano), pero no
 * silencioso: un paso con un typo se descartaba antes sin dejar rastro y el
 * script se importaba incompleto. Cada elemento de lista numerada —o línea que
 * parezca un paso mal numerado— que no case con la gramática se devuelve en
 * `ignored` para que la UI avise antes de guardar.
 *
 * @param {string} md
 * @returns {{ script: Script|null, ignored: IgnoredLine[] }}
 */
export function parseRunbook(md) {
  /** @type {IgnoredLine[]} */
  const ignored = [];
  if (typeof md !== "string") return { script: null, ignored };
  const lines = md.replace(/\r\n?/g, "\n").split("\n");

  /** @type {string|null} */
  let name = null;
  /** @type {string|null} */
  let targetLine = null;
  let sawTarget = false;
  let inSteps = false;
  /** @type {string[]} */
  const descParts = [];
  /** @type {{ line: number, text: string }[]} */
  const stepItems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const lineNo = i + 1;

    // 1. Buscar el título (h1). Se ignora lo anterior.
    if (name === null) {
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1) name = h1[1];
      continue;
    }

    // 2. Entre el título y el objetivo: descripción.
    if (!sawTarget) {
      const obj = line.match(/^\*\*(?:Target|Objetivo):\*\*\s*(.*)$/);
      if (obj) {
        targetLine = obj[1];
        sawTarget = true;
        continue;
      }
      if (line.trim() !== "") descParts.push(line.trim());
      continue;
    }

    // 3. Localizar la sección de pasos.
    if (!inSteps) {
      if (/^##\s+(?:Steps|Pasos)\s*$/.test(line)) inSteps = true;
      continue;
    }

    // 4. Elementos de lista numerada = pasos. Una línea que empieza por `**`
    //    sin numerar es casi siempre un paso al que se le cayó el número: se
    //    recoge como ignorada en vez de pasar desapercibida.
    const item = line.match(/^\d+\.\s+(.*)$/);
    if (item) {
      stepItems.push({ line: lineNo, text: item[1] });
    } else if (/^\s*(?:[-*+]\s+)?\*\*/.test(line)) {
      ignored.push({ line: lineNo, text: line.trim() });
    }
  }

  if (name === null || !sawTarget) return { script: null, ignored };
  const target = parseTargetLine(targetLine ?? "");
  if (!target) return { script: null, ignored };

  /** @type {Step[]} */
  const steps = [];
  for (const item of stepItems) {
    const step = parseStepLine(item.text);
    if (step) steps.push(step);
    else ignored.push({ line: item.line, text: item.text });
  }
  // Las ignoradas salen en orden de aparición aunque se hayan detectado en dos
  // pasadas (las mal numeradas durante el barrido, las mal escritas después).
  ignored.sort((a, b) => a.line - b.line);

  const script = emptyScript(target);
  script.name = name;
  script.description = descParts.join("\n");
  script.steps = steps;
  return { script, ignored };
}

/**
 * Reconstruye un `Script` a partir de un runbook Markdown (best-effort).
 * Devuelve `null` si no encuentra título u objetivo reconocibles. Descarta en
 * silencio lo que no entiende: usa `parseRunbook` si necesitas avisar de ello.
 * @param {string} md
 * @returns {Script|null}
 */
export function fromMarkdown(md) {
  return parseRunbook(md).script;
}
