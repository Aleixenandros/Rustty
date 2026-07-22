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

Cuando la sesión termina, la pestaña ofrece **Reconectar** además de cerrarla. La reconexión reutiliza la misma pestaña, así que conserva su sitio en la barra y el panel dividido donde estuviera.

## Protocolos

- **RDP**: usa el cliente de escritorio remoto del sistema. En Linux prueba `xfreerdp3`, `xfreerdp` y `rdesktop`; en Windows abre `mstsc.exe` o el manejador `rdp://`; en macOS abre el cliente registrado para `rdp://`. Al usar `xfreerdp` en Linux, Rustty aplica verificación de certificado basada en TOFU (`/cert:tofu`) en vez de ignorar la verificación en silencio, de modo que el cliente recuerda el certificado del servidor y advierte al usuario si cambia de forma inesperada. Si el cliente externo muere nada más arrancar (por ejemplo porque ese certificado cambió), Rustty muestra el **motivo real del fallo** con instrucciones, no un simple «sesión cerrada».

  **Ventana del escritorio remoto.** Puedes elegir cómo abre la ventana el cliente: *ventana redimensionable* (por defecto), *pantalla completa*, *área de trabajo* o *tamaño fijo*. El valor por defecto está en **Preferencias → Sistema** y cada perfil RDP puede llevar el suyo propio, que manda sobre el global.

  La ventana redimensionable y la pantalla completa piden **resolución dinámica**: puedes maximizar o arrastrar la ventana y el escritorio remoto sigue el tamaño. Eso necesita un servidor Windows 8 / Server 2012 o superior; contra servidores más antiguos usa *tamaño fijo*, que es el comportamiento clásico. Con `xfreerdp`, **Ctrl+Alt+Intro** alterna pantalla completa en cualquier momento.
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

En **Windows**, la contraseña del perfil se entrega al Escritorio remoto dejándola como credencial `TERMSRV/<host>` en el Gestor de credenciales justo antes de conectar (por la API nativa del sistema, nunca por línea de comandos), así `mstsc` entra directo sin volver a pedirla. Al cerrar la última sesión de ese host, Rustty retira la credencial; si ya existía una guardada por ti antes de usar Rustty, no se borra. En **Linux**, la contraseña nunca viaja como argumento visible en `ps`. Con FreeRDP 3 se entrega por su mecanismo `FREERDP_ASKPASS`, leyéndola de un fichero anónimo en memoria que el cliente hereda: no toca el disco ni el entorno del proceso. Con FreeRDP 2 y `rdesktop` se entrega por entrada estándar.

Si un perfil RDP **no** tiene contraseña guardada, FreeRDP 3 no puede pedírtela (necesitaría un terminal, y no lo hay). En ese caso Rustty avisa de que hace falta guardarla en el perfil, en vez de mostrar el volcado de errores del cliente.

VNC y Telnet no reciben contraseñas desde Rustty. El visor VNC o el cliente Telnet piden sus credenciales si las necesitan. Rustty guarda y sincroniza los metadatos del perfil (host, puerto, nombre, workspace, notas, etc.), pero no inyecta secretos en esos clientes externos.

## Limitaciones

Los perfiles externos no usan el terminal embebido de Rustty. Por eso no tienen búsqueda de buffer, snippets remotos, editor multilínea, restauración visual de pantalla, grabación de sesión, panel SFTP asociado ni túneles SSH sobre esa sesión.

Para túneles, usa un perfil SSH y levanta el túnel desde el panel **Túneles SSH**. Para transferencia de ficheros, usa SFTP, FTP o FTPS.
