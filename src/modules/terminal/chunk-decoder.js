// @ts-check
/**
 * Decodificador UTF-8 **con estado** para el caudal del terminal.
 *
 * La salida llega troceada en bloques de bytes (hasta 64 KiB) y un carácter de
 * varios bytes —una «ñ», una línea de caja `─` de una TUI, un emoji— puede caer
 * justo en la frontera entre dos. `TextDecoder.decode(bloque)` a secas decodifica
 * cada bloque como si fuera un texto completo: la mitad que queda al final sale
 * como U+FFFD y la que abre el bloque siguiente, también. Con `{ stream: true }`
 * el decodificador se guarda los bytes sueltos y los completa con el bloque que
 * sigue. Hace falta **un decodificador por sesión**: el estado es del flujo.
 *
 * @returns {(bytes: Uint8Array) => string}
 */
export function createChunkDecoder() {
  const decoder = new TextDecoder("utf-8");
  return (bytes) => decoder.decode(bytes, { stream: true });
}
