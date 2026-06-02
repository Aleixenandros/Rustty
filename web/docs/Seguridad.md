# Seguridad

Rustty está diseñado como aplicación local-first: no requiere cuenta propia, no envía telemetría y no tiene servidores de Rustty entre tu equipo y tus máquinas.

## Credenciales

- Las contraseñas guardadas van al keyring del sistema operativo.
- Las passphrases de claves privadas también pueden guardarse en el keyring.
- Las bases KeePass se descifran solo en memoria mientras están desbloqueadas.
- Los perfiles no guardan contraseñas en texto plano.
- La sincronización de contraseñas guardadas es opcional y viaja cifrada E2E dentro de `rustty-sync.bin`.
- La base KeePass desbloqueada nunca se sincroniza.
- En Unix, `profiles.json` se escribe con permisos privados `0600`.

## Sincronización cifrada

Cuando activas sincronización o exportas un backup cifrado, Rustty genera `rustty-sync.bin` con `age` y tu passphrase maestra. El backend remoto recibe ese fichero ya cifrado.

Rustty puede conectar con Google Drive, WebDAV, iCloud Drive o una carpeta local/NAS solo cuando lo configuras expresamente en **Preferencias → Copias de seguridad**.

Antes de sobrescribir el estado remoto, Rustty crea snapshots históricos cifrados. Esto ayuda a recuperar estados anteriores si una sincronización no era la esperada.

Si marcas **Contraseñas guardadas (cifradas E2E)**, Rustty lee del keyring local las contraseñas/passphrases guardadas, las mete en el estado cifrado y las restaura en el keyring local de otros equipos. Sin la passphrase de sync no se pueden descifrar.

## Verificación de host SSH

Rustty usa verificación de `known_hosts` con modelo TOFU: la primera huella conocida de un servidor se recuerda, y si más adelante cambia, la app rechaza la conexión y muestra un aviso explícito ("Host key cambiada") con el fingerprint anterior y el recibido, además de la línea de `~/.ssh/known_hosts` a limpiar. Un cambio inesperado puede indicar una reinstalación legítima del servidor o un ataque de intermediario.

La verificación se aplica también cuando el servidor **cambia de algoritmo de host key** (por ejemplo `ssh-rsa` → `ssh-ed25519`): Rustty compara la clave recibida con todas las entradas previas del host, no solo con las del mismo algoritmo, así rotaciones de tipo de clave no se aprenden en silencio.

Cuando necesites resolver un conflicto, **Preferencias → Copias de seguridad → Gestionar known_hosts** abre un gestor visual que lista las entradas de `~/.ssh/known_hosts` (host, puerto, algoritmo y huella SHA256) y permite eliminar la línea conflictiva con confirmación, sin editar el fichero a mano. Tras borrarla, la próxima conexión vuelve a aprender la clave nueva (TOFU).

## Protecciones del terminal

La salida de un servidor remoto es contenido no confiable, así que Rustty añade dos defensas en el propio terminal:

- **Validación de enlaces**: al pulsar un enlace detectado en la salida, Rustty abre directamente solo los esquemas `http`, `https` y `mailto`. Cualquier otro esquema (o una URL que no se pueda interpretar) pide confirmación antes de abrirse, para que la salida remota no pueda lanzar esquemas arbitrarios.
- **Confirmación de pegado peligroso**: antes de enviar al terminal un texto **multilínea**, **muy largo** o con **caracteres de control**, Rustty muestra una previsualización y pide confirmación. Así se evita ejecutar comandos pegados por error o secuencias de control ocultas. Está activado por defecto, se ajusta en **Preferencias → Terminal** y puede desactivarse por perfil en sus opciones avanzadas.
- **Aviso al activar agent forwarding**: el reenvío del agente SSH comparte tu agente local con el host remoto, de modo que un servidor comprometido podría usar tus claves para saltar a otros equipos. Por eso, al activar el toggle de *agent forwarding* en un perfil, Rustty muestra una advertencia y pide confirmación; habilítalo solo en hosts de confianza.

## Logs de sesión

La grabación de sesión por perfil vuelca la salida a ficheros en `<data_dir>/session_logs/`. Esos registros pueden contener información sensible (comandos y respuestas del servidor), así que en **Preferencias → Copias de seguridad → Logs de sesión** puedes ver cuántos hay y cuánto ocupan, fijar límites de **retención por edad (días)** y **tamaño total (MB)**, limpiarlos manualmente con un botón y abrir su carpeta directamente.

## Datos excluidos

Por diseño quedan fuera de la sincronización:

- Bases KeePass desbloqueadas en memoria.
- Rutas locales como `keepassPath` y `keepassKeyfile`.
- Ficheros transferidos por SFTP.
- Contenido de sesiones SSH/RDP.

Los exports JSON locales sí pueden incluir una sección `secrets`, pero solo después de confirmación explícita. Ese JSON no va cifrado por sí mismo.

## Reporte de vulnerabilidades

Si encuentras un fallo de seguridad, repórtalo de forma privada: usa el formulario «Report a vulnerability» de la pestaña *Security* del [repositorio en GitHub](https://github.com/Aleixenandros/Rustty/security/advisories/new) o el correo de contacto del proyecto. Evita abrir un issue público hasta que exista una corrección. Los detalles completos (versiones soportadas y modelo de seguridad) están en el fichero [`SECURITY.md`](https://github.com/Aleixenandros/Rustty/blob/main/SECURITY.md) del repositorio.

## Sitio web

rustty.es es estático, sin cookies de analítica ni SDKs de tracking. Consulta GitHub para mostrar la última versión publicada y carga fuentes desde Google Fonts.
