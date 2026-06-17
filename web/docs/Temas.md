# Temas

Rustty separa el tema de la interfaz del tema del terminal. Puedes usar una UI clara con una terminal oscura, o dejar que el terminal siga el tema de la interfaz.

## Temas incluidos

Rustty incluye una biblioteca amplia de temas listos para usar. Además de los temas base iniciales (Catppuccin, Dracula, Nord, Solarized, Gruvbox, Tokyo Night, Monokai, Tango, xterm clásico y VS Code Dark+), carga un pack ampliado desde `bundled-themes.json` con variantes claras, oscuras y de alto contraste.

En **Preferencias → Apariencia** puedes buscar por nombre, filtrar por **Todos / Oscuros / Claros / Alto contraste** y restablecer el tema al sistema. El tema activo aparece marcado con un check.

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

## Idioma

Desde **Preferencias → Idioma** puedes dejar la opción **Sistema (automático)**, que detecta el idioma del sistema operativo, o fijar manualmente uno de los disponibles: **español**, **inglés**, **francés**, **portugués** y **alemán**.
