// @ts-check
/** Políticas y nombres alternativos para conflictos de transferencia SFTP. */

/**
 * @returns {{ policy: null|string, reservedNames: { local: Set<string>, remote: Set<string> } }}
 */
export function createTransferConflictState() {
  return {
    policy: null,
    reservedNames: {
      local: new Set(),
      remote: new Set(),
    },
  };
}

/**
 * @param {unknown} policy
 * @returns {"ask"|"overwrite"|"skip"|"rename"}
 */
export function normalizeSftpConflictPolicy(policy) {
  const value = String(policy);
  return ["ask", "overwrite", "skip", "rename"].includes(value)
    ? /** @type {"ask"|"overwrite"|"skip"|"rename"} */ (value)
    : "ask";
}

/**
 * La transferencia recursiva ya resolvió el conflicto de la carpeta raíz. El
 * backend no puede volver a preguntar por cada hijo, así que `ask` se degrada
 * de forma explícita a overwrite para ese árbol.
 *
 * @param {{ renamed?: boolean, overwrite?: boolean }|null|undefined} resolved
 * @param {unknown} preferredPolicy
 * @returns {"overwrite"|"skip"|"rename"}
 */
export function recursiveConflictPolicyForTransfer(resolved, preferredPolicy) {
  if (resolved?.renamed || resolved?.overwrite) return "overwrite";
  const policy = normalizeSftpConflictPolicy(preferredPolicy);
  return policy === "ask" ? "overwrite" : policy;
}

/**
 * Elige el primer nombre `base (n).ext` que no esté ocupado. En directorios,
 * los puntos forman parte del nombre; en ficheros se conserva la extensión.
 *
 * @param {string} name
 * @param {boolean} isDir
 * @param {(candidate: string) => boolean} isTaken
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function nextAvailableTransferName(
  name,
  isDir,
  isTaken,
  { now = Date.now() } = {},
) {
  const dot = !isDir ? name.lastIndexOf(".") : -1;
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${base} (${now})${ext}`;
}
