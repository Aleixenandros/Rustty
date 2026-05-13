# Copias de seguridad y sincronización

Rustty agrupa las copias en **Preferencias → Copias de seguridad**. Desde ahí puedes sincronizar entre equipos, exportar un backup cifrado o mover datos locales en JSON.

## Qué se sincroniza

- Perfiles de conexión.
- Carpetas manuales de la barra lateral, incluidas las carpetas vacías.
- Preferencias generales.
- Temas personalizados.
- Atajos configurados por el usuario.
- Snippets, cuando exista la biblioteca de snippets.
- Contraseñas y passphrases guardadas, solo si activas el check **Contraseñas guardadas (cifradas E2E)**.

Las bases KeePass desbloqueadas y rutas locales como `keepassPath` o `keepassKeyfile` no se sincronizan.

## Cifrado

La sincronización usa un fichero `rustty-sync.bin` cifrado localmente con `age` y una passphrase maestra. Google Drive, WebDAV, iCloud Drive o la carpeta compartida solo reciben ese blob cifrado.

Si pierdes la passphrase, Rustty no puede descifrar el backup remoto.

Cuando activas la sincronización de contraseñas guardadas, Rustty lee del keyring local las claves `password:<profile_id>` y `passphrase:<profile_id>`, las incluye en ese blob cifrado y las restaura en el keyring del otro equipo. Google Drive o WebDAV nunca reciben esos valores en claro.

## Sincronización automática

La sincronización comprueba el estado **al iniciar la app** y se dispara **cada vez que detecta un cambio local relevante**, con un debounce de 1 minuto para agrupar ráfagas. Esto da margen para renombrar, mover o borrar varias carpetas antes de que Rustty empiece a sincronizar. No hay intervalo periódico ni opción "Auto-sync Sí/No": Rustty se mantiene al día por evento, no por temporizador.

Si pulsas **Sincronizar ahora**, Rustty cancela cualquier autosync pendiente y ejecuta la sincronización al momento.

Al abrir Rustty, si ya tienes una sincronización configurada, la app hace una comprobación silenciosa de arranque. Si el estado lógico local y remoto ya coincide, no reescribe el blob cifrado ni crea un snapshot histórico nuevo. Cuando termina correctamente, el estado muestra **Sincronizado** y conserva la última fecha real de sincronización.

## Historial y conflictos

Antes de sobrescribir el blob remoto, Rustty guarda una copia histórica cifrada. Se conservan **30 snapshots por defecto**, y el número se puede ajustar en **Copias históricas**.

La poda automática del histórico está disponible para **Carpeta local/NAS**, **WebDAV** y **Google Drive**. En conflictos, Rustty usa resolución last-write-wins por elemento, con tombstones para borrados.

## Restaurar una copia previa

En **Preferencias → Copias de seguridad** hay un desplegable **Restaurar copia** con todos los snapshots disponibles en el backend remoto, ordenados por fecha. Al elegir uno y pulsar **Restaurar**, Rustty descarga el blob, lo descifra con tu passphrase y aplica el estado al frontend con la misma rutina que **Importar fichero**.

La acción pide confirmación porque sustituye perfiles, preferencias, temas y atajos por los de la copia seleccionada.

## Proveedores disponibles

### Google Drive

Rustty abre el navegador para autorizar el acceso con Google. Usa el espacio privado `appDataFolder`, así que no necesita leer ni escribir tus ficheros visibles de Drive. El token de refresco se guarda en el keyring del sistema.

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

## Backup cifrado manual

El botón **Exportar a fichero** crea un `.rustty-sync.bin` cifrado con la passphrase que indiques. **Importar fichero** lo descifra, lo fusiona con el estado local y aplica el resultado.

Este flujo no depende de ningún proveedor remoto.

Antes de exportar, Rustty pregunta si quieres incluir contraseñas/passphrases guardadas. En el backup cifrado es la opción recomendada para mover credenciales entre equipos.

## Export JSON local

Los exports JSON de todos los perfiles, carpetas o workspaces preguntan si quieres incluir contraseñas. Si aceptas, el archivo contiene una sección `secrets` legible por cualquiera que abra el JSON. Úsalo solo para migraciones controladas o guárdalo dentro de un contenedor cifrado.

El JSON conserva las carpetas por workspace (`foldersByWorkspace`) para que una importación no mezcle subcarpetas con el mismo nombre en perfiles/contenedores distintos.
