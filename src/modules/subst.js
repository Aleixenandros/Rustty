/**
 * Espejo frontend (NO sensible) del motor de sustitución de plantillas.
 *
 * Resuelve SOLO los marcadores internos a partir de un contexto de cliente y,
 * para `${secret:...}` / `${master:...}`, devuelve el placeholder de redacción
 * `••••` (conforme al contrato: nunca se exponen secretos en el frontend). Los
 * marcadores `${var:...}` (Fase 2) y `${ask:...}` (Fase 5) se dejan literales
 * por ahora. La resolución real (var/secret/master/ask) vive en el backend.
 *
 * Reglas de parsing iguales al motor Rust: escape `$${...}` → literal `${...}`,
 * marcador desconocido/mal formado/sin cierre → literal, cuerpo leído hasta el
 * primer `}` sin anidamiento, y sustitución de una sola pasada (sin reescaneo).
 */

/** Placeholder de redacción para secretos/credenciales maestras (4 puntos). */
const REDACTED = "••••";

/** Nombres de las variables internas reconocidas. */
const INTERNALS = new Set([
  "host",
  "port",
  "user",
  "profileName",
  "workspace",
  "date",
  "time",
]);

/**
 * Resuelve un marcador interno desde el contexto.
 * `date`/`time` se calculan en el instante de la sustitución.
 * @returns {string|null} el valor, o null si no es un interno conocido.
 */
function resolveInternal(name, ctx) {
  switch (name) {
    case "host":
      return ctx.host ?? "";
    case "port":
      return ctx.port != null ? String(ctx.port) : "";
    case "user":
      return ctx.user ?? "";
    case "profileName":
      return ctx.profileName ?? "";
    case "workspace":
      return ctx.workspace ?? "";
    case "date":
      return formatDate(new Date());
    case "time":
      return formatTime(new Date());
    default:
      return null;
  }
}

/** Fecha local `YYYY-MM-DD`. */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Hora local `HH:MM:SS`. */
function formatTime(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${min}:${s}`;
}

/**
 * Interpreta el cuerpo de un marcador `${cuerpo}` (sin llaves).
 * @returns {string|null} el texto de reemplazo, o null si debe quedar literal.
 */
function resolveBody(body, ctx) {
  // Interno sin prefijo.
  if (INTERNALS.has(body)) {
    return resolveInternal(body, ctx);
  }
  const idx = body.indexOf(":");
  if (idx < 0) {
    return null;
  }
  const prefix = body.slice(0, idx);
  const rest = body.slice(idx + 1);
  switch (prefix) {
    // Secretos y credenciales maestras: redacción, nunca el valor real.
    case "secret":
    case "master":
      return rest.length > 0 ? REDACTED : null;
    // var (Fase 2) y ask (Fase 5): literales por ahora.
    case "var":
    case "ask":
    case "env":
    case "cmd":
    default:
      return null;
  }
}

/**
 * Previsualización NO sensible de una plantilla.
 * @param {string} template plantilla con marcadores `${...}`.
 * @param {object} ctx contexto con los internos
 *   ({ host, port, user, profileName, workspace }).
 * @returns {string} texto con los internos resueltos y secret/master
 *   redactados; el resto de marcadores se conserva literal.
 */
export function substitutePreview(template, ctx = {}) {
  if (typeof template !== "string") {
    return "";
  }
  let out = "";
  let i = 0;
  const len = template.length;
  while (i < len) {
    // Escape `$${...}` → literal `${...}`.
    if (
      template[i] === "$" &&
      template[i + 1] === "$" &&
      template[i + 2] === "{"
    ) {
      const close = template.indexOf("}", i + 3);
      if (close !== -1) {
        out += template.slice(i + 2, close + 1); // `${` ... `}`
        i = close + 1;
        continue;
      }
      out += "$";
      i += 1;
      continue;
    }
    // Marcador `${cuerpo}`.
    if (template[i] === "$" && template[i + 1] === "{") {
      const close = template.indexOf("}", i + 2);
      if (close !== -1) {
        const body = template.slice(i + 2, close);
        const resolved = resolveBody(body, ctx);
        // null → marcador desconocido/sin resolver: literal tal cual.
        out += resolved !== null ? resolved : template.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      // Sin cierre: el resto es literal.
      out += template.slice(i);
      break;
    }
    out += template[i];
    i += 1;
  }
  return out;
}
