# Snippets, comandos locales y paleta

Rustty incluye una pestaña **Comandos** en Preferencias para guardar comandos reutilizables. Hay dos tipos: **snippets remotos**, que se insertan en la terminal activa, y **comandos locales**, que se ejecutan o abren recursos en tu propio equipo.

Los scripts reproducibles completos siguen en diseño, pero estas herramientas cubren las tareas repetidas del día a día sin convertir Rustty en un orquestador.

## Snippets remotos

Un snippet es un texto de comando guardado con nombre, grupo y descripción opcional. Al ejecutarlo, Rustty lo inserta en la sesión de terminal activa: SSH o consola local. No se inserta en sesiones RDP.

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

## Variables

Snippets y comandos locales comparten el mismo resolutor de plantillas del cliente. Puedes usar:

- `${host}`, `${port}`, `${user}`, `${profileName}`, `${workspace}`.
- `${date}` y `${time}`.
- `${var:nombre}` para variables de texto definidas en **Preferencias → Credenciales**.
- `${ask:Etiqueta}` para pedir un valor al ejecutar.
- `${ask:Etiqueta|opción1|opción2}` para pedir una selección.

Las respuestas de `${ask:...}` se piden una vez por ejecución y no se guardan. Los marcadores de secretos (`${master:...}`, `${secret:...}`), entorno (`${env:...}`) y comandos reservados (`${cmd:...}`) quedan literales en snippets y comandos locales para no exponer secretos en el frontend.

Para escribir un marcador literal sin resolver, usa el escape `$${...}`.

## Paleta de comandos

Pulsa `Ctrl+Shift+P` para abrir la paleta global. Desde ahí puedes buscar y lanzar:

- Acciones de la app, como **Nueva conexión**, **Nueva conexión desde plantilla**, **Abrir consola local** o **Abrir preferencias**.
- Perfiles guardados.
- Snippets.
- Comandos locales.

La búsqueda acepta coincidencias parciales y subsecuencias. Usa `↑`/`↓` para moverte, `Enter` para ejecutar la opción activa y `Esc` para cerrar.

## Grabación e historial

Para auditoría o soporte siguen disponibles dos flujos relacionados:

- **Grabación de sesión a fichero**: activa **Grabar sesión** en las opciones avanzadas de un perfil SSH para volcar la salida del shell a un `.log`.
- **Exportar historial**: desde el menú contextual de una pestaña, **Exportar historial…** guarda en `.txt` el buffer visible del terminal.

Estos ficheros pueden contener información sensible; revísalos antes de compartirlos.
