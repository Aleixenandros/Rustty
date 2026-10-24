// @ts-check
/**
 * Qué hace el doble clic sobre una fila del panel de archivos: entrar en la
 * carpeta o transferir el fichero.
 *
 * Los dos listados dan el tipo del propio enlace simbólico, no el de su
 * destino (READDIR trae atributos de `lstat`; `DirEntry::metadata` no sigue
 * enlaces): un enlace a carpeta llega como «no carpeta». Decidir solo por
 * `isDir` mandaba a transferir como fichero `/bin` de un servidor con `/usr`
 * fusionado o el `current` de un despliegue, y fallaba (o, al subir, dejaba un
 * fichero vacío en el remoto). Para un enlace se sondea el destino listándolo.
 */

/**
 * @param {{ isDir?: boolean, isSymlink?: boolean }} row
 * @param {() => Promise<unknown>} probeDir Lista el destino del enlace;
 *   resuelve si es una carpeta y lanza si no (enlace a fichero o roto).
 * @returns {Promise<"navigate"|"transfer">}
 */
export async function sftpRowOpenAction({ isDir = false, isSymlink = false }, probeDir) {
  if (isDir) return "navigate";
  if (!isSymlink) return "transfer";
  try {
    await probeDir();
    return "navigate";
  } catch {
    // Enlace a fichero (o roto): se transfiere el contenido del destino, como
    // un fichero normal.
    return "transfer";
  }
}
