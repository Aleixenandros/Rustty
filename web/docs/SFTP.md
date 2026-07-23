# SFTP, FTP y FTPS

El panel de ficheros permite navegar, subir y descargar sin salir de Rustty. En perfiles SSH se abre como **SFTP** dentro de la sesión; en perfiles **FTP** o **FTPS** se abre directamente con el mismo explorador local/remoto.

## Abrir el panel

1. Conecta a un perfil SSH y pulsa el botón **SFTP** de la sesión, o abre directamente un perfil FTP/FTPS.
2. Rustty muestra un panel con dos columnas: **remoto** (a la izquierda) y **local** (a la derecha).

En SSH, el panel reutiliza los datos de conexión del perfil, pero crea su propio canal SFTP. En FTP/FTPS, la pestaña es el propio panel de ficheros.

## Vista dividida local / remoto

El panel tiene una **cabecera superior común** a ambos lados con el botón de cerrar (✕), separado de las acciones de cada columna para no confundirlo con un botón de eliminar.

Cada columna tiene su propia toolbar con:

- ← / → atrás y adelante en el historial de esa columna.
- ↑ subir un nivel.
- ⌂ ir al home.
- ⟳ refrescar.
- La ruta actual, como migas clicables.
- Nueva carpeta (icono de carpeta con «+»).
- Nuevo archivo (icono de documento con «+»).

### Historial y migas

Cada lado lleva **su propio historial**: atrás y adelante en el panel local no mueven el remoto, ni al revés. Refrescar la carpeta actual no añade entradas, y si una carpeta deja de existir (un USB desconectado, permisos retirados) se retira del historial para que el botón Atrás no vuelva a estrellarse contra ella.

La ruta se muestra como **migas clicables**: pulsa cualquier segmento para ir a esa carpeta. Para escribir una ruta a mano, pulsa **Ctrl+L** o haz clic en el hueco de la barra: aparece el campo de texto con su autocompletado. `Esc` o quitar el foco devuelven las migas.

Puedes elegir en qué lado se muestra el panel remoto (izquierda o derecha) desde **Preferencias → FTP/SFTP**; el local queda en el lado opuesto.

Entre las dos columnas están los botones centrales **⇨ Descargar** y **⇦ Subir**, con la flecha apuntando siempre al destino. La selección múltiple funciona con **Ctrl+click**; el doble clic en un fichero dispara la transferencia y el doble clic en una carpeta navega dentro de ella.

Las carpetas se transfieren de forma recursiva en ambos sentidos.

Cada columna tiene además un botón de **búsqueda** (icono de lupa) en su toolbar. La caja de búsqueda empieza **plegada**: al pulsar la lupa se despliega y al volver a pulsarla (o con `Esc`) se pliega y limpia el filtro. Es independiente del autocompletado de rutas: al escribir filtra las entradas del directorio actual y, activando el botón **Recursiva**, recorre los subdirectorios (con cancelación y límite de resultados) para localizar ficheros en niveles inferiores. Pulsa un resultado para ir a su carpeta contenedora; `↑`/`↓` + `Enter` navegan los resultados.

La zona inferior del panel agrupa **Transferencias** y **Actividad** en pestañas. Está pegada a la parte inferior, recuerda su altura y se puede redimensionar hacia arriba para revisar logs largos o colas de transferencia con más comodidad.

Las transferencias y sus errores aparecen también en el centro global de actividad del rail, desde donde puedes volver al log o reintentar una transferencia fallida cuando el contexto sigue disponible.

## Seguir el directorio del terminal

Cuando **CWD** está activo, Rustty intenta seguir el directorio actual de la terminal usando OSC 7. Si el shell remoto lo soporta, al cambiar de carpeta en la terminal el panel SFTP puede moverse con ella.

El toggle **CWD** está en la propia toolbar del panel SFTP; ya no aparece en el formulario de conexión. Solo aplica a sesiones SSH/SFTP, no a perfiles FTP/FTPS.

La barra de estado inferior muestra el directorio remoto como un **breadcrumb clicable**: pulsa cualquier segmento de la ruta para llevar el panel SFTP a esa carpeta (lo abre si hace falta). Un clic en el icono 📂 copia la ruta completa, y `Ctrl/Cmd+clic` sobre un segmento copia su ruta acumulada.

## Operaciones disponibles

- Navegar carpetas locales y remotas.
- Crear carpetas en cualquiera de los lados.
- Renombrar ficheros o carpetas (con el botón de la fila, el menú contextual o pulsando **F2** sobre el elemento seleccionado).
- Eliminar entradas.
- Cambiar permisos cuando el backend lo permite.
- Subir y descargar ficheros y **carpetas completas** con progreso.

Puedes acceder a estas acciones desde la toolbar, los botones centrales o el menú contextual con botón derecho dentro del panel local/remoto. Las acciones que necesitan pedir un nombre o confirmar una eliminación usan los modales propios de Rustty, integrados con el tema activo. Ya no aparecen diálogos nativos del navegador para crear carpeta, renombrar o borrar.

Las transferencias SFTP grandes están preparadas para superar el umbral de 1 GiB sin cortar la sesión por timeout durante la renegociación de claves.

## Descargas a medias: nunca un fichero engañoso

Una descarga se escribe primero en un fichero temporal hermano del destino (`<nombre>.rustty-part`) y solo **ocupa su nombre definitivo cuando ha terminado bien**, incluida la verificación de tamaño si la tienes activada. Si la transferencia falla, se cancela o se corta la red, el temporal se borra y en tu carpeta no queda un fichero truncado con aspecto de completo. Lo que ves con el nombre bueno está entero.

## Enlaces simbólicos

Al transferir una carpeta, los enlaces simbólicos **no se copian** en ninguna de las dos direcciones: copiarlos tal cual apuntaría a rutas que no existen en el otro extremo, y seguirlos podría sacar la copia del árbol elegido o meterla en un ciclo. Rustty los cuenta y te lo dice al terminar («N enlaces simbólicos omitidos»), tanto en el aviso como en el registro de ACTIVIDAD, para que sepas que la copia no los incluye.

## Panel TRANSFERENCIAS / ACTIVIDAD

Justo debajo de la vista dividida hay dos secciones siempre visibles:

- **TRANSFERENCIAS**: cola con barra de progreso, velocidad, ETA y botones de cancelar/reintentar para cada transferencia en curso o terminada.
- **ACTIVIDAD**: log con cada operación del panel — etapas de conexión (`connect`, `host_key`, `auth`, `subsystem`, `ready` cuando aplica), `mkdir`, renombrar, eliminar, errores de listado e inicio/fin de cada transferencia. Cada fila muestra estado (`ok`, `error`, `skipped`, `canceled`), etiqueta y tiempo.

Si una transferencia falla o se cancela, el detalle muestra los bytes realmente transferidos junto al total del fichero, no solo el tamaño esperado.

### Aviso al terminar

Al terminar una transferencia, Rustty avisa según dónde estés mirando: si la sesión está a la vista no interrumpe; si la app está activa pero la sesión oculta, muestra un toast; y si la app está en segundo plano, envía una **notificación del sistema**. Los errores avisan siempre; los éxitos, solo si la transferencia fue larga (umbral configurable) o de más de 10 MiB. Se ajusta —o se desactiva— en **Preferencias → FTP/SFTP**.

## Rendimiento (pipelining)

Las descargas y subidas mantienen varias peticiones SFTP simultáneamente en vuelo con chunks de 256 KiB. Eso elimina el techo de velocidad `chunk × RTT` típico de los clientes SFTP en serie: con un RTT de 12-15 ms y buffer de 64 KiB el techo era de ~5 MB/s; con varios MiB de datos en vuelo a la vez, la transferencia satura el ancho de banda real de la conexión.

Si el servidor limita el ancho de banda por sesión (por ejemplo a 100 Mbps), verás velocidades estables cerca de ese tope, sin importar la latencia.

En las descargas, la lectura adelantada está acotada: Rustty no lee más allá de un margen fijo por delante de lo ya escrito en disco, así que descargar ficheros o carpetas enormes no dispara el consumo de memoria aunque el disco local vaya más lento que la red.

### Peticiones simultáneas configurables

El número de peticiones SFTP en paralelo por transferencia se ajusta en **Preferencias → FTP/SFTP → Transferencias simultáneas (SFTP)** (por defecto **4**, rango 1–64, acotado internamente por el límite de pipelining). Súbelo para exprimir más velocidad en redes con latencia alta; **bájalo** si el servidor devuelve `Limit exceeded: Handle limit reached`.

Algunos servidores con SFTP restringido —como el **Storage Box de Hetzner**— imponen un límite bajo de *handles* (ficheros abiertos) por sesión. Un valor de concurrencia alto abre demasiados handles a la vez y dispara ese error, sobre todo al descargar carpetas recursivas. Con el valor por defecto de 4 no debería ocurrir. El cambio se aplica a las **sesiones nuevas**.

## SFTP elevado

El botón **sudo** reconecta el SFTP usando `sudo sftp-server` en el servidor remoto. Requiere que el usuario tenga `NOPASSWD` configurado para el binario `sftp-server` correspondiente.

Si el servidor no permite esa elevación, desactiva **sudo** y usa SFTP normal. Esta opción solo existe para SFTP sobre SSH; no aparece en perfiles FTP/FTPS.

## Seguridad de FTP y FTPS

**FTPS con certificado autofirmado.** Un NAS o un servidor interno rara vez tiene un certificado firmado por una CA pública. Antes esos servidores eran inconectables (Rustty exigía una cadena hasta una CA raíz); ahora se aceptan por **huella**, con el mismo modelo *Trust On First Use* que las claves SSH: la primera vez que conectas se muestra la huella SHA-256 del certificado y se pide confirmarla; una vez guardada, se acepta en silencio, y si el certificado **cambia** más adelante la conexión se rechaza con un aviso. No es un «ignorar certificado» global: cada huella se guarda por servidor.

Puedes desactivar la confirmación en **Preferencias → Seguridad** («Confirmar el certificado FTPS en la primera conexión»); entonces la primera huella se recuerda automáticamente. Sigue avisando si cambia después. La firma del handshake TLS se comprueba siempre; lo único que este modo relaja es la exigencia de una CA raíz.

**FTP plano.** El FTP sin cifrar transmite el usuario, la contraseña y los archivos **en claro**. Al conectar por FTP (no FTPS), Rustty muestra un aviso recordándolo y sugiriendo FTPS si el servidor lo admite.

## Cerrar el panel con una transferencia en curso

Si intentas cerrar la pestaña o pulsas `Ctrl+W` con una transferencia activa, Rustty pregunta antes de continuar y cancela las transferencias en curso si confirmas. El mismo aviso aparece para sesiones SSH vivas: evita perder progreso por error.
