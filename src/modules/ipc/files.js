// @ts-check
/**
 * Diálogos de fichero y lectura/escritura local **con permiso**.
 *
 * Espejo de `src-tauri/src/file_grants.rs`. El renderer ya no abre diálogos ni
 * nombra rutas para leer o escribir: pide a `fs_pick` que el **backend** abra el
 * diálogo nativo, y recibe la ruta (para enseñarla) y un permiso de un solo uso
 * que es lo único que aceptan `read_text_file`, `write_text_file`,
 * `read_file_base64`, `parse_asbru` y los backups cifrados de la sync.
 *
 * Consecuencias para quien llame:
 * - un permiso sirve **una vez**: si la operación falla, hay que volver a elegir;
 * - un permiso de lectura no sirve para escribir, ni al revés;
 * - caduca a los 15 minutos (el backend lo decide, aquí solo se traduce el error).
 *
 * `invoke` se inyecta (`createFileApi`) para que el módulo sea testeable sin Tauri.
 */

/** Prefijo estable de los errores de permiso (`GRANT_ERROR_MARKER` en Rust). */
export const FILE_GRANT_MARKER = "fs-grant:";

/** Prefijo de los errores con código de los comandos locales (`ERROR_MARKER`). */
export const LOCAL_COMMAND_MARKER = "local-command:";

/**
 * @typedef {{ name: string, extensions: string[] }} FileFilter
 * @typedef {{ title?: string, defaultPath?: string|null, filters?: FileFilter[] }} PickOptions
 * @typedef {"open"|"save"|"openPath"|"openMany"|"directory"} PickMode
 * @typedef {{ paths: string[], grant: string|null }} PickResult
 * @typedef {{ path: string, grant: string }} PickedFile
 * @typedef {(cmd: string, args?: Record<string, unknown>) => Promise<any>} Invoke
 */

/**
 * Carga útil de `fs_pick` para un modo y unas opciones del estilo del plugin de
 * diálogos (`title`, `defaultPath`, `filters`). Descarta lo vacío.
 * @param {PickMode} mode
 * @param {PickOptions} [opts]
 * @returns {{ options: { mode: PickMode, title?: string, defaultPath?: string, filters: FileFilter[] } }}
 */
export function pickRequest(mode, opts = {}) {
  /** @type {{ mode: PickMode, title?: string, defaultPath?: string, filters: FileFilter[] }} */
  const options = { mode, filters: [] };
  if (opts.title) options.title = String(opts.title);
  if (opts.defaultPath) options.defaultPath = String(opts.defaultPath);
  if (Array.isArray(opts.filters)) {
    options.filters = opts.filters
      .filter((f) => f && Array.isArray(f.extensions) && f.extensions.length > 0)
      .map((f) => ({ name: String(f.name || ""), extensions: f.extensions.map(String) }));
  }
  return { options };
}

/**
 * Fichero elegido con su permiso, o `null` si el usuario canceló.
 * @param {PickResult|null|undefined} result
 * @returns {PickedFile|null}
 */
export function pickedFile(result) {
  const path = result?.paths?.[0];
  if (!path || !result?.grant) return null;
  return { path, grant: result.grant };
}

/**
 * Rutas elegidas (varias o una carpeta), o `null` si el usuario canceló.
 * @param {PickResult|null|undefined} result
 * @returns {string[]|null}
 */
export function pickedPaths(result) {
  const paths = Array.isArray(result?.paths) ? result.paths.filter(Boolean) : [];
  return paths.length ? paths : null;
}

/**
 * ¿Es un rechazo por un permiso inválido (caducado, usado, ruta cambiada)?
 * @param {unknown} err
 * @returns {boolean}
 */
export function isFileGrantError(err) {
  return String(err ?? "").startsWith(FILE_GRANT_MARKER);
}

/**
 * Código y detalle de un error `local-command:<código>|<detalle>`, o `null` si
 * el error no viene de la política de comandos locales.
 * @param {unknown} err
 * @returns {{ code: string, detail: string }|null}
 */
export function localCommandError(err) {
  const text = String(err ?? "");
  if (!text.startsWith(LOCAL_COMMAND_MARKER)) return null;
  const body = text.slice(LOCAL_COMMAND_MARKER.length);
  const bar = body.indexOf("|");
  return bar < 0
    ? { code: body, detail: "" }
    : { code: body.slice(0, bar), detail: body.slice(bar + 1) };
}

/**
 * API de ficheros sobre un `invoke` concreto.
 * @param {Invoke} invoke
 */
export function createFileApi(invoke) {
  return {
    /**
     * Elige un fichero para leerlo.
     * @param {PickOptions} [opts]
     * @returns {Promise<PickedFile|null>}
     */
    async pickFileToOpen(opts) {
      return pickedFile(await invoke("fs_pick", pickRequest("open", opts)));
    },
    /**
     * Elige dónde guardar un fichero.
     * @param {PickOptions} [opts]
     * @returns {Promise<PickedFile|null>}
     */
    async pickFileToSave(opts) {
      return pickedFile(await invoke("fs_pick", pickRequest("save", opts)));
    },
    /**
     * Elige uno o varios ficheros por su ruta (sin permiso de lectura).
     * @param {PickOptions} [opts]
     * @returns {Promise<string[]|null>}
     */
    async pickFiles(opts) {
      return pickedPaths(await invoke("fs_pick", pickRequest("openMany", opts)));
    },
    /**
     * Elige una ruta de fichero para guardarla en la configuración (una clave,
     * una base KeePass): solo la ruta, sin permiso de lectura.
     * @param {PickOptions} [opts]
     * @returns {Promise<string|null>}
     */
    async pickFilePath(opts) {
      return pickedPaths(await invoke("fs_pick", pickRequest("openPath", opts)))?.[0] ?? null;
    },
    /**
     * Elige una carpeta.
     * @param {PickOptions} [opts]
     * @returns {Promise<string|null>}
     */
    async pickDirectory(opts) {
      return pickedPaths(await invoke("fs_pick", pickRequest("directory", opts)))?.[0] ?? null;
    },
    /**
     * Lee como texto el fichero elegido.
     * @param {PickedFile} file
     * @param {number} [maxBytes]
     * @returns {Promise<string>}
     */
    readTextFile(file, maxBytes) {
      return invoke("read_text_file", { grant: file.grant, maxBytes });
    },
    /**
     * Escribe texto en el fichero elegido.
     * @param {PickedFile} file
     * @param {string} contents
     * @returns {Promise<void>}
     */
    writeTextFile(file, contents) {
      return invoke("write_text_file", { grant: file.grant, contents });
    },
    /**
     * Lee en base64 el fichero elegido (imágenes).
     * @param {PickedFile} file
     * @param {number} [maxBytes]
     * @returns {Promise<string>}
     */
    readFileBase64(file, maxBytes) {
      return invoke("read_file_base64", { grant: file.grant, maxBytes });
    },
  };
}
