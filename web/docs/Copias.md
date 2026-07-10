# Copias de seguridad y sincronización

Rustty agrupa las copias en **Preferencias → Copias de seguridad**. Desde ahí puedes sincronizar entre equipos, exportar un backup cifrado o mover datos locales en JSON.

## Qué se sincroniza

- Perfiles de conexión.
- Carpetas manuales de la barra lateral, incluidas las carpetas vacías.
- Preferencias generales.
- Temas personalizados.
- Atajos configurados por el usuario.
- **Notas de conexión** en Markdown (opt-in **Notas**, activo por defecto).
- Snippets remotos creados en **Preferencias → Comandos**.
- El catálogo de **credenciales maestras y variables** (metadatos: nombre y tipo). Las variables de texto incluyen su valor; las maestras no.
- Contraseñas y passphrases guardadas y los **valores de las credenciales maestras**, solo si activas el check **Contraseñas guardadas (cifradas E2E)**.

Las bases KeePass desbloqueadas, rutas locales como `keepassPath` o `keepassKeyfile` y los **comandos locales** de Preferencias → Comandos no se sincronizan. Los comandos locales pueden depender de rutas, programas o URLs propias de un equipo. Los **scripts** tampoco se sincronizan: viven en `scripts.json` local y se mueven entre equipos exportándolos e importándolos como Markdown desde el propio panel de Scripts.

## Cifrado

La sincronización usa un fichero `rustty-sync.bin` cifrado localmente con `age` y una passphrase maestra. Google Drive, WebDAV, iCloud Drive o la carpeta compartida solo reciben ese blob cifrado.

Si pierdes la passphrase, Rustty no puede descifrar el backup remoto.

El campo de passphrase muestra un **medidor de fortaleza** mientras escribes y un botón **Generar passphrase** crea una fuerte y pronunciable (todo en local, sin red). Con **Cambiar passphrase…** un asistente re-cifra el estado del servidor —y, si quieres, también las copias históricas— con la nueva; los demás equipos mostrarán un aviso claro de «passphrase incorrecta» hasta que la actualices en sus Preferencias.

Cuando activas la sincronización de contraseñas guardadas, Rustty lee del keyring local las claves `password:<profile_id>` y `passphrase:<profile_id>` —y, con el mismo opt-in, los valores de las credenciales maestras (`master:<id>`)—, los incluye en ese blob cifrado y los restaura en el keyring del otro equipo. Google Drive o WebDAV nunca reciben esos valores en claro.

## Sincronización automática

La sincronización comprueba el estado **al iniciar la app** y se dispara **cada vez que detecta un cambio local relevante**, con un debounce de 1 minuto para agrupar ráfagas. Esto da margen para renombrar, mover o borrar varias carpetas antes de que Rustty empiece a sincronizar.

Desde la v1.51.0 existe además la **sincronización periódica**: un selector en Preferencias → Copias de seguridad para buscar cambios de otros equipos cada 1, 5, 15, 30 o 60 minutos mientras la app está abierta. Viene **desactivada por defecto** y el intervalo lo eliges tú. Si una pasada (periódica o la del arranque) no trae ningún cambio, no reescribe nada y **no toca la interfaz**: ni redibuja la barra lateral ni interrumpe lo que estés haciendo.

Si pulsas **Sincronizar ahora**, Rustty cancela cualquier autosync pendiente y ejecuta la sincronización al momento.

Al abrir Rustty, si ya tienes una sincronización configurada, la app hace una comprobación silenciosa de arranque. Si el estado lógico local y remoto ya coincide, no reescribe el blob cifrado ni crea un snapshot histórico nuevo. Cuando termina correctamente, el estado muestra **Sincronizado** y conserva la última fecha real de sincronización. Durante esa pasada inicial, un **indicador discreto** en la esquina inferior muestra «Sincronizando…» y después «Al día» (desactivable en Preferencias).

Al **cerrar la app** con cambios aún pendientes de subir, Rustty hace una sincronización final rápida (máximo 3 segundos) para que no se pierdan hasta el próximo arranque. Se controla con el toggle **Sincronizar al salir** (activado por defecto).

Los cortes de red no generan errores rojos: los fallos de conectividad se muestran como estado **Sin conexión** y la app reintenta sola al cabo de un minuto. Los errores pasajeros del servidor (throttling, 5xx) se reintentan automáticamente con esperas crecientes dentro de la misma pasada. Si el reloj de tu equipo difiere mucho del servidor, Rustty lo avisa (un reloj adelantado ya no «gana» los conflictos indefinidamente).

## Primera sincronización con vista previa

Al activar la sincronización en un equipo cuando el servidor **ya contiene datos**, Rustty muestra primero el alcance del primer merge —cuántos perfiles, temas, notas… se añadirían, cambiarían o borrarían, con una muestra de nombres— y pide confirmación antes de aplicar nada. Si el remoto está vacío o idéntico, no pregunta.

## Actividad de sincronización

La pestaña Copias de seguridad incluye un registro con las últimas pasadas que trajeron cambios: qué se aplicó y **desde qué equipo**. Puedes dar un nombre legible a cada equipo («Portátil del trabajo») en **Nombre de este equipo**; los demás lo verán en su registro en lugar del identificador.

## Historial y conflictos

Antes de sobrescribir el blob remoto, Rustty guarda una copia histórica cifrada. Se conservan **30 snapshots por defecto**, y el número se puede ajustar en **Copias históricas**.

La poda automática del histórico está disponible para **Carpeta local/NAS**, **WebDAV** y **Google Drive**. En conflictos, Rustty usa resolución last-write-wins por elemento, con tombstones para borrados.

Los **registros de borrado** (lo que impide que un elemento eliminado «resucite» desde otro equipo) caducan a los 90 días por defecto; el plazo se elige en Preferencias, con la opción **Conservar siempre** para quien tenga equipos que pasan meses apagados.

En WebDAV, si dos equipos suben cambios a la vez, la escritura es condicional: el choque se detecta, se vuelve a fusionar y se sube el resultado combinado en vez de pisar el push ajeno. En Google Drive, si dos equipos estrenan la sincronización en el mismo momento y crean dos archivos, Rustty los detecta, fusiona su contenido y deja uno solo.

Cuando configuras la sincronización en un **equipo recién instalado**, su configuración local (workspaces, carpetas, favoritos) aún no tiene cambios propios, así que el primer sync **adopta la del equipo que ya tenía datos** en lugar de sobrescribirla. A partir de ahí, las ediciones que hagas en cualquier equipo se propagan por fecha de modificación.

## Restaurar una copia previa

En **Preferencias → Copias de seguridad** hay un desplegable **Restaurar copia** con todos los snapshots disponibles en el backend remoto, ordenados por fecha. Al elegir uno y pulsar **Restaurar**, Rustty descarga el blob, lo descifra con tu passphrase y aplica el estado al frontend con la misma rutina que **Importar fichero**.

La acción pide confirmación porque sustituye perfiles, preferencias, temas, notas y atajos por los de la copia seleccionada.

## Proveedores disponibles

### Google Drive

Rustty abre el navegador para autorizar el acceso con Google. Usa el espacio privado `appDataFolder`, así que no necesita leer ni escribir tus ficheros visibles de Drive. El token de refresco se guarda en el keyring del sistema. Durante la autorización, Rustty espera la respuesta legítima de Google e ignora las conexiones de sondeo que abren algunos navegadores, así que el flujo no se corta a medias.

La app no pide Client ID ni Client secret al usuario. Esas credenciales vienen integradas en las builds oficiales.

Los snapshots históricos se guardan también en `appDataFolder` y se podan automáticamente según el límite configurado.

### iCloud Drive

En macOS, Rustty puede usar una carpeta dentro de iCloud Drive:

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Rustty/
```

Rustty escribe el fichero cifrado ahí y macOS se encarga de sincronizarlo.

### Carpeta local / NAS

Útil para carpetas compartidas, NAS, Syncthing o clientes de nube instalados en el sistema. Elige una carpeta y Rustty guardará dentro `rustty-sync.bin`.

Puedes usar el botón **Abrir carpeta** desde Preferencias para diagnosticar qué se está escribiendo.

### WebDAV

Compatible con Nextcloud, ownCloud y servidores WebDAV genéricos. La contraseña WebDAV se guarda en el keyring del sistema. Rustty crea el directorio de histórico si lo necesita y poda snapshots antiguos según tu configuración.

## Eliminar los datos del servidor

El botón **Eliminar datos del servidor…** borra del proveedor el estado cifrado y todas las copias históricas, y limpia la caché local del equipo. Tus datos locales (perfiles, temas, notas…) no se tocan. Además, al **desactivar** la sincronización se limpia automáticamente la caché local del último merge.

## Backup cifrado manual

El botón **Exportar a fichero** crea un `.rustty-sync.bin` cifrado con la passphrase que indiques. **Importar fichero** lo descifra, lo fusiona con el estado local y aplica el resultado.

Este flujo no depende de ningún proveedor remoto.

Antes de exportar, Rustty pregunta si quieres incluir contraseñas/passphrases guardadas. En el backup cifrado es la opción recomendada para mover credenciales entre equipos.

## Export JSON local

Los exports JSON de todos los perfiles, carpetas o workspaces preguntan si quieres incluir contraseñas. Si aceptas, el archivo contiene una sección `secrets` legible por cualquiera que abra el JSON. Úsalo solo para migraciones controladas o guárdalo dentro de un contenedor cifrado.

El JSON conserva las carpetas por workspace (`foldersByWorkspace`) para que una importación no mezcle subcarpetas con el mismo nombre en perfiles/contenedores distintos.
