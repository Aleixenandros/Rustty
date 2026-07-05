# Clientes externos

Rustty integra SSH, SFTP, FTP y FTPS dentro de la aplicación. En cambio, **RDP**, **VNC** y **Telnet** se gestionan como perfiles de Rustty pero se abren en clientes externos del sistema.

Esto permite tenerlos en el mismo árbol de conexiones, favoritos, workspaces, notas, copias y sincronización, sin que Rustty tenga que embeber motores de escritorio remoto o terminales inseguros.

## Cómo funciona

Al abrir un perfil RDP, VNC o Telnet, Rustty:

1. Resuelve variables del perfil como `${host}`, `${port}`, `${user}` o `${var:...}`.
2. Lanza el cliente externo disponible en tu sistema.
3. Crea una pestaña de estado en Rustty para saber que esa conexión está abierta.
4. Intenta vigilar el proceso lanzado y emite el cierre cuando termina.

Si el sistema delega la apertura en un manejador de URL (`rdp://` o `vnc://`), el ciclo de vida real puede depender del sistema operativo o del cliente registrado. El botón **Desconectar** cierra lo que Rustty haya lanzado y quita la pestaña de estado.

## Protocolos

- **RDP**: usa el cliente de escritorio remoto del sistema. En Linux prueba `xfreerdp3`, `xfreerdp` y `rdesktop`; en Windows abre `mstsc.exe` o el manejador `rdp://`; en macOS abre el cliente registrado para `rdp://`. Al usar `xfreerdp` en Linux, Rustty aplica verificación de certificado basada en TOFU (`/cert:tofu`) en vez de ignorar la verificación en silencio, de modo que el cliente recuerda el certificado del servidor y advierte al usuario si cambia de forma inesperada.
- **VNC**: abre un visor VNC externo. En Linux prueba TigerVNC / `vncviewer`; en macOS usa Pantalla compartida mediante `vnc://`; en Windows prueba `vncviewer.exe`, `tvnviewer.exe` o el manejador `vnc://`.
- **Telnet**: abre el comando `telnet` en un emulador de terminal del sistema. Telnet no cifra el tráfico, así que conviene reservarlo para equipos antiguos, redes controladas o tareas puntuales.

## Requisitos por plataforma

En Linux, instala los clientes que necesites:

```bash
# RDP
sudo dnf install freerdp          # Fedora
sudo apt install freerdp2-x11     # Debian/Ubuntu

# VNC
sudo dnf install tigervnc         # Fedora
sudo apt install tigervnc-viewer  # Debian/Ubuntu

# Telnet
sudo dnf install telnet           # Fedora
sudo apt install telnet           # Debian/Ubuntu
```

Para Telnet en Linux también hace falta un emulador de terminal disponible. Rustty prueba `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `alacritty`, `kitty` y `xterm`.

En Windows, RDP usa el cliente integrado `mstsc.exe`. Para VNC instala un visor compatible (`vncviewer.exe`, TightVNC u otro que registre `vnc://`). Para Telnet puede hacer falta activar el **Cliente Telnet** en las características opcionales de Windows.

En macOS, VNC usa la app nativa de **Pantalla compartida**. RDP requiere un cliente que registre `rdp://`, como Microsoft Remote Desktop. Telnet se abre en Terminal.app, pero en versiones modernas de macOS quizá tengas que instalar el binario `telnet` aparte.

## Credenciales

RDP comparte el flujo normal de credenciales de Rustty: contraseña propia, credencial maestra o KeePass, siempre sin guardar secretos en `profiles.json`.

VNC y Telnet no reciben contraseñas desde Rustty. El visor VNC o el cliente Telnet piden sus credenciales si las necesitan. Rustty guarda y sincroniza los metadatos del perfil (host, puerto, nombre, workspace, notas, etc.), pero no inyecta secretos en esos clientes externos.

## Limitaciones

Los perfiles externos no usan el terminal embebido de Rustty. Por eso no tienen búsqueda de buffer, snippets remotos, editor multilínea, restauración visual de pantalla, grabación de sesión, panel SFTP asociado ni túneles SSH sobre esa sesión.

Para túneles, usa un perfil SSH y levanta el túnel desde el panel **Túneles SSH**. Para transferencia de ficheros, usa SFTP, FTP o FTPS.
