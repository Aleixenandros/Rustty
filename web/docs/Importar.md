# Importar conexiones

Rustty puede crear perfiles a partir de las conexiones que ya tienes en otras herramientas, sin reescribirlas a mano. Las opciones viven en **Preferencias → Copias de seguridad**.

## Importar desde `~/.ssh/config`

El botón **Importar ~/.ssh/config** lee tu fichero de configuración de OpenSSH y crea un perfil por cada `Host`. Resuelve `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `ServerAliveInterval` (→ keep-alive), los reenvíos de puertos (`LocalForward`/`RemoteForward`/`DynamicForward` → túneles) y las directivas `Include`.

Antes de aplicar, Rustty muestra un resumen con los perfiles **nuevos**, los que se **actualizarían** y los que quedan **sin cambios**, además de las directivas no soportadas. Los hosts con comodines (`*`, `?`) se ignoran. Los perfiles se crean en la carpeta **SSH Config** del workspace activo.

## Importar desde otras aplicaciones

El botón **Importar datos de otros programas…** (en su propia sección de **Preferencias → Copias de seguridad**) abre un **asistente por pasos**. En el primer paso eliges el origen y, según cuál sea, el fichero a leer:

- **mRemoteNG** — un export `.xml` (`confCons.xml` o similar).
- **Ásbrú Connection Manager** — un export `.yml` (*Exportar* → *toda la configuración*).

En ambos casos las conexiones se crean en un **perfil-contenedor (workspace) nuevo**, reconstruyendo el árbol de carpetas original, y todo el proceso ocurre **en tu equipo**: el fichero no se sube a ningún sitio.

### Paso 1 · Origen

Elige el origen y selecciona el fichero. Rustty lo analiza y muestra un resumen: cuántas conexiones contiene, cuántas son importables, cuántas carpetas y qué protocolos aparecen.

El asistente importa actualmente los protocolos **SSH** y **RDP** desde esos formatos. Otros protocolos (VNC, Telnet, shells locales, etc.) se omiten y se indican en el resumen. Aunque Rustty permite crear perfiles VNC y Telnet manualmente, el mapeo de importación desde mRemoteNG/Ásbrú para esos tipos todavía no está implementado.

### Paso 2 · Selección

- Da nombre al **perfil-contenedor** que se creará (por defecto el del fichero, o el del programa de origen).
- Marca o desmarca protocolos completos con los *chips* superiores.
- En el árbol puedes marcar/desmarcar carpetas y conexiones concretas. Marcar una carpeta arrastra a sus descendientes.

### Paso 3 · Contraseñas (opcional)

Ambos programas guardan las contraseñas **cifradas** dentro del fichero. Si activas **Importar contraseñas guardadas**, Rustty las descifra y las guarda en el **keyring del sistema** (nunca en `profiles.json`).

- **mRemoteNG**: introduce la **contraseña maestra** que usabas. Si nunca configuraste una, déjala en blanco: se probará la predeterminada del programa. El botón **Validar contraseña** confirma que es correcta antes de importar. Solo se admite el cifrado moderno **AES-GCM** (el de las versiones actuales).
- **Ásbrú**: no hay que introducir nada. Ásbrú cifra las contraseñas con una clave fija, así que Rustty las descifra automáticamente al importar.

Si no activas esta opción, se importan estructura, host y usuario, y las contraseñas se añaden después a mano o mediante [credenciales maestras](?page=Seguridad).

### Resultado

Una barra de progreso muestra cuántas conexiones se van importando. Al terminar, Rustty crea el workspace, lo activa y te indica cuántas conexiones (y contraseñas, si las pediste) se importaron. Como cualquier otro workspace, viaja con la [sincronización en la nube](?page=Copias) si la tienes activada.

## Privacidad

El análisis y el descifrado de los ficheros se hacen **localmente** en Rustty. El fichero de origen no se copia ni se envía a ningún servidor. Las contraseñas, si decides importarlas, acaban únicamente en el keyring del sistema.

## Ficheros aceptados

Cada import tiene un tamaño máximo razonable para lo que espera leer (por ejemplo, 1 MB para un `~/.ssh/config` y 16 MB para el export de otro cliente o una copia de seguridad completa). Un fichero binario, o uno que supere ese tope, se rechaza con un aviso claro en vez de intentar cargarse entero: así, apuntar sin querer a un fichero enorme o equivocado no bloquea la aplicación.
