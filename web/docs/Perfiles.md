# Perfiles de conexión

Los perfiles guardan los datos necesarios para abrir una conexión: nombre, host, puerto, usuario, tipo de conexión y método de autenticación. Las contraseñas no se guardan dentro del perfil.

## Perfiles-contenedor (workspaces)

Además del modelo "perfil = conexión", Rustty admite **perfiles-contenedor** (workspaces) que agrupan árboles independientes de carpetas y conexiones. La cabecera de la barra lateral muestra una barra fina con el contexto activo y un botón **≡** que abre un popover compacto con tres bloques:

- **Vista**: alterna entre *Workspace actual*, *Todos los perfiles* (árbol agrupado por workspace) y *Favoritos*.
- **Perfil**: cambia al workspace que quieras, crea un **Nuevo perfil**, **Renombra** el activo o **Elimina** uno (con confirmación si contiene conexiones; éstas se eliminan en cascada). En la vista *Todos los perfiles* puedes renombrar / eliminar cada workspace directamente desde el menú contextual de su nodo.
- **Buscar**: filtra conexiones por nombre, host, usuario o grupo.

En la vista *Workspace actual* la lista de la sidebar, el dashboard de inicio y la búsqueda se filtran por el workspace activo. Cuando hay más de un workspace, el formulario de conexión muestra un selector de **Perfil** para mover la conexión a otro contenedor. Cada workspace mantiene además su **propio conjunto de carpetas**.

Los workspaces, las carpetas por workspace y el modo de vista viven en las preferencias y viajan con la sincronización en la nube.

Al cambiar de pestaña o enfocar un panel abierto, Rustty intenta sincronizar la sidebar con la conexión activa: cambia al workspace correspondiente, abre la carpeta que contiene el perfil y marca la conexión en la lista.

El estado visual del árbol (workspaces y carpetas abiertos) se recuerda localmente entre reinicios. Es una preferencia de interfaz del equipo actual y no se sincroniza con otros dispositivos.

## Probar sin guardar

El formulario de crear/editar conexión incluye el botón **Probar**. En perfiles SSH valida la resolución/conexión, la host key, la autenticación y la disponibilidad del subsistema SFTP reutilizando el mismo visor de diagnóstico que una sesión real. En perfiles RDP comprueba que el puerto configurado responde y muestra la latencia aproximada.

La prueba no guarda el perfil ni escribe secretos nuevos en el keyring. Si la conexión usa KeePass, Rustty resuelve la contraseña desde la base desbloqueada igual que haría al conectar.

## Selección múltiple y movimiento

En la sidebar puedes seleccionar varias conexiones con **Ctrl/Cmd+click** y rangos con **Shift+click**. Al arrastrar una conexión seleccionada hacia una carpeta o workspace, Rustty mueve el lote completo de conexiones seleccionadas dentro del mismo workspace origen.

## Conexiones favoritas

Cada conexión incluye un botón **estrella** (☆/★) en la sidebar, también accesible desde su menú contextual. Las favoritas se listan completas en la vista **Favoritos** del popover ≡, sin importar a qué workspace pertenezcan, y forman parte del bundle de sincronización junto al resto de preferencias.

## Tipos soportados

- **SSH**: sesión interactiva con terminal, SFTP integrado y autenticación por contraseña, clave pública o agente SSH.
- **RDP**: lanzamiento de escritorio remoto usando `xfreerdp3` / `xfreerdp`, `rdesktop`, `mstsc` o el cliente disponible en el sistema.

## Credenciales

Para SSH puedes elegir:

- **Contraseña**: se pide al conectar o se guarda opcionalmente en el keyring.
- **Clave pública**: selecciona el fichero de clave privada; la passphrase puede guardarse en el keyring.
- **Agente SSH**: usa el agente del sistema cuando está disponible.

También puedes asociar una entrada KeePass al perfil para resolver la contraseña desde una base `.kdbx` desbloqueada.

El check de guardar contraseña/passphrase aparece marcado por defecto para favorecer flujos multi-equipo; desmárcalo si no quieres guardar ese secreto en el keyring local. Si activas la sincronización de contraseñas guardadas en **Copias de seguridad**, esos secretos viajan cifrados E2E y se restauran en el keyring de los demás equipos.

En perfiles RDP, **Guardar y conectar** usa la contraseña escrita en el formulario para esa conexión aunque no marques guardarla en el keyring. Si no hay contraseña disponible, Rustty la pedirá con el mismo modal integrado con el tema.

## CLI SSH

Los perfiles SSH guardados también se pueden usar desde terminal para listar conexiones, abrir sesiones interactivas o ejecutar comandos remotos. Rustty reutiliza host/IP, puerto, usuario, método de autenticación, keyring, `known_hosts`, ProxyJump, keepalive, agent forwarding y compatibilidad legacy si estaba activada. Consulta la [guía del CLI SSH](?page=CLI) para ejemplos completos.

## Seguimiento del directorio remoto (CWD)

El toggle **CWD** vive ahora en la toolbar del panel SFTP, no en el formulario de conexión. Pulsa el botón **CWD** del panel para activar o desactivar el seguimiento del directorio actual del terminal por perfil. Por defecto está activo.

## Opciones avanzadas

En el formulario de perfil, la sección **Opciones avanzadas** expone toggles SSH adicionales:

- **Keep-alive (segundos)**: 0 deshabilita; cualquier valor mayor envía un paquete keepalive al servidor cada N segundos para evitar caídas por NAT.
- **Permitir cifrados / kex / MAC antiguos**: extiende la negociación con `aes-cbc`, `dh-sha1`, `hmac-sha1` y `ssh-rsa` para conectar con servidores legacy. ⚠️ Reduce la seguridad: úsalo sólo cuando lo necesites.
- **Reenviar agente SSH**: reusa `$SSH_AUTH_SOCK` (sólo Unix) para autenticar saltos desde el host remoto sin copiar las claves.
- **Reenviar X11**: solicita el canal X11 con cookie sintética `MIT-MAGIC-COOKIE-1` y lo redirige a `localhost:6000+display`. Requiere un X server local.
- **Bastion / Jump host**: conecta primero a un host bastión y abre el destino real a través de un canal `direct-tcpip`, equivalente a `ProxyJump`.

Todas las opciones son **opt-in** y se guardan en el perfil; los toggles permanecen apagados hasta que los actives explícitamente.

## Túneles guardados

Los perfiles SSH pueden guardar túneles locales, remotos o dinámicos / SOCKS. Al crear un túnel desde el panel **⇄** de una sesión o desde el acceso global **⇄** del rail puedes marcar **Guardar** para dejarlo asociado al perfil, o **Auto** para que Rustty lo levante automáticamente tras conectar la sesión.

Los túneles guardados forman parte del perfil y se incluyen en backups y sincronización cifrada.

## Duplicar perfiles y sesiones

Desde el menú contextual de un perfil de la sidebar puedes **Duplicar conexión**: crea una copia con nuevo UUID, mismo grupo y nombre sufijado con " (copia)" lista para editar antes de guardar.

Sobre la pestaña de una sesión activa, el menú contextual permite **Duplicar sesión**: abre una nueva sesión con el mismo perfil. Para shell local replica con un nuevo PTY; para RDP relanza el cliente externo.

## Organización

Los perfiles pueden agruparse en carpetas de la barra lateral. Cada workspace tiene su propio árbol de carpetas; las carpetas manuales, incluidas las vacías, se sincronizan entre equipos cuando está activa la sincronización de perfiles/preferencias.

Las carpetas se guardan como rutas completas dentro de cada workspace, por ejemplo `Producción/Web`. Si tienes subcarpetas con el mismo nombre bajo padres distintos, Rustty opera sobre la ruta completa y el workspace real del nodo seleccionado.

Al renombrar, mover o borrar una carpeta en un equipo, el cambio viaja con la sincronización y se refleja en el resto de equipos.

## Copias y sincronización

Los perfiles forman parte de los backups cifrados y de la sincronización en la nube. Rustty usa marcas de tiempo por perfil para resolver cambios simultáneos con last-write-wins.

Los exports JSON de perfiles, carpetas y workspaces preguntan antes de incluir contraseñas. Si aceptas, el JSON tendrá una sección `secrets`; trátalo como material sensible. Los exports conservan también las carpetas por workspace para evitar mezclas al importar.
