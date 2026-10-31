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
 * Veces que una transferencia de fichero suelto vuelve a intentarlo cuando el
 * backend contesta que el destino ya existe (cada vuelta pregunta al usuario o
 * aplica su política) antes de darla por fallida.
 */
export const TRANSFER_EXISTS_RETRIES = 3;

/**
 * El permiso `overwrite` que viaja al backend con una transferencia de fichero
 * suelto: solo cuando el usuario —o la política recordada— decidió sobrescribir
 * **ese** nombre. Un destino que no existía, o un nombre nuevo tras renombrar,
 * van sin permiso: si al llegar resulta que sí existe, el backend lo dice y se
 * pregunta, en vez de pisarlo.
 *
 * @param {{ overwrite?: boolean }|null|undefined} resolved
 * @returns {boolean}
 */
export function transferOverwriteFlag(resolved) {
  return resolved?.overwrite === true;
}

/**
 * Nombres con los que volver a resolver un conflicto cuando el backend ha
 * contestado que el destino existe: el listado que decía lo contrario estaba
 * desfasado, así que el nombre se da por ocupado pase lo que pase.
 *
 * @param {Iterable<string>|null|undefined} names
 * @param {string} name
 * @param {{ foldCase?: boolean }} [options]
 * @returns {Set<string>}
 */
export function namesWithExisting(names, name, options = {}) {
  const out = new Set(names ?? []);
  out.add(transferNameKey(name, options));
  return out;
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

/**
 * Clave con la que se comparan los nombres de un destino. En un disco que no
 * distingue mayúsculas (NTFS, APFS por defecto) `Informe.pdf` e `informe.PDF`
 * son el mismo fichero: compararlos tal cual daba el nombre por libre y la
 * descarga pisaba el existente sin preguntar. Mismo criterio que
 * `transfer_batch::target_key` del backend: `toLowerCase` y no
 * `toLocaleLowerCase`, que con un idioma turco convierte «I» en «ı» y dejaría
 * escapar la colisión. NFC porque APFS tampoco distingue la normalización
 * («café» compuesto o con tilde combinada).
 *
 * @param {unknown} name
 * @param {{ foldCase?: boolean }} [options]
 * @returns {string}
 */
export function transferNameKey(name, { foldCase = false } = {}) {
  const value = String(name ?? "");
  return foldCase ? value.normalize("NFC").toLowerCase() : value;
}

/**
 * Conjunto de claves de los nombres de un listado, para preguntar por
 * conflictos con `transferNameKey`.
 *
 * @param {ReadonlyArray<{ name?: unknown }|null|undefined>|null|undefined} entries
 * @param {{ foldCase?: boolean }} [options]
 * @returns {Set<string>}
 */
export function transferNameSet(entries, options = {}) {
  if (!Array.isArray(entries)) return new Set();
  return new Set(
    entries
      .map((entry) => entry?.name)
      .filter(Boolean)
      .map((name) => transferNameKey(name, options)),
  );
}

/**
 * Destino de un trabajo de la cola de transferencias. La carpeta se fija al
 * encolar (`job.targetDir`): la cola es secuencial y el panel sigue navegable,
 * así que leer la carpeta abierta cuando al trabajo le llega el turno mandaba
 * las transferencias pendientes a donde el usuario hubiera navegado entretanto.
 * Un trabajo sin carpeta fijada cae en la visible. `visible` dice si el panel
 * sigue mostrando esa carpeta: si no, los nombres para los conflictos hay que
 * pedirlos aparte y al terminar no se refresca el listado.
 *
 * @param {{ direction?: string, targetDir?: string|null }|null|undefined} job
 * @param {{ cwd?: string|null, localCwd?: string|null }} [panel]
 * @returns {{ side: "local"|"remote", dir: string, visible: boolean }}
 */
export function transferTarget(job, { cwd = "", localCwd = "" } = {}) {
  const side = job?.direction === "upload" ? "remote" : "local";
  const visibleDir = (side === "remote" ? cwd : localCwd) || "";
  const dir = job?.targetDir || visibleDir;
  return { side, dir, visible: dir === visibleDir };
}
