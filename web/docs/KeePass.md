# KeePass

Rustty puede leer bases KeePass `.kdbx` para resolver contraseñas sin copiarlas a los perfiles.

## Desbloquear una base

En **Preferencias → KeePass** selecciona:

- Ruta del fichero `.kdbx`.
- Contraseña maestra.
- Keyfile opcional, si tu base lo usa.

La base se descifra en memoria y queda disponible hasta que la bloquees, abras otra base o cierres la app.

## Bloqueo automático

Por defecto la base permanece abierta mientras la app lo esté. En **Preferencias → KeePass** puedes hacer que se cierre sola:

- **Bloqueo automático**: `Nunca` (por defecto) o tras `5`, `15`, `30` o `60` minutos **sin usarla**. Junto al estado verás cuánto queda para el cierre.
- **Bloquear al suspender el equipo** (activado por defecto): si cierras el portátil con la base abierta, al despertar la encuentras bloqueada.

Conviene entender qué cuenta como "usarla": el contador solo se reinicia cuando la base interviene de verdad —al desbloquearla, al elegir una entrada o al conectar un perfil que saca de ella su contraseña—. **La actividad del terminal no cuenta**: una sesión con un comando escupiendo salida no mantiene tus contraseñas abiertas indefinidamente, que es precisamente de lo que protege esta opción.

Al bloquearse, la base se cierra por completo: se borra de memoria y la lista de entradas desaparece de la interfaz. Para volver a usarla tendrás que introducir la contraseña maestra otra vez.

## Asociar entradas a perfiles

En el formulario de conexión puedes asociar un perfil a una entrada KeePass. Al conectar, Rustty toma la contraseña desde esa entrada desbloqueada.

Los perfiles solo guardan el UUID de la entrada, no la contraseña.

## Sincronización

Rustty no sincroniza la base KeePass ni su estado desbloqueado. Si quieres usar la misma base en varios equipos, guárdala en una ubicación que tú controles y configura la ruta local en cada equipo.

Las rutas `keepassPath` y `keepassKeyfile` quedan fuera de la sincronización para evitar mezclar rutas locales entre sistemas distintos.
