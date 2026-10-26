# Saltos y bastiones

Un **salto** (o bastión) es un servidor SSH intermedio: Rustty se conecta primero a él y, desde allí, abre la conexión con el servidor de destino. Sirve para llegar a equipos de una red privada, para que todo tu tráfico salga desde un sitio concreto (la oficina, un equipo de confianza) o para cumplir una política que obliga a pasar por un bastión. Es lo mismo que `ssh -J` o `ProxyJump` en OpenSSH.

Rustty lo ofrece de tres formas, que se pueden combinar:

| Forma | Para qué | Dónde se elige |
| ----- | -------- | -------------- |
| **Bastión del perfil** | Una conexión siempre pasa por un salto concreto. | Formulario de la conexión → **Bastión**. |
| **Salto activo** | «A partir de ahora, todo por aquí»: todas las conexiones nuevas salen por el mismo salto. | Píldora de ruta de la barra lateral, menú contextual o paleta de comandos. |
| **Conectar a través de…** | Una sola vez, sin tocar nada guardado. | Clic derecho sobre una conexión → **Conectar a través de**. |

## Bastión del perfil

En el formulario de una conexión SSH, el campo **Bastión** admite dos cosas:

- **Una conexión guardada.** El salto usa *sus propios* datos: host, puerto, usuario, método de autenticación, contraseña (del keyring, KeePass, una credencial maestra o preguntada al conectar), clave y passphrase, cifrados antiguos si los tiene activados y su huella en `known_hosts`. Es la opción recomendada: el bastión y el destino pueden tener usuarios y contraseñas distintos.
- **Una dirección manual** (`[usuario@]host[:puerto]`). El salto se autentica con las credenciales de la propia conexión, como hacía Rustty hasta ahora. Útil cuando el bastión acepta la misma clave que el destino.

Una conexión que hace de bastión puede tener a su vez su propio bastión: Rustty encadena los saltos en orden (hasta ocho) y avisa si alguna cadena forma un bucle o apunta a una conexión que ya no existe.

Si al importar `~/.ssh/config` un `ProxyJump` apunta a otro `Host` del mismo fichero, Rustty enlaza las dos conexiones en vez de copiar la dirección.

## Salto activo: todo por aquí

Con un salto activo, **cada conexión nueva** sale por él: SSH, el panel de archivos SFTP, las conexiones SFTP, RDP, VNC y Telnet. Las sesiones que ya estaban abiertas siguen por donde iban.

Para ponerlo:

- Pulsa la **píldora de ruta** de la barra lateral (encima del estado de la sincronización) y elige una conexión, o **Elegir conexión…** para buscarla.
- O haz clic derecho sobre una conexión SSH → **Usar como salto activo**.
- O desde la paleta de comandos (`Ctrl+Shift+P`): **Salto activo: elegir conexión…**. Puedes asignarle un atajo en Preferencias → Atajos.

Mientras está puesto, la píldora se resalta con el nombre del salto; su **✕** lo quita. Las pestañas que van por un salto llevan un icono de ruta, y su tooltip y la barra inferior dicen por dónde van («A través de: oficina → bastión»).

Reglas que conviene saber:

- Si la conexión ya tiene su propio bastión, el salto activo va **delante**: tu equipo → salto activo → bastión del perfil → destino. Si el bastión del perfil ya es el salto activo (o pasa por él), no se repite.
- La conexión del propio salto (y los saltos de su cadena) van directos, claro.
- Una conexión puede quedar fuera para siempre con la casilla **No usar nunca el salto activo** de su formulario: útil para equipos de tu red local.
- La consola local no se ve afectada.
- **FTP, FTPS y WebDAV no pueden ir por un salto** (el FTP abre conexiones de datos en otros puertos y el HTTPS comprueba el nombre del servidor). Con un salto activo conectan directo y lo avisan; si prefieres que no conecten, cámbialo en Preferencias.
- El salto activo es de este equipo: no se sincroniza. Por defecto se quita al cerrar Rustty; en Preferencias puedes hacer que se mantenga.

## Conectar a través de… (una sola vez)

Clic derecho sobre una conexión → **Conectar a través de** ofrece:

- **Sin saltos (directo)**: conecta directamente, ignorando el salto activo y también el bastión del perfil.
- El **salto activo**, los saltos que has usado hace poco y las conexiones que ya hacen de bastión.
- **Elegir conexión…** para buscar cualquier otra conexión SSH.

No cambia nada guardado: solo vale para esa sesión.

## Una sola conexión con el salto

Las sesiones que van por el mismo salto **comparten su conexión** con él: se autentica una sola vez (una sola pregunta de contraseña o de huella), las pestañas nuevas abren al instante y el servidor del salto ve una única conexión SSH. Cuando ninguna sesión la usa, se cierra sola pasado un minuto. Puedes desactivarlo o cambiar ese tiempo en Preferencias.

## RDP, VNC y Telnet por el salto

Estos protocolos los abren [clientes externos](?page=ClientesExternos). Cuando van por un salto, Rustty abre un **túnel local automático**: escucha solo en tu propio equipo, en una dirección local (`127.x.y.z`) y un puerto que son siempre los mismos para cada destino, y reenvía por el salto hasta el servidor real. El cliente externo se conecta a esa dirección, y el túnel se cierra cuando cierras el cliente. (En macOS la dirección es siempre `127.0.0.1` y lo que cambia por destino es el puerto.)

Como el cliente ve esa dirección local y no el nombre real del servidor, la primera vez puede preguntarte por su certificado; al ser siempre la misma para cada servidor, no vuelve a preguntar mientras el certificado no cambie.

## Probar el salto

Con un salto activo, la píldora ofrece **Probar el salto**: Rustty se conecta a él y comprueba que **deja abrir túneles**. Si no lo permite, el servidor tiene desactivado el reenvío (`AllowTcpForwarding no` en su `sshd_config`) y ninguna conexión podrá pasar por él.

## Desde la terminal

El [CLI](?page=CLI) respeta el bastión de cada perfil y el salto activo que tengas puesto en la aplicación. Además:

```bash
rustty -c produccion -J oficina           # pasar por la conexión guardada «oficina»
rustty -c produccion -J ana@10.0.0.1:2222 # o por una dirección manual
rustty -c produccion --direct             # sin ningún salto
```

## Usar un equipo Windows como salto

Windows 10, Windows 11 y Windows Server 2019 o posterior incluyen **OpenSSH Server**. Con él activado, cualquier equipo Windows sirve de salto para todo lo anterior.

### 1. Instalar y arrancar OpenSSH Server

En **Configuración → Sistema → Características opcionales → Agregar una característica**, instala **Servidor OpenSSH**. O, en PowerShell como administrador:

```powershell
# ¿Está ya instalado? (en las versiones recientes puede venir de serie)
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'

# Instalarlo si hace falta
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Arrancarlo y dejarlo automático
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
```

### 2. Abrir el cortafuegos

La instalación crea la regla `OpenSSH-Server-In-TCP` para el puerto 22. Compruébalo y, si no está, créala:

```powershell
Get-NetFirewallRule -Name *OpenSSH-Server* | Select-Object Name, Enabled

New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

### 3. Permitir los túneles

La configuración vive en `C:\ProgramData\ssh\sshd_config`. Por defecto **ya permite** abrir túneles; solo asegúrate de que no haya una línea `AllowTcpForwarding no` (si la cambias, reinicia el servicio con `Restart-Service sshd`).

### 4. Entrar con clave (recomendado)

- **Usuario normal:** copia tu clave pública a `C:\Users\<usuario>\.ssh\authorized_keys`.
- **Usuario administrador:** Windows **no** mira ese fichero para los miembros del grupo Administradores (lo indica el bloque `Match Group administrators` del `sshd_config`). La clave va en `C:\ProgramData\ssh\administrators_authorized_keys`, que solo pueden leer Administradores y SYSTEM:

```powershell
icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F"
```

  (Los identificadores `S-1-5-32-544` y `S-1-5-18` son Administradores y SYSTEM en cualquier idioma de Windows.)

También puedes entrar con la contraseña de la cuenta de Windows. Para una cuenta de dominio, escribe el usuario como `DOMINIO\usuario` o `usuario@dominio`.

### 5. Crear la conexión en Rustty

Crea una conexión SSH al equipo Windows con su usuario y método de autenticación, pulsa **Probar** y, cuando entre, úsala como bastión de otras conexiones o ponla como **salto activo**. **Probar el salto** confirma que deja abrir túneles.

## Problemas frecuentes

- **«El salto no permite abrir túneles»**: el servidor tiene `AllowTcpForwarding no` (o una política de la organización lo impide). Hay que permitirlo en su `sshd_config`.
- **El administrador de Windows no entra con su clave**: la clave está en `authorized_keys` del usuario en vez de en `administrators_authorized_keys`, o ese fichero tiene permisos de más (ver el paso 4).
- **«El bastión de esta conexión ya no existe»**: la conexión que hacía de bastión se ha borrado (aquí o en otro equipo sincronizado). Edita la conexión y elige otro bastión.
- **Te pregunta la huella de un servidor que no conoces**: con saltos, Rustty verifica la huella de **cada** servidor de la cadena, en orden. Comprueba de cuál se trata antes de aceptar.
