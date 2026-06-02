# Temas

Rustty separa el tema de la interfaz del tema del terminal. Puedes usar una UI clara con una terminal oscura, o dejar que el terminal siga el tema de la interfaz.

## Temas incluidos

Rustty incluye temas base y variantes listas para usar:

- Catppuccin Mocha
- Catppuccin Latte
- Dracula
- Nord
- xterm clásico
- VS Code Dark+
- Tango
- Solarized Dark
- Solarized Light
- Gruvbox Dark
- Tokyo Night
- Monokai

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

El botón **Exportar plantilla** genera un JSON listo para editar. Los temas personalizados se guardan en las preferencias y pueden viajar con la sincronización cifrada.

## Idioma

Desde **Preferencias → Idioma** puedes dejar la opción **Sistema (automático)**, que detecta el idioma del sistema operativo, o fijar manualmente uno de los disponibles: **español**, **inglés**, **francés**, **portugués** y **alemán**.
