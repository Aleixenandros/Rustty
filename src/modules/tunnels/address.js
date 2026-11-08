// @ts-check
/**
 * Dirección por la que se llega a un túnel local (`-L`) desde este equipo.
 * Núcleo **puro**: sin DOM ni IPC.
 *
 * El túnel escucha en su host de escucha (`bindHost`) y su puerto local. Para
 * copiar la dirección o abrirla en el navegador hace falta una a la que se
 * pueda **conectar**: un comodín (`0.0.0.0`, `::`, vacío) escucha en todas las
 * interfaces pero no es un destino, así que se usa el loopback de su familia.
 * Una IPv6 literal va entre corchetes, como exige `host:puerto` y una URL.
 */

/**
 * @typedef {object} LocalTunnelLike
 * @property {string} [tunnelType]  `"local"`, `"remote"` o `"dynamic"`.
 * @property {string | null} [bindHost]
 * @property {number | string | null} [localPort]
 */

/** Comodines IPv4/IPv6: escuchan en todo, pero no se puede conectar a ellos. */
const IPV4_ANY = new Set(["", "0.0.0.0", "*"]);
const IPV6_ANY = new Set(["::", "[::]", "::0", "0:0:0:0:0:0:0:0"]);

/**
 * Host al que conectarse para llegar a un túnel que escucha en `bindHost`.
 * @param {string | null | undefined} bindHost
 * @returns {string}  Listo para `host:puerto` (IPv6 entre corchetes).
 */
export function connectableHost(bindHost) {
  const host = String(bindHost ?? "").trim();
  if (IPV4_ANY.has(host)) return "127.0.0.1";
  if (IPV6_ANY.has(host)) return "[::1]";
  if (host.startsWith("[") && host.endsWith("]")) return host;
  if (host.includes(":")) return `[${host}]`;
  return host;
}

/**
 * `host:puerto` de un túnel local, o `null` si no es un `-L` con puerto válido
 * (un SOCKS no es un servicio al que apuntar el navegador, y un `-R` escucha
 * en el servidor, no aquí).
 * @param {LocalTunnelLike | null | undefined} tunnel
 * @returns {string | null}
 */
export function localTunnelAddress(tunnel) {
  if (!tunnel || tunnel.tunnelType !== "local") return null;
  const port = Number(tunnel.localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${connectableHost(tunnel.bindHost)}:${port}`;
}

/**
 * URL `http://host:puerto/` para abrir un túnel local en el navegador, o
 * `null` si no aplica (ver {@link localTunnelAddress}).
 * @param {LocalTunnelLike | null | undefined} tunnel
 * @returns {string | null}
 */
export function localTunnelUrl(tunnel) {
  const address = localTunnelAddress(tunnel);
  return address ? `http://${address}/` : null;
}
