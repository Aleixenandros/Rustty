// @ts-check
/**
 * Comparación de versiones SemVer usada por el updater. Vive fuera de
 * `main.js` para poder cubrir los bordes que importan al decidir si se ofrece
 * una actualización: prefijo `v`, componentes omitidos, prereleases y build
 * metadata.
 */

/**
 * @typedef {object} ParsedVersion
 * @property {number[]} core
 * @property {string[]} prerelease
 */

/**
 * @param {unknown} version
 * @returns {string}
 */
export function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

/**
 * @param {unknown} version
 * @returns {ParsedVersion}
 */
function parseVersion(version) {
  const normalized = normalizeVersion(version).split("+", 1)[0];
  const dash = normalized.indexOf("-");
  const coreText = dash >= 0 ? normalized.slice(0, dash) : normalized;
  const prereleaseText = dash >= 0 ? normalized.slice(dash + 1) : "";
  return {
    core: coreText.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }),
    prerelease: prereleaseText ? prereleaseText.split(".") : [],
  };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function comparePrereleasePart(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    return an === bn ? 0 : an > bn ? 1 : -1;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * Compara dos versiones y devuelve `1` si `a` es posterior, `-1` si es
 * anterior y `0` si son equivalentes. La metadata `+build` no participa en
 * la precedencia, conforme a SemVer.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const coreLength = Math.max(pa.core.length, pb.core.length, 3);
  for (let i = 0; i < coreLength; i += 1) {
    const av = pa.core[i] || 0;
    const bv = pb.core[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }

  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length === 0 ? 1 : -1;
  }
  const prereleaseLength = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < prereleaseLength; i += 1) {
    const av = pa.prerelease[i];
    const bv = pb.prerelease[i];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    const compared = comparePrereleasePart(av, bv);
    if (compared !== 0) return compared;
  }
  return 0;
}
