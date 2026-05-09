# Temas de Rustty

Rustty usa un formato JSON simple para crear temas. La interfaz y el terminal
viven en el mismo fichero:

```json
{
  "formatVersion": 2,
  "id": "mi-tema",
  "name": "Mi tema",
  "ui": {
    "crust": "#11111b",
    "mantle": "#181825",
    "base": "#1e1e2e",
    "surface0": "#313244",
    "surface1": "#45475a",
    "surface2": "#585b70",
    "text": "#cdd6f4",
    "subtext0": "#a6adc8",
    "subtext1": "#bac2de",
    "overlay0": "#6c7086",
    "overlay1": "#7f849c",
    "blue": "#89b4fa",
    "red": "#f38ba8",
    "green": "#a6e3a1",
    "yellow": "#f9e2af",
    "mauve": "#cba6f7",
    "peach": "#fab387",
    "teal": "#94e2d5",
    "sky": "#89dceb",
    "lavender": "#b4befe"
  },
  "terminal": {
    "background": "#1e1e2e",
    "foreground": "#cdd6f4",
    "cursor": "#f5e0dc",
    "cursorAccent": "#1e1e2e",
    "selectionBackground": "rgba(137,180,250,0.3)",
    "black": "#45475a",
    "red": "#f38ba8",
    "green": "#a6e3a1",
    "yellow": "#f9e2af",
    "blue": "#89b4fa",
    "magenta": "#cba6f7",
    "cyan": "#94e2d5",
    "white": "#bac2de",
    "brightBlack": "#585b70",
    "brightRed": "#f38ba8",
    "brightGreen": "#a6e3a1",
    "brightYellow": "#f9e2af",
    "brightBlue": "#89b4fa",
    "brightMagenta": "#cba6f7",
    "brightCyan": "#94e2d5",
    "brightWhite": "#a6adc8"
  }
}
```

La forma más cómoda de empezar es ir a Preferencias -> Apariencia y pulsar
"Exportar plantilla". Rustty exporta el tema activo con este formato; después
solo hay que editar colores e importarlo desde la misma pantalla.

También hay una biblioteca ampliada de temas incluida en este repositorio:

- `docs/themes/bundled/bundled-themes.json`: pack completo en formato Rustty v2.
- `public/themes/bundled-themes.json`: copia publicada que se carga al arrancar.

El importador de Rustty acepta tanto un tema suelto como un pack JSON con
`themes: [...]`. Además, la biblioteca publicada en `public/themes/` aparece
directamente en los selectores de Preferencias -> Apariencia sin guardarse en
`prefs.customThemes`.

Tokens de UI:

- `crust`, `mantle`, `base`: fondos principales.
- `surface0`, `surface1`, `surface2`: tarjetas, bordes y estados hover.
- `text`, `subtext0`, `subtext1`: textos.
- `overlay0`, `overlay1`: iconos y texto secundario.
- `blue`, `red`, `green`, `yellow`, `mauve`, `peach`, `teal`, `sky`, `lavender`: acentos.

Campos mínimos para importar: `formatVersion: 2`, `name`, `ui.base`,
`ui.text`, `terminal.background` y `terminal.foreground`.
