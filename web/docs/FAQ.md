# FAQ

## ¿Rustty sube mis contraseñas a la nube?

Solo si lo activas explícitamente. En **Preferencias → Copias de seguridad** puedes marcar **Contraseñas guardadas (cifradas E2E)**. Entonces Rustty lee las contraseñas/passphrases del keyring local, las cifra dentro de `rustty-sync.bin` con tu passphrase y las restaura en el keyring de otros equipos.

La base KeePass desbloqueada nunca se sube. Si no marcas ese check, la sincronización incluye perfiles, carpetas, preferencias, temas, notas, snippets, atajos y metadatos de credenciales maestras/variables, pero no valores secretos.

## ¿Qué pasa si pierdo la passphrase de sincronización?

Rustty no puede recuperar el contenido cifrado. Tendrás que crear un estado remoto nuevo o importar una copia cuya passphrase recuerdes.

## ¿Google Drive puede leer mis perfiles?

No debería poder leer el contenido útil: Rustty sube `rustty-sync.bin` ya cifrado con `age`. Además usa `appDataFolder`, un espacio privado de la app, en vez de pedir acceso amplio a tus ficheros visibles.

## ¿Puedo usar OneDrive o Dropbox?

Sí, usando sus clientes de escritorio y seleccionando una carpeta local sincronizada en **Carpeta local / NAS**. La integración OAuth directa de la v1 se limita a Google Drive.

## ¿Cuándo sincroniza Rustty?

Al arrancar la app y cada vez que detecta un cambio local relevante (debounce de 1 minuto para agrupar ráfagas de renombrado/movimiento/borrado). No hay intervalo periódico ni botón de "Auto-sync Sí/No": la sincronización es por evento. Si pulsas **Sincronizar ahora**, se ejecuta al momento.

## ¿Rustty conserva versiones anteriores del backup remoto?

Sí. Antes de sobrescribir `rustty-sync.bin`, Rustty guarda un snapshot cifrado. Conserva 30 copias por defecto y puedes cambiar ese número en **Copias históricas**.

## ¿Puedo volver a una copia anterior?

Sí. En **Preferencias → Copias de seguridad**, el desplegable **Restaurar copia** lista los snapshots disponibles. Al elegir uno y pulsar **Restaurar**, Rustty descarga ese snapshot, lo descifra y reemplaza el estado actual.

## ¿Por qué al abrir la app comprueba actualizaciones?

La comprobación al iniciar es opcional. Puedes activarla o desactivarla en **Preferencias → Acerca de → Comprobar al iniciar**. La comprobación consulta la última release publicada en GitHub.

## ¿Cómo se actualiza Rustty?

En **Windows**, **macOS** y **AppImage de Linux**, Rustty se **actualiza desde dentro de la app**: descarga la nueva versión (verificando su firma), la instala y se reinicia. Lánzalo desde **Preferencias → Acerca de → Comprobar actualizaciones**, o deja activado **Comprobar al iniciar**.

En el resto de formatos de Linux (`.deb`, `.rpm`, Flatpak, Arch) la actualización la hace tu **gestor de paquetes**; Rustty solo te avisa y abre la página de descargas. En Windows, si actualizas con instalador, el `.msi` actualiza in-place; con el `.exe` (NSIS) elige "Uninstall before installing" (conserva tus datos).

## ¿Puedo añadir notas a una conexión?

Sí. Haz clic derecho sobre una conexión → **Añadir nota** y escribe en Markdown, con previsualización en vivo. Cada nota se guarda como un archivo `.md`, se sincroniza y puede mostrarse como **panel runbook** junto a la sesión con casillas de tarea. Más detalles en la [guía de notas](?page=Notas).

## ¿Rustty trae cliente RDP, VNC o Telnet integrado?

No. Esos perfiles viven dentro de Rustty, pero se abren en clientes externos del sistema. RDP usa `xfreerdp`/`rdesktop`, `mstsc` o el cliente registrado; VNC usa un visor VNC como TigerVNC o el manejador `vnc://`; Telnet abre el comando `telnet` en una terminal externa. Más detalles en [Clientes externos](?page=ClientesExternos).

## ¿Los snippets y comandos locales se sincronizan?

Los **snippets remotos** sí: viajan dentro del backup cifrado como `snippet:<id>` y aparecen también en la paleta de comandos. Los **comandos locales** no se sincronizan porque pueden depender de rutas, binarios o asociaciones propias de este equipo.

## ¿Los scripts guardan contraseñas o se sincronizan?

Ninguna de las dos cosas. Los scripts se guardan en un `scripts.json` local que **nunca contiene contraseñas**: los pasos de contraseña solo referencian el keyring o una entrada KeePass, y la salida que muestra el panel redacta los secretos enviados. Para llevar un script a otro equipo, expórtalo como Markdown desde el panel de Scripts e impórtalo allí. Más detalle en la [guía de scripts](?page=Scripts).

## ¿iCloud necesita Client ID o secret?

No. iCloud Drive se usa como carpeta local de macOS; Rustty escribe el blob cifrado y el sistema se encarga de subirlo.

## ¿Qué son los perfiles-contenedor (workspaces)?

Son árboles independientes de carpetas y conexiones que conviven en la misma instalación. Te permiten separar, por ejemplo, **Trabajo** y **Personal**, o un cliente de otro. Se crean, renombran, eliminan y conmutan desde el popover del botón **≡** de la cabecera de la sidebar. Cada conexión guarda el `workspace_id` al que pertenece y la lista, el dashboard y la búsqueda se filtran por el workspace activo. Los workspaces viajan con la sincronización en la nube.

## ¿Dónde están mis datos locales?

En el directorio de datos de Tauri:

- Linux: `~/.local/share/com.rustty.app/`
- macOS: `~/Library/Application Support/com.rustty.app/`
- Windows: `%APPDATA%\com.rustty.app\`

## ¿Rustty recuerda el tamaño de la ventana?

Sí. Rustty guarda tamaño, posición y estado maximizado para que no tengas que redimensionar la ventana en cada arranque.

## ¿Los túneles SSH se cierran solos?

Sí. Los túneles viven asociados a una sesión SSH. Si cierras la sesión o la pestaña, Rustty cierra los listeners locales/remotos que haya creado para ella.

## ¿Puedo abrir túneles sin entrar primero en la pestaña SSH?

Sí. El botón **⇄** del rail lateral abre la vista global de túneles. Desde ahí puedes elegir un perfil SSH, crear un túnel nuevo o arrancar uno guardado. Si el perfil no tiene una sesión activa, Rustty abre la conexión y levanta el túnel al conectar.

## ¿Puedo guardar túneles por perfil?

Sí. En el panel **⇄** puedes marcar **Guardar** para persistir el túnel, o **Auto** para que se abra automáticamente al conectar ese perfil.

## ¿Por qué las transferencias SFTP iban tan lentas?

Hasta la 1.2.x el camino SFTP era serie con buffer de 64 KiB, así que el techo de velocidad era `chunk_size / RTT` (~5 MB/s con 12-15 ms de latencia). Desde la **1.3.0** Rustty mantiene **varias peticiones SFTP en vuelo** con chunks de 256 KiB, lo que satura el ancho de banda real en lugar de quedarse limitado por la latencia. El número de peticiones en paralelo es **configurable** en **Preferencias → FTP/SFTP** (`sftpMaxConcurrent`, 4 por defecto); súbelo para más velocidad o bájalo para servidores con límite de handles (p. ej. Hetzner Storage Box).

## ¿Por qué la sidebar cambia sola al moverme entre pestañas?

Es intencional: cuando activas una pestaña asociada a un perfil, Rustty abre su workspace/carpeta en la sidebar y marca esa conexión. Así puedes ubicar rápidamente qué perfil corresponde a la sesión activa.
