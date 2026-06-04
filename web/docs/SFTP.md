# SFTP

El panel SFTP se abre dentro de una sesión SSH y permite navegar, subir y descargar ficheros sin salir de Rustty.

## Abrir el panel

1. Conecta a un perfil SSH.
2. Pulsa el botón **SFTP** de la sesión.
3. Rustty abre un panel con dos columnas: **remoto** (a la izquierda) y **local** (a la derecha).

El panel reutiliza los datos de conexión del perfil, pero crea su propio canal SFTP.

## Vista dividida local / remoto

El panel tiene una **cabecera superior común** a ambos lados con el botón de cerrar (✕), separado de las acciones de cada columna para no confundirlo con un botón de eliminar.

Cada columna tiene su propia toolbar con:

- Ruta editable.
- ↑ subir un nivel.
- ⌂ ir al home.
- ⟳ refrescar.
- Nueva carpeta (icono de carpeta con «+»).
- Nuevo archivo (icono de documento con «+»).

Puedes elegir en qué lado se muestra el panel remoto (izquierda o derecha) desde **Preferencias → FTP/SFTP**; el local queda en el lado opuesto.

Entre las dos columnas están los botones centrales **⇨ Descargar** y **⇦ Subir**, con la flecha apuntando siempre al destino. La selección múltiple funciona con **Ctrl+click**; el doble clic en un fichero dispara la transferencia y el doble clic en una carpeta navega dentro de ella.

Las carpetas se transfieren de forma recursiva en ambos sentidos.

Cada columna tiene además un botón de **búsqueda** (icono de lupa) en su toolbar. La caja de búsqueda empieza **plegada**: al pulsar la lupa se despliega y al volver a pulsarla (o con `Esc`) se pliega y limpia el filtro. Es independiente del autocompletado de rutas: al escribir filtra las entradas del directorio actual y, activando el botón **Recursiva**, recorre los subdirectorios (con cancelación y límite de resultados) para localizar ficheros en niveles inferiores. Pulsa un resultado para ir a su carpeta contenedora; `↑`/`↓` + `Enter` navegan los resultados.

La zona inferior del panel agrupa **Transferencias** y **Actividad** en pestañas. Está pegada a la parte inferior, recuerda su altura y se puede redimensionar hacia arriba para revisar logs largos o colas de transferencia con más comodidad.

Las transferencias y sus errores aparecen también en el centro global de actividad del rail, desde donde puedes volver al log o reintentar una transferencia fallida cuando el contexto sigue disponible.

## Seguir el directorio del terminal

Cuando **CWD** está activo, Rustty intenta seguir el directorio actual de la terminal usando OSC 7. Si el shell remoto lo soporta, al cambiar de carpeta en la terminal el panel SFTP puede moverse con ella.

El toggle **CWD** está en la propia toolbar del panel SFTP; ya no aparece en el formulario de conexión.

La barra de estado inferior muestra el directorio remoto como un **breadcrumb clicable**: pulsa cualquier segmento de la ruta para llevar el panel SFTP a esa carpeta (lo abre si hace falta). Un clic en el icono 📂 copia la ruta completa, y `Ctrl/Cmd+clic` sobre un segmento copia su ruta acumulada.

## Operaciones disponibles

- Navegar carpetas locales y remotas.
- Crear carpetas en cualquiera de los lados.
- Renombrar ficheros o carpetas.
- Eliminar entradas.
- Cambiar permisos cuando el backend lo permite.
- Subir y descargar ficheros y **carpetas completas** con progreso.

Puedes acceder a estas acciones desde la toolbar, los botones centrales o el menú contextual con botón derecho dentro del panel local/remoto. Las acciones que necesitan pedir un nombre o confirmar una eliminación usan los modales propios de Rustty, integrados con el tema activo. Ya no aparecen diálogos nativos del navegador para crear carpeta, renombrar o borrar.

Las transferencias SFTP grandes están preparadas para superar el umbral de 1 GiB sin cortar la sesión por timeout durante la renegociación de claves.

## Panel TRANSFERENCIAS / ACTIVIDAD

Justo debajo de la vista dividida hay dos secciones siempre visibles:

- **TRANSFERENCIAS**: cola con barra de progreso, velocidad, ETA y botones de cancelar/reintentar para cada transferencia en curso o terminada.
- **ACTIVIDAD**: log con cada operación SFTP — etapas de conexión (`connect`, `host_key`, `auth`, `subsystem`, `ready`), `mkdir`, renombrar, eliminar, errores de listado e inicio/fin de cada transferencia. Cada fila muestra estado (`ok`, `error`, `skipped`, `canceled`), etiqueta y tiempo.

Si una transferencia falla o se cancela, el detalle muestra los bytes realmente transferidos junto al total del fichero, no solo el tamaño esperado.

## Rendimiento (pipelining)

Las descargas y subidas mantienen varias peticiones SFTP simultáneamente en vuelo con chunks de 256 KiB. Eso elimina el techo de velocidad `chunk × RTT` típico de los clientes SFTP en serie: con un RTT de 12-15 ms y buffer de 64 KiB el techo era de ~5 MB/s; con varios MiB de datos en vuelo a la vez, la transferencia satura el ancho de banda real de la conexión.

Si el servidor caps por sesión (por ejemplo limita a 100 Mbps) verás velocidades estables cerca de ese tope, sin importar la latencia.

### Transferencias simultáneas configurables

El número de peticiones SFTP en paralelo por transferencia se ajusta en **Preferencias → FTP/SFTP → Transferencias simultáneas (SFTP)** (por defecto **4**, rango 1–64). Súbelo para exprimir más velocidad en redes con latencia alta; **bájalo** si el servidor devuelve `Limit exceeded: Handle limit reached`.

Algunos servidores con SFTP restringido —como el **Storage Box de Hetzner**— imponen un límite bajo de *handles* (ficheros abiertos) por sesión. Un valor de concurrencia alto abre demasiados handles a la vez y dispara ese error, sobre todo al descargar carpetas recursivas. Con el valor por defecto de 4 no debería ocurrir. El cambio se aplica a las **sesiones nuevas**.

## SFTP elevado

El botón **sudo** reconecta el SFTP usando `sudo sftp-server` en el servidor remoto. Requiere que el usuario tenga `NOPASSWD` configurado para el binario `sftp-server` correspondiente.

Si el servidor no permite esa elevación, desactiva **sudo** y usa SFTP normal.

## Cerrar el panel con una transferencia en curso

Si intentas cerrar la pestaña o pulsas `Ctrl+W` con una transferencia activa, Rustty pregunta antes de continuar y cancela las transferencias en curso si confirmas. El mismo aviso aparece para sesiones SSH vivas: evita perder progreso por error.
