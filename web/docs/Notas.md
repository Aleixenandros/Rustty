# Notas de conexión (runbooks)

Cada conexión de Rustty puede tener una **nota en Markdown**: un runbook con los comandos frecuentes, rutas, responsables o pasos de mantenimiento de ese servidor. Las notas se guardan como archivos `.md` independientes, se sincronizan y se pueden consultar mientras trabajas en la sesión.

## Añadir o editar una nota

1. Haz **clic derecho** sobre una conexión en la sidebar.
2. Elige **Añadir nota** (o **Editar nota** si ya existe).
3. Se abre el editor con vista dividida: a la izquierda escribes Markdown y a la derecha ves la previsualización en vivo.
4. Pulsa **Guardar** o `Ctrl+S`. Al cerrar con cambios sin guardar, la nota se guarda automáticamente.

También puedes abrir el editor:

- Desde el badge de nota que aparece junto a las conexiones que ya tienen una.
- Desde la pestaña **Notas** del modal de edición de la conexión.
- Con el atajo `Ctrl+Shift+M`, que abre la nota de la conexión activa.

## Editor

El editor incluye:

- **Título** y **etiquetas** (tags) opcionales.
- Una **barra de formato** (encabezado, negrita, cursiva, código, listas, casillas de tarea y enlaces).
- **Previsualización en vivo** con el mismo render que el panel runbook.
- Resolución de **variables** en la vista: `${host}`, `${user}`, `${port}`, `${profileName}`, `${workspace}`, `${date}`, `${time}`. El archivo guarda los marcadores originales; solo la previsualización los sustituye. Las credenciales (`${master:…}` / `${secret:…}`) se muestran como `••••` y nunca se revelan.

> Evita guardar secretos en las notas. Para contraseñas y tokens usa el keyring, KeePass o las credenciales maestras.

## Panel runbook

Cada pestaña de una sesión asociada a un perfil muestra un botón de nota. Al pulsarlo se abre un **cajón lateral** con la nota renderizada junto al terminal, para seguir el runbook mientras trabajas.

Las **casillas de tarea** (`- [ ]` / `- [x]`) del panel son interactivas: al marcarlas o desmarcarlas se actualiza el archivo `.md` de la nota, de modo que tu checklist queda guardada.

## Dónde se guardan

Cada nota es un archivo Markdown autocontenido en la carpeta de datos de la aplicación:

```text
<directorio de datos>/notes/<id-de-la-conexión>.md
```

El archivo lleva una cabecera (frontmatter) con su título, conexión, etiquetas y fechas, seguida del cuerpo en Markdown. Al ser un `.md` normal, puedes abrirlo o editarlo con cualquier editor externo (por ejemplo Obsidian o VS Code). El botón de carpeta del editor abre directamente este directorio.

## Búsqueda y sincronización

- La **búsqueda** de la barra lateral encuentra conexiones por el título, las etiquetas y el contenido de su nota.
- Las notas se **sincronizan** dentro del blob cifrado de extremo a extremo, con la opción **Notas** activada por defecto en **Preferencias → Copias de seguridad**. La resolución de conflictos es por fecha de modificación (gana la más reciente) y borrar una nota se propaga al resto de equipos.
