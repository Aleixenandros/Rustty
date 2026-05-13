# KeePass

Rustty puede leer bases KeePass `.kdbx` para resolver contraseñas sin copiarlas a los perfiles.

## Desbloquear una base

En **Preferencias → KeePass** selecciona:

- Ruta del fichero `.kdbx`.
- Contraseña maestra.
- Keyfile opcional, si tu base lo usa.

La base se descifra en memoria y queda disponible hasta que la bloquees, abras otra base o cierres la app.

## Asociar entradas a perfiles

En el formulario de conexión puedes asociar un perfil a una entrada KeePass. Al conectar, Rustty toma la contraseña desde esa entrada desbloqueada.

Los perfiles solo guardan el UUID de la entrada, no la contraseña.

## Sincronización

Rustty no sincroniza la base KeePass ni su estado desbloqueado. Si quieres usar la misma base en varios equipos, guárdala en una ubicación que tú controles y configura la ruta local en cada equipo.

Las rutas `keepassPath` y `keepassKeyfile` quedan fuera de la sincronización para evitar mezclar rutas locales entre sistemas distintos.
