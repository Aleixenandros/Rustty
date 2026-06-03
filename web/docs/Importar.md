# Importar conexiones

Rustty puede crear perfiles a partir de las conexiones que ya tienes en otras herramientas, sin reescribirlas a mano. Las opciones viven en **Preferencias → Copias de seguridad**.

## Importar desde `~/.ssh/config`

El botón **Importar ~/.ssh/config** lee tu fichero de configuración de OpenSSH y crea un perfil por cada `Host`. Resuelve `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `ServerAliveInterval` (→ keep-alive), los reenvíos de puertos (`LocalForward`/`RemoteForward`/`DynamicForward` → túneles) y las directivas `Include`.

Antes de aplicar, Rustty muestra un resumen con los perfiles **nuevos**, los que se **actualizarían** y los que quedan **sin cambios**, además de las directivas no soportadas. Los hosts con comodines (`*`, `?`) se ignoran. Los perfiles se crean en la carpeta **SSH Config** del workspace activo.

## Importar desde mRemoteNG

El botón **Importar desde mRemoteNG…** abre un **asistente por pasos** que lee un fichero de exportación de [mRemoteNG](https://mremoteng.org/) (`confCons.xml` o cualquier export `.xml`) y crea las conexiones en un **perfil-contenedor (workspace) nuevo**, reconstruyendo el árbol de carpetas original.

Todo el proceso ocurre **en tu equipo**: el fichero no se sube a ningún sitio.

### Paso 1 · Origen

Elige el fichero `.xml`. Rustty lo analiza y muestra un resumen: cuántas conexiones contiene, cuántas son importables, cuántas carpetas y qué protocolos aparecen.

Se importan los protocolos **SSH** y **RDP**. Otros protocolos de mRemoteNG (VNC, Telnet, etc.) se omiten y se indican en el resumen, ya que Rustty no los gestiona como perfil propio todavía.

### Paso 2 · Selección

- Da nombre al **perfil-contenedor** que se creará (por defecto el del fichero, o `mRemoteNG`).
- Marca o desmarca protocolos completos con los *chips* superiores.
- En el árbol puedes marcar/desmarcar carpetas y conexiones concretas. Marcar una carpeta arrastra a sus descendientes.

### Paso 3 · Contraseñas (opcional)

mRemoteNG guarda las contraseñas **cifradas** dentro del propio XML. Si activas **Importar contraseñas guardadas**, Rustty las descifra y las guarda en el **keyring del sistema** (nunca en `profiles.json`).

- Introduce la **contraseña maestra** que usabas en mRemoteNG. Si nunca configuraste una, déjala en blanco: se probará la predeterminada del programa.
- El botón **Validar contraseña** confirma que es correcta antes de importar.
- Solo se admite el cifrado moderno **AES-GCM** (el de las versiones actuales de mRemoteNG).

Si no activas esta opción, se importan estructura, host y usuario, y las contraseñas se añaden después a mano o mediante [credenciales maestras](?page=Seguridad).

### Resultado

Al terminar, Rustty crea el workspace, lo activa y te muestra cuántas conexiones (y contraseñas, si las pediste) se importaron. Como cualquier otro workspace, viaja con la [sincronización en la nube](?page=Copias) si la tienes activada.

## Privacidad

El análisis y el descifrado del fichero de mRemoteNG se hacen **localmente** en Rustty. El fichero de origen no se copia ni se envía a ningún servidor. Las contraseñas, si decides importarlas, acaban únicamente en el keyring del sistema.
