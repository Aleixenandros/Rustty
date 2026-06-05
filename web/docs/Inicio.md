# Bienvenido a Rustty

**Rustty** es un cliente de terminal y gestor de conexiones multiplataforma. Soporta **SSH**, **SFTP** y **RDP** en la misma aplicación, con una implementación 100 % Rust del backend SSH/SFTP (sin dependencia de `libssh2`) y una interfaz moderna sobre **Tauri** + **xterm.js**.

## ¿Qué puede hacer?

- Abrir varias sesiones SSH a la vez y organizarlas en pestañas o vistas divididas.
- Listar, abrir conexiones SSH guardadas y ejecutar comandos remotos desde terminal con el [CLI SSH](?page=CLI), sin abrir la interfaz gráfica.
- Agrupar tus conexiones en **perfiles-contenedor (workspaces)** independientes con sus propias carpetas, mover conexiones en lote con selección múltiple, marcarlas como **favoritas** y alternar la sidebar entre *Workspace actual*, *Todos los perfiles* y *Favoritos* desde el botón ≡ de la cabecera. La cabecera incluye un icono 🔍 de búsqueda rápida que abre solo el cuadro de filtro y un atajo global `Ctrl+K`. Al cambiar de pestaña, Rustty selecciona automáticamente la conexión asociada en la barra lateral y recuerda el árbol de carpetas abierto entre reinicios.
- **Ordenar conexiones** alfabéticamente (por defecto) o de forma **manual** con flechas *Mover arriba / abajo* en el menú contextual. El orden manual se guarda por carpeta y workspace.
- **Anclar conexiones al dashboard** para tenerlas como tiles grandes en la pantalla de bienvenida desde el menú contextual ("Anclar / desanclar del dashboard"). Cada tile muestra el color de la carpeta del perfil y, en conexiones SSH, un botón secundario para abrir directamente el panel SFTP.
- **Zoom de UI** con `Ctrl+Alt +/-/0` para escalar el rail, la sidebar y las pestañas sin afectar al tamaño del terminal.
- Probar una conexión desde el modal antes de guardarla, ver el diagnóstico SSH por etapas en la barra inferior y consultar el centro global de actividad desde el acceso **Historial y logs** del rail.
- Navegar el directorio remoto desde un **breadcrumb clicable** en la barra inferior: pulsa un segmento de la ruta para llevar el panel SFTP a esa carpeta, o copia la ruta completa al portapapeles.
- Transferir ficheros con un **panel SFTP** integrado de **vista dividida remoto / local**, transferencia recursiva de carpetas, seguimiento del directorio del terminal y elevación a `sudo` cuando el servidor lo permita.
- Crear **túneles SSH** locales, remotos y dinámicos / SOCKS desde una sesión activa o desde el acceso global **⇄** del rail, con panel de estado, tráfico, túneles guardados y autoconexión opcional por perfil.
- Configurar opciones avanzadas SSH por perfil: **keep-alive**, **ProxyJump**, **agent forwarding**, **X11 forwarding** y compatibilidad opcional con cifrados / kex / MAC legacy.
- Buscar dentro del buffer del terminal con `Ctrl+F` y filtrar perfiles desde la barra lateral.
- Redactar comandos largos con el **editor multilínea** (`Ctrl+Shift+E`): una hoja flotante que guarda un borrador por perfil y, al confirmar, inserta el comando en la sesión activa.
- Adjuntar una **nota Markdown por conexión (runbook)** con clic derecho: editor con previsualización en vivo, variables `${host}/${user}/…`, panel lateral junto a la sesión con casillas de tarea interactivas y sincronización. Ver la [guía de notas](?page=Notas).
- Abrir una **sesión privada / efímera** ("Abrir en privado" desde el menú del perfil) que no deja rastro en recientes, actividad, borradores ni grabación de sesión.
- **Iniciar Rustty con el sistema** y, opcionalmente, **arrancar minimizado** en la bandeja, desde **Preferencias → Sistema** (opt-in).
- **Exportar el historial** de una sesión a un fichero de texto desde el menú contextual de la pestaña: vuelca todo el buffer del terminal (comandos introducidos y salida del servidor) en texto plano.
- Renombrar pestañas con un **alias temporal** desde su menú contextual, sin modificar el perfil: útil al duplicar sesiones o abrir varias a la vez. Dejar el alias vacío restablece el nombre del perfil.
- **Desconectar todo** de golpe desde el botón de emergencia del rail o un atajo configurable: cierra las sesiones SSH, SFTP, RDP y consolas locales, cierra los túneles y cancela las transferencias en curso, tras confirmar con el recuento afectado.
- Guardar contraseñas y passphrases en el **keyring del sistema** (KWallet, GNOME Keyring, Keychain, Credential Store) o tomarlas de una base **KeePass** (`.kdbx`).
- Crear **copias de seguridad cifradas** y sincronizar perfiles, carpetas, preferencias, temas, notas, snippets y atajos con Google Drive, iCloud Drive, una carpeta local/NAS o WebDAV. La sincronización se dispara al iniciar y al detectar cambios; puedes restaurar snapshots anteriores cuando lo necesites.
- Personalizar la apariencia con **temas base y variantes** (Catppuccin, Dracula, Nord, Solarized, Gruvbox, Tokyo Night…), tema del terminal independiente del de UI, fuente configurable, **ligaduras tipográficas opcionales** (FiraCode, JetBrains Mono…) y **atajos de teclado** editables con presets *Vim-like* y *Tmux-like*.
- Lanzar **escritorio remoto RDP** mediante `xfreerdp`, `rdesktop`, `mstsc` o el cliente registrado del sistema, según plataforma.
- Recordar tamaño y posición de la ventana y **actualizarse automáticamente**: en Windows, macOS y AppImage de Linux, Rustty descarga e instala la nueva versión desde dentro de la app y se reinicia; en el resto de formatos de Linux avisa y abre la página de descargas.

## Primeros pasos

1. [Descarga](/descargas) el binario para tu plataforma.
2. Abre Rustty, pulsa **+** en la barra lateral para crear tu primera conexión.
3. Rellena host, usuario y método de autenticación. Pulsa **Guardar y conectar**.
4. Para ver el panel de ficheros, haz clic en el icono **SFTP** dentro de la sesión SSH abierta. Para túneles, usa el icono **⇄** de la pestaña o el acceso **⇄** del rail lateral.
5. Configura tus copias en **Preferencias → Copias de seguridad** si quieres mover Rustty entre equipos.

## ¿Problema o duda?

Abre un issue en [GitHub](https://github.com/Aleixenandros/Rustty/issues) o escríbeme por la [página del repositorio](https://github.com/Aleixenandros/Rustty).
