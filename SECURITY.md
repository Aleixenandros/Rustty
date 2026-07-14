# Política de seguridad

Gracias por ayudar a mantener Rustty seguro. Rustty es un cliente de acceso remoto multiplataforma (Linux, macOS y Windows) escrito en Rust + Tauri 2. Esta política describe cómo reportar vulnerabilidades, qué versiones reciben parches y qué garantías de seguridad ofrece el proyecto.

## Reporte de vulnerabilidades

Si crees haber encontrado una vulnerabilidad de seguridad, repórtala de forma **privada y responsable**. **No abras un issue público** ni publiques detalles en foros, redes sociales o pull requests hasta que exista una corrección disponible.

Vías de contacto, en orden de preferencia:

1. **GitHub Security Advisories (vía preferida).** Usa el formulario privado "Report a vulnerability" en la pestaña *Security* del repositorio: <https://github.com/Aleixenandros/Rustty/security/advisories/new>. Permite coordinar la corrección y la divulgación de forma confidencial.
2. **Correo electrónico.** Si no puedes usar GitHub, escribe a **aleixenandros@gmail.com** con el asunto `[Rustty][Security]`.

Incluye, en la medida de lo posible:

- Versión de Rustty y sistema operativo afectados.
- Descripción del problema y su impacto.
- Pasos para reproducirlo (prueba de concepto si la tienes).
- Cualquier mitigación temporal que conozcas.

Al tratarse de un proyecto mantenido de forma voluntaria, no se garantizan plazos de respuesta concretos, pero los reportes se atienden con la mayor diligencia posible. Se agradece dar un margen razonable para publicar una corrección antes de divulgar los detalles.

## Versiones soportadas

Solo la última versión menor publicada recibe parches de seguridad. La versión actual es la línea **1.55.x** (`package.json` y `src-tauri/Cargo.toml` declaran `1.55.0`).

| Versión | Soporte de seguridad |
| ------- | -------------------- |
| 1.55.x  | Sí                   |
| < 1.55  | No                   |

Si usas una versión anterior, actualiza a la última 1.55.x para recibir correcciones.

## Superficie de seguridad

Rustty incluye, dentro del alcance de esta política, los siguientes componentes:

- **SSH y SFTP**: implementados con [`russh`](https://github.com/warp-tech/russh) y `russh-sftp`, en Rust puro (no envuelven el binario `ssh` del sistema).
- **RDP**: Rustty no implementa el protocolo RDP; actúa como **lanzador de un cliente externo del sistema** (`mstsc.exe` en Windows; `xfreerdp3`/`xfreerdp` o `rdesktop` como alternativa en Linux).
- **Shell local**: terminal sobre un PTY local.
- **Túneles SSH**: reenvío de puertos local y remoto, agent forwarding y X11 forwarding (estos dos últimos solo cuando se activan explícitamente en el perfil).
- **Sincronización en la nube**: copia/sincronización cifrada de extremo a extremo (E2E) del estado de configuración.

## Modelo de seguridad

Las siguientes garantías reflejan el comportamiento real del código y la documentación del proyecto.

### Credenciales

- Las contraseñas y passphrases de claves se almacenan en el **keyring del sistema operativo** bajo el servicio `rustty` (claves `password:<id>` / `passphrase:<id>`). Los ficheros de perfil JSON **no contienen contraseñas en texto plano**.
- Rustty admite bases de datos **KeePass (`.kdbx`)** como fuente de secretos, referenciando las entradas por UUID. La base KeePass se descifra **solo en memoria** mientras está desbloqueada.

### Verificación de host SSH

- La autenticación de host usa `known_hosts` con modelo **TOFU** (*Trust On First Use*): la primera clave de un servidor se aprende y se recuerda.
- Si la clave de host **cambia** más adelante, Rustty **rechaza la conexión** y muestra un aviso explícito con el fingerprint SHA256 recibido y las entradas previas de `known_hosts` a revisar.
- La comprobación cubre también el caso en que el servidor **cambia de algoritmo de host key** (por ejemplo `ssh-rsa` → `ssh-ed25519`): la clave nueva no se aprende en silencio si ya existían entradas para ese host y puerto.

### Sincronización cifrada de extremo a extremo

- La sincronización es **opcional (opt-in)** y **local-first**: no existe un servidor propio de Rustty entre tu equipo y tus datos. El usuario configura el destino (Google Drive, WebDAV, iCloud Drive o una carpeta local/NAS).
- El estado se cifra con [`age`](https://github.com/FiloSottile/age) y una **passphrase maestra** antes de subirse. El backend remoto solo recibe un blob ya cifrado (`rustty-sync.bin`); sin la passphrase no es descifrable.
- **Nunca** se sincroniza la base KeePass desbloqueada ni rutas locales como `keepassPath` o `keepassKeyfile`. Las contraseñas guardadas solo viajan dentro del blob cifrado E2E, y únicamente si activas esa opción de forma explícita.

### Sin telemetría

- Rustty es local-first y **no envía datos de uso ni telemetría**. No requiere una cuenta propia de Rustty.

### Permisos de fichero

- En sistemas Unix, `profiles.json` se escribe con permisos restringidos **`0600`** (solo el usuario propietario puede leerlo o escribirlo).

### Ejecución de comandos y SFTP elevado

- El acceso SFTP a rutas privilegiadas (SFTP elevado) es **opt-in** y se realiza lanzando `sudo -n` sobre el binario `sftp-server` del servidor remoto. Requiere que el `sudoers` del servidor permita esa ejecución sin contraseña (`NOPASSWD`); Rustty no eleva privilegios por su cuenta.

### Firma de código y actualizaciones

- Los binarios de **macOS** se firman con **Apple Developer ID Application** y se **notarizan** con Apple. La firma de código de **Windows** está en evaluación; hasta entonces los instaladores de Windows se publican sin firma Authenticode y deben verificarse por su `sha256`.
- Las **actualizaciones automáticas** (updater de Tauri) van firmadas con una clave **minisign**; la app verifica cada artefacto contra la clave pública embebida antes de instalarlo y rechaza los que no cuadren.
- Las builds oficiales se construyen **solo desde el código fuente público** vía GitHub Actions; los binarios locales no se firman. Cada release requiere **aprobación manual** antes de firmarse.
- El detalle completo (mecanismos, roles, build verificable y cómo verificar una descarga) está en [`CODE_SIGNING.md`](CODE_SIGNING.md).

## Fuera de alcance

Quedan fuera del alcance de esta política, por depender de software o entornos que Rustty no controla:

- La seguridad del **propio sistema operativo** y de su **keyring/almacén de credenciales** (Credential Manager de Windows, Keychain de macOS, Secret Service de Linux, etc.).
- La seguridad y configuración de los **servidores remotos** a los que te conectas (sus claves, su `sudoers`, sus servicios SSH/SFTP).
- El **cliente RDP externo del sistema** (`mstsc.exe`, `xfreerdp`, `rdesktop`) y sus posibles vulnerabilidades, ya que Rustty solo lo lanza.
- Los **proveedores de almacenamiento en la nube** elegidos para la sincronización (Google Drive, WebDAV, iCloud, NAS). Rustty solo garantiza que el contenido sube cifrado E2E.
- La protección de la **passphrase maestra de sincronización**: si se pierde, los datos cifrados no se pueden recuperar; si se filtra, el blob deja de ser confidencial.
- Los **exports JSON locales** que el usuario genere con la sección `secrets` incluida: ese fichero no va cifrado por sí mismo y su custodia es responsabilidad del usuario.
