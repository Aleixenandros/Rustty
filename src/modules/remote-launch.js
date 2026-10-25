// @ts-check
/**
 * Núcleo **puro** del arranque del canal interactivo de un perfil SSH en el
 * frontend: tipo de terminal (TERM), variables de entorno y comando al
 * conectar. Espejo de `src-tauri/src/remote_launch.rs` (misma lista de TERM,
 * mismos topes y misma precedencia), para que el formulario valide con lo que
 * el backend acepta. Incluye la traducción de las directivas de
 * `~/.ssh/config` que lo describen (`SetEnv`, `SendEnv`, `RemoteCommand`,
 * `RequestTTY`). Sin DOM ni IPC.
 */

/** TERM que se pide cuando el perfil no elige otro. */
export const DEFAULT_TERM_TYPE = "xterm-256color";

/** Lista cerrada del selector (espejo de `TERM_TYPES` del backend). */
export const TERM_TYPES = Object.freeze([
  "xterm-256color",
  "xterm",
  "screen-256color",
  "tmux-256color",
  "vt220",
  "vt100",
  "linux",
]);

export const MAX_ENV_VARS = 32;
export const MAX_ENV_NAME_LEN = 64;
export const MAX_ENV_VALUE_LEN = 4096;

/** @param {string} text */
const utf8Length = (text) => new TextEncoder().encode(text).length;
export const MAX_REMOTE_COMMAND_LEN = 4096;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Nombre de variable POSIX: `[A-Za-z_][A-Za-z0-9_]*`, con tope.
 * @param {unknown} name
 */
export function isValidEnvName(name) {
  const s = String(name ?? "");
  return s.length <= MAX_ENV_NAME_LEN && ENV_NAME_RE.test(s);
}

/** @typedef {{ name: string, value: string }} EnvVar */
/**
 * Primer error del texto de variables, para el aviso del formulario.
 * `line`: formato o nombre inválido; `duplicate`: nombre repetido;
 * `value_too_long`: valor por encima del tope; `too_many`: más de las que caben.
 * @typedef {{ line: number, code: "line"|"duplicate"|"value_too_long"|"too_many", name?: string }} EnvVarsError
 */

/**
 * Parsea el texto del formulario: una variable por línea, `NOMBRE=valor`. Las
 * líneas en blanco y las que empiezan por `#` se ignoran. El valor es lo que
 * sigue al primer `=` (puede llevar más `=` y `${...}`), sin los espacios de
 * los extremos.
 * @param {unknown} text
 * @returns {{ vars: EnvVar[], error: EnvVarsError|null }}
 */
export function parseEnvVarsText(text) {
  /** @type {EnvVar[]} */
  const vars = [];
  const seen = new Set();
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = i + 1;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return { vars, error: { line, code: "line" } };
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!isValidEnvName(name)) return { vars, error: { line, code: "line", name } };
    if (seen.has(name)) return { vars, error: { line, code: "duplicate", name } };
    // En bytes UTF-8, como lo mide el backend: con acentos, un valor que cabía
    // en caracteres podía descartarse al conectar.
    if (utf8Length(value) > MAX_ENV_VALUE_LEN) return { vars, error: { line, code: "value_too_long", name } };
    if (vars.length >= MAX_ENV_VARS) return { vars, error: { line, code: "too_many" } };
    seen.add(name);
    vars.push({ name, value });
  }
  return { vars, error: null };
}

/**
 * Texto del formulario a partir de las variables del perfil.
 * @param {unknown} vars
 */
export function formatEnvVarsText(vars) {
  if (!Array.isArray(vars)) return "";
  return vars
    .filter((v) => v && typeof v.name === "string" && v.name)
    .map((v) => `${v.name}=${v.value ?? ""}`)
    .join("\n");
}

/**
 * TERM elegido, si está en la lista y no es el de por defecto. `null` = el de
 * siempre (es también lo que se guarda: un solo valor para «por defecto»).
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeTermType(value) {
  const s = String(value ?? "").trim();
  return TERM_TYPES.includes(s) && s !== DEFAULT_TERM_TYPE ? s : null;
}

/**
 * Comando al conectar del perfil, sin espacios sobrantes. `null` si no hay.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeRemoteCommand(value) {
  const s = String(value ?? "").trim();
  return s ? s : null;
}

/**
 * Qué arranca el canal principal según el perfil, con la precedencia del
 * backend: modo control de tmux > sesión persistente > comando al conectar >
 * shell. Es la intención del perfil: si en el servidor falta tmux/screen, la
 * sesión persistente degrada y el comando vuelve a contar.
 * @param {any} profile
 * @returns {"tmux_control"|"persist"|"command"|"shell"}
 */
export function launchKind(profile) {
  if (profile?.tmux_control) return "tmux_control";
  if (profile?.persist_session) return "persist";
  if (normalizeRemoteCommand(profile?.remote_command)) return "command";
  return "shell";
}

/**
 * ¿Se puede teclear el hook OSC 7 de `follow_cwd` en esta sesión? Con un
 * comando al conectar, solo si el perfil dice que el comando abre un shell:
 * dentro de `docker exec … sh` o de un programa sería escribirle basura. Las
 * pestañas nuevas de la conexión (`childShell`) siempre abren un shell.
 * @param {any} profile
 * @param {{ childShell?: boolean }} [options]
 */
export function allowsOsc7Hook(profile, { childShell = false } = {}) {
  if (!profile) return true;
  if (profile.follow_cwd === false) return false;
  if (childShell) return true;
  return launchKind(profile) !== "command" || !!profile.remote_command_shell;
}

// ─── ~/.ssh/config ──────────────────────────────────────────────────────────

/**
 * Divide los argumentos de una directiva de ssh_config como OpenSSH: por
 * espacios, con comillas dobles o simples que agrupan (y se quitan) en
 * cualquier punto del argumento, y `\` que escapa el carácter siguiente.
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitSshConfigArgs(value) {
  const s = String(value ?? "");
  /** @type {string[]} */
  const out = [];
  let cur = "";
  let has = false;
  /** @type {string|null} */
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && quote !== "'") {
      cur += s[++i];
      has = true;
    } else if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Un `${…}` que venga en el fichero es del shell remoto, no de Rustty: se
 * escapa (`$${…}`) para que el motor de sustitución lo deje literal.
 * @param {string} text
 */
function escapeSubst(text) {
  return text.replace(/\$\{([^}]*)\}/g, (_, body) => `$\${${body}}`);
}

/** Tokens `%` de `RemoteCommand` con equivalente en el motor de Rustty. */
const REMOTE_COMMAND_TOKENS = {
  "%": "%",
  h: "${host}",
  p: "${port}",
  r: "${user}",
  n: "${profileName}",
  u: "${env:USER}",
  d: "${env:HOME}",
};

/**
 * Traduce un `RemoteCommand` a la plantilla de Rustty: escapa los `${…}` del
 * fichero y convierte los tokens `%` con equivalente. Devuelve los tokens que
 * no lo tienen (quedan tal cual) para avisar.
 * @param {string} value
 * @returns {{ command: string, unknownTokens: string[] }}
 */
export function translateRemoteCommand(value) {
  /** @type {string[]} */
  const unknownTokens = [];
  const command = escapeSubst(value).replace(/%(.)/g, (whole, token) => {
    const mapped = /** @type {Record<string, string>} */ (REMOTE_COMMAND_TOKENS)[token];
    if (mapped !== undefined) return mapped;
    if (!unknownTokens.includes(whole)) unknownTokens.push(whole);
    return whole;
  });
  return { command, unknownTokens };
}

/**
 * @typedef {{ setEnv: EnvVar[], sendEnv: string[], remoteCommand?: string|null, termType?: string }} SshLaunchDirectives
 */

/**
 * Aplica a un bloque `Host` una de las directivas de arranque. Devuelve `null`
 * si la clave no es de este módulo, o la lista (quizá vacía) de entradas no
 * soportadas para el resumen de la importación. Como OpenSSH, dentro de un
 * bloque manda el primer valor de cada directiva (y de cada variable).
 * @param {{ launch?: SshLaunchDirectives }} block
 * @param {string} key  clave ya en minúsculas
 * @param {string} value
 * @returns {string[]|null}
 */
export function applySshConfigLaunchKey(block, key, value) {
  if (!["setenv", "sendenv", "remotecommand", "requesttty"].includes(key)) return null;
  const launch = (block.launch ||= { setEnv: [], sendEnv: [] });
  /** @type {string[]} */
  const unsupported = [];
  if (key === "requesttty") {
    // El terminal de Rustty siempre pide un TTY: `yes`/`force`/`auto` ya es
    // lo que hace; `no` no tiene equivalente.
    if (/^no$/i.test(value.trim())) unsupported.push("RequestTTY no");
    return unsupported;
  }
  if (key === "remotecommand") {
    if (launch.remoteCommand !== undefined) return unsupported;
    const raw = value.trim();
    if (/^none$/i.test(raw)) {
      launch.remoteCommand = null;
      return unsupported;
    }
    const { command, unknownTokens } = translateRemoteCommand(raw);
    launch.remoteCommand = command;
    for (const token of unknownTokens) unsupported.push(`RemoteCommand ${token}`);
    return unsupported;
  }
  if (key === "sendenv") {
    for (const pattern of splitSshConfigArgs(value)) {
      if (pattern.startsWith("-")) {
        // `SendEnv -VAR` retira lo declarado antes.
        const name = pattern.slice(1);
        launch.sendEnv = launch.sendEnv.filter((n) => n !== name);
      } else if (isValidEnvName(pattern)) {
        if (!launch.sendEnv.includes(pattern)) launch.sendEnv.push(pattern);
      } else {
        // Comodines (`LC_*`): Rustty no puede enumerar a qué variables locales
        // se refieren sin mirar el entorno al conectar.
        unsupported.push(`SendEnv ${pattern}`);
      }
    }
    return unsupported;
  }
  // SetEnv NOMBRE=valor [NOMBRE=valor…]
  for (const arg of splitSshConfigArgs(value)) {
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : "";
    if (!isValidEnvName(name)) {
      unsupported.push(`SetEnv ${arg}`);
      continue;
    }
    const val = arg.slice(eq + 1);
    if (name === "TERM") {
      // En OpenSSH, `SetEnv TERM=…` es el TERM del PTY, no una variable más.
      if (launch.termType !== undefined) continue;
      if (TERM_TYPES.includes(val)) launch.termType = val;
      else unsupported.push(`SetEnv ${arg}`);
      continue;
    }
    if (launch.setEnv.some((v) => v.name === name)) continue;
    launch.setEnv.push({ name, value: escapeSubst(val) });
  }
  return unsupported;
}

/**
 * Campos del perfil que declara el bloque. Solo los que el bloque trae: un
 * perfil importado al que el usuario añadió variables en Rustty no las pierde
 * al reimportar un `Host` que no habla de ellas.
 * @param {{ launch?: SshLaunchDirectives }} block
 * @returns {{ remote_command?: string|null, env_vars?: EnvVar[], term_type?: string|null }}
 */
export function launchFieldsFromBlock(block) {
  const launch = block?.launch;
  /** @type {{ remote_command?: string|null, env_vars?: EnvVar[], term_type?: string|null }} */
  const fields = {};
  if (!launch) return fields;
  if (launch.remoteCommand !== undefined) fields.remote_command = launch.remoteCommand || null;
  if (launch.setEnv.length || launch.sendEnv.length) {
    // `SendEnv` reenvía la variable local: en Rustty, `${env:VAR}` al conectar.
    // Si `SetEnv` fija la misma, manda su valor (el servidor recibe el último).
    const fixed = new Set(launch.setEnv.map((v) => v.name));
    fields.env_vars = [
      ...launch.sendEnv.filter((n) => !fixed.has(n)).map((name) => ({ name, value: `\${env:${name}}` })),
      ...launch.setEnv,
    ].slice(0, MAX_ENV_VARS);
  }
  if (launch.termType !== undefined) fields.term_type = normalizeTermType(launch.termType);
  return fields;
}

/**
 * Campos de arranque que cambiarían al aplicar `fields` (de
 * `launchFieldsFromBlock`) sobre un perfil existente.
 * @param {{ remote_command?: string|null, env_vars?: EnvVar[], term_type?: string|null }} fields
 * @param {any} profile
 * @returns {string[]}
 */
export function launchFieldsChanged(fields, profile) {
  /** @type {string[]} */
  const changed = [];
  if ("remote_command" in fields
      && (fields.remote_command || null) !== normalizeRemoteCommand(profile?.remote_command)) {
    changed.push("remote_command");
  }
  if ("env_vars" in fields
      && formatEnvVarsText(fields.env_vars) !== formatEnvVarsText(profile?.env_vars)) {
    changed.push("env_vars");
  }
  if ("term_type" in fields
      && (fields.term_type || null) !== normalizeTermType(profile?.term_type)) {
    changed.push("term_type");
  }
  return changed;
}
