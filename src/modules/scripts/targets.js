// @ts-check
/**
 * Resolución pura de objetivos (`TargetSpec`) a listas de perfiles.
 *
 * Sin DOM ni `invoke`: dada la lista de perfiles del frontend (con
 * `workspace_id` en snake_case y `group` como carpeta), traduce un objetivo a
 * los ids de perfil que abarca y produce una etiqueta descriptiva para la UI.
 *
 * Cuidado con las carpetas: `group` puede ser `null`/vacío (raíz) y el
 * `workspace_id` puede faltar (se trata como `"default"`); ambos se normalizan.
 */

/** @typedef {import("./model.js").TargetSpec} TargetSpec */

/**
 * Perfil de conexión tal como lo maneja el frontend (subconjunto relevante).
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} [workspace_id] Workspace (snake_case en el frontend).
 * @property {string|null} [group] Carpeta; `null`/vacío = raíz.
 * @property {string} [name]
 * @property {string} [host]
 */

/**
 * Normaliza un workspace: vacío/ausente → `"default"`.
 * @param {unknown} w
 * @returns {string}
 */
function normWorkspace(w) {
  return typeof w === "string" && w.length > 0 ? w : "default";
}

/**
 * Normaliza una ruta de carpeta: recorta espacios y quita barras finales;
 * `null`/vacío → `""` (raíz).
 * @param {unknown} s
 * @returns {string}
 */
function normPath(s) {
  return String(s ?? "").trim().replace(/\/+$/, "");
}

/**
 * @param {number} n
 * @returns {string}
 */
function plural(n) {
  return n === 1 ? "conexión" : "conexiones";
}

/**
 * Resuelve un objetivo a la lista de ids de perfil que abarca.
 * @param {TargetSpec} target Objetivo.
 * @param {ReadonlyArray<Profile>} profiles Perfiles disponibles.
 * @returns {string[]} Ids de perfil (en orden de aparición).
 */
export function resolveTarget(target, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (!target || typeof target !== "object") return [];

  switch (target.kind) {
    case "profile":
      return list.some((p) => p && p.id === target.profileId) ? [target.profileId] : [];

    case "folder": {
      const wid = normWorkspace(target.workspaceId);
      const folder = normPath(target.folderPath);
      /** @type {string[]} */
      const out = [];
      for (const p of list) {
        if (!p || typeof p.id !== "string") continue;
        if (normWorkspace(p.workspace_id) !== wid) continue;
        const g = normPath(p.group);
        if (g === folder) {
          out.push(p.id);
          continue;
        }
        if (target.recursive && (folder === "" || g.startsWith(folder + "/"))) {
          out.push(p.id);
        }
      }
      return out;
    }

    case "adhoc": {
      const ids = Array.isArray(target.profileIds) ? target.profileIds : [];
      const existing = new Set(
        list.filter((p) => p && typeof p.id === "string").map((p) => p.id)
      );
      return ids.filter((id) => existing.has(id));
    }

    default:
      return [];
  }
}

/**
 * Descripción para la UI: número de conexiones abarcadas y etiqueta legible
 * (p. ej. `"Carpeta PROD · 7 conexiones"`).
 * @param {TargetSpec} target Objetivo.
 * @param {ReadonlyArray<Profile>} profiles Perfiles disponibles.
 * @returns {{ count: number, label: string }}
 */
export function describeTarget(target, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const count = resolveTarget(target, profiles).length;
  if (!target || typeof target !== "object") {
    return { count: 0, label: "Sin objetivo" };
  }

  switch (target.kind) {
    case "profile": {
      const p = list.find((x) => x && x.id === target.profileId);
      const name = p ? (p.name || p.host || p.id) : "(no encontrada)";
      return { count, label: `Conexión ${name}` };
    }
    case "folder": {
      const path = normPath(target.folderPath) || "raíz";
      return { count, label: `Carpeta ${path} · ${count} ${plural(count)}` };
    }
    case "adhoc":
      return { count, label: `Selección · ${count} ${plural(count)}` };
    default:
      return { count: 0, label: "Objetivo desconocido" };
  }
}
