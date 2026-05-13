# Bienvenido a Rustty

**Rustty** es un cliente de terminal y gestor de conexiones multiplataforma. Soporta **SSH**, **SFTP** y **RDP** en la misma aplicación, con una implementación 100 % Rust del backend SSH/SFTP (sin dependencia de `libssh2`) y una interfaz moderna sobre **Tauri** + **xterm.js**.

## ¿Qué puede hacer?

- Abrir varias sesiones SSH a la vez y organizarlas en pestañas o vistas divididas.
- Listar, abrir conexiones SSH guardadas y ejecutar comandos remotos desde terminal con el [CLI SSH](?page=CLI), sin abrir la interfaz gráfica.
- Agrupar tus conexiones en **perfiles-contenedor (workspaces)** independientes con sus propias carpetas, mover conexiones en lote con selección múltiple, marcarlas como **favoritas** y alternar la sidebar entre *Workspace actual*, *Todos los perfiles* y *Favoritos* desde el botón ≡ de la cabecera. Al cambiar de pestaña, Rustty selecciona automáticamente la conexión asociada en la barra lateral y recuerda el árbol de carpetas abierto entre reinicios.
- Probar una conexión desde el modal antes de guardarla, ver el diagnóstico SSH por etapas en la barra inferior y consultar el centro global de actividad desde el acceso **Historial y logs** del rail.
- Transferir ficheros con un **panel SFTP** integrado de **vista dividida remoto / local**, transferencia recursiva de carpetas, seguimiento del directorio del terminal y elevación a `sudo` cuando el servidor lo permita.
- Crear **túneles SSH** locales, remotos y dinámicos / SOCKS desde una sesión activa o desde el acceso global **⇄** del rail, con panel de estado, tráfico, túneles guardados y autoconexión opcional por perfil.
- Configurar opciones avanzadas SSH por perfil: **keep-alive**, **ProxyJump**, **agent forwarding**, **X11 forwarding** y compatibilidad opcional con cifrados / kex / MAC legacy.
- Buscar dentro del buffer del terminal con `Ctrl+F` y filtrar perfiles desde la barra lateral.
- Guardar contraseñas y passphrases en el **keyring del sistema** (KWallet, GNOME Keyring, Keychain, Credential Store) o tomarlas de una base **KeePass** (`.kdbx`).
- Crear **copias de seguridad cifradas** y sincronizar perfiles, carpetas, preferencias, temas, snippets y atajos con Google Drive, iCloud Drive, una carpeta local/NAS o WebDAV. La sincronización se dispara al iniciar y al detectar cambios; puedes restaurar snapshots anteriores cuando lo necesites.
- Personalizar la apariencia con **temas base y variantes** (Catppuccin, Dracula, Nord, Solarized, Gruvbox, Tokyo Night…), tema del terminal independiente del de UI, fuente configurable y atajos de teclado editables.
- Lanzar **escritorio remoto RDP** mediante `xfreerdp`, `rdesktop`, `mstsc` o el cliente registrado del sistema, según plataforma.
- Recordar tamaño y posición de la ventana y comprobar actualizaciones al iniciar si lo activas.

## Primeros pasos

1. [Descarga](/descargas) el binario para tu plataforma.
2. Abre Rustty, pulsa **+** en la barra lateral para crear tu primera conexión.
3. Rellena host, usuario y método de autenticación. Pulsa **Guardar y conectar**.
4. Para ver el panel de ficheros, haz clic en el icono **SFTP** dentro de la sesión SSH abierta. Para túneles, usa el icono **⇄** de la pestaña o el acceso **⇄** del rail lateral.
5. Configura tus copias en **Preferencias → Copias de seguridad** si quieres mover Rustty entre equipos.

## ¿Problema o duda?

Abre un issue en [GitHub](https://github.com/Aleixenandros/Rustty/issues) o escríbeme por la [página del repositorio](https://github.com/Aleixenandros/Rustty).
