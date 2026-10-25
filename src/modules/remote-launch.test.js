import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERM_TYPE,
  MAX_ENV_NAME_LEN,
  MAX_ENV_VALUE_LEN,
  MAX_ENV_VARS,
  MAX_REMOTE_COMMAND_LEN,
  TERM_TYPES,
  allowsOsc7Hook,
  applySshConfigLaunchKey,
  formatEnvVarsText,
  isValidEnvName,
  launchFieldsChanged,
  launchFieldsFromBlock,
  launchKind,
  normalizeRemoteCommand,
  normalizeTermType,
  parseEnvVarsText,
  splitSshConfigArgs,
  translateRemoteCommand,
} from "./remote-launch.js";

describe("espejo del backend", () => {
  const rust = readFileSync(new URL("../../src-tauri/src/remote_launch.rs", import.meta.url), "utf8");

  it("la lista de TERM y los topes son los mismos que en remote_launch.rs", () => {
    const list = rust.match(/pub const TERM_TYPES: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? "";
    expect([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...TERM_TYPES]);
    expect(rust).toContain(`pub const DEFAULT_TERM: &str = "${DEFAULT_TERM_TYPE}";`);
    for (const [name, value] of Object.entries({
      MAX_ENV_VARS, MAX_ENV_NAME_LEN, MAX_ENV_VALUE_LEN, MAX_REMOTE_COMMAND_LEN,
    })) {
      expect(rust).toContain(`pub const ${name}: usize = ${value};`);
    }
  });
});

describe("variables de entorno del formulario", () => {
  it("valida nombres POSIX", () => {
    for (const ok of ["LANG", "LC_ALL", "_x", "a1"]) expect(isValidEnvName(ok)).toBe(true);
    for (const bad of ["", "1A", "A-B", "A B", "Ñ", "$HOME"]) expect(isValidEnvName(bad)).toBe(false);
    expect(isValidEnvName("A".repeat(MAX_ENV_NAME_LEN + 1))).toBe(false);
  });

  it("lee NOMBRE=valor por línea, ignora vacías y comentarios y conserva los ${…}", () => {
    const { vars, error } = parseEnvVarsText(
      "LANG=es_ES.UTF-8\r\n\n# auditoría\n  OPERADOR = ${env:USER} \nURL=a=b=c\nVACIA=",
    );
    expect(error).toBeNull();
    expect(vars).toEqual([
      { name: "LANG", value: "es_ES.UTF-8" },
      { name: "OPERADOR", value: "${env:USER}" },
      { name: "URL", value: "a=b=c" },
      { name: "VACIA", value: "" },
    ]);
    expect(formatEnvVarsText(vars)).toBe("LANG=es_ES.UTF-8\nOPERADOR=${env:USER}\nURL=a=b=c\nVACIA=");
  });

  it("señala la primera línea mala con su motivo", () => {
    expect(parseEnvVarsText("LANG=C\nsin igual").error).toEqual({ line: 2, code: "line" });
    expect(parseEnvVarsText("9X=1").error).toEqual({ line: 1, code: "line", name: "9X" });
    expect(parseEnvVarsText("A=1\nA=2").error).toEqual({ line: 2, code: "duplicate", name: "A" });
    expect(parseEnvVarsText(`A=${"x".repeat(MAX_ENV_VALUE_LEN + 1)}`).error)
      .toEqual({ line: 1, code: "value_too_long", name: "A" });
    // El tope es en bytes, como el backend: «ñ» ocupa dos.
    expect(parseEnvVarsText(`A=${"ñ".repeat(MAX_ENV_VALUE_LEN / 2 + 1)}`).error?.code).toBe("value_too_long");
    expect(parseEnvVarsText(`A=${"ñ".repeat(MAX_ENV_VALUE_LEN / 2)}`).error).toBeFalsy();
    const many = Array.from({ length: MAX_ENV_VARS + 1 }, (_, i) => `V${i}=1`).join("\n");
    expect(parseEnvVarsText(many).error).toEqual({ line: MAX_ENV_VARS + 1, code: "too_many" });
  });

  it("formatea lo que venga del perfil sin romperse", () => {
    expect(formatEnvVarsText(null)).toBe("");
    expect(formatEnvVarsText([{ name: "A" }, { value: "x" }, null])).toBe("A=");
  });
});

describe("tipo de terminal y comando", () => {
  it("solo guarda un TERM de la lista y distinto del de por defecto", () => {
    expect(normalizeTermType("vt100")).toBe("vt100");
    expect(normalizeTermType(DEFAULT_TERM_TYPE)).toBeNull();
    expect(normalizeTermType("rxvt")).toBeNull();
    expect(normalizeTermType("")).toBeNull();
  });

  it("un comando en blanco es ningún comando", () => {
    expect(normalizeRemoteCommand("  sudo -i  ")).toBe("sudo -i");
    expect(normalizeRemoteCommand("   ")).toBeNull();
    expect(normalizeRemoteCommand(undefined)).toBeNull();
  });
});

describe("precedencia y hook OSC 7", () => {
  const base = { follow_cwd: true, remote_command: "docker exec -it app sh" };

  it("modo control > sesión persistente > comando > shell", () => {
    expect(launchKind({ ...base, tmux_control: true, persist_session: true })).toBe("tmux_control");
    expect(launchKind({ ...base, persist_session: true })).toBe("persist");
    expect(launchKind(base)).toBe("command");
    expect(launchKind({ remote_command: "  " })).toBe("shell");
  });

  it("con comando propio solo se inyecta si el comando abre un shell", () => {
    expect(allowsOsc7Hook(base)).toBe(false);
    expect(allowsOsc7Hook({ ...base, remote_command_shell: true })).toBe(true);
    // La pestaña nueva de la conexión abre un shell aunque el perfil tenga comando.
    expect(allowsOsc7Hook(base, { childShell: true })).toBe(true);
    // Si manda la sesión persistente, el comando no se usa.
    expect(allowsOsc7Hook({ ...base, persist_session: true })).toBe(true);
    expect(allowsOsc7Hook({ follow_cwd: true })).toBe(true);
    expect(allowsOsc7Hook({ ...base, follow_cwd: false, remote_command_shell: true })).toBe(false);
    expect(allowsOsc7Hook(null)).toBe(true);
  });
});

describe("~/.ssh/config", () => {
  it("parte los argumentos como OpenSSH", () => {
    expect(splitSshConfigArgs(`A=1 "B=dos palabras" C="tres y" D='x y' E=a\\ b`))
      .toEqual(["A=1", "B=dos palabras", "C=tres y", "D=x y", "E=a b"]);
    expect(splitSshConfigArgs("  ")).toEqual([]);
    expect(splitSshConfigArgs(`X=""`)).toEqual(["X="]);
  });

  it("traduce RemoteCommand: tokens % con equivalente y ${…} literales", () => {
    expect(translateRemoteCommand("cd ${APP_DIR} && ssh %r@%h -p %p # 100%%"))
      .toEqual({ command: "cd $${APP_DIR} && ssh ${user}@${host} -p ${port} # 100%", unknownTokens: [] });
    expect(translateRemoteCommand("echo %C %C").unknownTokens).toEqual(["%C"]);
  });

  it("SetEnv, SendEnv, RemoteCommand y RequestTTY dan campos del perfil", () => {
    const block = {};
    const unsupported = [
      applySshConfigLaunchKey(block, "sendenv", "LANG LC_* OPERADOR VIEJA"),
      applySshConfigLaunchKey(block, "sendenv", "-VIEJA"),
      applySshConfigLaunchKey(block, "setenv", `OPERADOR=ana "ZONA=Europe/Madrid" TERM=vt100 1MAL=x`),
      applySshConfigLaunchKey(block, "setenv", "ZONA=otra"),
      applySshConfigLaunchKey(block, "remotecommand", "sudo -i"),
      applySshConfigLaunchKey(block, "remotecommand", "ignorado: manda el primero"),
      applySshConfigLaunchKey(block, "requesttty", "force"),
      applySshConfigLaunchKey(block, "requesttty", "no"),
    ].flat();
    expect(unsupported).toEqual(["SendEnv LC_*", "SetEnv 1MAL=x", "RequestTTY no"]);
    expect(applySshConfigLaunchKey(block, "hostname", "x")).toBeNull();
    expect(launchFieldsFromBlock(block)).toEqual({
      remote_command: "sudo -i",
      env_vars: [
        { name: "LANG", value: "${env:LANG}" },
        { name: "OPERADOR", value: "ana" },
        { name: "ZONA", value: "Europe/Madrid" },
      ],
      term_type: "vt100",
    });
  });

  it("RemoteCommand none y un bloque sin directivas no tocan nada", () => {
    const none = {};
    applySshConfigLaunchKey(none, "remotecommand", "none");
    expect(launchFieldsFromBlock(none)).toEqual({ remote_command: null });
    expect(launchFieldsFromBlock({})).toEqual({});
  });

  it("al reimportar solo cambia lo que el bloque declara", () => {
    const profile = {
      remote_command: "sudo -i",
      env_vars: [{ name: "LANG", value: "C" }],
      term_type: null,
    };
    // El bloque no habla de variables ni de TERM: no se tocan.
    expect(launchFieldsChanged({ remote_command: "sudo -i" }, profile)).toEqual([]);
    expect(launchFieldsChanged({ remote_command: "htop" }, profile)).toEqual(["remote_command"]);
    expect(launchFieldsChanged({ env_vars: [{ name: "LANG", value: "es" }], term_type: "linux" }, profile))
      .toEqual(["env_vars", "term_type"]);
  });
});
