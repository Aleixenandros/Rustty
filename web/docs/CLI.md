# CLI SSH

Rustty también puede usarse desde terminal para trabajar con perfiles SSH y SFTP guardados sin abrir la interfaz gráfica: listar, abrir sesiones, ejecutar comandos en uno o en muchos servidores y copiar ficheros.

## Listar perfiles

```bash
rustty -l
rustty --list
rustty -l --json
rustty -l --workspace Omnia
rustty -l --group VPS
```

El listado muestra los perfiles SSH y SFTP con su tipo, su **workspace** y su grupo. `--json` sirve para scripts: cada entrada lleva `id`, `name`, `host`, `port`, `username`, `type` (`ssh` o `sftp`), `group` y `workspace` con `id` y `name`. `--workspace` acepta el nombre o el id del workspace (sin distinguir mayúsculas) y `--group` una carpeta, incluidas sus subcarpetas.

## Abrir una sesión interactiva

```bash
rustty -c <nombre|id|ip|host>
rustty --connect <nombre|id|ip|host>
rustty --workspace Omnia -c web
```

Rustty busca el perfil por nombre, id, IP o host. Si hay varias coincidencias, muestra las opciones y te pide afinar la búsqueda; `--workspace` y `--group` acotan dónde buscar.

La conexión reutiliza los datos del perfil: host/IP, puerto, usuario, método de autenticación, keyring, `known_hosts`, ProxyJump, keepalive, agent forwarding y compatibilidad legacy si estaba activada.

Si falta una contraseña o passphrase en el keyring, Rustty la pide en la terminal sin mostrarla. La pregunta va por la salida de errores, así que la salida normal queda limpia aunque haya que teclearla.

## Ejecutar comandos remotos

```bash
rustty -c <nombre|id|ip|host> --exec "uptime"
rustty -c <nombre|id|ip|host> -- hostname
rustty -c <nombre|id|ip|host> "hostname"
```

En modo comando, Rustty abre un canal SSH `exec`, escribe `stdout` y `stderr` en la terminal local y **termina con el código de salida del comando remoto**, así que sirve en scripts:

```bash
rustty -c produccion --exec "test -f /etc/nginx/nginx.conf"
echo $?
```

Los códigos son los de `ssh`: el del comando remoto; `255` si no se pudo conectar o autenticar; `124` si se agotó `--timeout`; `2` por uso incorrecto o perfil no encontrado.

`--exec` toma el comando como un único argumento y es la forma recomendada para comillas, tuberías o redirecciones; las opciones pueden ir antes o después:

```bash
rustty -c produccion --exec "systemctl is-active nginx && journalctl -u nginx -n 20" --timeout 30
```

La forma `--` es un atajo cómodo parecido a `ssh`, y el texto extra después del perfil también funciona como alias breve:

```bash
rustty -c produccion -- uname -a
rustty -c produccion "df -h"
```

### Entrada estándar

Sin `--tty`, si la entrada estándar es un terminal, Rustty la **cierra al momento** (como `ssh -n`): un comando que lea de ella, como `plesk db` o `mysql`, termina en vez de quedarse esperando para siempre. Si la entrada es una tubería o un fichero, se reenvía al comando remoto:

```bash
rustty -c produccion --exec "bash -s" < mantenimiento.sh
cat lista.txt | rustty -c produccion --exec "xargs -n1 host"
```

`-n` (`--no-stdin`) la cierra siempre, venga de donde venga.

### Mandar un script local

```bash
rustty -c produccion --script mantenimiento.sh
rustty -c produccion --script mantenimiento.sh --sudo
```

`--script` envía el fichero por la entrada estándar a `bash -s` en el servidor: no hay que codificarlo ni pegarlo en la línea de comandos. Es excluyente con `--exec`.

### Sudo

`--sudo` ejecuta el comando (o el script) con `sudo`. Sin `--tty` usa `sudo -n`, que exige `NOPASSWD` para ese usuario: si sudo necesitara contraseña, falla al instante con un error claro en vez de quedarse esperando. Con `--tty`, sudo puede preguntarla por la terminal.

### Silencio y JSON

`-q` (`--quiet`) quita los avisos por la salida de errores («Conectando a…», resúmenes). `--json` escribe en la salida normal un objeto por servidor con `profile`, `name`, `host`, `username`, `workspace`, `exitCode`, `stdout`, `stderr`, `durationMs` y `error`, y no imprime nada más.

### Límite de tiempo

`--timeout <segundos>` acota cada servidor, conexión incluida. Al agotarse, el comando sale con `124` y, en `--json`, `error` lo explica.

## Ejecutar en varios servidores a la vez

```bash
rustty --workspace Omnia --exec "uptime"
rustty --group VPS --exec "df -h /" --json
rustty --all --script parche.sh --sudo --parallel 8 --timeout 60
rustty --workspace Omnia --exec "apt list --upgradable" --ndjson | jq -r '.name + ": " + (.exitCode|tostring)'
```

Con `--workspace`, `--group` o `--all` (sin `-c`), Rustty ejecuta el comando en todos los perfiles SSH que casen, `--parallel` a la vez (4 por defecto). Sin `--json`, la salida llega **agrupada por servidor** conforme cada uno termina: una cabecera y un resumen por la salida de errores, y la salida del comando por donde le toca. Con `--json` se imprime al final un array ordenado por nombre, con una entrada por servidor.

Con **`--ndjson`** el resultado es el mismo, pero cada servidor sale **en cuanto termina**, como un objeto JSON en una sola línea: no hay que esperar al más lento para empezar a procesar los demás, y una tubería con `jq` o un `while read` los va consumiendo según llegan. El orden es el de llegada, no el alfabético. `--json` y `--ndjson` son excluyentes, y el listado (`-l`) solo admite `--json`, porque es un documento y no un flujo.

El código de salida es `0` si todos acabaron en `0` y `1` si alguno no. Una entrada de la tubería se lee entera una vez y se reparte a todos; `--script` funciona igual. `--tty` no está disponible en multi-host.

Las contraseñas que falten en el keyring se piden **antes** de conectar, una por una. Las huellas de servidores nuevos también se preguntan por la terminal; en un script sin terminal se rechazan, así que conviene aprobarlas antes desde la interfaz o con una conexión interactiva.

## Copiar ficheros por SFTP

```bash
rustty -c storagebox --get /backups/hoy.tgz ./
rustty -c produccion --put ./nginx.conf /etc/nginx/nginx.conf
rustty -c storagebox --put informe.pdf /docs/ --json
```

`--get <remoto> <local>` descarga y `--put <local> <remoto>` sube un fichero. Si el destino es una carpeta (existe o acaba en `/`), el fichero conserva su nombre. Funciona con perfiles SSH y también con perfiles **SFTP** sin shell, como un StorageBox: `-l` los lista con tipo `sftp`. `--timeout`, `-q`, `--json` y `--ndjson` se aplican igual.

### Carpetas enteras

```bash
rustty -c produccion -r --get /var/www/sitio ./copias/
rustty -c storagebox -r --put ./fotos /backups/ --json
```

Con **`-r`** (`--recursive`) la ruta de origen puede ser una carpeta y se copia con todo lo que cuelga de ella. Sin `-r`, una carpeta es un error que lo dice, igual que en `scp`: copiar un árbol entero nunca ocurre por accidente.

- **Dónde acaba la copia** sigue la regla de `cp -r`. Si el destino ya es una carpeta (o acaba en `/`), el árbol cuelga de ella con su nombre: `--get -r /var/www/sitio ./copias/` deja `./copias/sitio/`. Si el destino no existe, **es** la copia: `--get -r /var/www/sitio ./nuevo` deja el contenido en `./nuevo/`.
- **Los enlaces simbólicos no se siguen ni se copian**, y tampoco los ficheros especiales (sockets, dispositivos): se cuentan como omitidos y el resumen dice cuántos. Seguirlos permitiría salirse del árbol que has pedido o entrar en un bucle.
- **Un fichero que falla no detiene el resto.** Si uno no se puede leer (permisos, por ejemplo), su error sale por la salida de errores, la copia sigue y el comando termina con `1`; con todo copiado, termina con `0`.
- Por seguridad, si el servidor devolviera un nombre de fichero con una ruta dentro (`../algo`), la copia se aborta entera: es lo que intentaría un servidor malicioso para escribir fuera de tu carpeta de destino.

El resumen —y `--json`— cuenta `files`, `dirs`, `bytes`, `skipped` y la lista de `errors`, además de `op`, `durationMs` y `error`.

## Importar conexiones desde un JSON

```bash
rustty --import conexiones.json --dry-run
rustty --import conexiones.json                    # a un workspace nuevo import_<fecha>
rustty --import conexiones.json --workspace Omnia  # a ese workspace, o lo crea con ese nombre
cat conexion.json | rustty --import - --json
```

`--import` lee un perfil o un array de perfiles en el **formato nativo** de Rustty (el mismo de `profiles.json`) y los guarda por el mismo camino que la interfaz: una sola transacción. Lo importado **no se mezcla** con lo que ya tienes: sin `--workspace`, va a un workspace nuevo llamado `import_<fecha>_<hora>`; con `--workspace` y un nombre o id existente, se añade a ese workspace; con un nombre que no existe, se crea con ese nombre. El workspace nuevo aparece en la interfaz la próxima vez que se abra. Sirve para volcar lo que ya tengas descifrado de otro cliente, como mRemoteNG, sin pasar por el asistente gráfico. Cada objeto admite los campos de un perfil (los que falten toman su valor por defecto) y tres campos que la app nunca escribe en `profiles.json`: `password`, `passphrase` y `extra_credentials[].password`. El importador los saca del perfil y los guarda en el **keyring del sistema**, bajo las mismas claves que usa la interfaz (`password:<id>`, `passphrase:<id>`), con el modelo de contraseña propia del perfil (`password_source: own`). En Rustty no hay un almacén cifrado con clave maestra que desbloquear: `profiles.json` va en claro y los secretos los guarda el keyring, así que no hace falta ninguna contraseña maestra; en Linux basta con que el keyring de la sesión esté desbloqueado, que es lo normal en una sesión de escritorio.

Ejemplo mínimo:

```json
[
  {
    "name": "Web 01",
    "host": "10.0.0.5",
    "port": 22,
    "username": "root",
    "connection_type": "ssh",
    "group": "Producción/Web",
    "password": "en-claro-solo-en-este-fichero"
  },
  {
    "name": "Escritorio Ana",
    "host": "10.0.0.20",
    "connection_type": "rdp",
    "username": "ana",
    "domain": "CORP",
    "password": "…"
  }
]
```

Reglas:

- **Tipo**: `connection_type` acepta `ssh`, `rdp`, `vnc`, `telnet`, `ftp` y `ftps`, y los alias de otros clientes (`SSH2` y `SFTP` valen como `ssh`). Un tipo desconocido descarta la entrada con su motivo. Si falta el puerto, se pone el del protocolo.
- **Carpeta y workspace**: la carpeta es `group`, una ruta con barras (`Producción/Web`), como en la barra lateral. El workspace lo decide `--workspace` para todo el fichero; un `workspace_id` dentro de las entradas se ignora, para que nada acabe en un workspace ajeno por accidente.
- **Coincidencias**: si la entrada trae un `id` que ya existe, actualiza ese perfil; si no, busca por nombre dentro del mismo workspace y lo actualiza **conservando el id** (las contraseñas del keyring cuelgan de él); si tampoco lo encuentra, lo crea. Una entrada idéntica a lo guardado se omite como «sin cambios», y una repetida en el mismo fichero, como «duplicado».
- **`--dry-run`** cuenta lo que haría sin escribir nada, ni perfiles ni contraseñas.
- **Resumen** por la salida de errores: importadas, actualizadas y omitidas (con el motivo de cada una) y contraseñas guardadas o no; con `--json`, el mismo resumen como objeto. Sale con `0` si todo entró y con `1` si alguna entrada era inválida o alguna contraseña no pudo guardarse (los perfiles sí se guardan).

Un fichero con contraseñas en claro es sensible: bórralo en cuanto termine la importación.

## Comandos con pseudo-terminal

Algunos comandos necesitan una pseudo-terminal remota. Puedes solicitarla con `--tty`:

```bash
rustty -c <nombre|id|ip|host> --tty -- sudo systemctl status nginx
rustty -c <nombre|id|ip|host> --tty --exec "sudo journalctl -u nginx -n 50"
```

Con `--tty` la entrada estándar se reenvía en vivo, para que el comando pueda preguntar. Por defecto, los comandos remotos se ejecutan sin PTY para que sean más predecibles en automatización.

## Primera conexión a un servidor nuevo

Al conectar por primera vez a un servidor cuya clave no conoce, Rustty muestra su huella y pide confirmación **también desde el CLI**, por la propia terminal:

```text
La autenticidad del host servidor.example:22 no se puede establecer.
Huella de la clave ssh-ed25519: SHA256:abc…
¿Confiar en este host y guardar su clave? (sí/no):
```

Una vez aceptada, la clave se guarda y no se vuelve a preguntar por ese servidor.

Si el comando corre **sin terminal interactiva** (dentro de un script, un cron o una tubería), no hay a quién preguntar: la conexión **se rechaza** con un aviso, en lugar de aprender la clave a ciegas. Para esos casos, conecta una vez desde la interfaz gráfica (o desde una terminal real) para aprobar la huella, o desactiva **Confirmar la huella en la primera conexión** en Preferencias → Seguridad si prefieres el comportamiento automático de siempre.

## Limitaciones

- Solo funciona con perfiles SSH y SFTP guardados (RDP, VNC, Telnet y FTP quedan fuera).
- Los nombres de workspace los conoce la CLI porque la interfaz los vuelca a `workspaces.json` al guardar preferencias; hasta que la interfaz se haya abierto una vez con esta versión, el listado muestra el id en su lugar.
- KeePass desbloqueado en la interfaz gráfica no está disponible desde el CLI.
- X11 forwarding queda fuera del CLI.
- `--get`/`--put -r` no conservan permisos ni fechas, y no copian enlaces simbólicos; tampoco reanudan una copia cortada (la interfaz sí reanuda descargas).
- `--sudo` no usa la contraseña del perfil: necesita `NOPASSWD` en el servidor, o `--tty` para que `sudo` la pida.
- Las credenciales sí se resuelven desde el keyring del sistema cuando existen, incluidas las **credenciales maestras** y los marcadores `${var:...}` / `${master:...}` / `${secret:...}` en la contraseña del perfil, igual que en la interfaz gráfica. Los marcadores `${ask:...}` no se preguntan desde el CLI.
