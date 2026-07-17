# Scripts, snippets y comandos

Rustty ofrece tres niveles de automatización, de mayor a menor alcance: **scripts** (recetas de pasos que se ejecutan sobre una o varias conexiones SSH a la vez), **snippets remotos** (comandos guardados que se insertan en la terminal activa) y **comandos locales** (acciones en tu propio equipo). Todo sin convertir Rustty en un orquestador: la línea roja son recetas pequeñas y legibles, no un sustituto de Ansible.

## Scripts

Un script es una lista ordenada de pasos (enviar un comando, esperar a que termine, comprobar su código de salida, enviar una contraseña…) que Rustty ejecuta contra un objetivo: una conexión, una carpeta o una selección de conexiones. Solo funciona sobre perfiles **SSH**.

El botón **Scripts** del rail lateral abre el panel con la lista de scripts guardados. Desde ahí puedes crear un **Nuevo script**, consultar las **Ejecuciones recientes** (ver más abajo) y, sobre cada script: **Ejecutar**, **Editar**, **Duplicar**, **Exportar** como Markdown o **Eliminar**. También puedes lanzar uno directamente con clic derecho sobre una conexión SSH o una carpeta de la sidebar → **Ejecutar script…**: se abre un selector con tus scripts y el objetivo ya apuntando a esa conexión o carpeta (las carpetas incluyen sus subcarpetas).

### Editor

Cada script tiene **nombre**, **descripción** opcional (en Markdown) y un **objetivo** por defecto:

- **Una conexión**: un perfil SSH concreto.
- **Una carpeta**: todas las conexiones SSH de una carpeta de un workspace, con la casilla **Incluir subcarpetas**.
- **Selección de conexiones**: una lista de perfiles marcados a mano.

Debajo se define la lista de **pasos**, que puedes reordenar con las flechas o quitar. El máximo son **50 pasos** por script.

| Paso | Qué hace |
| ---- | -------- |
| **Enviar comando** | Envía el texto al shell remoto (con salto de línea). Admite variables `${...}`, incluidas `${ask:Etiqueta}`. |
| **Esperar fin de comando** | Espera a que termine el último comando enviado y captura su código de salida. Inyecta un marcador invisible con `printf`, así que necesita un shell tipo POSIX. Espera hasta 30 minutos. |
| **Esperar patrón (regex)** | Lee la salida hasta que casa con la expresión regular o vence el **timeout** en milisegundos (30 000 por defecto). Si vence, el host se marca en error. |
| **Comprobar código de salida** | Compara el exit code capturado por el último «Esperar fin de comando» con el valor esperado; si no coincide (o no hubo espera previa), el host falla. |
| **Enviar contraseña (keyring)** | Envía la contraseña guardada en el keyring: la de la propia conexión o la de otro perfil que elijas. Se envía oculta y nunca aparece en la salida. |
| **Enviar contraseña (KeePass)** | Envía la contraseña de una entrada KeePass por su UUID. Requiere la base desbloqueada. |
| **Pausa** | Espera los milisegundos indicados. |
| **Desconectar** | Cierra la sesión de ese host; los pasos posteriores ya no se ejecutan. Si el comando anterior todavía no ha terminado (un «Enviar comando» sin una «Espera» detrás), **espera a que acabe** antes de cerrar, para no cortarlo a mitad. |

El patrón típico es encadenar **Enviar comando** → **Esperar fin de comando** → **Comprobar código de salida**, y repetir. Para comandos interactivos (un `sudo` que pide contraseña, un instalador con prompt), combina **Esperar patrón (regex)** con los pasos de contraseña.

### Ejecutar sobre varios hosts

Al pulsar **Ejecutar**, si el script usa `${ask:...}`, Rustty pregunta esos valores una vez para toda la tirada. Después aparece el diálogo de opciones:

- **Modo**: **Paralelo** (todos los hosts a la vez, respetando la concurrencia) o **Canario (primero un host)**: se ejecuta un solo host y, solo si termina bien, arranca el resto.
- **Concurrencia**: cuántos hosts en vuelo a la vez, de 1 a 16 (4 por defecto).
- **Detener al primer error**: cuando un host falla, no se arrancan más hosts (los que ya están en marcha terminan).
- **Credenciales**: por defecto, **las de cada perfil**. Alternativamente puedes autenticar todos los hosts de la tirada con una **credencial maestra**, una **entrada KeePass** (con la base bloqueada la opción queda deshabilitada hasta desbloquearla; el usuario vacío usa el de la entrada) o un **usuario y contraseña manuales**, que solo viven en memoria durante la ejecución.

Antes de lanzar, la **previsualización por host** muestra los comandos que se enviarían a cada máquina, con los secretos ya redactados (`••••`). Es el momento de comprobar que las variables se resuelven como esperas.

Durante la ejecución, el panel muestra una fila por host con el paso en curso (`N/M`), un **registro de ejecución** (la línea de tiempo de fases y pasos: conexión establecida, cada paso con su comando, el resultado con la duración o el error) y la **salida** de los comandos con un contador de líneas. Con un solo host, registro y salida se abren desplegados. Puedes **Abortar** un host concreto o **Abortar todo**; la cancelación surte efecto entre pasos.

La salida sale ya limpia de las secuencias de control del terminal (colores, títulos de ventana, barras de progreso): no verás «caracteres raros» como `[?2004h`.

Cada host usa su **propia conexión SSH** (respetando ProxyJump, verificación de host key y el resto de opciones del perfil) y se cierra limpiamente al terminar, haya o no paso de desconexión.

### Copiar, exportar y reintentar

- **Copiar**: el registro y la salida se pueden seleccionar con el ratón, y cada host tiene un botón **Copiar** que lleva al portapapeles su registro más su salida.
- **Exportar .log**: en el pie de la ejecución, guarda en un fichero de texto el registro y la salida de todas las conexiones de la tirada.
- **Reintentar**: cuando la ejecución termina, si alguna conexión falló aparecen **Reintentar fallidos** (solo las que dieron error) y **Reintentar todo**. Relanzan la misma receta reutilizando el modo y las credenciales de la tirada anterior.

### Ejecuciones recientes

El botón **Ejecuciones recientes** del panel de Scripts abre el historial de las últimas tiradas guardadas en este equipo (hasta 30). De cada una puedes:

- **Reabrir** la ejecución en modo solo lectura para ver su registro y su salida.
- **Exportar .log** a un fichero.
- **Borrar historial** por completo.

El historial se guarda en `script_runs.json`, en el directorio de datos, con **permisos privados (0600)**. Contiene la salida ya redactada de secretos (`••••`) pero puede incluir salida normal de comandos, así que se protege como el resto de datos sensibles y **nunca guarda contraseñas**. No se sincroniza entre equipos.

### Grabar desde la sesión

Rustty permite generar scripts de forma interactiva a partir de las acciones reales que realizas en una terminal.

- **Cómo iniciar**: En el modal de **Scripts** (rail lateral → Scripts), pulsa el botón **Grabar desde la sesión…**. Se requiere tener una sesión SSH activa y conectada.
- **Interfaz de grabación**: Al iniciar, el modal se cierra y aparece una barra flotante en la parte inferior de la ventana con un contador de pasos grabados.
- **Flujo de captura**: Cada comando que escribas y ejecutes con `Intro` se registrará como un paso de tipo **Enviar comando**. Entre comandos, Rustty añade automáticamente un paso **Esperar fin de comando** (para detectar que el prompt remoto vuelve a estar disponible).
- **Seguridad y redacción de contraseñas (Heurística de eco apagado)**: Si ejecutas un comando que solicita contraseña (como `sudo`, `su` o login SSH secundario) y la terminal apaga el eco, la grabadora detecta la palabra clave del prompt de contraseña de forma heurística. Para proteger tu seguridad, **la contraseña escrita nunca se almacena literal** en los pasos del script. En su lugar, Rustty inserta un paso genérico **Enviar contraseña (keyring)** con el perfil vacío (`profileId: null`), de modo que puedas asociar una credencial del keyring o de KeePass al editar el script.
- **Límites**: La grabación admite un máximo de **50 pasos**. Si se alcanza este tope, la grabación se marcará como truncada y dejará de añadir pasos adicionales.
- **Guardado y finalización**:
  - Pulsa **Detener y editar** en la barra flotante para detener la grabación, materializar los pasos en el editor de scripts y abrir el formulario del script con el objetivo preconfigurado en el perfil desde el cual se grabó.
  - Pulsa **Descartar** para detener la grabación y borrar todos los pasos acumulados.
  - Si la pestaña de la sesión SSH que estás grabando se cierra o se desconecta, la grabación se detiene y se abre el editor con los pasos acumulados de manera automática para evitar pérdidas de progreso.

### Exportar e importar como runbook Markdown

**Exportar** genera un fichero Markdown legible —un *runbook*— con el nombre, la descripción, el objetivo y los pasos del script. Sirve tanto de documentación como de formato de intercambio: **Importar Markdown…** lo reconstruye en otro equipo. No viajan ni ids ni secretos (los pasos de contraseña conservan solo la referencia al keyring o el UUID de KeePass).

El fichero se puede editar a mano. Sus etiquetas estructurales (`**Target:**`, `## Steps`, `recursive=yes`, `timeout=5000ms pattern=…`) son **independientes del idioma de la aplicación**: así un runbook exportado en un equipo en alemán se lee igual en uno en español. Lo que escribes tú —nombre, descripción y comandos— nunca se traduce.

> Los runbooks exportados con versiones anteriores (etiquetas en castellano: `**Objetivo:**`, `## Pasos`, `recursivo sí`) **se siguen importando sin cambios**. Al exportarlos de nuevo se guardan con el formato actual.

Si al importar hay líneas que Rustty no reconoce (un paso con una errata, un número de lista perdido…), **te lo dice antes de guardar**: enumera las líneas afectadas con su número y te deja elegir entre corregir el fichero o importar el script aun sabiendo que quedará incompleto. Nunca se descartan pasos en silencio.

### Seguridad de los scripts

- Los scripts se guardan en `scripts.json`, en el directorio de datos, y **nunca contienen contraseñas**: los pasos de contraseña guardan solo la referencia al keyring o el UUID de KeePass.
- Las credenciales alternativas de una tirada no se guardan con el script; las manuales viven solo en memoria durante la ejecución.
- La salida que se muestra en el panel pasa por **redacción de secretos**: los valores enviados (contraseñas incluidas) se sustituyen por `••••`.
- El historial de **Ejecuciones recientes** (`script_runs.json`) se guarda con permisos privados (0600), con la salida ya redactada y sin contraseñas. No se sincroniza.
- Los scripts **no se sincronizan** entre equipos. Para moverlos o versionarlos, usa **Exportar**: genera un runbook Markdown legible que **Importar Markdown…** reconstruye en otro equipo (sin ids ni secretos).
- Un script ejecuta comandos reales en tus servidores: revisa la previsualización y prueba primero en modo **canario** antes de lanzarlo contra una carpeta entera.

## Snippets remotos

Un snippet es un texto de comando guardado con nombre, grupo y descripción opcional, en la pestaña **Comandos** de Preferencias. Al ejecutarlo, Rustty lo inserta en la sesión de terminal activa: SSH o consola local. No se inserta en sesiones RDP, VNC ni Telnet porque se abren en clientes externos.

Cada snippet puede configurarse con:

- **Nombre**: lo que verás en la lista y en la paleta.
- **Grupo**: útil para ordenar por área, cliente o servicio.
- **Descripción**: ayuda breve para distinguir variantes.
- **Comando**: el texto que se insertará.
- **Enviar Enter al final**: si está activo, el snippet se ejecuta inmediatamente; si no, solo queda escrito para revisarlo.
- **Pedir confirmación**: muestra un modal antes de insertar el texto.

Los snippets se guardan localmente y viajan con la sincronización cifrada como elementos `snippet:<id>`.

## Comandos locales

Los comandos locales viven también en **Preferencias → Comandos**, pero no se sincronizan. Están pensados para acciones que dependen de este equipo: rutas locales, binarios instalados, URLs internas o carpetas de trabajo.

Tipos disponibles:

- **Ejecutar comando**: lanza el texto con el shell del sistema (`sh -c` en Unix, `cmd /C` en Windows) y captura código de salida, `stdout` y `stderr`.
- **Abrir URL**: abre la URL con el navegador o aplicación registrada.
- **Abrir archivo o carpeta**: abre una ruta local con la aplicación predeterminada del sistema.

La confirmación está activada por defecto y los comandos de tipo shell se tratan como acciones sensibles en el modal de confirmación.

### Límites de ejecución

Un comando local es tu shell, pero no puede quedarse colgado indefinidamente ni llenar la memoria con su salida. En **Preferencias → Comandos** eliges los dos límites:

- **Límite de tiempo**: plazo máximo de ejecución (10 s, 30 s, 1, 5 o 15 min; por defecto 30 s). Al agotarse, Rustty detiene el comando **y los procesos que haya lanzado** (el árbol completo). Puedes elegir **Sin límite** si prefieres que no se detenga nunca.
- **Salida capturada**: cuánta salida se guarda de cada comando (64 KiB, 512 KiB, 2 MiB u 8 MiB; por defecto 512 KiB). Lo que exceda se descarta y el aviso lo indica con «(salida truncada)»; el comando sigue ejecutándose con normalidad.

Mientras el comando corre aparece un aviso con la acción **Cancelar**, que lo detiene al momento junto con sus procesos hijos.

## Variables

Snippets y comandos locales comparten el mismo resolutor de plantillas del cliente. Puedes usar:

- `${host}`, `${port}`, `${user}`, `${profileName}`, `${workspace}`.
- `${date}` y `${time}`.
- `${var:nombre}` para variables de texto definidas en **Preferencias → Credenciales**.
- `${ask:Etiqueta}` para pedir un valor al ejecutar.
- `${ask:Etiqueta|opción1|opción2}` para pedir una selección.

Las respuestas de `${ask:...}` se piden una vez por ejecución y no se guardan. Los marcadores de secretos (`${master:...}`, `${secret:...}`), entorno (`${env:...}`) y comandos reservados (`${cmd:...}`) quedan literales en snippets y comandos locales para no exponer secretos en el frontend. Los pasos **Enviar comando** de los scripts sí resuelven todos los marcadores, porque la resolución ocurre en el backend en el momento de enviar.

Para escribir un marcador literal sin resolver, usa el escape `$${...}`.

## Paleta de comandos

Pulsa `Ctrl+Shift+P` para abrir la paleta global. Desde ahí puedes buscar y lanzar:

- Acciones de la app, como **Nueva conexión**, **Nueva conexión desde plantilla**, **Abrir consola local** o **Abrir preferencias**, más acciones contextuales (panel SFTP y nota de la conexión activa, túneles, comprobación de salud).
- Perfiles guardados.
- Snippets.
- Comandos locales.
- **Scripts**: se ejecutan directamente con su objetivo guardado.
- **Notas de conexión**: abren su editor.

La búsqueda acepta coincidencias parciales y subsecuencias, y el orden aprende de tu uso: sin texto escrito, lo reciente y frecuente va primero; con texto, manda la coincidencia. Usa `↑`/`↓` para moverte, `Enter` para ejecutar la opción activa y `Esc` para cerrar.

## Grabación e historial

Para auditoría o soporte siguen disponibles dos flujos relacionados:

- **Grabación de sesión a fichero**: activa **Grabar sesión** en las opciones avanzadas de un perfil SSH para volcar la salida del shell a un `.log`.
- **Exportar historial**: desde el menú contextual de una pestaña, **Exportar historial…** guarda en `.txt` el buffer visible del terminal.

Estos ficheros pueden contener información sensible; revísalos antes de compartirlos.
