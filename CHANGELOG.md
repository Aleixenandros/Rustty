# Changelog

Todas las novedades reseñables del proyecto Rustty.

## [1.60.0] - 2026-07-22

### Añadido

- **La ventana del escritorio remoto ya no está clavada a un tamaño**. Las
  sesiones RDP abren en una ventana redimensionable: se puede maximizar y
  arrastrar, y el escritorio remoto sigue el tamaño. También se puede pedir
  pantalla completa o que ocupe el área de trabajo del monitor. El valor por
  defecto está en Preferencias → Sistema y cada perfil puede llevar el suyo. Los
  servidores anteriores a Windows 8 / Server 2012 no admiten ese ajuste: para
  ellos queda la opción «Tamaño fijo», que es el comportamiento de siempre.
- **Una sesión RDP, VNC o Telnet cerrada ofrece reconectar**, además de cerrar
  la pestaña. La reconexión reutiliza la misma pestaña, así que conserva su
  sitio en la barra y el panel dividido donde estuviera.
- **Atrás, adelante y ruta en migas en el panel de ficheros**. Cada lado (local
  y remoto) lleva su propio historial, independiente del otro. La ruta se
  muestra como segmentos clicables: pulsa cualquiera para ir a esa carpeta, o
  `Ctrl+L` para escribirla a mano con el autocompletado de siempre. Refrescar no
  llena el historial de repeticiones, y una carpeta que deja de existir se
  retira de él en vez de hacer que Atrás falle una y otra vez.

### Cambiado

- Actualizadas las dependencias de `tokio`, `serde`, `async-trait`,
  `tauri-plugin-dialog`, `vite` y `eslint-plugin-jsdoc`.

## [1.59.0] - 2026-07-22

### Corregido

- **Las conexiones RDP vuelven a funcionar en Linux con FreeRDP 3**. La sesión
  moría nada más empezar con un volcado de `tcgetattr()`/`tcsetattr()` y un
  `ERRCONNECT_CONNECT_CANCELLED`: la versión 3 del cliente exige un terminal
  real para leer la contraseña y ya no la acepta por la tubería que usaba
  Rustty. Ahora se le entrega por el mecanismo que sí soporta, sin que el
  secreto pase por la línea de comandos, por el entorno ni por el disco. De
  paso, se le indica siempre el dominio —vacío incluido—, porque su ausencia
  disparaba otra pregunta imposible de contestar.
- **Un fallo de RDP por falta de contraseña se explica en una frase**, en vez
  de enseñar el volcado del cliente: si el perfil no la trae guardada, el aviso
  dice justamente eso y qué hacer.

### Cambiado

- **El acceso al gestor de credenciales del sistema queda acotado a lo que
  Rustty gestiona**. Las peticiones que llegan desde la interfaz ya no pueden
  nombrar un servicio ajeno ni una entrada fuera de las categorías propias de
  la aplicación (contraseñas y passphrases de perfiles, credenciales del
  catálogo y secretos de la sincronización). Es una barrera preventiva: ante un
  fallo futuro en la capa visual, el daño no alcanza a las credenciales que
  otras aplicaciones guardan en el mismo llavero.

## [1.58.1] - 2026-07-20

### Corregido

- **Los enlaces del terminal vuelven a comportarse como enlaces normales**.
  Tanto las URLs impresas como texto como los enlaces OSC 8 —incluidos los que
  ocupan varias líneas— se abren con un clic izquierdo en el navegador del
  sistema. El clic ya no muestra el diálogo interno con «OK», y los botones del
  ratón sobre un enlace no se reenvían al terminal como caracteres o secuencias
  de control.

## [1.58.0] - 2026-07-20

### Corregido

- **Editar una credencial maestra o secreta ya muestra su valor guardado**.
  El campo aparecía vacío pese al icono de «ver valor», porque el catálogo de
  credenciales nunca guarda el secreto — solo vive en el keyring del sistema —
  y el editor no llegaba a pedirlo. Ahora lo recupera al abrir el editor, igual
  que ya hacía el formulario de conexión con la contraseña de un perfil.

### Cambiado

- **Las sesiones SSH piden el tamaño real del terminal desde el primer
  instante**, en vez de un 80×24 fijo que solo se corregía tras la primera
  redimensión. Reduce los casos en los que un banner, un `motd` o un comando
  lanzado nada más abrir la shell llega formateado para un terminal mucho más
  estrecho del real.

## [1.57.0] - 2026-07-18

### Añadido

- **La paleta de comandos ahora lo encuentra todo**: además de acciones,
  perfiles, snippets y comandos locales, busca y lanza **scripts** (se ejecutan
  directamente), abre **notas de conexión**, los túneles SSH y el panel SFTP o
  la nota de la sesión activa cuando aplican. Y aprende del uso: mientras no
  escribes, lo reciente y frecuente aparece primero; al escribir, manda la
  coincidencia del texto.
- **Aviso de fin de comando largo** (opcional, apagado por defecto): con las
  marcas semánticas del shell (bash/zsh/fish modernos), Rustty avisa cuando un
  comando supera la duración elegida — en silencio si estás mirando la sesión,
  con un toast si estás en otra pestaña y con una notificación del sistema si
  la app está en segundo plano. El umbral es global y cada perfil puede afinar
  el suyo. Solo viajan la duración y el código de salida, nunca la salida del
  comando; las sesiones privadas no avisan.
- **Comprobación de salud de conexiones**: un barrido rápido (resolución de
  nombre + conexión TCP con tiempo límite) sobre los favoritos o el workspace
  actual, desde la paleta o el menú de workspaces, con la latencia de cada
  host. Nunca intenta iniciar sesión, así que no puede provocar bloqueos de
  cuenta.
- **Fundido al cambiar de vista** entre el panel de inicio y el terminal, con
  su propio interruptor en Apariencia; «Reducir movimiento» también lo anula.

### Cambiado

- **La barra lateral de iconos se reorganiza**: Nueva conexión y Consola local
  suben arriba como acciones de creación, y Preferencias baja abajo del todo
  con el color destacado que antes llevaba Nueva conexión.
- **Los avisos de fin de transferencia siguen el mismo criterio por foco** que
  los de comandos largos, con textos en los cinco idiomas y, por primera vez,
  interruptor y umbral propios en Preferencias → FTP/SFTP.
- **La galería de temas previsualiza cada tema con un mini terminal real**
  — prompt, comando con selección y salida pintados con la paleta exacta —
  también en los temas base, que aún mostraban un mosaico de colores.
- **Casi todo el chrome es ya vectorial**: cierres de ventana y panel, botones
  de fila de la barra lateral, toolbars del panel SFTP, búsqueda del terminal,
  breadcrumb de ruta, barra de layouts y los avisos de los formularios pasan de
  glifos y emojis a iconos SVG coherentes con el tema activo.

## [1.56.0] - 2026-07-15

### Añadido

- **Barras de desplazamiento superpuestas** (Preferencias → Apariencia): una
  opción nueva para que el pulgar de las barras flote sobre el contenido, fino en
  reposo y más ancho al pasar el ratón. Viene desactivada; con ella apagada se
  mantienen las barras finas de siempre.

### Cambiado

- **Los iconos de tipo de fichero del panel SFTP son ahora vectoriales**.
  Carpetas, imágenes, vídeo, audio, comprimidos, documentos, código y demás se
  dibujan con iconos de trazo que siguen el color de cada tipo y el tema activo,
  en lugar de emojis. Se distinguen por su forma, no solo por el color, y se ven
  igual en cualquier sistema.

### Interno

- Puesta al día de dependencias: TypeScript 7, `tauri-plugin-log`, `socket2`,
  `tauri-plugin-single-instance` y la acción `setup-node` del CI.

## [1.55.0] - 2026-07-14

### Corregido

- **Borrar varias conexiones a la vez ya no deja ninguna «resucitada»**. Al
  eliminar una selección múltiple —o un espacio de trabajo con sus conexiones—,
  cada baja se aplicaba por su cuenta y podían pisarse entre ellas: alguna
  conexión reaparecía al recargar. Ahora el borrado se aplica de una sola vez.
- **Importar ya no puede dejar la mitad de las conexiones dentro**. Los tres
  caminos de importación (copia de seguridad, `~/.ssh/config` y el asistente de
  otros clientes) guardaban conexión a conexión, así que un fallo a media
  importación dejaba una parte aplicada y otra no, sin decir cuál. Ahora entran
  todas o no entra ninguna, y si algo falla se avisa.

### Cambiado

- **Los ficheros de datos (conexiones, credenciales y scripts) declaran su
  formato** y se pueden actualizar sin riesgo. Antes de cambiarlos a un formato
  nuevo, Rustty guarda una copia intacta del original junto a ellos
  (`profiles.json.v1-<fecha>.bak`), que **no se borra nunca**: es la vuelta atrás
  si algo va mal o si instalas una versión anterior.
- **Una versión antigua de Rustty ya no puede pisar los datos de una más nueva**:
  si encuentra un fichero escrito por una versión posterior, se detiene y lo dice
  en vez de tratarlo como corrupto. Antes lo habría reemplazado en silencio.

### Interno

- La versión del compilador de Rust queda **fijada** en el proyecto
  (`rust-toolchain.toml`), y el CI y la publicación la leen de ahí. Actualizar
  Rust pasa a ser una decisión deliberada: hasta ahora, una versión nueva del
  compilador podía romper una publicación sin haber tocado una línea de código
  (ocurrió al publicar la 1.54.0).
- Nuevo aviso de mantenimiento (`npm run check:backlog`) que detecta tareas del
  backlog que el código dice que ya están hechas. Avisa; no cierra nada.

## [1.54.0] - 2026-07-13

### Añadido

- **Bloqueo automático de KeePass**: nueva opción en Preferencias → KeePass para
  cerrar la base sola tras 5, 15, 30 o 60 minutos **sin usarla** (o nunca, que es
  lo que hacía hasta ahora). El contador solo se reinicia cuando usas la base de
  verdad —consultar o insertar una credencial—, no con la actividad del terminal:
  una sesión con un comando largo en marcha ya no mantiene tus contraseñas
  abiertas toda la tarde. Junto al estado ves cuánto queda para el cierre.
- **Bloqueo de KeePass al suspender el equipo** (activado por defecto): si cierras
  el portátil con la base abierta, al despertar la encuentras bloqueada.
- **Rustty detecta que el equipo ha estado suspendido** y que la red ha vuelto.
  Tras despertar, una sesión puede seguir apareciendo como conectada aunque su
  conexión ya esté muerta: ahora se comprueban y se avisa de las que no responden.
  En Preferencias → Seguridad puedes elegir que además **reconecte** las caídas
  (de forma escalonada, para no saturar el servidor) o que no haga nada.
- **El importador de runbooks avisa de lo que no entiende**: al importar un
  script desde un fichero Markdown editado a mano, la app enumera las líneas que
  no ha sabido interpretar (con su número de línea) y te deja decidir si importas
  igualmente. Antes las descartaba en silencio y el script quedaba incompleto sin
  que nadie lo dijera.

### Cambiado

- **La primera conexión a un servidor ahora pide confirmar su huella**. Hasta
  ahora Rustty aprendía la clave del servidor en silencio y solo avisaba si
  *cambiaba* más adelante; eso deja pasar desapercibido a un intermediario que ya
  estuviera ahí en esa primera conexión. Ahora se muestra la huella y tú decides.
  Puedes volver al comportamiento anterior desactivando **Confirmar la huella en
  la primera conexión** en Preferencias → Seguridad. Los servidores que ya
  conocías no se ven afectados.
- **Una sola ventana de Rustty**: si la app ya está abierta y la vuelves a lanzar
  desde el lanzador del sistema, se te devuelve la ventana que tenías en vez de
  abrir una segunda. Dos ventanas sobre el mismo fichero de conexiones podían
  pisarse los cambios entre ellas. La línea de comandos (`rustty -c perfil`) sigue
  funcionando con la app abierta, igual que antes.
- **Los runbooks exportados usan etiquetas independientes del idioma**
  (`**Target:**`, `## Steps`, `recursive=yes`…). Antes las etiquetas del fichero
  estaban fijas en castellano, así que quien usa la app en francés, alemán o
  portugués exportaba un documento con encabezados en un idioma que no es el
  suyo. **Los runbooks antiguos se siguen leyendo sin cambios**: al reexportarlos
  se guardan con el formato nuevo. Lo que tú escribes (nombre, descripción y
  comandos) no se toca.
- Puesta al día de las dependencias del proyecto (Rust y JavaScript).

### Corregido

- **Un fichero de conexiones dañado ya no te deja con la lista vacía**. Si
  `profiles.json` no se puede leer (un corte de luz a mitad de un guardado, un
  disco lleno), Rustty conserva el fichero dañado a un lado, **restaura la última
  copia buena** y te lo dice. Antes, un fichero corrupto podía presentarte un
  catálogo vacío como si nada — y el siguiente guardado lo habría rematado. Lo
  mismo vale ahora para las credenciales y los scripts.
- **Las escrituras aguantan un corte de luz**: además del contenido, ahora se
  sincroniza también la carpeta, de modo que un apagón justo después de guardar no
  puede dejar el fichero sin nombre. Los temporales que deje un cierre brusco se
  limpian solos al arrancar.
- **La actualización automática de Windows podía apuntar a un instalador
  inexistente**: al preparar la publicación, el instalador `.msi` se renombra, y
  ni su firma ni el fichero que consulta el actualizador se corregían. Un equipo
  con Windows podía recibir un error al buscar actualizaciones. Ahora la
  publicación comprueba que todo lo que anuncia el actualizador existe realmente
  antes de hacer pública la versión.
- **La política de seguridad ya no se queda anclada a una versión antigua**:
  `SECURITY.md` anunciaba soporte para la línea 1.35.x cuando la app ya iba por
  la 1.53. La versión se propaga sola desde ahora y la publicación falla si
  alguien la deja desactualizada.
- **Un fallo interno ya no puede dejar una sesión colgada en silencio**: los
  cierres de RDP, VNC, KeePass, la bandeja del sistema y la sincronización
  resisten ahora el mismo tipo de error interno del que ya estaban protegidas las
  sesiones SSH y SFTP, en vez de matar el hilo y dejar la sesión zombi.

### Seguridad

- **Importaciones de otros clientes acotadas**: un fichero de Ásbrú o mRemoteNG
  manipulado podía agotar la memoria del equipo aunque ocupara pocos kilobytes,
  aprovechando las referencias internas del formato para expandirse
  desmesuradamente al abrirlo. Rustty ahora estima ese coste antes de leerlo y
  rechaza el fichero, además de limitar cuántas conexiones y cuántos niveles de
  carpetas admite un import. El límite de tamaño que ya existía no cubría este
  caso.
- **Publicar una versión exige pasar toda la batería de pruebas**: el proceso de
  release no compila, ni firma, ni publica nada hasta que lint, tipos, tests,
  contraste, i18n y la comprobación de que la versión etiquetada cuadra con el
  código han pasado.

## [1.53.0] - 2026-07-13

### Añadido

- **Los comandos locales ya no se pueden quedar colgados**: cada comando tiene
  un límite de tiempo (30 s por defecto, configurable o desactivable en
  Preferencias → Comandos) y un botón **Cancelar** en el aviso mientras se
  ejecuta. Al cancelarlo, o al agotarse el plazo, se detiene también todo lo
  que el comando hubiera lanzado por su cuenta.
- **Límite de salida capturada**: eliges cuánta salida guarda cada comando
  local (64 KiB a 8 MiB). Si un comando escribe sin parar, la app ya no se
  queda sin memoria: se queda con lo que cabe y avisa de que la salida está
  truncada.
- **Aviso de enlaces simbólicos**: al copiar una carpeta por SFTP, los enlaces
  simbólicos se omiten (como siempre), pero ahora la app te dice cuántos ha
  saltado, en el aviso y en el registro de actividad. Antes desaparecían en
  silencio y parecía que se había copiado todo.

### Cambiado

- **Las descargas nunca dejan un fichero a medias con aspecto de completo**: el
  fichero se baja a un temporal y solo toma su nombre definitivo cuando ha
  terminado bien. Si se corta la red o cancelas, no queda basura en tu carpeta:
  lo que ves con el nombre bueno está entero.
- **Ficheros de importación acotados**: cada importación (tema, copia de
  seguridad, `~/.ssh/config`, export de otro cliente…) tiene un tamaño máximo
  razonable y rechaza ficheros binarios con un aviso claro, en vez de intentar
  cargar entero un fichero enorme o equivocado y bloquear la aplicación.

### Seguridad

- **Los logs de sesión se crean privados**: en Linux y macOS solo tu usuario
  puede leerlos (permisos `0600`). Antes, según la configuración del sistema,
  podían quedar legibles para el resto de usuarios del equipo. Los logs
  antiguos con permisos abiertos se corrigen solos al volver a usarlos.

### Dependencias

- Actualizados `tauri` (2.11.5), `russh` (0.62), `keepass` (0.13.15) y las
  herramientas de desarrollo (`vite`, `vitest`, `eslint-plugin-jsdoc`).

## [1.52.0] - 2026-07-10

### Añadido

- **RDP en Windows sin doble contraseña**: la contraseña del perfil se entrega
  de forma segura al cliente de Escritorio remoto de Windows, que conecta
  directo sin volver a pedirla. Al cerrar la última sesión del host la
  credencial se retira; si ya tenías una guardada por tu cuenta, no se toca.
- **Vista previa de la primera sincronización**: al activar la sincronización
  en un equipo cuando el servidor ya tiene datos, la app muestra qué se
  añadiría, cambiaría o borraría y pide confirmación antes de aplicar nada.
- **Actividad de sincronización**: la pestaña Copias de seguridad registra qué
  hizo cada pasada (cuántos perfiles, temas o notas cambiaron y desde qué
  equipo). Puedes dar un nombre a cada equipo («Portátil del trabajo») para
  que el registro sea legible.
- **Cambiar la passphrase con un asistente**: re-cifra los datos del servidor
  (y, si quieres, también las copias históricas) con la nueva passphrase. Si
  otro equipo aún tiene la antigua, verá un aviso claro con lo que debe hacer
  en lugar de un error técnico.
- **Generador y medidor de passphrase**: el campo indica la fortaleza de lo
  que escribes y un botón genera una passphrase fuerte y pronunciable, todo
  en local.
- **Eliminar los datos del servidor**: botón para borrar del servidor el
  estado cifrado y todas las copias históricas; al desactivar la
  sincronización también se limpia la caché local del equipo.
- **Sincronizar al salir**: si cierras la app con cambios pendientes de subir,
  se hace una sincronización final rápida para que no se pierdan hasta el
  próximo arranque (desactivable).
- **Indicador discreto al arrancar**: un aviso pequeño en la esquina inferior
  muestra «Sincronizando…» y «Al día» mientras corre la sincronización de
  arranque (desactivable).

### Cambiado

- **Sincronización más resistente**: los microcortes de red y los errores
  pasajeros del servidor se reintentan solos; sin conexión, la app queda en
  estado «sin conexión» y reintenta en un minuto, sin llenar el centro de
  actividad de errores.
- **Equipos con el reloj desajustado ya no mandan**: un equipo con la hora
  adelantada ya no gana siempre los conflictos de sincronización, y la app
  avisa si tu reloj difiere mucho del servidor.
- **Registros de borrado con caducidad configurable**: lo borrado se recuerda
  unos días para que no «resucite» desde otro equipo; ahora eliges cuántos
  (90 por defecto, o «conservar siempre» si algún equipo pasa meses apagado).
- **Credencial de Google Drive mejor guardada**: el secreto de cliente de
  Drive pasa del archivo de configuración al almacén de claves del sistema.

### Corregido

- **Sesiones RDP en Linux que se cerraban sin explicación**: cuando el cliente
  RDP externo falla al arrancar (por ejemplo porque el certificado del
  servidor cambió desde la última conexión), ahora se muestra el motivo real
  con instrucciones, en vez de un simple «sesión cerrada».
- **Dos equipos estrenando la sincronización a la vez**: si ambos creaban el
  archivo en Google Drive en el mismo momento, cada uno podía quedarse con una
  copia distinta y no verse nunca; ahora se detecta, se fusionan y queda una
  sola.
- **Ediciones simultáneas desde dos equipos (WebDAV)**: si otro equipo subía
  cambios justo mientras el tuyo sincronizaba, ya no se pisan: se detecta el
  choque, se vuelve a fusionar y se sube el resultado combinado.
- **Compatibilidad WebDAV más amplia**: el listado de copias históricas
  funciona ahora con más servidores WebDAV, no solo Nextcloud/ownCloud.
- **Menos escrituras en disco**: la configuración de sincronización ya no se
  reescribe entera en cada pasada.

## [1.51.0] - 2026-07-10

### Añadido

- **Sincronización periódica con el intervalo que tú elijas**: nueva opción en
  Preferencias → Copias de seguridad para buscar cambios de otros equipos cada
  1, 5, 15, 30 o 60 minutos (o nunca) mientras la app está abierta. Hasta ahora,
  lo que cambiabas en otro equipo solo llegaba al reiniciar la app.

### Cambiado

- **La sincronización deja de interrumpir**: si una pasada (la del arranque o
  una periódica) no trae ningún cambio, la interfaz no se toca — nada de
  redibujar la barra lateral, perder el foco o cerrar menús a mitad de trabajo.
  El centro de actividad solo anota las sincronizaciones con cambios reales o
  las lanzadas a mano.
- **Lo que cambias mientras se sincroniza ya no se pierde**: si tocas una
  preferencia (un favorito, un color, el tema…) justo cuando hay una
  sincronización en marcha, tu cambio se conserva y se sube en la siguiente
  pasada, en vez de revertirse en silencio.
- **Google Drive bastante más rápido**: la app recuerda la autorización y la
  ubicación del archivo entre operaciones; cada sincronización hace muchas menos
  llamadas a Google (antes pedía un permiso nuevo en cada paso).

### Corregido

- **Conectar Google Drive al segundo intento**: si cerrabas el navegador sin
  autorizar y volvías a pulsar «Conectar», la app no podía abrir el puerto de
  retorno durante 3 minutos. El intento abandonado se descarta y el nuevo
  funciona a la primera.
- **Aviso claro si revocas el acceso a Google Drive**: al retirar el permiso
  desde tu cuenta de Google, la app lo detecta, desconecta el proveedor y te
  pide reconectar, en vez de fallar para siempre con un error técnico.
- **Guardado más robusto de la copia en carpeta local**: el archivo de
  sincronización en carpeta local/NAS y la identidad del equipo se escriben de
  forma atómica; un corte a mitad ya no puede dejarlos corruptos.

## [1.50.0] - 2026-07-09

### Corregido

- **Scripts con una orden larga que se quedaban «en marcha» sin terminar**: si un
  paso lanzaba un comando que a su vez abría conexiones `ssh`/`rsync` (por ejemplo
  una réplica a varios servidores), el indicador de progreso se quedaba clavado en
  el último paso y el script no llegaba a desconectar, aunque la salida completa sí
  aparecía. La detección del fin de cada comando es ahora inmune a ello: el script
  termina y marca su resultado como debe.

### Cambiado

- **Botones de acción con el color del tema**: los botones del panel de ejecución
  de scripts y de los túneles (Reintentar, Exportar, Copiar, Abortar…) ya no se
  ven grises; toman el acento del tema activo —azul para las acciones normales,
  rojo para las destructivas— y se intensifican al pasar el ratón.

## [1.49.0] - 2026-07-09

### Añadido

- **Mantener la sesión SSH activa**: nueva opción para evitar que el servidor te
  desconecte por inactividad (por ejemplo detrás de un router con NAT). Se activa
  por conexión en el formulario y también con el botón derecho sobre la pestaña de
  la sesión, con efecto inmediato sin reconectar. Viene **desactivada por defecto**.
- **Francés y portugués completos**: la pestaña de Copias de seguridad y
  sincronización, el formulario de conexión, las opciones de apariencia y los
  textos de «hace un momento / hace 3 min» dejan de aparecer en español cuando la
  app está en francés o portugués. Los cinco idiomas quedan ya al 100 %, y una
  comprobación interna vigila que ninguno se quede atrás en el futuro.

### Cambiado

- **Más solidez frente a errores internos**: si un fallo puntual bloqueaba un
  «cerrojo» interno, las sesiones de terminal, ficheros y consola local podían
  quedarse colgadas en silencio; ahora se recuperan y siguen funcionando.
- **Menos rastro de contraseñas en memoria**: las contraseñas y la clave maestra
  de KeePass se borran de la memoria en cuanto dejan de usarse, en vez de quedar
  ahí hasta que el sistema reutilice ese espacio.

### Corregido

- **Pestañas que se quedaban «conectando» o «conectadas» para siempre**: cerrar
  una conexión SSH justo mientras conectaba podía dejar una sesión huérfana por
  detrás; y una conexión RDP, VNC, Telnet o de consola local que se cerraba en el
  primer instante podía dejar la pestaña marcada como conectada sin estarlo. Ambos
  casos quedan resueltos.
- **Avisos de los scripts traducidos**: los mensajes de validación del editor de
  scripts (nombre obligatorio, demasiados pasos, patrón inválido…) respetan ahora
  el idioma de la app en vez de salir siempre en español.
- **Limpieza de seguridad**: se retiran diez órdenes internas que ya no usaba
  nadie —una de ellas permitía borrar cualquier fichero sin restricción— y se
  refuerza el gestor de known_hosts.

## [1.48.0] - 2026-07-08

### Añadido

- **Más idiomas en los avisos**: los mensajes emergentes (túneles, conexiones,
  transferencias, pruebas de conexión, selección de archivos…) y el diálogo de
  eliminar una conexión respetan ahora el idioma elegido en los cinco idiomas de
  la app (español, inglés, francés, portugués y alemán), en vez de aparecer
  siempre en español. Una comprobación interna vigila además que ningún idioma
  se quede sin traducir esos mensajes.

### Cambiado

- **Permisos del sistema más ajustados**: Rustty pide ahora solo los permisos
  que realmente usa para abrir enlaces y carpetas. Se han retirado un permiso de
  «mostrar en la carpeta» que no se utilizaba y una lista de direcciones
  permitidas que no tenía ningún efecto.

### Corregido

- **La latencia deja de medirse en sesiones caídas**: cuando una sesión se
  cierra o falla, la barra inferior ya no sigue midiendo la latencia contra un
  host que puede estar inaccesible.
- **Menos saturación al mover mucho tráfico por un túnel**: el contador de
  tráfico de los túneles SSH se actualiza de forma agrupada (varias veces por
  segundo) en lugar de por cada fragmento, evitando sobrecargar la interfaz en
  transferencias grandes; al terminar muestra siempre el total exacto.

## [1.47.0] - 2026-07-07

### Añadido

- **Copiar y exportar la salida de los scripts**: cada conexión tiene ahora un
  botón «Copiar» que lleva al portapapeles su registro y su salida, y el pie de
  la ejecución incluye «Exportar .log» para guardarlo todo en un fichero. La
  salida y el registro también se pueden seleccionar con el ratón.
- **Ejecuciones recientes**: la sección «Scripts» guarda las últimas ejecuciones
  en este equipo (botón «Ejecuciones recientes»). Puedes reabrir cualquiera para
  ver su registro y su salida, exportarla, o borrar todo el historial. El
  historial se guarda con permisos privados (0600) y nunca contiene contraseñas.
- **Reintentar**: cuando una ejecución termina, aparecen «Reintentar fallidos» y
  «Reintentar todo», que relanzan la misma receta reutilizando el modo y las
  credenciales del run (solo los equipos con error, o todos).

### Corregido

- **Caracteres raros en la salida de los scripts**: la salida se limpia ahora de
  las secuencias de control del terminal (colores, títulos de ventana, el modo
  «bracketed paste» que se veía como `[?2004h`) y de las barras de progreso
  redibujadas, tanto en pantalla como al copiar o exportar.
- **El paso «Desconectar» ya no se adelanta al comando anterior**: si la receta
  envía un comando y a continuación desconecta (sin un paso de espera entre
  medias), ahora se espera a que el comando termine antes de cerrar la conexión,
  en lugar de cortarlo a mitad.
- **Al cerrar la ejecución ya terminada no se pregunta por abortar**: si todas
  las conexiones han acabado, cerrar la ventana no vuelve a preguntar si se
  quiere abortar. El aviso de «esperando la salida final» se ha reescrito para
  dejar claro que se está esperando a que termine el último comando.

## [1.46.0] - 2026-07-07

### Añadido

- **Registro de ejecución en los scripts**: al lanzar un script, cada conexión
  muestra ahora una línea de tiempo con lo que va ocurriendo —conexión
  establecida, cada paso con su comando, y el resultado con la duración—, además
  de la salida de los comandos con un contador de líneas. Antes solo se veía el
  estado final sin ningún detalle.

### Corregido

- **Los scripts que terminaban en un comando ya muestran su salida**: si la
  receta acababa con un «Enviar comando» sin un paso de espera posterior, la
  conexión se cerraba al instante y no se mostraba nada (el comando podía incluso
  no llegar a ejecutarse). Ahora se espera a que termine y se recoge su salida.
- **Al soltar un fichero en la consola local de Windows**, un nombre con
  caracteres especiales (`$(...)`, comillas, `%VAR%`) ya no puede ejecutar
  comandos al pulsar Intro.
- **El asistente de importar conexiones** ya no interpreta como HTML los nombres
  de protocolo de un fichero manipulado.
- **Exportar e importar copias cifradas y restaurar una copia histórica** vuelven
  a mostrar los diálogos de contraseña y confirmación (antes, en algunas
  plataformas, el botón parecía no hacer nada).
- Corregidas varias **fugas de recursos** al cerrar paneles de archivos (SFTP) y
  conexiones FTP/FTPS.

## [1.45.0] - 2026-07-06

### Añadido

- **Grabar scripts desde la sesión**: en la sección «Scripts», el botón «Grabar
  desde la sesión…» captura lo que tecleas en una conexión SSH y lo convierte
  en un script listo para editar. Cada comando se guarda como un paso y entre
  comandos se inserta automáticamente la espera del prompt.
  - **Las contraseñas nunca se graban**: cuando el servidor pide una contraseña
    (por ejemplo `sudo` o un `ssh` anidado), la grabadora detecta que el eco
    está apagado y, en lugar del texto tecleado, deja un paso «enviar
    contraseña» en blanco para que elijas keyring o KeePass al editar.
  - Al detener la grabación se abre el editor con los pasos capturados y la
    conexión de origen ya seleccionada como objetivo, para que revises y
    ajustes antes de guardar.

## [1.44.0] - 2026-07-05

### Añadido

- **Scripts reproducibles**: nueva sección «Scripts» (botón en la barra lateral)
  para crear recetas de pasos que se ejecutan contra tus conexiones SSH.
  - **Editor paso a paso**: enviar un comando, esperar el prompt o un patrón
    (con tiempo límite), comprobar el código de salida, enviar la contraseña
    guardada (keyring o KeePass, siempre por referencia), pausar y desconectar.
    Hasta 50 pasos por script.
  - **Ejecución sobre varios equipos a la vez**: el objetivo puede ser una
    conexión, una carpeta entera (con o sin subcarpetas) o una selección de
    conexiones; en paralelo con concurrencia configurable o en modo «canario»
    (primero un equipo y, si acaba bien, el resto), con parada opcional al
    primer error.
  - **Previsualización antes de lanzar**: se muestran los comandos que se
    enviarán a cada equipo, con los secretos ocultos, junto a un panel de
    estado por equipo (paso en curso, salida, resultado) y cancelación
    individual o total.
  - **Credenciales de la tirada a elegir**: por defecto las de cada conexión,
    o bien una credencial maestra, una entrada de KeePass o un usuario y
    contraseña introducidos al momento (que no se guardan en ningún sitio).
  - **Parámetros `${ask:…}`** en los comandos: al ejecutar se piden los valores
    en un diálogo, para reutilizar la misma receta con distintos servicios.
  - **Exportar e importar como Markdown**: cada script se puede guardar como un
    documento legible que sirve a la vez de runbook y de script ejecutable.
  - El fichero de scripts nunca guarda contraseñas, y la salida mostrada
    oculta cualquier secreto enviado.
- **Eliminar varias conexiones a la vez**: con una selección múltiple en la
  barra lateral, «Eliminar» borra ahora todas las seleccionadas bajo una única
  confirmación (antes solo borraba una).

### Corregido

- **Probar una conexión ya no congela la ventana** mientras dura la prueba;
  desbloquear KeePass y exportar o importar copias cifradas tampoco.
- **La conexión con Google Drive** (copias de seguridad) ya no falla de forma
  intermitente: la autorización sobrevive a las conexiones automáticas que
  abren los navegadores modernos.
- **Las descargas SFTP grandes limitan la memoria** que pueden llegar a usar
  cuando el servidor responde fuera de orden.
- **Un programa que conecta al proxy SOCKS de un túnel dinámico y no envía
  nada** ya no bloquea el terminal de esa sesión: el saludo se atiende aparte
  y con tiempo límite.
- **Notas de conexión**: los enlaces con parámetros (`?a=1&b=2`) ya no se
  rompen al mostrarse, y marcar casillas de tareas funciona bien aunque la
  nota contenga listas de ejemplo dentro de bloques de código.
- **La previsualización de variables** marca como ocultos (`••••`) únicamente
  los secretos con nombre válido, igual que hace la sustitución real al
  conectar.

## [1.43.0] - 2026-07-04

### Seguridad

- **Descarga de carpetas a prueba de servidores maliciosos**: al descargar una
  carpeta por SFTP/FTP, los nombres de fichero que envía el servidor se validan
  antes de escribir en disco, de modo que un servidor comprometido ya no puede
  colocar ficheros fuera de la carpeta de destino elegida.
- **Escrituras atómicas del fichero de claves de host conocidas** y de los datos
  de sincronización, copias de seguridad y capturas de pantalla de sesión: un
  cierre inesperado a mitad de guardado ya no puede truncarlos ni corromperlos.
- **La contraseña de conexión RDP en macOS** se codifica correctamente al abrir
  el cliente, evitando URLs rotas con usuarios que contienen barra, espacios u
  otros caracteres especiales.

### Corregido

- **Cancelar o pausar la transferencia de una carpeta** ahora surte efecto de
  verdad: antes la interfaz mostraba «Cancelando…» pero la transferencia seguía
  hasta el final.
- **Conexiones a través de saltos (jump host) con direcciones IPv6**: se admiten
  las formas `[dirección]:puerto` y la dirección IPv6 sin puerto, que antes se
  interpretaban mal.
- **Al salir por la bandeja del sistema** se cierran también los visores VNC y
  los clientes Telnet externos, que antes podían quedar abiertos.
- **La aplicación arranca aunque el archivo de carpetas guardadas esté dañado**:
  se recupera con una lista vacía en lugar de quedar bloqueada al inicio.
- **La línea de comandos (`rustty -c`)** resuelve las contraseñas que usan
  variables o credenciales maestras, igual que ya hacía la interfaz gráfica.

## [1.42.0] - 2026-07-03

### Seguridad

- **La contraseña de RDP ya no viaja por la línea de comandos** en Linux: se
  entrega al cliente (`xfreerdp`/`rdesktop`) a través de la entrada estándar, de
  modo que deja de ser visible para otros usuarios del equipo con herramientas
  como `ps`.
- **Verificación del certificado del servidor RDP**: el cliente pasa a
  confiar-en-el-primer-uso (recuerda el certificado y avisa si cambia) en lugar
  de aceptar cualquier certificado sin comprobarlo, igual que ya hacía Rustty
  con las claves de host SSH.
- **Limpieza de credenciales al eliminar una conexión**: al borrar un perfil
  (también en los borrados en lote de carpetas o workspaces) se eliminan sus
  contraseñas y frases de paso del almacén de credenciales del sistema, que
  antes quedaban huérfanas.

### Cambiado

- **Guardado a prueba de cortes** de las conexiones, las credenciales y las
  notas: los ficheros se escriben de forma atómica y con permisos restringidos,
  así que un cierre inesperado a mitad de guardado ya no puede dejar el fichero
  vacío o corrupto.

## [1.41.0] - 2026-07-01

### Añadido

- **Autocompletado por historial en el editor de comandos**: al escribir en el
  editor multilínea (`Ctrl+Shift+E`), se abre un desplegable con los comandos
  anteriores que encajan con lo tecleado —primero los que empiezan igual y
  luego los que lo contienen—. Se navega con las flechas y se acepta con `Tab`
  o `Intro`; `Ctrl+Espacio` lo abre a demanda y `Esc` lo cierra.
- **Densidad de interfaz «Espaciosa»**: nuevo nivel en Preferencias →
  Apariencia que aumenta el interlineado y el espaciado de la barra lateral,
  las pestañas y los diálogos para facilitar la lectura, sin cambiar el tamaño
  del terminal.
- **Pestañas de sesión accesibles**: las pestañas anuncian su rol y su estado
  de selección a los lectores de pantalla, y sus botones (SFTP, túneles y
  cerrar) llevan etiquetas descriptivas.

### Cambiado

- **Iconos vectoriales en el chrome**: los botones de las pestañas (SFTP,
  túneles y cerrar) y las tarjetas de servicio de copia de seguridad pasan de
  glifos y emojis a iconos SVG monocromo, coherentes en trazo y tamaño con el
  resto de la interfaz.

### Interno

- **Traducciones de densidad completadas** en francés y portugués, que hasta
  ahora recurrían al idioma de reserva en ese ajuste.

## [1.40.0] - 2026-06-30

### Añadido

- **Barra de estado compacta por prioridad**: en ventanas estrechas, la barra
  inferior pliega el directorio remoto, el tamaño del terminal, la latencia y el
  indicador `REC` tras un botón que abre un pequeño panel con esos datos,
  conservando siempre el estado de conexión y el host. Vuelve a expandirse sola
  al recuperar ancho.
- **Tiradores de redimensionado accesibles por teclado**: la barra lateral, el
  divisor del panel SFTP, el de sus registros y los separadores de los paneles
  divididos se pueden enfocar con el tabulador y ajustar con las flechas
  (mantén `Shift` para pasos grandes); la tecla `Inicio` restablece el tamaño,
  igual que el doble clic. Incluyen etiquetas para lectores de pantalla.
- **Atajo «Limpiar línea del prompt»**: nueva acción configurable en
  Preferencias → Atajos que vacía de un tirón la línea de edición del shell
  (SSH o consola local). Sin combinación por defecto para no pisar `Ctrl+U`, que
  usan programas como `vim` o `less`.
- **Avisos para lectores de pantalla**: las notificaciones (conexiones,
  transferencias y sincronización) se anuncian mediante una región `aria-live`,
  y los errores se comunican de inmediato.

### Corregido

- **Textos sin traducir en Preferencias → Atajos**: las acciones «Paleta de
  comandos» y «Modo zen / pantalla completa» mostraban su clave interna en lugar
  del nombre traducido. Añadidas en los cinco idiomas.

### Interno

- **Contraste de temas en integración continua**: el verificador de contraste
  WCAG AA de los temas se ejecuta ahora en CI en modo estricto, bloqueando
  cualquier regresión de legibilidad en los 12 temas base y la biblioteca
  precargada.

## [1.39.0] - 2026-06-29

### Añadido

- **Arrastrar ficheros a la consola local**: al soltar uno o varios ficheros o
  carpetas del sistema sobre una consola local, sus rutas se insertan en el
  prompt entrecomilladas correctamente (espacios y caracteres especiales
  incluidos) y separadas por espacios, listas para completar el comando. No se
  ejecuta nada: solo se escribe la línea para que la revises y pulses Intro.

### Corregido

- **Foco al pegar en el terminal**: tras confirmar el pegado de un texto largo,
  el foco vuelve automáticamente al terminal, así se puede pulsar Intro sin
  tener que volver a hacer clic en él.

## [1.38.0] - 2026-06-29

### Añadido

- **Bloque de accesibilidad** en Preferencias → Apariencia que agrupa los ajustes
  de legibilidad y movimiento.
- **Contraste de la interfaz** (Normal / Alto / Máximo): refuerza el contraste del
  texto, los bordes, el foco y la selección en toda la aplicación sin obligar a
  cambiar de tema.
- **Reducir movimiento**: desactiva animaciones, transiciones largas y efectos
  decorativos aunque el sistema operativo no lo anuncie. La campana visual del
  terminal pasa a un realce estable, sin parpadeo.
- **Foco visible reforzado**: aumenta el grosor y el contraste del anillo de foco
  en la navegación por teclado.
- **Contraste mínimo del terminal** (Sin ajuste / AA / AAA): adapta los colores
  ANSI poco legibles para que el texto alcance un contraste mínimo con su fondo.
- **Cursor del terminal más visible**: tinta de alto contraste en cualquier estilo
  de cursor y caret más grueso en el estilo «barra».
- **Navegación por teclado** completa en menús contextuales, barra lateral y
  pestañas: foco al abrir un menú, recorrido con flechas/Inicio/Fin, cierre con
  Tab/Escape y apertura del menú contextual con Shift+F10.

### Cambiado

- **Modo daltónico ampliado** más allá de los puntos de estado: los avisos
  emergentes añaden un icono por severidad y las barras de transferencia SFTP
  marcan el estado final con una trama distinta, además del color.
- **Foco no oculto tras scroll**: al tabular, el elemento enfocado se desplaza a la
  vista con un margen para no quedar pegado al borde ni medio oculto.

## [1.37.0] - 2026-06-24

### Añadido

- **Conexiones VNC**: nuevo tipo de conexión que abre el escritorio remoto en el
  visor VNC del sistema (TigerVNC/`vncviewer` en Linux, Pantalla compartida en
  macOS, visor instalado o `vnc://` en Windows). Igual que RDP, Rustty lanza el
  cliente externo y vigila la sesión, cerrando la pestaña cuando termina.
- **Conexiones Telnet**: nuevo tipo de conexión que lanza el cliente `telnet` del
  sistema dentro de un emulador de terminal. Pensado para equipos de red y
  dispositivos antiguos; se avisa con claridad si falta el cliente o el terminal.
- **Selector de carpeta como árbol navegable**: al elegir la carpeta de una
  conexión, en lugar de un desplegable plano interminable ahora hay un árbol que
  se despliega y se filtra por nombre, mucho más cómodo con muchas carpetas.
- **Verificación de contraste de temas** (`npm run check:contrast`): herramienta
  interna que comprueba el contraste WCAG AA de los temas de la interfaz.

### Cambiado

- **Divisores del terminal**: doble clic en el divisor entre paneles divididos
  reparte el espacio a partes iguales, igual que ya hacían la barra lateral y el
  panel SFTP.

### Corregido

- **Contraste de los temas empaquetados**: se ajustan los colores de texto de los
  temas precargados que no alcanzaban el contraste mínimo AA, para que el texto se
  lea con claridad sobre su fondo.

## [1.36.0] - 2026-06-23

### Añadido

- **Pestaña «Seguridad» en Preferencias**: una sección dedicada que reúne las
  opciones sensibles bajo un principio claro: Rustty nunca bloquea una acción,
  siempre ofrece opciones y deja que tú elijas. Incluye el nuevo ajuste de
  pegado de contraseña con broadcast y recoge, ya existentes, la confirmación de
  pegados peligrosos, el guardado de pantalla para restaurar, la gestión de
  `known_hosts` y la retención de logs de sesión.
- **Renombrar con F2**: pulsa F2 para renombrar el archivo seleccionado en el
  panel SFTP, o la conexión seleccionada en la barra lateral. El renombrado de
  conexión también está disponible desde su menú contextual.

### Cambiado

- **Pegado de contraseña con broadcast activo**: al pegar la contraseña (Ctrl+P)
  con el modo broadcast replicando la entrada en varias panes, ya no se impide la
  acción. Una preferencia decide el comportamiento: difundir a todas las panes
  (por defecto), pegar solo en la pane activa o preguntar en cada pegado.
- **Selección con doble clic en el terminal**: ahora corta en los separadores de
  campo habituales (`:` `@` `/` `=` `.` `|`) para aislar trozos en salidas densas
  como las de `grep` o los logs. Los guiones siguen unidos (SHAs, kebab-case).

### Corregido

- Los diálogos de renombrar y eliminar carpeta mostraban la clave de traducción
  en crudo (`sidebar.rename_folder`…) por un prefijo i18n incorrecto.

## [1.35.0] - 2026-06-23

### Seguridad

- **Política de seguridad de contenido (CSP) explícita**: la ventana de la
  aplicación restringe ahora de forma estricta qué recursos puede cargar y a qué
  destinos puede conectarse, permitiendo solo lo imprescindible. Es un refuerzo
  interno frente a contenido no confiable, sin cambios visibles en el uso.
- **Escritura de archivos más robusta**: las exportaciones y los archivos
  temporales se escriben de forma atómica y no pueden seguir un enlace simbólico
  preparado, evitando archivos a medias o sobrescrituras inesperadas. Los nombres
  de los temporales se sanean para que no puedan salirse de su carpeta.

## [1.34.0] - 2026-06-20

### Cambiado

- **Mantenimiento de dependencias**: el importador de Ásbrú deja de usar
  `serde_yaml` (archivado) y pasa a `serde_yaml_ng`, su continuación mantenida con
  el mismo formato YAML. Sin cambios de uso.
- **Calidad del código reforzada**: se incorporan comprobación de tipos del
  frontend (`// @ts-check` + JSDoc, `npm run typecheck`), un linter
  (`eslint`, `npm run lint`) y un paso `clippy::pedantic` informativo en la
  integración continua. Cambios internos, sin efecto visible en la app.

### Corregido

- **Sitio web — instrucciones de instalación**: la sección de instalación de la
  portada y la página de descargas ya ofrecen **winget** en Windows y el
  **instalador automático** (`install.sh`) en macOS, además de Linux. La
  documentación de instalación se actualiza en consecuencia.

## [1.33.0] - 2026-06-18

### Añadido

- **Carpeta inicial de la consola local configurable**: nueva opción en
  **Preferencias → Terminal** para elegir en qué carpeta se abren las consolas
  locales nuevas. Vacío sigue usando tu carpeta personal; si la ruta indicada no
  existe, se usa la carpeta personal como respaldo.

### Seguridad

- **Blindaje del seguimiento de carpeta (OSC 7)**: cuando el panel SFTP sigue al
  terminal, los cambios de carpeta que llegan **durante la salida de un comando**
  se ignoran. Así, mostrar un fichero manipulado (p. ej. `cat` de contenido no
  confiable) ya no puede redirigir de forma silenciosa el panel de archivos a una
  ruta arbitraria; solo se aceptan los cambios en la zona del prompt.

## [1.32.0] - 2026-06-18

### Cambiado

- **Terminal más fluido con salidas enormes**: el caudal de datos del terminal
  (sesiones SSH y consola local) viaja ahora por un **canal binario** en lugar
  de serializarse como texto JSON. Un `cat` de un log grande, `journalctl -f` o
  cualquier salida sostenida consumen bastante menos CPU y memoria en la
  interfaz. El resto del protocolo (estado de conexión, errores, registro) no
  cambia.
- **Consola local más capaz**: en Windows se prioriza PowerShell moderno
  (`pwsh`) → Windows PowerShell → `cmd`; en todos los sistemas se anuncia color
  verdadero (`COLORTERM=truecolor`) y se fija un locale UTF-8 cuando el entorno
  no define ninguno, para que `readline` y las TUIs no caigan a ASCII.

### Corregido

- **Escritura con IME (chino/japonés/coreano y teclas muertas)**: ya no se
  duplica el Enter ni se corta la composición mientras se escribe con un método
  de entrada activo.
- **Consolas locales huérfanas**: si la apertura del PTY falla a medias se mata
  el proceso del shell, y al terminar el shell su sesión se retira del registro
  interno en vez de quedar acumulada.

## [1.31.0] - 2026-06-17

### Añadido

- **SFTP: progreso por archivo al transferir carpetas** (estilo FileZilla): al
  subir o descargar una carpeta con subcarpetas, la transferencia ya no muestra
  solo un progreso global. Ahora la fila indica **qué archivo o subcarpeta se
  está transfiriendo** en cada momento y un contador «(3/20)», con barra,
  velocidad y tiempo restante calculados sobre el total de la carpeta.

### Cambiado

- **Menús contextuales reordenados por uso**: el menú de clic derecho sobre una
  conexión se agrupa por bloques (conectar · editar y organizar · red y avanzado
  · orden · eliminar) y «Conectar con cambios…» queda junto al resto de acciones
  de conexión. En el menú de pestaña, las acciones rápidas (renombrar, anclar,
  duplicar) suben al principio y las de cierre se agrupan al final.

## [1.30.0] - 2026-06-17

### Añadido

- **Registro de diagnóstico técnico**: la aplicación escribe ahora un log de
  actividad propia (`rustty.log`) en el directorio de logs del sistema, con
  rotación acotada para que no crezca sin límite. Nivel de detalle mayor en las
  versiones de desarrollo y más conciso en las publicadas. **No** registra el
  contenido del terminal ni contraseñas; está pensado para diagnóstico.

### Cambiado

- **Mantenimiento de dependencias**: actualización de las librerías de Rust y de
  Node a sus últimas versiones compatibles.
- **Contrato interno de eventos unificado**: los nombres de los eventos entre el
  backend y la interfaz se centralizan en un único punto, reduciendo el riesgo de
  errores al evolucionar el código. Sin cambios visibles de uso.
- **Tests automáticos**: se incorpora una primera batería de pruebas (vitest)
  sobre módulos internos de la interfaz.

### Corregido

- El escape `$${...}` en snippets y comandos perdía un carácter `$`: ahora produce
  correctamente el literal `${...}` sin sustituir la variable.

## [1.29.0] - 2026-06-16

### Añadido

- **Biblioteca de snippets**: catálogo de comandos remotos con nombre, grupo y
  descripción en **Preferencias → Comandos**, insertables en el terminal activo.
  Cada snippet admite sustituciones `${host}`, `${user}`, `${port}`,
  `${var:nombre}` y `${ask:Etiqueta}` (las preguntas se piden al insertar), una
  opción **«Enviar Enter al final»** para ejecutarlo y otra de **confirmación**
  previa. Se sincronizan junto al resto de ajustes.
- **Comandos locales**: catálogo de acciones que se ejecutan en tu equipo —
  **ejecutar un comando** (con el shell del sistema), **abrir una URL** o **abrir
  un archivo o carpeta**— con confirmación opcional y las mismas sustituciones que
  los snippets. No se sincronizan, porque suelen depender de rutas locales.
- **Paleta de comandos global** (`Ctrl+Shift+P`): buscador difuso sobre perfiles
  (conectar), snippets (insertar), comandos locales (ejecutar) y acciones de la
  app (nueva conexión, nueva desde plantilla, consola local, preferencias).
  Navegación con flechas, `Enter` ejecuta y `Esc` cierra.
- **Plantillas de perfil**: al crear una conexión, un selector **«Plantilla»**
  rellena el formulario con valores por defecto (Linux SSH, SSH con clave, SSH con
  bastión, SSH heredado, RDP Windows, FTPS). Además puedes **marcar tus propios
  perfiles como plantilla** desde el menú contextual para reutilizarlos como base
  de nuevas conexiones.

## [1.28.1] - 2026-06-15

### Corregido

- **Salida masiva en terminal**: comandos muy verbosos como `cat` sobre logs de
  más de 1 MB ya no bloquean la interfaz. El terminal pasa a renderizarse por GPU
  (WebGL, con vuelta automática al modo DOM si no está disponible) y la salida
  SSH y de consola local se encola por sesión para drenarse hacia xterm en lotes
  acotados mediante su callback de escritura. La memoria pendiente está limitada:
  ante una ráfaga extrema se descarta lo más antiguo (avisándolo en pantalla) en
  lugar de dejar la WebView colgada. La consola local lee además en bloques
  mayores para emitir menos eventos hacia el frontend.
- **Nombres con «/» en el panel de ficheros**: crear o renombrar una carpeta o un
  archivo con «/» en el nombre (p. ej. `HOLA / MUNDO`) ya no genera por error una
  jerarquía de subcarpetas. El nombre se valida como un único componente y se
  avisa al usuario para que lo corrija.

## [1.28.0] - 2026-06-15

### Añadido

- **Selección granular de algoritmos legacy**: al activar **«Permitir cifrados /
  kex / MAC antiguos»** en las opciones avanzadas de un perfil SSH, se despliega
  una lista con casillas, agrupadas por categoría (**Cifrados**, **Intercambio
  de claves (KEX)**, **MAC** y **Claves de host**), para elegir exactamente qué
  algoritmos ofrecer en la negociación. El catálogo lo expone el backend (fuente
  única de verdad), de modo que lo que se muestra es lo que se negocia. Se añade
  además **`3des-cbc`** para servidores muy antiguos.

### Corregido

- **Conexión con servidores que solo aceptan MAC antiguas** (`hmac-sha1`): la
  opción legacy volvía a no ofrecer ningún MAC antiguo porque `russh` 0.61 dejó
  de incluir `hmac-sha1` en sus algoritmos por defecto. Ahora se ofrecen
  explícitamente `hmac-sha1` y `hmac-sha1-etm`, resolviendo el error
  *«No common Mac algorithm»*.
- **Doble clic en una conexión ya abierta**: ahora abre siempre una sesión
  nueva, en lugar de limitarse a activar la pestaña existente.
- **Hueco entre el terminal y la barra de estado** con la ventana sin
  maximizar: el terminal se alinea al fondo, de modo que el sobrante de fila
  parcial de xterm queda arriba y la última línea queda pegada al pie.

## [1.27.1] - 2026-06-11

### Añadido

- **Arrastrar ficheros del sistema al panel SFTP remoto**: ahora se pueden
  arrastrar archivos o carpetas desde el explorador del sistema operativo y
  soltarlos sobre el panel **Remoto** del SFTP para subirlos al directorio
  remoto actual. Soltarlos sobre el panel es el gesto explícito; si se sueltan
  fuera de un panel remoto conectado no ocurre nada. Reutiliza la cola de
  transferencias, los conflictos y la verificación de tamaño existentes.
- **Orden manual de carpetas**: con el orden de la barra lateral en «Manual»,
  el menú contextual de una carpeta incluye **Mover arriba** / **Mover abajo**
  para reordenarla entre sus carpetas hermanas. Se suma al reordenado manual de
  conexiones, que ya existía en el menú contextual de cada máquina. El orden se
  guarda por contenedor y se sincroniza.

## [1.27.0] - 2026-06-11

### Añadido

- **Historial de comandos compartido entre pestañas** (opt-in): activable en
  Preferencias → Terminal. Cuando está activo, los comandos tecleados en
  cualquier sesión SSH o consola local se acumulan en un único historial
  compartido por todas las pestañas y reutilizable desde el editor multilínea
  (Ctrl+Shift+E), donde un botón despliega los comandos recientes para
  insertarlos. El historial se guarda en local y **no** se sincroniza en la
  nube.
- **Tamaño de la interfaz ajustable** desde Preferencias → Apariencia: control
  para escalar el rail, la barra lateral, las pestañas y los modales sin tocar
  el tamaño del terminal, además de los atajos `Ctrl+Alt` con `+` / `-` / `0`.

### Corregido

- **Exportar conexiones sin contraseñas**: el botón «Sin contraseñas» del
  diálogo de exportación no respondía por un error de ámbito en el modal de
  credenciales; ahora funciona y arregla también cualquier otra acción
  secundaria de esos diálogos.
- **Zoom de la interfaz**: el tamaño elegido se restablecía al 100 % cada vez
  que se guardaban las preferencias; ahora se conserva.

### Cambiado

- **Desplazamiento más fluido**: la rueda del ratón avanza de forma
  proporcional a su velocidad en el terminal (mayor sensibilidad de scroll) y
  en la lista de conexiones de la barra lateral, donde antes el scroll nativo
  se sentía lento y «atrancado».

## [1.26.1] - 2026-06-10

### Cambiado

- **Mantenimiento de dependencias Rust**: fusionados los PRs de Dependabot para
  `keepass` 0.13.8, `suppaftp` 8.0.4, `auto-launch` 0.6.0, `uuid` 1.23.3 y
  `russh` 0.61.2. La actualización de `suppaftp` corrige el estado interno de
  la conexión de datos FTP tras comandos rechazados por el servidor, y `russh`
  incorpora fixes de agente SSH y soporte de claves EC SEC1 con parámetros de
  dominio completos.

## [1.26.0] - 2026-06-10

### Añadido

- **Duplicar sesión con cambios**: nueva acción **Conectar con cambios…** en el
  menú contextual del perfil y **Duplicar con cambios…** en el de la pestaña
  (sesiones SSH). Un mini formulario prefijado con los valores del perfil
  permite cambiar usuario, puerto, carpeta inicial, bastion y autenticación
  (contraseña puntual, clave privada o agente SSH) solo para esa sesión: el
  perfil guardado no se modifica y nada se persiste en el keyring. Los cambios
  se reaplican al reconectar y la pestaña muestra el usuario alternativo.

### Corregido

- **Panel SFTP**: al cambiar la disposición (remoto a la izquierda/derecha) en
  Preferencias, las flechas de los botones de subir/descargar del divisor
  central no se invertían y apuntaban al lado equivocado.
- **Ventanas emergentes con fondo blanco**: las confirmaciones de eliminar
  conexión, borrar túnel guardado, restaurar copia de seguridad e instalar o
  abrir una actualización usaban diálogos nativos del sistema que ignoraban el
  tema de la app. Ahora usan los modales tematizados propios.

### Cambiado

- **Redimensionado del terminal más eficiente**: arrastrar la sidebar, el
  divisor SFTP o los splits ya no dispara una tormenta de avisos de tamaño al
  backend; el ajuste visual sigue siendo inmediato y el aviso se agrupa y
  deduplica por sesión. Además, cada pane observa su propio tamaño, por lo que
  el terminal se reajusta correctamente en cualquier cambio de layout.

## [1.25.1] - 2026-06-08

### Corregido

- **Usuarios adicionales**: el desplegable de origen de la contraseña no dejaba
  elegir **Credencial maestra** (volvía solo a «Propia del perfil»). Además, el
  usuario y su credencial se muestran ahora en la misma línea.
- **Sincronización**: dejaba una versión restaurable nueva en cada arranque
  aunque no hubiera cambios; ahora solo se archiva una versión cuando cambia el
  contenido real (los refrescos de marca de tiempo no cuentan).
- **Sincronización al iniciar**: si cambiabas de perfil o de workspace mientras
  sincronizaba, al terminar ya no revierte al que estaba activo al arrancar.

### Cambiado

- **Iconos de los menús contextuales** unificados a SVG, en lugar de la mezcla
  de emojis y glifos que se renderizaba distinto según el sistema operativo.

## [1.25.0] - 2026-06-08

### Añadido

- **Varios usuarios por conexión**: el formulario de conexión permite añadir
  identidades adicionales con el botón «Añadir otro usuario», cada una con su
  propia autenticación (contraseña, credencial maestra, clave SSH o agente). Al
  conectar se usa la principal; con clic derecho aparece **Conectar con otro
  usuario** para elegir una identidad alternativa. La sesión recuerda con qué
  usuario se conectó, de modo que **Ctrl+P** (pegar contraseña) pega la
  contraseña de ese usuario. Disponible en SSH, RDP y SFTP/FTP.
- **Conectar y restaurar pantalla anterior**: clic derecho sobre una conexión
  ofrece reconectar repintando lo que se vio en la última sesión (restauración
  **visual** del scrollback, no del proceso remoto). La captura se guarda en
  disco por perfil y puede desactivarse en **Preferencias → Terminal → Guardar
  pantalla para restaurar**. No se sincroniza.

## [1.24.1] - 2026-06-05

### Añadido

- **Actualización automática también en Linux (AppImage)**: las instalaciones
  AppImage ya pueden descargarse e instalar la nueva versión desde dentro de la
  app, igual que en Windows y macOS. El resto de formatos de Linux
  (deb/rpm/Flatpak/Arch) siguen actualizándose por el gestor de paquetes y
  muestran el aviso con la página de descargas.

## [1.24.0] - 2026-06-05

### Añadido

- **Actualización automática (Windows y macOS)**: Rustty puede descargar e
  instalar la nueva versión y reiniciarse desde dentro de la app, sin volver a
  ejecutar el instalador. Disponible en **Preferencias → Acerca de → Comprobar
  actualizaciones** (y al iniciar, si está activado). En Linux se mantiene el
  aviso que abre la página de descargas.

### Cambiado

- **Actualizar en Windows**: el instalador **`.msi`** queda recomendado para
  actualizar (hace la actualización in-place); el `.exe` (NSIS) sigue mostrando
  la página "Already Installed", donde "Uninstall before installing" es la opción
  segura y conserva tus datos. Documentado en la guía de instalación.
- Dependencias del importador de Ásbrú actualizadas (`md-5` 0.11, `blowfish`
  0.10) con la migración del cifrado Blowfish-CBC a la API cipher 0.5.

## [1.23.1] - 2026-06-05

### Corregido

- **Sincronización en equipos recién instalados**: una instalación nueva marcaba
  su bundle de preferencias con la fecha actual al inicializarse, de modo que en
  el primer sync podía **ganar el merge** (last-write-wins) frente al remoto y
  **descartar los workspaces, carpetas y favoritos** sincronizados — e incluso
  pisarlos en el almacenamiento remoto. Los perfiles sí bajaban, pero quedaban
  colgando de "default". Ahora un equipo nuevo nunca gana ese merge en el primer
  sync y adopta correctamente la configuración remota.
- **Red de seguridad de workspaces**: si un perfil referencia un workspace que no
  existe en la lista local (p. ej. tras un sync incompleto), se reconstruye una
  entrada de respaldo para que la conexión no quede colgando de "default".

## [1.23.0] - 2026-06-04

### Añadido

- **Notas Markdown por conexión (runbooks)**: clic derecho sobre una conexión →
  "Añadir/Editar nota" abre un editor Markdown con previsualización en vivo,
  toolbar, título y tags. Cada nota se guarda como un archivo `.md`
  autocontenido (con frontmatter) en `notes/<id>.md`, se sincroniza (opt-in
  **Notas**, activo por defecto) y resuelve variables `${host}/${user}/…` en el
  preview. Las conexiones con nota muestran un badge `📝`, la búsqueda de la
  barra lateral indexa título/tags/contenido, y cada sesión SSH/SFTP tiene un
  **panel runbook** lateral con la nota renderizada y casillas de tarea
  interactivas que se guardan en el `.md`. Atajo `Ctrl+Shift+N`.

## [1.22.0] - 2026-06-04

### Añadido

- **Iniciar Rustty con el sistema**: nueva pestaña **Preferencias → Sistema** con
  las opciones "Iniciar Rustty con el sistema" y "Arrancar minimizado" (opt-in,
  desactivadas por defecto). Con "minimizado" la app arranca en la bandeja sin
  abrir la ventana, ideal para el quick launcher.
- **Editor multilínea de comandos** (`Ctrl+Shift+E`): hoja flotante para
  redactar comandos largos y enviarlos a la sesión activa (SSH o consola local).
  Guarda un borrador por perfil y lo restaura al reabrir. `Ctrl+Enter` inserta,
  `Esc` cierra conservando el borrador.
- **Sesión privada / efímera**: acción "Abrir en privado" en el menú contextual
  de un perfil. La sesión no deja rastro: no se guarda en recientes, no registra
  detalle en el centro de actividad, no guarda borrador y desactiva la grabación
  de sesión. La pestaña muestra un distintivo de sesión privada.
- **Aviso de proceso activo al cerrar una consola local**: si la consola está
  ejecutando un proceso (p. ej. `vim`, `top`, una compilación), Rustty pide
  confirmación antes de cerrar la pestaña; una consola inactiva se cierra sin
  preguntar.

### Cambiado

- **Preferencias → Estética** se integra dentro de **Preferencias → FTP/SFTP**:
  la opción "Disposición del panel SFTP" deja de tener pestaña propia.
- **`Ctrl+P` (pegar contraseña) endurecido**: solo se envía a una sesión SSH
  realmente conectada y queda bloqueado mientras el broadcast está activo, para
  no difundir el secreto a varias sesiones.
- **Zoom del terminal con `Ctrl+rueda` / `Ctrl±`**: ahora muestra un indicador
  con el tamaño en píxeles y el porcentaje respecto al tamaño por defecto, que
  se resalta al volver al 100 %.

### Corregido

- **Importar datos de otros programas**: el desplegable de origen no mostraba la
  opción de **Ásbrú Connection Manager** porque la lista quedaba oculta tras el
  modal; ahora se ve correctamente.
- **Abrir carpeta de logs de sesión**: corregido el error "Not allowed to open
  path" al pulsar "Abrir carpeta" en Preferencias → Copias de seguridad.

## [1.21.0] - 2026-06-03

### Añadido

- **Importador de Ásbrú Connection Manager**: el asistente de importación admite
  ahora ficheros `.yml` de **Ásbrú** además de los `.xml` de mRemoteNG.
  Reconstruye el árbol de carpetas, importa las conexiones SSH/RDP y, de forma
  opcional, descifra las contraseñas guardadas (Blowfish + KDF de OpenSSL, sin
  necesidad de introducir contraseña maestra). El parseo del YAML y el descifrado
  se hacen en el backend.
- **Barra de progreso en el importador**: al volcar las conexiones, el asistente
  muestra un porcentaje dinámico y un contador («N de M conexiones importadas»),
  útil sobre todo con catálogos grandes.

### Cambiado

- El botón de importación de terceros se reorganiza en su propia sección de
  **Preferencias → Copias de seguridad** y pasa a llamarse **Importar datos de
  otros programas…**, que abre el asistente con el selector de origen
  (mRemoteNG / Ásbrú).

### Corregido

- Los controles de ventana (minimizar / maximizar / cerrar) y el botón de
  pestañas desbordadas ya no se desplazan al abrir muchas pestañas: ahora solo la
  tira de pestañas hace scroll horizontal y los controles quedan fijos a la
  derecha.

## [1.20.0] - 2026-06-03

### Añadido

- **Importador desde mRemoteNG**: nuevo asistente por pasos en **Preferencias →
  Copias de seguridad → Importar desde mRemoteNG…** que lee un export `.xml`,
  reconstruye el árbol de carpetas y crea las conexiones (SSH y RDP) en un
  perfil-contenedor nuevo. Permite elegir qué importar (por protocolo y por
  nodo) y, opcionalmente, descifrar e importar las contraseñas guardadas con la
  contraseña maestra de mRemoteNG. Todo el proceso es local.
- **Transferencias SFTP simultáneas configurables**: nueva opción en
  **Preferencias → FTP/SFTP** para fijar el número de peticiones SFTP en
  paralelo por transferencia (por defecto 4, rango 1–64). Bajarla evita el error
  `Handle limit reached` en servidores con SFTP restringido como el Storage Box
  de Hetzner; subirla exprime más velocidad en redes con latencia alta.

### Cambiado

- **Buscador del panel SFTP plegable**: la caja de búsqueda de cada lado deja de
  estar siempre visible. Ahora se abre con un botón de lupa (icono SVG) en la
  toolbar y se pliega al volver a pulsarlo o con `Esc`.

## [1.19.2] - 2026-06-03

### Cambiado

- Se revierte el logotipo SVG del dashboard introducido en 1.18.0 (no se parecía
  a un cangrejo) y se vuelve al emoji 🦀.

## [1.19.1] - 2026-06-03

### Corregido

- Al crear o editar una conexión, pulsar **Intro** ahora **guarda** sin conectar
  (antes guardaba y conectaba). «Guardar y conectar» sigue disponible como botón
  explícito.

## [1.19.0] - 2026-06-03

### Añadido

- Las **variables de texto** (`${var:nombre}`) y las variables de entorno
  (`${env:VAR}`) se resuelven ahora también en los campos **host**, **usuario** y
  **bastion** de un perfil al conectar (además de en la contraseña). Permite,
  por ejemplo, completar un host con `servidor.${var:dominio}`.

### Cambiado

- **Rediseño de Preferencias → Credenciales**: cada fila muestra el nombre, el
  tipo y la descripción en una línea, con «Editar» y «Eliminar» siempre dentro
  del recuadro; la variable (`${master:…}` / `${var:…}`) ocupa su propia línea,
  se ve completa y **se copia al portapapeles al pulsarla**.
- La sección de credenciales se simplifica a **Maestras** y **Variables**; se
  retira la categoría «Secretos» de la interfaz.

## [1.18.0] - 2026-06-03

### Añadido

- **Conexiones fijadas en el dashboard**: los *tiles* anclados muestran ahora la
  franja de color de la carpeta del perfil y, en perfiles SSH, un botón
  secundario para abrir directamente el panel SFTP.
- **Preferencias → FTP/SFTP**: nueva sección que agrupa las opciones de
  transferencia de ficheros (política de conflictos y verificación de tamaño),
  antes repartidas en la pestaña Terminal.
- **Preferencias → Estética**: nueva sección para ajustar la disposición del
  panel de ficheros, con la opción de mostrar el panel **remoto a la izquierda o
  a la derecha**.

### Cambiado

- **Panel SFTP**: el botón de cerrar se ha movido a una cabecera superior que
  engloba los paneles local y remoto, en lugar de ir junto a «nueva carpeta» y
  «nuevo archivo» (donde se confundía con un botón de eliminar). Es neutro y
  solo se resalta en rojo al pasar el ratón.
- Los botones de **nueva carpeta** y **nuevo archivo** del panel SFTP usan
  ahora iconos propios (carpeta con «+» y documento con «+») en lugar de glifos.
- El logotipo del dashboard de bienvenida es ahora un **SVG propio** (un
  cangrejo monocromo que sigue el color del tema) en vez de un emoji.

## [1.17.2] - 2026-06-03

### Corregido

- En la búsqueda de la barra lateral, al pulsar un resultado el filtro se
  borraba en el primer clic y re-renderizaba la lista, lo que impedía el doble
  clic para conectar. Ahora, mientras interactúas con los resultados, el
  popover de búsqueda y el filtro se mantienen; se cierran y limpian al conectar
  o al hacer clic fuera de la lista.

## [1.17.1] - 2026-06-03

### Corregido

- El editor de credenciales maestras se mostraba al pie de la pantalla
  principal en lugar de superpuesto y centrado sobre Preferencias: a los
  modales de credenciales, gestor de `known_hosts` y preguntas `${ask:}` les
  faltaba el posicionamiento de overlay. Ahora aparecen centrados y por encima
  del resto de la interfaz.
- El icono de la pestaña **Credenciales** usaba un emoji a color; ahora es un
  glifo monocromo coherente con el resto de iconos de Preferencias (se atenúa y
  se resalta en azul al activarse como los demás).

## [1.17.0] - 2026-06-02

### Añadido

- **Credenciales maestras y motor de variables**: una contraseña o token
  reutilizable se define una sola vez en **Preferencias → Credenciales** y se
  referencia desde cualquier perfil como `${master:nombre}`. Al rotar su valor,
  todos los perfiles que la usan quedan actualizados sin tocarlos uno a uno. El
  valor se guarda exclusivamente en el keyring del sistema; el perfil solo
  guarda la referencia.
- **Origen de la contraseña por perfil**: el formulario de conexión incluye un
  selector «Contraseña propia / Credencial maestra / KeePass». Los perfiles
  KeePass existentes se migran de forma transparente.
- **Motor de sustitución `${...}`**: además de `${master:nombre}`, se resuelven
  variables internas (`${host}`, `${port}`, `${user}`, `${date}`…), de entorno
  (`${env:VAR}`), variables de texto (`${var:nombre}`), secretos
  (`${secret:nombre}`) y preguntas al conectar (`${ask:Etiqueta|op1|op2}`), que
  se piden una vez al abrir la sesión y no se persisten.
- **Editor de variables y secretos**: la sección Credenciales gestiona los tres
  tipos (maestras, variables de texto y secretos), con copia de la referencia y
  borrado seguro que avisa si algún perfil la usa.
- **Promover a credencial maestra**: acción en el menú contextual de un perfil
  que convierte su contraseña propia en una credencial maestra reutilizable.
- **Sincronización de credenciales**: los metadatos del catálogo viajan en la
  copia cifrada E2E; los valores de maestras y secretos solo si activas la
  opción de incluir secretos, igual que las contraseñas de perfil.

### Seguridad

- Los valores de credenciales maestras y secretos nunca se escriben en
  `profiles.json`, en exports sin cifrar ni en los logs de sesión; se resuelven
  en el backend en el momento de conectar y se redactan de forma defensiva en
  los mensajes de error de conexión.

## [1.16.0] - 2026-06-02

### Añadido

- **Wake On LAN en la bandeja del sistema**: submenú «Wake On LAN» que lista los
  perfiles con dirección MAC configurada y permite despertarlos directamente
  desde el tray, reutilizando el mismo flujo que el menú contextual.
- **Aviso al activar agent forwarding**: el formulario de conexión muestra una
  advertencia junto al toggle y pide confirmación al habilitarlo, recordando que
  un host comprometido podría usar tu agente SSH para saltar a otros equipos.
- **Gestor visual de `known_hosts`**: nuevo apartado en Preferencias → Copias de
  seguridad que lista las huellas registradas (host, puerto, algoritmo y huella
  SHA256) y permite eliminar entradas conflictivas con confirmación, sin tocar
  `~/.ssh/known_hosts` a mano.
- **Retención de logs de sesión**: bloque «Logs de sesión» en Preferencias con
  el número y tamaño de los registros, límites configurables por edad y tamaño,
  botón «Limpiar ahora», acceso rápido a la carpeta y aviso de contenido
  sensible.
- **Menú de overflow de pestañas**: cuando las pestañas no caben aparece un
  botón `⋯` que abre un buscador con todas las sesiones abiertas (nombre, host y
  estado), navegable por teclado; la pestaña activa se mantiene siempre visible.
- **Timeline del centro de actividad**: los eventos se agrupan por día (Hoy,
  Ayer, Esta semana y fechas anteriores) con cabeceras fijas, reduciendo el
  ruido cuando hay muchos elementos.
- **Búsqueda de ficheros en el panel SFTP**: caja de búsqueda por lado para
  filtrar el directorio actual y, opcionalmente, buscar de forma recursiva con
  cancelación y límites, independiente del autocompletado de rutas.
- **Importación ampliada de `~/.ssh/config`**: se resuelven directivas `Include`,
  `IdentityAgent`, keepalives (`ServerAliveInterval`) y reenvíos de puertos
  (`LocalForward`/`RemoteForward`/`DynamicForward`), se listan las directivas no
  soportadas y se muestra un resumen con los cambios (nuevos / a actualizar /
  sin cambios) antes de aplicar, actualizando perfiles existentes sin duplicar.

### Cambiado

- **Arranque sin parpadeo**: la ventana principal arranca oculta y se muestra
  tras restaurar su estado y completar el primer pintado, evitando el flash
  blanco/sin estilos al iniciar.
- Los toasts de transferencias, sincronización y errores se agrupan por
  categoría: un único toast por categoría con un contador «+N más» en lugar de
  una avalancha de notificaciones.

## [1.15.0] - 2026-06-02

### Añadido

- El directorio remoto de la barra inferior es ahora un **breadcrumb
  clicable**: pulsar un segmento lleva el panel SFTP a esa carpeta (lo abre si
  hace falta), el icono 📂 copia la ruta completa y `Ctrl/Cmd+clic` copia la
  ruta acumulada del segmento. Normaliza rutas POSIX, `~` y unidades de Windows.
- Workflow de integración continua (`ci.yml`) separado del release: valida
  cada pull request y push a `main` con `npm run build`, `cargo check`,
  `cargo test` y `cargo clippy` (de momento informativo), más comprobaciones de
  regresión en Windows y macOS. Cierra el hueco de los PR de dependencias que
  antes se fusionaban sin validación automática.

### Corregido

- El fondo del terminal usa esquinas rectas para cubrir el panel por completo:
  ya no asoma el color de la interfaz por las esquinas redondeadas.

### Mantenimiento

- Dependencias actualizadas: `keepass` 0.13.7, `uuid` 1.23.2, `socket2` 0.6.4,
  `rpassword` 7.5.4 y `vite` 8.0.16.

## [1.14.0] - 2026-06-02

### Añadido

- Acción global «Desconectar todo» como botón de emergencia en el rail y como
  atajo configurable: confirma con el número de sesiones y transferencias
  afectadas, cancela las transferencias SFTP en curso, cierra los túneles y
  desconecta todas las sesiones SSH, SFTP, RDP y consolas locales.
- Alias temporal de pestaña: renombrar una pestaña desde su menú contextual
  sin tocar el perfil. El alias vive solo en la sesión y se restablece al
  nombre del perfil al dejar el campo vacío.
- README en inglés (`README.en.md`) con enlaces de cambio de idioma desde y
  hacia el README en español.
- Política de seguridad (`SECURITY.md`) con el canal de reporte privado, las
  versiones soportadas y el modelo de seguridad del proyecto.
- Configuración de Dependabot (npm, Cargo y GitHub Actions) y plantillas de
  issues y pull request con checklist de pruebas y aviso de redacción de datos
  sensibles.

### Cambiado

- Los enlaces detectados en el terminal se validan antes de abrirse: solo se
  abren directamente los esquemas `http`, `https` y `mailto`; cualquier otro
  pide confirmación, evitando que la salida remota abra esquemas arbitrarios.
- El pegado en el terminal pide confirmación con previsualización cuando el
  texto es multilínea, muy largo o contiene caracteres de control. Es
  configurable de forma global y se puede desactivar por perfil.

### Corregido

- El fondo del terminal ahora cubre todo el panel: desaparecen las franjas del
  color de la interfaz que asomaban en los bordes y bajo la barra de estado.
- Se elimina el parpadeo de temas al arrancar: la interfaz aplica el tema
  guardado antes del primer pintado y se revela cuando los temas están listos.

## [1.13.0] - 2026-06-01

### Añadido

- Exportar el historial de una sesión a un fichero de texto desde el menú
  contextual de la pestaña. Vuelca todo el buffer del terminal (scrollback
  incluido) con los comandos introducidos y la salida del servidor en texto
  plano. La opción no aparece en sesiones RDP.
- Atajos `Ctrl/Cmd+1…9` para saltar directamente a una pestaña (el 9 va a la
  última). La pestaña activa se desplaza a la vista automáticamente cuando la
  barra de pestañas desborda en horizontal.

### Cambiado

- La traducción al alemán pasa a estar completa: antes solo cubría unas pocas
  secciones y el resto de la interfaz recurría al inglés.

## [1.12.5] - 2026-05-30

### Cambiado

- La carpeta raíz de cada perfil también admite un color desde su menú
  contextual. El tono se refleja en el árbol global, la cabecera de la sidebar
  y el selector de perfiles, y viaja con la sincronización de preferencias.

## [1.12.4] - 2026-05-30

### Cambiado

- Las carpetas y subcarpetas de perfiles dejan de usar el emoji del sistema.
  La sidebar renderiza un SVG propio de Rustty y el color elegido desde el
  menú contextual se aplica al icono, además de mantener la franja lateral
  discreta como apoyo visual. Los colores quedan aislados por workspace para
  que carpetas con la misma ruta no se afecten entre sí.

## [1.12.3] - 2026-05-30

### Corregido

- Los buscadores de conexiones del inicio y de la sidebar recorren ahora todos
  los workspaces cuando hay texto escrito. La sidebar muestra una lista plana
  de coincidencias globales durante la búsqueda y restaura el árbol anterior
  al limpiar el campo, evitando que perfiles existentes queden invisibles por
  la vista o el workspace activo. Preferencias → Apariencia incorpora el check
  "Buscar conexiones en todos los workspaces", activado por defecto, para
  limitar ambos buscadores al workspace activo cuando se desmarca.

## [1.12.2] - 2026-05-28

### Añadido

- Sidebar: nuevo toggle "📁 Carpetas primero" en el popover de filtros,
  habilitado por defecto. Las carpetas se pintan antes que las conexiones
  dentro de cada workspace y cada subcarpeta, manteniendo el orden interno
  (alfabético o manual). Persistido en `prefs.foldersFirst` y sincronizado.
- Buscador de la sidebar: `Esc` limpia el texto y la lista filtrada en el
  acto; un segundo `Esc` cierra el popover. Cerrar el popover de búsqueda
  por cualquier vía descarta el filtro para que la lista no quede
  "enganchada". El atajo es reasignable desde Preferencias → Atajos como
  `clear_sidebar_search`.
- Duplicar conexión también copia la contraseña y la passphrase guardadas
  en el keyring del perfil original al nuevo perfil. Antes solo se
  copiaban las referencias (KeePass, clave, auth_type) y había que
  volver a guardar el secreto a mano.

### Corregido

- Sidebar: al cerrarse una sesión SSH remotamente, la conexión deja de
  mostrarse en verde y con sombreado azul fuerte. Las sesiones con
  status `closed` ya no contribuyen al estado "abierta" ni a "pestaña
  activa" para fines de coloreado, así que la entrada vuelve al aspecto
  neutro inmediatamente.

## [1.12.1] - 2026-05-28

### Arreglado

- Bloqueo "Rustty no responde" al abrir SFTP dentro de una sesión SSH.
  Cada evento `sftp-log-*` reconstruía el centro de actividad completo y
  reescribía el historial en `localStorage`; ahora `renderActivityCenter`
  hace early-return si el overlay está oculto y `persistActivityHistory`
  tiene debounce de 250 ms para colapsar ráfagas.
- Bloqueo al escribir en el input de ruta del lado Local del panel SFTP.
  `local_list_dir` era síncrono y bloqueaba el hilo principal en
  directorios grandes (`node_modules`, `/usr/lib`); ahora corre en
  `spawn_blocking`.
- Autocompletado de rutas SFTP: seleccionar una entrada (clic o flecha +
  Enter) navega al directorio en el acto en lugar de exigir un Enter
  extra.
- Panel SFTP: la selección múltiple acepta también `Alt + Clic` además de
  `Ctrl/Cmd + Clic`.
- Hook OSC 7 (CWD): la línea de configuración ya no contamina el
  historial del shell remoto. En bash se borra con `history -d` aunque
  no haya `HISTCONTROL=ignorespace`; en zsh activa `HIST_IGNORE_SPACE`
  en la propia sesión SSH.

### Cambiado

- Sidebar: el sombreado azul intenso queda reservado para la conexión
  cuya pestaña está activa. Las demás conexiones abiertas muestran un
  indicador tenue (`is-open`) y los estados `connecting`,
  `reconnecting` y `error` se pintan en amarillo/rojo.

## [1.12.0] - 2026-05-27

### Añadido

- Panel SFTP: autocompletado de rutas en los inputs Local y Remoto.
  `Tab` completa al prefijo común; mientras se escribe aparece un
  desplegable con sugerencias navegable con flechas/`Enter`.
- Panel SFTP: botón "Nuevo archivo" en la barra de herramientas y en
  el menú contextual, junto a "Nueva carpeta". Nuevos comandos
  `sftp_create_file` y `local_create_file` (fallan si el archivo
  existe para no sobrescribir contenido).
- Icono de mostrar/ocultar contraseña del formulario de conexión
  reemplazado por un par ojo abierto / ojo tachado en SVG.

### Arreglado

- Panel SFTP: el botón ⇅ de la pestaña cierra ahora el panel aunque
  la sesión SSH ya no esté conectada.
- Panel SFTP: cuando la conexión SSH se cierra, el panel se cierra
  automáticamente en lugar de quedar huérfano.
- Panel SFTP: botón ✕ del toolbar reestilizado en rojo para que sea
  inmediatamente identificable como acción de cierre.

## [1.11.0] - 2026-05-27

### Añadido

- Selector avanzado de entradas KeePass: buscador con columnas
  (grupo · título · usuario · URL), sección de recientes persistida y
  filtrado por título/usuario/URL/grupo, en sustitución del `<select>`
  plano del formulario de conexión.
- Referencias KeePass por propiedad: el perfil puede usar
  `password`, `username`, `title`, `url` o `notes` de una entrada como
  valor; el valor se resuelve en el momento de conectar contra la base
  desbloqueada. Nuevo comando Tauri `keepass_get_property`.
- Formulario de conexión: el bloque Usuario/Contraseña ahora se muestra
  agrupado bajo el selector "Autenticación".

### Cambiado

- Actualizada la pila de dependencias Rust: `russh 0.50 → 0.61`,
  `russh-sftp 2 → 2.3`, `keepass 0.10 → 0.13`, `age 0.10 → 0.11`,
  `socket2 0.5 → 0.6`. La actualización de russh corrige el cuelgue
  de transferencias SFTP grandes al cruzar el límite de rekey de 1 GiB.

## [1.10.4] - 2026-05-27

### Añadido

- Zoom de la UI independiente del terminal con `Ctrl+Alt +/-/0`
  (`prefs.uiZoom`, escala el rail, sidebar y tab-bar sin tocar el buffer xterm).
- Toasts apilados: solo se muestran los últimos 3 y aparece un contador
  "+N más" que abre el centro de actividad para ver el histórico.
- Conexiones ancladas al dashboard (tiles grandes en el welcome screen,
  acción "Anclar / desanclar del dashboard" en el menú contextual).
- Centro de actividad agrupado por día (Hoy, Ayer, Esta semana, fecha
  absoluta) con headers sticky.
- Preview real de los temas en la galería: mini terminal con líneas de
  prompt, comando y salida pintadas con la paleta xterm del tema.
- Tarjetas de backend en Preferencias → Copias de seguridad con icono,
  estado y última sync relativa.
- Atajo `Ctrl+Shift+R` para reconectar la sesión activa.
- Orden de conexiones en la sidebar: alfabético (por defecto) y manual
  con flechas "Mover arriba / Mover abajo" en el menú contextual y
  persistencia por workspace + carpeta.
- Unificada la pestaña Autenticación dentro de General en el modal de
  conexión (tres pestañas en lugar de cuatro: General, Avanzado, Notas).
- SVG propio del logo en el footer del sitio (sustituye el emoji).

### Corregido

- Al renombrar workspace o carpeta ya no aparece el cuadro nativo
  "JavaScript - tauri://localhost"; se usa el modal interno temático.
- La franja blanca entre la sidebar y el terminal (scrollbar nativa de
  WebKit2GTK con tema claro del sistema) ahora respeta la paleta.
- El perfil activo en la sidebar se distingue con más claridad: franja
  izquierda más ancha con halo, fondo con más contraste y nombre en
  negrita.

### Cambiado

- El icono de Preferencias en el rail pasa a un engranaje claro (antes
  parecía un sol / toggle de tema).
- Eliminado el botón de Sincronización del rail (redundante con el dot
  inferior y la pestaña de Copias).
- El botón 🔍 de la sidebar abre el popover en modo compacto con solo
  el cuadro de búsqueda; el botón ≡ mantiene el popover completo.

## [1.10.3] - 2026-05-26

### Corregido

- Build del bundle Flatpak en CI: el manifest dejaba el `metainfo.xml` en
  `/app/share/metainfo/`, lo que hacía que `flatpak-builder 1.2.2` (Ubuntu
  22.04) ejecutase `appstream-compose` automáticamente. Ese binario no está
  disponible en el sandbox `bwrap` de esa versión, así que el build fallaba.
  El metainfo se reincorporará cuando migremos a `org.flatpak.Builder` para
  Flathub-ready.

## [1.10.2] - 2026-05-26

### Añadido

- Paquete Flatpak (`Rustty-<ver>-x86_64.flatpak`) generado en CI sobre el
  binario ya compilado. Manifest mínimo en `packaging/flatpak/`. Pendiente
  de migrar a un build offline reproducible cuando se publique en Flathub.
- El botón de búsqueda de la sidebar abre el popover en modo compacto que
  solo muestra el campo de búsqueda; el botón ≡ sigue abriendo el popover
  completo con workspace y filtros.

### Cambiado

- La pestaña anclada de Inicio se compacta a su icono en cuanto hay otras
  pestañas abiertas y vuelve al tamaño normal al cerrar la última. Antes
  podía quedar un instante sin compactar al abrir la primera sesión.

### Eliminado

- El indicador global de sincronización junto a los controles de ventana
  (minimizar/maximizar/cerrar). El estado de sync sigue disponible en la
  parte inferior de la sidebar y en la pestaña Copias de seguridad.

## [1.10.1] - 2026-05-26

### Corregido

- Aviso real cuando cambia la host key del servidor: la detección anterior
  solo comparaba claves del mismo algoritmo, así que rotaciones de tipo
  `ssh-rsa` → `ssh-ed25519` se aprendían en silencio. Ahora `host_keys` mira
  todas las entradas del host y rechaza la conexión con un mensaje que
  incluye fingerprints previos y recibido.

### Cambiado

- El error de host key cambiada aparece como bloque rojo destacado en el
  terminal, overlay específico ("Host key cambiada") y toast persistente
  durante 12 s, en vez de un toast normal.
- Zoom del terminal con `Ctrl+Rueda`. Los atajos configurables (`Ctrl+=`,
  `Ctrl+-`, `Ctrl+0`) admiten también la variante `Ctrl+Shift+=` para que
  "Ctrl++" funcione en teclados US/ES sin reconfigurar.

## [1.10.0] - 2026-05-26

### Añadido

- Ligaduras tipográficas opcionales en el terminal (toggle en Preferencias →
  Terminal). Requiere una fuente con soporte (FiraCode, JetBrains Mono,
  Cascadia Code…) y se aplica a sesiones nuevas.
- Perfiles de atajos predefinidos en Preferencias → Atajos: *Por defecto*,
  *Vim-like* (HJKL bajo `Ctrl+Alt`) y *Tmux-like* (combinaciones `Alt+letra`
  inspiradas en el prefix `C-b`). Aplicar uno sobreescribe el mapa actual con
  confirmación previa.
- Botón de búsqueda con icono de lupa en la cabecera de la sidebar, al lado
  del botón ≡. Abre el popover y enfoca el buscador (equivalente a `Ctrl+K`).

### Cambiado

- Confirmaciones de borrado destructivo con varios elementos (workspace o
  carpeta con perfiles dentro) piden teclear el nombre exacto antes de
  habilitar el botón rojo. Borrados de un solo elemento siguen siendo un clic.
- Los indicadores de arrastrar y soltar de la sidebar, las pestañas y el panel
  SFTP comparten ahora los mismos tokens de color, grosor y opacidad.
- Dependencias `@tauri-apps/*` y `tauri` actualizadas a la última 2.x compatible.

## [1.7.1] - 2026-05-15

### Corregido

- Los temas Rustty v2 precargados vuelven a aplicar sus tokens de interfaz y
  terminal al seleccionarlos desde Preferencias -> Apariencia, en lugar de
  caer visualmente al tema oscuro por defecto.
- La vista previa del terminal respeta el tema de interfaz seleccionado en vivo
  cuando el terminal está configurado como "Igual que la interfaz".

## [1.7.0] - 2026-05-13

### Añadido

- Idioma alemán en Preferencias, con fallback de traducciones a inglés antes de español.
- Reglas de ejemplo para el resaltado por regex del terminal: errores, warnings, info, éxito y debug.
- Ordenación por tipo, nombre, tamaño y fecha en las listas local y remota del panel SFTP.

### Cambiado

- El botón secundario del modal de conexión pasa de "Solo guardar" a "Guardar".
- Los selectores de temas de Apariencia se muestran como desplegables buscables por nombre.
- El panel de logs SFTP usa una fila redimensionable del layout y ocupa correctamente el alto disponible.

## [1.6.0] - 2026-05-13

### Añadido

- Vista compacta opcional para listas largas de conexiones en la sidebar.
- Indicadores de actividad no leída en pestañas SSH y consolas locales.

### Cambiado

- Selector de temas más compacto y escaneable para bibliotecas amplias.
- La biblioteca ampliada de temas queda publicada desde `public/themes/bundled-themes.json`; se eliminan las copias JSON individuales versionadas en `docs/themes/bundled/`.

## [1.5.1] - 2026-05-13

### Añadido

- La documentación web incluye una página dedicada al CLI SSH con listado de perfiles, conexión interactiva, ejecución remota, `--tty`, códigos de salida y limitaciones.

## [1.5.0] - 2026-05-13

### Añadido

- La CLI SSH puede ejecutar comandos remotos sin abrir la GUI: `rustty -c <perfil> --exec "cmd"`, `rustty -c <perfil> -- cmd` o el alias breve `rustty -c <perfil> "cmd"`. También acepta `--tty` para solicitar pseudo-terminal y devuelve el código de salida remoto al proceso local.

## [1.4.0] - 2026-05-12

### Añadido

- **CLI SSH inicial**: `rustty -l` / `--list` lista conexiones SSH guardadas,
  `rustty -l --json` emite JSON y `rustty -c <nombre|id|ip|host>` /
  `--connect` abre una sesión SSH directamente en la terminal sin lanzar la
  interfaz gráfica.
- El CLI reutiliza los perfiles guardados, keyring, `known_hosts`, ProxyJump,
  keepalive, agent forwarding y la opción de algoritmos legacy configurada por
  perfil. Si falta un secreto en el keyring, lo pide en terminal sin eco.
- **Búsqueda global de conexiones**: `Ctrl+K` funciona desde cualquier vista,
  incluso dentro de una sesión abierta, enfocando la búsqueda de la sidebar.
- Menús contextuales en los paneles local/remoto del explorador SFTP para crear
  carpetas, subir/descargar, renombrar, eliminar, refrescar y cambiar permisos.
- Comandos backend para cambiar permisos en entradas SFTP y locales.

### Cambiado

- Los logs del panel SFTP se muestran en pestañas separadas de
  **Transferencias** y **Actividad**, pegadas a la parte inferior del panel y
  redimensionables hacia arriba con altura persistente.
- El centro global de actividad usa un icono más descriptivo y conserva su
  historial en `localStorage` entre reinicios.

### Corregido

- Las transferencias SFTP grandes ya no se cortan alrededor de 1 GiB: el canal
  SFTP aumenta el timeout de petición y evita chocar con la renegociación de
  claves por defecto de `russh`.

## [1.3.0] - 2026-05-10

### Cambiado

- **Pipelining SFTP**: las descargas y subidas mantienen 16 peticiones SFTP en
  vuelo simultáneamente con chunks de 256 KiB (el máximo del cliente
  `russh-sftp`). Antes el bucle era serie con buffer de 64 KiB, lo que limitaba
  la velocidad real a `chunk / RTT` (~5 MB/s con 12-15 ms de latencia). Ahora
  la transferencia satura el ancho de banda real de la conexión en lugar del
  producto chunk × RTT.
- El camino FTP/FTPS sube el buffer de 64 KiB a 256 KiB.

## [1.2.0] - 2026-05-10

### Añadido

- **Etapas de conexión SFTP visibles**: el backend emite `sftp-log-{sessionId}`
  por cada fase (`connect`, `host_key`, `auth`, `channel`, `subsystem`, `ready`)
  igual que ya hacía SSH. El frontend preasigna el `sessionId` antes de invocar
  `sftp_connect` para no perder eventos tempranos y los pinta en el panel
  ACTIVIDAD del SFTP.
- **Log de operaciones SFTP**: el panel registra en ACTIVIDAD las operaciones
  `mkdir`, renombrar, eliminar y errores de listado (Local y Remoto), además
  del inicio/fin de cada transferencia.
- **Confirmación al cerrar pestaña**: `Ctrl+W`, la `✕` de la pestaña y la
  acción "Cerrar" del menú contextual avisan si la conexión sigue viva o hay
  transferencias SFTP en curso. Las acciones "Cerrar todas / otras / a la
  derecha" preguntan una sola vez con el conteo de sesiones afectadas.

### Cambiado

- El bloque TRANSFERENCIAS / ACTIVIDAD del panel SFTP deja de empezar oculto:
  aparece nada más abrir el panel con placeholders ("Sin transferencias
  todavía", "Sin actividad todavía") y se mantiene visible mientras el panel
  exista. `min-height` y `max-height` ajustados para que siempre quede sitio
  legible aunque haya una transferencia en curso.

### Corregido

- El meta de la fila de error/cancelado usaba el tamaño total del fichero y la
  velocidad media calculada con ese total, dando lecturas absurdas cuando solo
  se habían transferido unos pocos MB. Ahora usa los bytes realmente movidos y
  añade en el detalle `(transferido de total)`.

## [1.1.2] - 2026-05-09

### Corregido

- Las transferencias del panel SFTP/FTP/FTPS ahora esperan las respuestas del
  worker en `spawn_blocking`, evitando bloquear el runtime de Tauri y permitiendo
  que los eventos de progreso actualicen porcentaje, velocidad y ETA durante la
  copia.
- La fila de transferencia se fuerza a pintarse antes de lanzar la operación
  larga, de modo que aparece inmediatamente en **Transferencias** aunque el
  servidor tarde en enviar el primer bloque.

## [1.1.1] - 2026-05-09

### Corregido

- Las operaciones del panel de ficheros SFTP/FTP/FTPS dejan de bloquear la
  WebView mientras esperan al backend. Las transferencias largas ya no deberían
  disparar el aviso del sistema de "Rustty no responde" antes de empezar a
  mostrar progreso.

## [1.1.0] - 2026-05-09

### Añadido

- **Perfiles FTP y FTPS**: el formulario de conexión permite crear perfiles
  `ftp` y `ftps`, con contraseña/KeePass/keyring, puerto 21 por defecto y
  apertura directa del explorador de ficheros local/remoto.
- **Backend de transferencia unificado**: el gestor de ficheros abstrae SFTP,
  FTP y FTPS tras un `trait FileTransfer`. FTP plano y FTPS explícito usan
  `suppaftp`; FTPS se cifra con `rustls` y raíces `webpki-roots`.
- **Biblioteca ampliada de temas Rustty v2**: 221 temas precargados aparecen
  directamente en Preferencias -> Apariencia y se publican en
  `public/themes/bundled-themes.json`.

### Cambiado

- El panel SFTP pasa a ser el panel común de ficheros para SFTP/FTP/FTPS,
  reutilizando árbol local/remoto, drag & drop, cola de transferencias,
  conflictos, progreso y logs.
- La documentación de arquitectura, memoria y temas refleja los nuevos backends
  de transferencia y la biblioteca de temas incluida.

## [1.0.2] - 2026-05-08

### Corregido

- Rustty deja de inyectar el hook OSC 7 al abrir una sesión SSH. El seguimiento
  de `cwd` remoto queda desactivado por defecto y solo se activa al pulsar
  **CWD** en el panel SFTP, evitando que shells restringidos o CLIs remotas
  impriman el comando de integración como `Command not found`.

## [1.0.1] - 2026-05-08

### Añadido

- **Test de conexión desde el modal**: el formulario de crear/editar conexión
  incorpora el botón **Probar**, que valida SSH sin guardar el perfil y reutiliza
  las mismas etapas de diagnóstico (`resolución`, `host key`, `autenticación`,
  `SFTP`). En RDP comprueba la conectividad TCP/latencia al puerto configurado.
- **Centro de actividad global**: nuevo acceso **☷** en el rail con eventos de
  conexiones, SFTP, sincronización, toasts y comprobación de actualizaciones.
  Incluye filtros, limpieza y acciones contextuales como ver logs o reintentar.

### Cambiado

- El diagnóstico de conexión deja de aparecer como una píldora flotante en la
  parte superior del terminal. Ahora vive en la barra de estado inferior: el
  punto verde/rojo y el mensaje de la derecha abren el detalle del log.
- La sincronización de arranque pasa a ser idempotente: si el estado lógico
  local/remoto coincide, no reescribe el blob cifrado ni crea snapshot histórico.

### Corregido

- La barra lateral recuerda entre reinicios qué carpetas/workspaces estaban
  abiertos, en lugar de arrancar siempre con todo el árbol cerrado.
- La construcción del estado de sincronización deja de fabricar cambios usando
  timestamps del momento de arranque cuando no existen marcas reales.

## [1.0.0] - 2026-05-08

### Añadido

- **Versión estable 1.0.0**: primer corte estable del cliente con SSH/SFTP/RDP,
  sincronización E2E, workspaces, favoritos, túneles, temas, atajos y paquetes
  multiplataforma.
- **Logs visibles de conexión**: cada sesión SSH muestra etapas y errores
  (`resolución`, `conexión TCP`, `host key`, `autenticación`, `shell`) sin
  depender de la consola de desarrollo.
- **Bandeja del sistema / quick launcher**: icono de tray con favoritos,
  recientes, workspaces, consola local y acciones para abrir/ocultar la ventana.

### Cambiado

- El frontend preasigna el `session_id` antes de conectar por SSH para registrar
  listeners de diagnóstico desde el primer evento emitido por el backend.
- Las builds Linux incorporan dependencias DBus necesarias para el backend
  persistente de Secret Service usado por el keyring.

### Corregido

- En Linux, las passphrases y secretos de sincronización del keyring pasan a
  guardarse de forma persistente mediante Secret Service. Las entradas antiguas
  disponibles solo en la sesión se migran automáticamente al leerlas.

## [0.6.3] - 2026-05-07

### Añadido

- El panel SFTP de una conexión SSH ahora se puede redimensionar desde un
  tirador superior, recuerda su altura y permite volver al tamaño por defecto
  con doble clic.
- El lanzador RDP en Windows es más robusto: busca `mstsc.exe` en rutas del
  sistema, valida salidas tempranas y añade fallbacks mediante `cmd start
  /WAIT` y URL `rdp://`.

### Cambiado

- La autosincronización tras cambios locales espera ahora 1 minuto antes de
  arrancar, para evitar competir con reorganizaciones largas de perfiles y
  carpetas.
- `sync-version` deja de tocar el README; `package.json` sigue siendo la fuente
  única y la web resuelve la última versión desde GitHub.

### Corregido

- Al terminar una sincronización ya no se repliega el árbol de carpetas que el
  usuario tenía abierto en la sidebar.
- La sincronización deja de aplicar estado local de navegación de otro equipo
  como workspace activo o modo de vista de la sidebar.

## [0.6.2] - 2026-05-06

### Añadido

- Selección múltiple de conexiones en la sidebar con Ctrl/Cmd y rangos con
  Shift, con movimiento en lote mediante drag and drop.

### Cambiado

- La autosincronización agrupa cambios durante 5 segundos antes de arrancar,
  evitando sincronizaciones intermedias al renombrar, mover o borrar varias
  carpetas seguidas.
- Los exports de conexiones incluyen `foldersByWorkspace` para conservar la
  pertenencia de carpetas al importar.

### Corregido

- Las acciones de carpeta preservan el workspace real del nodo seleccionado y
  solo modifican perfiles/conexiones de ese workspace.
- Crear, renombrar, mover, borrar, importar y exportar carpetas evita mezclar
  subcarpetas con el mismo nombre en otros perfiles/workspaces.

## [0.6.1] - 2026-05-06

### Corregido

- Al editar una conexión, Rustty recupera del keyring la contraseña o
  passphrase guardada y rellena el campo correspondiente, de modo que el botón
  de ver contraseña muestra el valor almacenado.

## [0.6.0] - 2026-05-06

### Añadido

- **Sincronización opcional de contraseñas guardadas**: la pestaña
  **Copias de seguridad** permite incluir contraseñas y passphrases del
  keyring en el `SyncState`. Viajan como items `secret:*` dentro del blob
  cifrado E2E con `age` y se restauran en el keyring local de otros equipos.
- **Exports con secretos bajo confirmación**: los exports JSON de conexiones,
  carpetas y workspaces preguntan antes de incluir contraseñas/passphrases.
  Al importar un JSON con `secrets`, Rustty pregunta si debe guardarlos en el
  keyring local.
- **Backups cifrados con secretos opcionales**: el export `.rustty-sync.bin`
  también pregunta si debe incluir credenciales guardadas.
- **Wake On LAN parcial por perfil**: campos MAC/broadcast/puerto, acción
  "Despertar equipo" desde el menú contextual y toasts con conectar/reintentar.
- **Validación de KeePass en el formulario**: el selector avisa si la base está
  bloqueada, si la entrada existe, qué usuario/título se usará y si contiene
  contraseña usable.

### Cambiado

- El formulario de conexión coloca **usuario y contraseña juntos** para reducir
  saltos visuales al crear perfiles SSH/RDP.
- Los checks de guardar contraseña/passphrase quedan marcados por defecto; el
  usuario puede desmarcarlos en cada caso.
- Los toasts de error genéricos incluyen la acción **Copiar error**; los casos
  específicos conservan acciones como "Ver log", "Reintentar" o "Conectar".
- SFTP gana cola visible, políticas de conflictos, logs de actividad, drag &
  drop local/remoto y verificación opcional de tamaño al terminar.
- Los atajos incorporan import/export, selección de pane, limpiar terminal y
  acciones configurables para abrir/cerrar SFTP, seguir CWD y alternar sudo.

## [0.4.5] - 2026-05-06

### Añadido

- **Túneles SSH globales**: nuevo acceso rápido `⇄` en el rail para crear,
  arrancar, detener y borrar túneles guardados sin tener que abrir primero el
  panel de túneles de una pestaña concreta. Si ya existe una sesión SSH activa
  del perfil, se reutiliza; si no, Rustty abre la conexión y arranca el túnel
  tras conectar.
- **Sincronización visual sidebar ↔ pestaña activa**: al cambiar de pestaña,
  la barra lateral selecciona automáticamente la conexión asociada, abre su
  carpeta y cambia al workspace correspondiente cuando hace falta.

### Cambiado

- **Acciones SFTP integradas con el tema**: crear carpeta, renombrar y borrar
  usan ahora el modal propio de Rustty en lugar de `prompt`/`confirm` nativos.
- **RDP en "Guardar y conectar"**: las conexiones RDP usan el flujo RDP real
  y reutilizan la contraseña escrita en el formulario aunque no se guarde en
  el keyring.

### Corregido

- **RDP externo**: en Windows se elimina el fichero `.rdp` temporal al cerrar
  o fallar la sesión, y en Linux el fallback `rdesktop` usa ahora argumentos
  compatibles con `rdesktop` en vez de opciones de FreeRDP.

## [0.4.2] – 2026-05-05

### Corregido

- **Credenciales bajo demanda**: los diálogos de contraseña y passphrase para
  SSH, RDP y SFTP usan ahora un modal propio integrado con el tema, eliminando
  el emergente nativo con título `JavaScript - tauri://localhost`.
- **Barra de estado de sesión**: al cerrar una pestaña se limpian el destino,
  la latencia y el indicador de estado si no queda una sesión SSH activa.

## [0.4.1] – 2026-05-05

### Corregido

- **Cierre de ventana en controles CSD**: el botón de cerrar ya no puede
  quedarse bloqueado esperando al guardado del estado de ventana. Ahora usa
  un timeout corto y un cierre backend de respaldo que limpia sesiones SSH,
  SFTP, shell local y RDP antes de salir.

## [0.4.0] – 2026-05-05

### Añadido

- **Túneles SSH con redirección de puertos** sobre sesiones activas:
  locales (`-L`), remotos (`-R`) y dinámicos / SOCKS (`-D`). Incluye panel
  por sesión con estado, tráfico y cierre individual, botón `⇄` en pestañas
  SSH, acción contextual "Nuevo túnel…" en perfiles, persistencia por perfil
  y autoconexión opcional.
- **Formato de temas v2**: los temas personalizados usan `formatVersion: 2`
  con tokens separados para UI y terminal. Se añadió exportación de plantilla
  desde Preferencias → Apariencia y documentación en `web/docs/Temas.md`.
- **Botón de ver / ocultar contraseña** en el modal de crear o editar
  conexión.
- **Portapapeles nativo de Tauri** para copiar/pegar texto del terminal,
  evitando limitaciones del WebView al pegar con clic derecho contenido
  copiado fuera de Rustty.

### Cambiado

- El modal de conexión ahora es **redimensionable** y recuerda su tamaño,
  pensado para rutas KeePass largas o formularios con muchas opciones.
- Los temas personalizados antiguos se sustituyen por el formato v2 sin capa
  de compatibilidad.

### Corregido

- **Restauración de tamaño y posición de ventana** al arrancar: el estado
  guardado por `tauri-plugin-window-state` se aplica explícitamente al abrir
  la ventana principal.
- **Pegar con botón derecho** funciona también con texto copiado desde fuera
  de Rustty.

## [0.3.0] – 2026-05-03

### Añadido

- **Barra lateral vertical de iconos** (`#rail`): franja izquierda fija de
  44 px con dos secciones — arriba 📁 Perfiles, ★ Favoritos, ⇅
  Sincronización y ⚙ Preferencias; abajo $_ Consola local y ＋ Nueva
  conexión. El icono activo refleja `prefs.sidebarViewMode`.
- **Drag & drop en la sidebar**: las conexiones y carpetas se pueden
  arrastrar entre carpetas, hacia la cabecera de un workspace o a la zona
  vacía (raíz). Bloquea destinos inválidos (carpeta dentro de sí misma o
  de un descendiente) y persiste en `profile.group` /
  `prefs.userFoldersByWorkspace`. Feedback visual con resaltado del
  `folder-header` y borde azul en la raíz.
- **Colores por carpeta**: paleta de 8 colores predefinidos + "Quitar
  color" en el menú contextual de la carpeta. Persistido en
  `prefs.folderColors[path]`, pintado como franja izquierda de 3 px en el
  `folder-header` (`--folder-tint`) y sincronizado como parte del bundle
  de prefs.
- **Exportar conexiones de una carpeta**: nueva opción
  "Exportar conexiones…" en el menú contextual de carpeta. Vuelca a JSON
  los perfiles de la carpeta y sus subcarpetas, sin contraseñas en claro.
- **Exportar conexiones de un workspace**: misma acción desde el menú
  contextual del nodo de workspace en la vista "Todos los perfiles".
- **Reconexión automática SSH**: campo `auto_reconnect` por perfil
  (0 – 20 reintentos). El backend reintenta con backoff exponencial
  (2s, 4s, 8s, …, 60s máx) y emite `ssh-reconnecting-{id}` con el número
  de intento. Se interrumpe si el usuario pulsa Disconnect durante el
  backoff.
- **Grabación de sesión**: toggle `session_log` por perfil. Vuelca toda
  la salida del shell SSH a `<data_dir>/session_logs/<perfil>-<timestamp>.log`
  (o a `session_log_dir` si se indica).

### Cambiado

- **Cabecera de la sidebar simplificada**: los botones ⚙, $_ y ＋ se
  mueven al rail vertical. La cabecera queda con logo + ≡ (popover de
  filtros y switcher de workspaces).
- **Icono "Filtrar / cambiar de perfil"**: ahora tiene el mismo tamaño
  que el resto de iconos del header (26×26).
- **Popover ≡ anclado bajo el botón**: antes se abría con `right: 8px`,
  fuera de eje respecto al trigger; ahora se posiciona dinámicamente bajo
  el botón con flip horizontal/vertical si no cabe en el viewport.

### Corregido

- **Detección de host key cambiada**: ya estaba cubierta por la
  verificación TOFU + `known_hosts` real introducida en versiones
  anteriores. Marcado como completado en `tareas.md`.

## [0.2.7] – 2026-05-02

### Añadido

- **Conexiones favoritas**: cada conexión puede marcarse como favorita con
  el botón estrella (☆/★) o desde el menú contextual, y se sincronizan en
  la nube con el resto de preferencias.
- **Vistas de la sidebar**: nuevo selector con los modos *Workspace actual*,
  *Todos los perfiles* (árbol agrupado por workspace) y *Favoritos*. Al
  cambiar de modo, la cabecera muestra el contexto activo en una barra fina.
- **Menú contextual sobre el nodo de un workspace** (en la vista *Todos los
  perfiles*): renombrar y eliminar el workspace sin tener que activarlo
  antes.

### Cambiado

- **Cabecera de la sidebar unificada**: el switcher de workspaces se
  sustituye por un único botón **≡** que abre un popover compacto con la
  vista activa, el switcher de workspaces y la búsqueda. La cabecera ya no
  ocupa dos filas.
- **Carpetas manuales por workspace**: cada workspace mantiene su propio
  conjunto de carpetas, en lugar de compartir una lista global. Las
  carpetas existentes se migran automáticamente al workspace activo en el
  primer arranque tras la actualización.
- **Sincronización en la nube**: el bundle de preferencias incluye ahora
  `userFoldersByWorkspace`, `workspaces`, `activeWorkspaceId`, `favorites`
  y `sidebarViewMode` para que el modo de vista, el workspace activo, las
  favoritas y el árbol por workspace viajen entre equipos.

## [0.2.6] – 2026-05-02

### Añadido

- **Perfiles-contenedor (workspaces)**: cada conexión guarda su `workspace_id`.
  El sidebar incluye un selector con las acciones Nuevo / Renombrar /
  Eliminar; la lista de perfiles, el dashboard y la búsqueda se filtran
  por el workspace activo, y el formulario de conexión muestra un selector
  de workspace cuando hay más de uno. Los workspaces viajan con la
  sincronización en la nube como parte del bundle de preferencias.

### Cambiado

- **Panel SFTP**: el panel remoto pasa a la izquierda y el local a la
  derecha; las flechas centrales se reordenan para apuntar visualmente al
  destino.
- **Formulario de conexión**: eliminado el checkbox "Seguir CWD del terminal
  en el panel SFTP" — el toggle está disponible en el propio panel SFTP
  mediante el botón "CWD".
- **Pantalla principal**: eliminadas las sombras de la barra de búsqueda
  y de las tarjetas para una apariencia más plana.

### Corregido

- **Doble clic en la topbar**: ya no se maximiza y restaura en cascada. Se
  delega completamente en el comportamiento nativo de
  `data-tauri-drag-region`, que ahora maximiza/restaura una sola vez.

### Traducciones

- Añadidas las cadenas del switcher de workspaces en español, inglés,
  francés y portugués.
- Completadas en francés y portugués las cadenas `search_placeholder` y
  `search_no_results` de la sidebar, que caían al fallback en español.

## [0.2.5] – 2026-05-02

### Añadido

- **Opciones avanzadas por perfil SSH**: keep-alive configurable, agent
  forwarding, X11 forwarding y opción para permitir cifrados / kex / MAC
  legacy (aes-cbc, dh-sha1, hmac-sha1, ssh-rsa) al conectar con servidores
  antiguos.
- **Panel SFTP con vista dividida local / remoto**, con toolbars
  independientes (path, ↑ up, ⌂ home, ⟳ refresh, ＋ mkdir), botones centrales
  de subir / descargar y transferencia recursiva de carpetas en ambos
  sentidos.
- **Búsqueda dentro del buffer del terminal** (Ctrl+F) con barra flotante,
  next/prev y toggle case-sensitive sobre `@xterm/addon-search`.
- **Búsqueda rápida en la lista de perfiles** desde la cabecera de la
  sidebar, filtrando por nombre, host, usuario y grupo.
- **Restauración de copias de seguridad** desde la pestaña Sincronización:
  desplegable con los snapshots disponibles en Carpeta local / NAS, WebDAV y
  Google Drive, descifrado y aplicación local con la misma rutina que
  `importFromFile`.

### Cambiado

- **Auto-sync sin temporizador**: la sincronización en la nube se dispara al
  iniciar y al detectar cambios locales (debounce 1.2 s); se elimina el
  intervalo periódico y la opción "Auto-sync Sí/No" de la UI.
- Mensajes de Preferencias actualizados para reflejar la nueva lógica de
  sincronización y de copias históricas.

### Seguridad

- Las opciones de algoritmos legacy y de forwarding son **opt-in por perfil**
  con avisos explícitos en la UI.
- El identificador de snapshot se valida contra el directorio histórico para
  evitar lecturas fuera de él (Local y WebDAV).

## [0.2.4] – 2026-05-01

- Preparación de release y ajustes menores antes del corte.

## [0.2.3] – 2026-05-01

- Mejoras de seguridad y de sincronización en la nube.

## [0.2.2] – 2026-04-29

- Rediseño de la pantalla principal y corrección de bugs.

## [0.2.0] – [0.2.1] – 2026-04-27

- Catálogo completo de 11 temas base (Catppuccin Mocha / Latte, Dracula,
  Nord, xterm clásico, VS Code Dark+, Tango, Solarized Dark / Light,
  Gruvbox Dark, Tokyo Night, Monokai).
- Editor de atajos en Preferencias y atajos globales configurables.
- Duplicar conexiones y duplicar sesiones activas desde el menú contextual.
- Drag handle para redimensionar la sidebar.

## [0.1.5] – [0.1.9] – 2026-04-26 / 2026-04-27

- Sincronización en la nube v1: Google Drive, iCloud Drive, Carpeta local /
  NAS y WebDAV con cifrado E2E (`age`).
- Empaquetado para Arch Linux (`pacman .pkg.tar.zst`) además de AppImage,
  `.deb` y `.rpm`.
- Toggle de la barra lateral con persistencia.

## [0.1.0] – [0.1.4] – 2026-04-19 / 2026-04-25

- Primer scaffolding Tauri 2 + Vite + Vanilla JS + Xterm.js 6.
- Gestor SSH interactivo, shell local con PTY y gestor RDP externo.
- Perfiles en JSON, credenciales en keyring del SO y soporte de KeePass.
- Migración del backend SSH/SFTP a `russh` + `russh-sftp` puro Rust.
- Modo portable real en Windows.
