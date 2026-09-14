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
```

Con `--workspace`, `--group` o `--all` (sin `-c`), Rustty ejecuta el comando en todos los perfiles SSH que casen, `--parallel` a la vez (4 por defecto). Sin `--json`, la salida llega **agrupada por servidor** conforme cada uno termina: una cabecera y un resumen por la salida de errores, y la salida del comando por donde le toca. Con `--json` se imprime al final un array ordenado por nombre, con una entrada por servidor.

El código de salida es `0` si todos acabaron en `0` y `1` si alguno no. Una entrada de la tubería se lee entera una vez y se reparte a todos; `--script` funciona igual. `--tty` no está disponible en multi-host.

Las contraseñas que falten en el keyring se piden **antes** de conectar, una por una. Las huellas de servidores nuevos también se preguntan por la terminal; en un script sin terminal se rechazan, así que conviene aprobarlas antes desde la interfaz o con una conexión interactiva.

## Copiar ficheros por SFTP

```bash
rustty -c storagebox --get /backups/hoy.tgz ./
rustty -c produccion --put ./nginx.conf /etc/nginx/nginx.conf
rustty -c storagebox --put informe.pdf /docs/ --json
```

`--get <remoto> <local>` descarga y `--put <local> <remoto>` sube un fichero, de uno en uno. Si el destino es una carpeta (existe o acaba en `/`), el fichero conserva su nombre. Funciona con perfiles SSH y también con perfiles **SFTP** sin shell, como un StorageBox: `-l` los lista con tipo `sftp`. `--timeout`, `-q` y `--json` (`op`, `bytes`, `durationMs`, `error`) se aplican igual.

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
- `--get`/`--put` copian ficheros sueltos, no carpetas.
- Las credenciales sí se resuelven desde el keyring del sistema cuando existen, incluidas las **credenciales maestras** y los marcadores `${var:...}` / `${master:...}` / `${secret:...}` en la contraseña del perfil, igual que en la interfaz gráfica. Los marcadores `${ask:...}` no se preguntan desde el CLI.
