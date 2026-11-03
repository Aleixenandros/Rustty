# Clientes externos

Rustty integra SSH, SFTP, FTP y FTPS dentro de la aplicación. En cambio, **RDP**, **VNC** y **Telnet** se gestionan como perfiles de Rustty pero se abren en clientes externos del sistema. RDP puede verse también dentro de la pestaña, con el [cliente integrado](#rdp-dentro-de-la-pestaña-cliente-integrado), si lo eliges en Preferencias.

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

- **RDP**: por defecto se abre en una ventana externa; si en **Preferencias → RDP** eliges «En la pestaña», lo abre el [cliente integrado](#rdp-dentro-de-la-pestaña-cliente-integrado) y lo que sigue no aplica. Usa el cliente de escritorio remoto del sistema. En Linux prueba `xfreerdp3`, `xfreerdp` y `rdesktop`; en Windows abre `mstsc.exe` o el manejador `rdp://`; en macOS abre el cliente registrado para `rdp://`. Al usar `xfreerdp` en Linux, Rustty aplica verificación de certificado basada en TOFU (`/cert:tofu`) en vez de ignorar la verificación en silencio, de modo que el cliente recuerda el certificado del servidor y advierte al usuario si cambia de forma inesperada. Si el cliente externo muere nada más arrancar, Rustty muestra el **motivo real del fallo**, no un simple «sesión cerrada»; y cuando el motivo es que el certificado cambió, enseña la huella recordada y la recibida y ofrece aceptar el cambio: al aceptar, olvida el certificado guardado y reconecta en la misma pestaña.

  **Ventana del escritorio remoto.** Puedes elegir cómo abre la ventana el cliente: *ventana redimensionable* (por defecto), *pantalla completa*, *área de trabajo* o *tamaño fijo*. El valor por defecto está en **Preferencias → RDP** y cada perfil RDP puede llevar el suyo propio, que manda sobre el global.

  La ventana redimensionable y la pantalla completa piden **resolución dinámica**: puedes maximizar o arrastrar la ventana y el escritorio remoto sigue el tamaño. Eso necesita un servidor Windows 8 / Server 2012 o superior; contra servidores más antiguos usa *tamaño fijo*, que es el comportamiento clásico. Con `xfreerdp`, **Ctrl+Alt+Intro** alterna pantalla completa en cualquier momento.
- **VNC**: abre un visor VNC externo. En Linux prueba TigerVNC / `vncviewer`; en macOS usa Pantalla compartida mediante `vnc://`; en Windows prueba `vncviewer.exe`, `tvnviewer.exe` o el manejador `vnc://`.
- **Telnet**: abre el comando `telnet` en un emulador de terminal del sistema. Telnet no cifra el tráfico, así que conviene reservarlo para equipos antiguos, redes controladas o tareas puntuales.

## RDP dentro de la pestaña (cliente integrado)

En **Preferencias → RDP → Abrir el escritorio remoto (RDP)** puedes elegir **En la pestaña**: el escritorio remoto se dibuja dentro de Rustty, sin ventana aparte y sin necesitar `xfreerdp` ni `mstsc`. Es un cliente nuevo y por eso no es el predeterminado: si algo no funciona con tu servidor (audio, varios monitores, impresoras, servidores que exigen Kerberos o redirigen la sesión), vuelve a la ventana externa.

- **Credenciales**: las mismas que el resto de Rustty (contraseña del perfil, credencial maestra o KeePass). Las resuelve el backend; la interfaz solo las ve si no hay ninguna guardada y te la pide. Se autentica con NLA (CredSSP) sobre TLS y nunca con la seguridad heredada de RDP.
- **Certificado del servidor**: la primera vez se enseña su huella SHA-256 y se pide confirmarla, como con las claves SSH. Si después cambia, se avisa con las dos huellas según «Preguntar si el certificado de un servidor RDP cambia» (Preferencias → RDP). En los dos casos, **ninguna credencial sale del equipo** hasta que decides.
- **Tamaño del escritorio**: por defecto **se ajusta a la pestaña**. Al cambiar el tamaño de la ventana, maximizarla, plegar la barra lateral, dividir la vista o cambiar de pantalla, el escritorio remoto se redimensiona al hueco que queda (un instante después de soltar), sin reconectar. Necesita que el servidor ofrezca *Display Control* (Windows 8.1 / Server 2012 R2 o superior, GNOME Remote Desktop y xrdp recientes); si no lo ofrece, la imagen se escala para llenar la pestaña sin deformarse.
- **Resolución fija**: con clic derecho en la pestaña, **Resolución** ofrece *Ajustar a la pestaña* y tamaños habituales (de 1024 × 768 a 2560 × 1440); la marca indica el elegido. Con un tamaño fijo, el escritorio se escala para caber entero en la pestaña, centrado y con bandas si la proporción no coincide. La elección es de esa pestaña y se conserva al reconectar en ella. Si el servidor no admite el cambio en caliente, elegir una resolución reconecta la sesión en la misma pestaña a ese tamaño (se avisa con un mensaje).
- **Rendimiento**: *Velocidad*, *Equilibrado* (por defecto) o *Calidad* deciden qué se pide al servidor (fondo, temas, animaciones, compresión).
- **Portapapeles compartido** (activo por defecto): el texto copiado en un lado se pega en el otro. Lo copiado en local se ofrece al remoto al volver a la pestaña o al pegar.
- **Ficheros y carpetas por el portapapeles** (apagado por defecto):
  - Lo que copias **en el remoto** no se descarga solo: Rustty avisa de cuántos ficheros son y cuánto ocupan, y solo si pulsas **Guardar en…** y eliges una carpeta se descargan ahí (no vale la carpeta personal entera ni ninguna que toque `~/.ssh` o los datos de Rustty: el remoto podría dejar un `.profile` o un `.bash_login` que no existían). Nunca se sobrescribe nada (un nombre ocupado se guarda como «nombre (2)»), los nombres se validan (sin `..`, rutas absolutas ni nombres reservados de Windows), la copia tiene un tope de 8 GiB y 20 000 entradas, y si falla o la cancelas se borra lo que se llevaba copiado.
  - Lo que copias **en local** queda a disposición del remoto en cuanto lo anuncias (al volver a la pestaña): el servidor puede leerlo aunque nadie pegue. Si parece sensible —una clave privada, algo de `~/.ssh` o de la carpeta de datos de Rustty—, se pregunta antes con un diálogo del sistema.
- **Carpeta compartida** (apagada por defecto): una carpeta que eliges con **Elegir carpeta…** aparece en el Explorador del remoto como unidad, con lectura y escritura. Solo esa carpeta, sin seguir enlaces fuera de ella. No se puede compartir la carpeta personal entera ni ninguna que contenga tus claves SSH o los datos de Rustty.

Los saltos SSH funcionan igual que con el cliente externo: la conexión viaja por el túnel y el certificado que se confirma es el del servidor de destino.

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

En Windows, RDP usa el cliente del sistema `mstsc.exe` (o el integrado de Rustty, si lo eliges). Para VNC instala un visor compatible (`vncviewer.exe`, TightVNC u otro que registre `vnc://`). Para Telnet puede hacer falta activar el **Cliente Telnet** en las características opcionales de Windows.

En macOS, VNC usa la app nativa de **Pantalla compartida**. RDP requiere un cliente que registre `rdp://`, como Microsoft Remote Desktop. Telnet se abre en Terminal.app, pero en versiones modernas de macOS quizá tengas que instalar el binario `telnet` aparte.

## Credenciales

RDP comparte el flujo normal de credenciales de Rustty: contraseña propia, credencial maestra o KeePass, siempre sin guardar secretos en `profiles.json`.

En **Windows**, la contraseña del perfil se entrega al Escritorio remoto dejándola como credencial `TERMSRV/<host>` en el Gestor de credenciales justo antes de conectar (por la API nativa del sistema, nunca por línea de comandos), así `mstsc` entra directo sin volver a pedirla. Al cerrar la última sesión de ese host, Rustty retira la credencial; si ya existía una guardada por ti antes de usar Rustty, no se borra. En **Linux**, la contraseña nunca viaja como argumento visible en `ps`. Con FreeRDP 3 se entrega por su mecanismo `FREERDP_ASKPASS`, leyéndola de un fichero anónimo en memoria que el cliente hereda: no toca el disco ni el entorno del proceso. Con FreeRDP 2 y `rdesktop` se entrega por entrada estándar.

Si un perfil RDP **no** tiene contraseña guardada, FreeRDP 3 no puede pedírtela (necesitaría un terminal, y no lo hay). En ese caso Rustty avisa de que hace falta guardarla en el perfil, en vez de mostrar el volcado de errores del cliente.

VNC y Telnet no reciben contraseñas desde Rustty. El visor VNC o el cliente Telnet piden sus credenciales si las necesitan. Rustty guarda y sincroniza los metadatos del perfil (host, puerto, nombre, workspace, notas, etc.), pero no inyecta secretos en esos clientes externos.

## Limitaciones

Los perfiles externos no usan el terminal embebido de Rustty. Por eso no tienen búsqueda de buffer, snippets remotos, editor multilínea, restauración visual de pantalla, grabación de sesión, panel SFTP asociado ni túneles SSH sobre esa sesión.

Para túneles, usa un perfil SSH y levanta el túnel desde el panel **Túneles SSH**. Para transferencia de ficheros, usa SFTP, FTP o FTPS.
