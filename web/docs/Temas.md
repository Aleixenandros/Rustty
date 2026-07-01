# Temas

Rustty separa el tema de la interfaz del tema del terminal. Puedes usar una UI clara con una terminal oscura, o dejar que el terminal siga el tema de la interfaz.

## Temas incluidos

Rustty incluye una biblioteca amplia de temas listos para usar. Además de los temas base iniciales (Catppuccin, Dracula, Nord, Solarized, Gruvbox, Tokyo Night, Monokai, Tango, xterm clásico y VS Code Dark+), carga un pack ampliado desde `bundled-themes.json` con variantes claras, oscuras y de alto contraste.

En **Preferencias → Apariencia** puedes buscar por nombre, filtrar por **Todos / Oscuros / Claros / Alto contraste** y restablecer el tema al sistema. El tema activo aparece marcado con un check.

## Accesibilidad

En **Preferencias → Apariencia** hay un bloque **Accesibilidad** que ajusta la legibilidad y el movimiento de la interfaz sin obligarte a cambiar de tema:

- **Contraste de la interfaz** (Normal / Alto / Máximo): refuerza el contraste del texto, los bordes, el foco y la selección en toda la aplicación. Acerca los colores de texto más tenues al color principal sin cambiar el tema activo.
- **Modo daltónico**: diferencia los indicadores de estado también por forma, no solo por color. Los puntos de estado usan círculo / cuadrado / diamante; los avisos emergentes añaden un icono por severidad (éxito, error, información, aviso); y las barras de transferencia SFTP marcan el estado final (correcto / error / omitido) con una trama distinta.
- **Reducir movimiento**: desactiva animaciones, transiciones largas y efectos decorativos. Se respeta también la preferencia equivalente del sistema operativo. La campana visual del terminal pasa entonces a un realce estable, sin parpadeo.
- **Foco visible reforzado**: aumenta el grosor y el contraste del anillo de foco en la navegación por teclado.
- **Contraste mínimo del terminal** (Sin ajuste / AA 4.5:1 / AAA 7:1): adapta los colores ANSI poco legibles para que el texto alcance un contraste mínimo con su fondo. Útil con temas de bajo contraste.
- **Cursor del terminal más visible**: pinta el cursor con una tinta de alto contraste (blanco o negro según el fondo) en cualquier estilo y engrosa el caret cuando el estilo es «barra».
- **Densidad de la interfaz** (Espaciosa / Cómoda / Compacta): «Espaciosa» aumenta el interlineado y el espaciado de la barra lateral, las pestañas y los diálogos para facilitar la lectura; «Compacta» los reduce para mostrar más contenido. No afecta al tamaño del terminal ni a los ajustes de fuente de xterm.

### Navegación por teclado

Toda la interfaz es operable con teclado. Los menús contextuales (clic derecho o **Shift+F10** sobre una conexión, pestaña o panel SFTP) enfocan su primer ítem al abrirse y se recorren con las flechas **↑/↓** e **Inicio/Fin**; **Enter/Espacio** activan la opción y **Tab/Escape** cierran devolviendo el foco al punto de partida. En la barra lateral, **Enter/Espacio** sobre una conexión la abre; en las pestañas, la seleccionan (**Ctrl/Cmd+Enter** la añade a la vista múltiple).

La barra de pestañas de sesión se expone a los lectores de pantalla como una lista de pestañas (`tablist`), con el estado de selección de cada una y una etiqueta descriptiva en sus botones (SFTP, túneles y cerrar).

## Terminal

En **Preferencias → Terminal** puedes ajustar:

- Familia de fuente monoespaciada.
- Tamaño de fuente.
- Altura de línea.
- Espaciado entre letras.
- **Ligaduras tipográficas** (opcional). Requieren una fuente con soporte de ligaduras (FiraCode, JetBrains Mono, Cascadia Code, Iosevka, …). Se aplican únicamente a las sesiones nuevas que abras después de activarlas.
- Scrollback.
- Tema del terminal independiente.

Los cambios se aplican a las sesiones abiertas cuando es posible. Además del atajo `Ctrl +/-/0`, puedes ajustar el tamaño de fuente con `Ctrl+Rueda` del ratón.

## Temas personalizados

Desde **Preferencias → Apariencia** puedes exportar e importar temas JSON. Rustty usa el formato **v2** (`formatVersion: 2`), con tokens separados para la interfaz (`ui`) y la paleta del terminal (`terminal`).

El botón **Exportar plantilla** genera un JSON listo para editar. También puedes importar un tema suelto o un pack con varios temas. Los temas personalizados se guardan en las preferencias y pueden viajar con la sincronización cifrada.

## Crear un tema personalizado

La forma más cómoda de crear un tema es partir de una plantilla generada por la propia aplicación:

1. Abre **Preferencias → Apariencia**.
2. Pulsa **Exportar plantilla**.
3. Edita el fichero JSON: cambia `id`, `name` y los colores de `ui` y `terminal`.
4. Vuelve a **Preferencias → Apariencia** y pulsa **Importar tema…**.

El importador acepta colores CSS válidos (`#rrggbb`, `rgb(...)`, `rgba(...)`, `hsl(...)`, etc.). El campo `id` se normaliza para usarlo como identificador interno; si ya existe otro tema con el mismo identificador, Rustty crea uno único añadiendo un sufijo.

### Formato v2

Un tema suelto tiene esta estructura:

```json
{
  "formatVersion": 2,
  "id": "bosque-nocturno",
  "name": "Bosque nocturno",
  "ui": {
    "base": "#101814",
    "mantle": "#0b120f",
    "crust": "#070c0a",
    "surface0": "#17241f",
    "surface1": "#20342c",
    "surface2": "#2b463b",
    "overlay0": "#49675a",
    "overlay1": "#668374",
    "text": "#edf7ef",
    "subtext0": "#b8cabb",
    "subtext1": "#d1dfd3",
    "blue": "#80bfff",
    "red": "#ff8f8f",
    "green": "#8de8a1",
    "yellow": "#f4d06f",
    "mauve": "#c7a7ff",
    "peach": "#f3a46f",
    "teal": "#72d6c9",
    "sky": "#8bd3ff",
    "lavender": "#b7c5ff"
  },
  "terminal": {
    "background": "#101814",
    "foreground": "#edf7ef",
    "cursor": "#f4d06f",
    "cursorAccent": "#101814",
    "selectionBackground": "rgba(128, 191, 255, 0.28)",
    "black": "#0b120f",
    "red": "#ff8f8f",
    "green": "#8de8a1",
    "yellow": "#f4d06f",
    "blue": "#80bfff",
    "magenta": "#c7a7ff",
    "cyan": "#72d6c9",
    "white": "#d1dfd3",
    "brightBlack": "#668374",
    "brightRed": "#ffb3b3",
    "brightGreen": "#b3f2c0",
    "brightYellow": "#ffe49a",
    "brightBlue": "#add6ff",
    "brightMagenta": "#dcc8ff",
    "brightCyan": "#a0eee4",
    "brightWhite": "#ffffff"
  }
}
```

Los campos obligatorios son `formatVersion`, `name`, `ui.base`, `ui.text`, `terminal.background` y `terminal.foreground`. El resto de tokens son opcionales, pero conviene rellenarlos para que los controles, estados, previews y colores ANSI del terminal no hereden valores del tema por defecto.

### Tokens de interfaz

Los tokens de `ui` controlan las variables CSS de la aplicación:

- Fondos: `base`, `mantle`, `crust`.
- Superficies: `surface0`, `surface1`, `surface2`.
- Capas y bordes suaves: `overlay0`, `overlay1`.
- Texto: `text`, `subtext0`, `subtext1`.
- Acentos y estados: `blue`, `red`, `green`, `yellow`, `mauve`, `peach`, `teal`, `sky`, `lavender`.

### Tokens del terminal

Los tokens de `terminal` se pasan a xterm.js:

- Base: `background`, `foreground`, `cursor`, `cursorAccent`, `selectionBackground`.
- ANSI normales: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`.
- ANSI brillantes: `brightBlack`, `brightRed`, `brightGreen`, `brightYellow`, `brightBlue`, `brightMagenta`, `brightCyan`, `brightWhite`.

### Pack de varios temas

Para distribuir varios temas en un único fichero, usa un objeto con `themes`:

```json
{
  "formatVersion": 2,
  "kind": "rustty-theme-pack",
  "name": "Mis temas Rustty",
  "themes": [
    {
      "formatVersion": 2,
      "id": "bosque-nocturno",
      "name": "Bosque nocturno",
      "ui": {
        "base": "#101814",
        "text": "#edf7ef"
      },
      "terminal": {
        "background": "#101814",
        "foreground": "#edf7ef"
      }
    },
    {
      "formatVersion": 2,
      "id": "papel-claro",
      "name": "Papel claro",
      "ui": {
        "base": "#f8f3e8",
        "text": "#241f1a"
      },
      "terminal": {
        "background": "#fffaf0",
        "foreground": "#241f1a"
      }
    }
  ]
}
```

Ese ejemplo de pack usa solo los tokens mínimos para abreviar. Para un tema pulido, rellena todos los tokens de interfaz y terminal como en el ejemplo completo.

## Idioma

Desde **Preferencias → Idioma** puedes dejar la opción **Sistema (automático)**, que detecta el idioma del sistema operativo, o fijar manualmente uno de los disponibles: **español**, **inglés**, **francés**, **portugués** y **alemán**.
