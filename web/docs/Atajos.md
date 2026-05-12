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
| `Ctrl+K`       | Buscar conexiones desde cualquier vista             |
| `Ctrl+,`       | Abrir preferencias                                  |

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

La búsqueda en el buffer abre una barra flotante con next/prev y un toggle de **case-sensitive**. Resalta todas las coincidencias sobre `@xterm/addon-search`.

## Sidebar

La cabecera de la barra lateral incluye un campo de búsqueda rápida que filtra los perfiles por nombre, host, usuario o grupo y oculta las carpetas vacías mientras escribes.

`Ctrl+K` enfoca esa búsqueda de forma global: funciona desde inicio, desde una sesión SSH/RDP o desde un split activo. Si estás dentro de una sesión, Rustty abre la barra lateral si hace falta y te deja buscar por nombre, IP/host, usuario o grupo sin volver al dashboard.

## Captura de nuevos atajos

El capturador detecta cualquier combinación de **Ctrl / Alt / Shift / Meta** más una tecla final, y normaliza el código de tecla independientemente del layout del teclado (ES / EN / FR). En macOS, `Ctrl` se muestra como `Cmd` en la interfaz pero internamente sigue siendo la misma combinación.

Si un atajo entra en conflicto con otro ya asignado, Rustty te avisa con un toast pero deja que decidas: puedes mantener el conflicto (uno de los dos no funcionará) o elegir una combinación distinta.

## Exportar / importar

Los atajos viven dentro de las preferencias en `localStorage` (`rustty-prefs`). También pueden viajar en **Preferencias → Copias de seguridad**: como parte del backup cifrado, de la sincronización en la nube o del export/import JSON local.
