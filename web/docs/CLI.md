# CLI SSH

Rustty también puede usarse desde terminal para trabajar con perfiles SSH guardados sin abrir la interfaz gráfica.

## Listar perfiles

```bash
rustty -l
rustty --list
rustty -l --json
```

El listado muestra solo perfiles SSH. La salida normal está pensada para lectura humana; `--json` sirve para scripts y herramientas externas.

## Abrir una sesión interactiva

```bash
rustty -c <nombre|id|ip|host>
rustty --connect <nombre|id|ip|host>
```

Rustty busca el perfil por nombre, id, IP o host. Si hay varias coincidencias, muestra las opciones y te pide afinar la búsqueda.

La conexión reutiliza los datos del perfil: host/IP, puerto, usuario, método de autenticación, keyring, `known_hosts`, ProxyJump, keepalive, agent forwarding y compatibilidad legacy si estaba activada.

Si falta una contraseña o passphrase en el keyring, Rustty la pide en la terminal sin mostrarla.

## Ejecutar comandos remotos

```bash
rustty -c <nombre|id|ip|host> --exec "uptime"
rustty -c <nombre|id|ip|host> -- hostname
rustty -c <nombre|id|ip|host> "hostname"
```

En modo comando, Rustty abre un canal SSH `exec`, reenvía `stdin`, escribe `stdout` y `stderr` en la terminal local y termina con el código de salida remoto. Esto permite usarlo en scripts:

```bash
rustty -c produccion --exec "test -f /etc/nginx/nginx.conf"
echo $?
```

`--exec` es la forma recomendada para comandos con comillas, tuberías o redirecciones:

```bash
rustty -c produccion --exec "systemctl is-active nginx && journalctl -u nginx -n 20"
```

La forma `--` es un atajo cómodo parecido a `ssh`:

```bash
rustty -c produccion -- uname -a
```

El texto extra después del perfil también funciona como alias breve:

```bash
rustty -c produccion "df -h"
```

## Comandos con pseudo-terminal

Algunos comandos necesitan una pseudo-terminal remota. Puedes solicitarla con `--tty`:

```bash
rustty -c <nombre|id|ip|host> --tty -- sudo systemctl status nginx
rustty -c <nombre|id|ip|host> --tty --exec "sudo journalctl -u nginx -n 50"
```

Por defecto, los comandos remotos se ejecutan sin PTY para que sean más predecibles en automatización.

## Limitaciones

- Solo funciona con perfiles SSH guardados.
- KeePass desbloqueado en la interfaz gráfica no está disponible desde el CLI.
- X11 forwarding queda fuera del CLI inicial.
- Las credenciales sí se resuelven desde el keyring del sistema cuando existen.
