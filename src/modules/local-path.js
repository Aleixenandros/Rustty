// @ts-check
/**
 * Rutas del lado local del panel de archivos: POSIX o Windows («C:\…», también
 * con «/»). Puro, sin acceso a disco.
 *
 * La trampa de Windows: una unidad sin separador («C:») NO es su raíz, sino el
 * directorio actual del proceso en esa unidad. Listar «C:» enseñaba la carpeta
 * de instalación como si fuera la raíz, con entradas «C:foo», y renombrar en la
 * raíz construía «C:nuevo.txt», que el guardián local rechaza por no absoluta.
 */

const BARE_DRIVE = /^[a-zA-Z]:$/;

/**
 * Directorio padre de una ruta local. La raíz («/», «C:\») es su propio padre.
 *
 * @param {string|null|undefined} p
 * @returns {string|null}
 */
export function localParentPath(p) {
  if (!p) return null;
  // «C:» escrita a mano: su sitio es la raíz de la unidad.
  if (BARE_DRIVE.test(p)) return `${p}\\`;
  const m = p.match(/^([a-zA-Z]:[\\/])(.*)$/); // Windows root
  if (m) {
    const rest = m[2];
    if (!rest || rest === "" || rest === "\\" || rest === "/") return p;
  }
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return p.startsWith("/") ? "/" : p;
  const parent = p.slice(0, idx);
  // El padre de «C:\Users» es «C:\» (con el separador que se usaba), no «C:».
  if (BARE_DRIVE.test(parent)) return p.slice(0, idx + 1);
  return parent || "/";
}

/**
 * Parte una ruta local que se está escribiendo en carpeta padre y prefijo del
 * último componente, para el autocompletado.
 *
 * @param {string} fullPath
 * @returns {{ parent: string, prefix: string, sep: string }}
 */
export function splitLocalPathPrefix(fullPath) {
  const sep = fullPath.lastIndexOf("\\") > fullPath.lastIndexOf("/") ? "\\" : "/";
  const idx = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
  if (idx < 0) return { parent: fullPath, prefix: "", sep };
  let parent = idx === 0 ? (fullPath.startsWith("/") ? "/" : fullPath.slice(0, 1) + sep)
                         : fullPath.slice(0, idx) || sep;
  // «C:\Us» se completa dentro de «C:\», no de «C:» (la carpeta del proceso).
  if (BARE_DRIVE.test(parent)) parent = fullPath.slice(0, idx + 1);
  return { parent, prefix: fullPath.slice(idx + 1), sep };
}
