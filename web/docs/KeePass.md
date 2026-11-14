# KeePass

Rustty reúne en **Preferencias → Credenciales** las tres fuentes reutilizables:
credenciales locales protegidas por el keyring, bases KeePass y variables de
texto. Cada fuente conserva su almacenamiento y sus reglas de seguridad; la
sección común solo evita repartirlas por menús distintos.

La cabecera muestra el número de credenciales locales y si KeePass está
bloqueado o desbloqueado. Usa **←/→**, **Inicio** y **Fin** para recorrer las
vistas **Locales / KeePass / Variables** con el teclado.

## Desbloquear una base

En **Preferencias → Credenciales → KeePass** selecciona:

- Ruta del fichero `.kdbx`.
- Contraseña maestra.
- Keyfile opcional, si tu base lo usa.

La base se descifra en memoria y queda disponible hasta que la bloquees, abras otra base o cierres la app.

## Bloqueo automático

Por defecto la base permanece abierta mientras la app lo esté. En
**Preferencias → Credenciales → KeePass** puedes hacer que se cierre sola:

- **Bloqueo automático**: `Nunca` (por defecto) o tras `5`, `15`, `30` o `60` minutos **sin usarla**. Junto al estado verás cuánto queda para el cierre.
- **Bloquear al suspender el equipo** (activado por defecto): si cierras el portátil con la base abierta, al despertar la encuentras bloqueada.

Conviene entender qué cuenta como "usarla": el contador solo se reinicia cuando la base interviene de verdad —al desbloquearla, al elegir una entrada o al conectar un perfil que saca de ella su contraseña—. **La actividad del terminal no cuenta**: una sesión con un comando escupiendo salida no mantiene tus contraseñas abiertas indefinidamente, que es precisamente de lo que protege esta opción.

Al bloquearse, la base se cierra por completo: se borra de memoria y la lista de entradas desaparece de la interfaz. Para volver a usarla tendrás que introducir la contraseña maestra otra vez.

## Asociar entradas a perfiles

En el formulario de conexión puedes asociar un perfil a una entrada KeePass. Al conectar, Rustty toma la contraseña desde esa entrada desbloqueada.

Los perfiles solo guardan el UUID de la entrada, no la contraseña.

## Código de verificación (TOTP) desde KeePass

Si el servidor pide un segundo factor (Google Authenticator, PAM…) y guardas su semilla en KeePass —en el campo «otp» de la entrada, como hace KeePassXC—, Rustty puede contestar por ti. Es una opción de cada conexión SSH, **apagada por defecto**: formulario de conexión → **Avanzado** → «Responder el código de verificación con el TOTP de KeePass».

- Con la opción activa, el diálogo de verificación ofrece **«Usar código de KeePass»**. Rustty calcula el código y lo envía; no se muestra ni se guarda.
- La semilla puede salir de la misma entrada que la contraseña o de otra: el selector lista solo las entradas que tienen código.
- «Enviar el código sin preguntar» (también apagada) contesta sin diálogo, incluidas las reconexiones y la apertura del panel SFTP. Si el servidor rechaza el código **no se reintenta**: se te pregunta hasta que acepte un código de KeePass pedido con el botón.
- Si la base está bloqueada, el diálogo lo dice y te lleva a desbloquearla; si prefieres no hacerlo, tecleas el código como siempre.
- Un código ya usado con ese servidor no se repite: Rustty espera al siguiente y te dice cuántos segundos faltan.

> **Piénsalo antes de activarlo.** Guardar la contraseña y la semilla del segundo factor en la misma base reduce los dos factores a uno: quien abra la base tiene los dos. Para conservar los dos factores, deja la semilla solo en el móvil o en otra base.

La línea de órdenes (`rustty -c …`) no usa esta opción: allí el código se sigue pidiendo por la terminal.

## Sincronización

Rustty no sincroniza la base KeePass ni su estado desbloqueado. Si quieres usar la misma base en varios equipos, guárdala en una ubicación que tú controles y configura la ruta local en cada equipo.

Las rutas `keepassPath` y `keepassKeyfile` quedan fuera de la sincronización para evitar mezclar rutas locales entre sistemas distintos.
