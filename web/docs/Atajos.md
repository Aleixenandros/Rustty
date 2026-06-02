# Atajos de teclado

Todos los atajos son **configurables** desde **Preferencias → Atajos**. Pulsa **Editar** sobre cualquier acción para asignarle una nueva combinación, o **Desactivar** para quitarla.

## Globales

| Atajo          | Acción                                              |
|----------------|-----------------------------------------------------|
| `Ctrl+Shift+N` | Nueva conexión                                      |
| `Ctrl+Shift+T` | Nueva consola local                                 |
| `Ctrl+W`       | Cerrar pestaña activa                               |
| `Ctrl+Tab`     | Pestaña siguiente                                   |
| `Ctrl+Shift+Tab` | Pestaña anterior                                  |
| `Ctrl+1`…`Ctrl+9` | Saltar a la pestaña N (`Ctrl+9` salta a la última) |
| `Ctrl+K`       | Buscar conexiones desde cualquier vista             |
| `Ctrl+,`       | Abrir preferencias                                  |
| _(sin asignar)_ | Desconectar todo: cierra sesiones, túneles y cancela transferencias |

«Desconectar todo» también está disponible como botón de emergencia en el rail lateral. No trae combinación por defecto para no pisar otros atajos; asígnale una desde **Preferencias → Atajos** si quieres lanzarla con el teclado.

## Terminal

| Atajo          | Acción                                              |
|----------------|-----------------------------------------------------|
| `Ctrl+Alt+C`   | Copiar selección del terminal                       |
| `Ctrl+Alt+V`   | Pegar en el terminal                                |
| `Ctrl+P`       | Pegar la contraseña del perfil activo               |
| `Ctrl+F`       | Buscar dentro del buffer del terminal               |
| `Ctrl++`       | Aumentar tamaño de fuente                           |
| `Ctrl+-`       | Disminuir tamaño de fuente                          |
| `Ctrl+0`       | Restablecer tamaño de fuente                        |
| `Ctrl+Rueda`   | Zoom del terminal con la rueda del ratón            |
| `Ctrl+Alt++`   | Aumentar tamaño de la UI (rail, sidebar, tabs)      |
| `Ctrl+Alt+-`   | Disminuir tamaño de la UI                           |
| `Ctrl+Alt+0`   | Restablecer tamaño de la UI                         |
| `Ctrl+Shift+R` | Reconectar la sesión activa                         |

La búsqueda en el buffer abre una barra flotante con next/prev y un toggle de **case-sensitive**. Resalta todas las coincidencias sobre `@xterm/addon-search`.

El pegado en el terminal (`Ctrl+Alt+V`) pide confirmación con una previsualización cuando el texto es **multilínea**, **muy largo** o trae **caracteres de control**. Se configura en **Preferencias → Terminal** y puede desactivarse por perfil desde sus opciones avanzadas.

## Presets predefinidos

Desde **Preferencias → Atajos** puedes aplicar de golpe un preset entero al mapa de atajos:

- **Por defecto**: limpia overrides y deja cada acción con su atajo por omisión.
- **Vim-like**: navegación entre paneles y pestañas con `Ctrl+Alt+H/J/K/L`; nueva conexión `Ctrl+Alt+N`, nueva consola `Ctrl+Alt+T`, cerrar pestaña `Ctrl+Alt+Q`, buscar en terminal `Ctrl+Alt+F`.
- **Tmux-like**: aproxima la convención del prefix `C-b` con combinaciones `Alt+letra` sin chord — `Alt+N`/`Alt+P` para pestañas, `Alt+O` / `Alt+Shift+O` para paneles, `Alt+C` para nueva consola, `Alt+X` para cerrar pestaña, `Alt+/` para buscar.

Al aplicar un preset Rustty pide confirmación y sustituye el mapa actual; los atajos sustituidos siguen siendo editables individualmente después.

## Sidebar

La cabecera de la barra lateral tiene dos iconos junto al logo:

- **🔍 Lupa** — abre un popover compacto con solo el cuadro de búsqueda; filtra los perfiles por nombre, host, usuario o grupo y oculta las carpetas vacías mientras escribes.
- **≡ Filtros** — abre el popover completo con switcher de workspace, modos de vista (workspace actual / todos / favoritos), toggles de vista compacta y carpetas primero, y el mismo buscador.

`Ctrl+K` enfoca la búsqueda de forma global y se comporta exactamente como pulsar el icono 🔍: funciona desde inicio, desde una sesión SSH/RDP o desde un split activo. Si estás dentro de una sesión, Rustty abre la barra lateral si hace falta y te deja buscar por nombre, IP/host, usuario o grupo sin volver al dashboard.

Dentro del buscador, `Esc` limpia el texto y restablece la lista; un segundo `Esc` cierra el popover. Cerrar el popover por cualquier otra vía (clic fuera, volver a pulsar la lupa…) también descarta el filtro para que la lista no se quede "enganchada". La combinación es reasignable desde **Preferencias → Atajos** como `clear_sidebar_search`.

## Captura de nuevos atajos

El capturador detecta cualquier combinación de **Ctrl / Alt / Shift / Meta** más una tecla final, y normaliza el código de tecla independientemente del layout del teclado (ES / EN / FR). En macOS, `Ctrl` se muestra como `Cmd` en la interfaz pero internamente sigue siendo la misma combinación.

Si un atajo entra en conflicto con otro ya asignado, Rustty te avisa con un toast pero deja que decidas: puedes mantener el conflicto (uno de los dos no funcionará) o elegir una combinación distinta.

## Exportar / importar

Los atajos viven dentro de las preferencias en `localStorage` (`rustty-prefs`). También pueden viajar en **Preferencias → Copias de seguridad**: como parte del backup cifrado, de la sincronización en la nube o del export/import JSON local.
