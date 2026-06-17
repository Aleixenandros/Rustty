# Seguridad

Rustty está diseñado como aplicación local-first: no requiere cuenta propia, no envía telemetría y no tiene servidores de Rustty entre tu equipo y tus máquinas.

## Credenciales

- Las contraseñas guardadas van al keyring del sistema operativo.
- Las passphrases de claves privadas también pueden guardarse en el keyring.
- Las bases KeePass se descifran solo en memoria mientras están desbloqueadas.
- Los perfiles no guardan contraseñas en texto plano.
- Los **usuarios adicionales** de un perfil guardan sus secretos en el keyring bajo claves propias (`password:<perfil>:<id>` / `passphrase:<perfil>:<id>`), nunca en `profiles.json`; se sincronizan solo con el opt-in de contraseñas, como los de la identidad principal.
- La sincronización de contraseñas guardadas es opcional y viaja cifrada E2E dentro de `rustty-sync.bin`.
- La base KeePass desbloqueada nunca se sincroniza.
- En Unix, los ficheros locales sensibles (`profiles.json`, `credentials.json` y las notas `notes/*.md`) se escriben con permisos privados `0600`.

## Notas de conexión

Las notas son archivos Markdown (`notes/<id>.md`) pensados para runbooks: comandos, rutas o pasos de mantenimiento. Se renderizan de forma **segura** (el HTML de la nota se escapa; los enlaces solo abren `http`/`https`/`mailto`), así que una nota sincronizada desde otro equipo no puede inyectar código en la app. **No guardes secretos en las notas**: viajan en la copia E2E como el resto de la configuración (no tras el opt-in de contraseñas), pero su contenido no está pensado para credenciales; para eso usa el keyring, KeePass o las credenciales maestras.

## Snippets y comandos locales

Los snippets se insertan en la terminal activa y pueden sincronizarse dentro del backup cifrado. Trátalos como texto operativo: si contienen comandos destructivos, activa **Pedir confirmación** y revisa si deben enviar `Enter` automáticamente.

Los comandos locales se guardan solo en este equipo (`localStorage`) y **no se sincronizan**. Los de tipo shell se ejecutan con el shell del sistema (`sh -c` o `cmd /C`), así que la confirmación viene activada por defecto y el modal los trata como acciones sensibles. En snippets y comandos locales se resuelven variables internas, `${var:...}` y `${ask:...}`; los marcadores de secretos (`${master:...}` / `${secret:...}`) quedan literales para no exponer valores sensibles en el frontend.

## Credenciales maestras y variables

En **Preferencias → Credenciales** puedes definir dos tipos reutilizables entre perfiles: **credenciales maestras** y **variables de texto**. Una credencial maestra (contraseña o token) se guarda una sola vez en el keyring del sistema y se referencia con `${master:nombre}`; el perfil guarda únicamente la referencia, nunca el valor, así que **rotar** la credencial actualiza a la vez todos los perfiles que la usan. Las variables (`${var:nombre}`) son texto plano y sirven para reutilizar valores comunes como un dominio o un usuario.

La lista se organiza en dos pestañas (**Maestras** y **Variables**); cada fila muestra su variable de referencia, que se **copia al portapapeles al pulsarla**.

En el formulario de conexión, el selector **Origen de la contraseña** permite elegir entre *Contraseña propia*, *Credencial maestra* o *KeePass*. También puedes **promover** la contraseña propia de un perfil a credencial maestra desde su menú contextual.

Las credenciales maestras forman parte de un **motor de variables** que resuelve marcadores `${...}` al conectar:

- Internos: `${host}`, `${port}`, `${user}`, `${profileName}`, `${workspace}`, `${date}`, `${time}`.
- Entorno: `${env:NOMBRE}`.
- Variables de texto: `${var:nombre}`.
- Credenciales maestras (keyring): `${master:nombre}`.
- Preguntas al conectar: `${ask:Etiqueta}` o `${ask:Etiqueta|opción1|opción2}`, que se piden una vez al abrir la sesión y no se persisten.

Las variables de texto (`${var:nombre}`) y de entorno (`${env:VAR}`) se resuelven además en los campos **host**, **usuario** y **bastion** del perfil, no solo en la contraseña: por ejemplo, un host `servidor.${var:dominio}` se completa al conectar.

> Avisos: usar la misma credencial en varios hosts implica que, si se compromete, quedan afectados todos a la vez. Las credenciales maestras **no** son la passphrase de sincronización ni la contraseña maestra de KeePass: son conceptos distintos.

Los valores de credenciales maestras y secretos se resuelven en el backend en el momento de conectar; nunca se escriben en `profiles.json`, en exports sin cifrar ni en los logs de sesión. Solo viajan en la copia cifrada E2E si activas la opción de incluir secretos.

## Sincronización cifrada

Cuando activas sincronización o exportas un backup cifrado, Rustty genera `rustty-sync.bin` con `age` y tu passphrase maestra. El backend remoto recibe ese fichero ya cifrado.

Rustty puede conectar con Google Drive, WebDAV, iCloud Drive o una carpeta local/NAS solo cuando lo configuras expresamente en **Preferencias → Copias de seguridad**.

Antes de sobrescribir el estado remoto, Rustty crea snapshots históricos cifrados. Esto ayuda a recuperar estados anteriores si una sincronización no era la esperada.

Si marcas **Contraseñas guardadas (cifradas E2E)**, Rustty lee del keyring local las contraseñas/passphrases guardadas, las mete en el estado cifrado y las restaura en el keyring local de otros equipos. Sin la passphrase de sync no se pueden descifrar.

## Actualizaciones firmadas

La auto-actualización (Windows, macOS y AppImage de Linux) está **firmada criptográficamente**. Cada artefacto publicado lleva una firma generada con una clave privada que solo vive en los secretos del CI del proyecto; la app incluye embebida la **clave pública** correspondiente. Antes de instalar una actualización, Rustty descarga el artefacto y su firma y la **verifica contra la clave pública**: si no cuadra (descarga manipulada o de origen no fiable), la actualización se rechaza. Por eso los ficheros `.sig` aparecen junto a cada binario en la página de releases: son firmas públicas, no exponen ningún secreto.

## Verificación de host SSH

Rustty usa verificación de `known_hosts` con modelo TOFU: la primera huella conocida de un servidor se recuerda, y si más adelante cambia, la app rechaza la conexión y muestra un aviso explícito ("Host key cambiada") con el fingerprint anterior y el recibido, además de la línea de `~/.ssh/known_hosts` a limpiar. Un cambio inesperado puede indicar una reinstalación legítima del servidor o un ataque de intermediario.

La verificación se aplica también cuando el servidor **cambia de algoritmo de host key** (por ejemplo `ssh-rsa` → `ssh-ed25519`): Rustty compara la clave recibida con todas las entradas previas del host, no solo con las del mismo algoritmo, así rotaciones de tipo de clave no se aprenden en silencio.

Cuando necesites resolver un conflicto, **Preferencias → Copias de seguridad → Gestionar known_hosts** abre un gestor visual que lista las entradas de `~/.ssh/known_hosts` (host, puerto, algoritmo y huella SHA256) y permite eliminar la línea conflictiva con confirmación, sin editar el fichero a mano. Tras borrarla, la próxima conexión vuelve a aprender la clave nueva (TOFU).

## Protecciones del terminal

La salida de un servidor remoto es contenido no confiable, así que Rustty añade dos defensas en el propio terminal:

- **Validación de enlaces**: al pulsar un enlace detectado en la salida, Rustty abre directamente solo los esquemas `http`, `https` y `mailto`. Cualquier otro esquema (o una URL que no se pueda interpretar) pide confirmación antes de abrirse, para que la salida remota no pueda lanzar esquemas arbitrarios.
- **Confirmación de pegado peligroso**: antes de enviar al terminal un texto **multilínea**, **muy largo** o con **caracteres de control**, Rustty muestra una previsualización y pide confirmación. Así se evita ejecutar comandos pegados por error o secuencias de control ocultas. Está activado por defecto, se ajusta en **Preferencias → Terminal** y puede desactivarse por perfil en sus opciones avanzadas.
- **Aviso al activar agent forwarding**: el reenvío del agente SSH comparte tu agente local con el host remoto, de modo que un servidor comprometido podría usar tus claves para saltar a otros equipos. Por eso, al activar el toggle de *agent forwarding* en un perfil, Rustty muestra una advertencia y pide confirmación; habilítalo solo en hosts de confianza.
- **Pegado de contraseña acotado (`Ctrl+P`)**: el atajo pega la contraseña del **usuario con el que se conectó** la sesión activa (la principal o la identidad adicional elegida con «Conectar con otro usuario»). Solo la envía a una sesión SSH **conectada y enfocada**, y queda **bloqueado mientras el *broadcast* está activo**, para que el secreto no se difunda a varias sesiones a la vez. El valor no aparece en logs, historial ni previsualizaciones.

## Sesión privada

Desde el menú contextual de un perfil, **"Abrir en privado"** inicia una sesión SSH **efímera** que no deja rastro local: no se añade a recientes ni al quick launcher, no registra detalle en el centro de actividad, no guarda borrador de comandos y **desactiva la grabación de sesión** aunque el perfil la tenga habilitada (también al reconectar). La pestaña se marca con un distintivo para recordarte que estás en modo privado.

## Logs de sesión

La grabación de sesión por perfil vuelca la salida a ficheros en `<data_dir>/session_logs/`. Esos registros pueden contener información sensible (comandos y respuestas del servidor), así que en **Preferencias → Copias de seguridad → Logs de sesión** puedes ver cuántos hay y cuánto ocupan, fijar límites de **retención por edad (días)** y **tamaño total (MB)**, limpiarlos manualmente con un botón y abrir su carpeta directamente.

## Restauración de pantalla anterior

«Conectar y restaurar pantalla anterior» repinta lo que se vio en la última sesión de un perfil. Para ello Rustty guarda en disco un *snapshot* por perfil en `<data_dir>/session_snapshots/<id>.snapshot` (en Unix con permisos `0600`). Ese contenido es la **salida visual** del terminal y puede incluir datos sensibles, igual que los logs de sesión. Por eso: está acotado en tamaño, **nunca se captura en sesiones privadas**, **no se sincroniza** y puede desactivarse en **Preferencias → Terminal → «Guardar pantalla para restaurar»**. Al borrar el perfil se elimina también su snapshot. Es restauración visual, no reanudación del proceso remoto.

## Datos excluidos

Por diseño quedan fuera de la sincronización:

- Bases KeePass desbloqueadas en memoria.
- Rutas locales como `keepassPath` y `keepassKeyfile`.
- Ficheros transferidos por SFTP/FTP/FTPS.
- Contenido de sesiones SSH/RDP.
- Snapshots de pantalla para restaurar sesiones (`session_snapshots/`).
- Comandos locales de Preferencias → Comandos.

Los exports JSON locales sí pueden incluir una sección `secrets`, pero solo después de confirmación explícita. Ese JSON no va cifrado por sí mismo.

## Reporte de vulnerabilidades

Si encuentras un fallo de seguridad, repórtalo de forma privada: usa el formulario «Report a vulnerability» de la pestaña *Security* del [repositorio en GitHub](https://github.com/Aleixenandros/Rustty/security/advisories/new) o el correo de contacto del proyecto. Evita abrir un issue público hasta que exista una corrección. Los detalles completos (versiones soportadas y modelo de seguridad) están en el fichero [`SECURITY.md`](https://github.com/Aleixenandros/Rustty/blob/main/SECURITY.md) del repositorio.

## Sitio web

rustty.es es estático, sin cookies de analítica ni SDKs de tracking. Consulta GitHub para mostrar la última versión publicada y carga fuentes desde Google Fonts.
