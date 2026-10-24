# Pruebas de la aplicación

`npm run e2e:smoke` abre el binario debug con `tauri-driver` y WebKitWebDriver,
un directorio de datos temporal y un HOME de prueba. Comprueba la consola local,
la recuperación inicial desde una nube cifrada local, la conservación de
preferencias y nombres, el botón de sincronización lateral (configuración
guardada, progreso, cancelación y reintento), los permisos del IPC y una transferencia SFTP contra
un `sshd` efímero. No utiliza cuentas de nube ni secretos reales.

También crea una carpeta y mueve dos conexiones desde la interfaz: comprueba
que llegan al backend cifrado, que el mensaje y el historial cuentan los
cambios enviados y que repetir la sincronización indica que todo está al día.

La pestaña de sincronización se prueba además ante un keyring del SO que
rechaza las escrituras y una cuenta de Drive cuyo token ha desaparecido: el
aviso nombra al keyring (no al backend) con el detalle técnico, el estado de la
cuenta lo dice y «Desconectar» avisa aunque no quede nada que desconectar. Se
simula en el renderer, sin tocar el keyring ni ninguna cuenta.

La sección de atajos recorre Preferencias con eventos de teclado en el WebView,
captura combinaciones ya asignadas sin ejecutarlas, cancela con Escape, cambia y
restablece atajos, confirma/cancela presets y abre el formulario de conexión con
una combinación personalizada. Comprueba el foco y los datos persistidos; no
simula la distribución física del teclado ni los atajos reservados por el SO.

La sección de diálogos (`dialogs.mjs`) comprueba el controlador común: el foco
entra al abrir Nueva conexión y vuelve a quien la abrió al cerrar, el fondo
queda inerte (salvo los tiradores de la ventana), Escape en el selector de
carpeta no cierra el formulario ni borra lo escrito, Tab y Shift+Tab dan la
vuelta en los extremos, Ctrl+W y Ctrl+, no actúan detrás de un modal (el zoom
de la interfaz sí), Escape en known_hosts no cierra Preferencias y una
confirmación destructiva es `alertdialog` con el foco en «Cancelar». Como
WebKitWebDriver no mueve el foco con eventos sintéticos, solo prueba lo que el
controlador hace de forma explícita.

El panel de túneles se comprueba en claro, oscuro y una ventana de 800 px:
controles de cabecera juntos, contenido sin desbordar, minimizar/reabrir,
cerrar y confirmar/cancelar el borrado de un túnel guardado. Las capturas se
guardan en `E2E_ARTIFACT_DIR`; no se abren conexiones SSH para esta sección.

En Linux hacen falta `cargo build --locked` en `src-tauri/`, `npm ci`,
`tauri-driver` 2.1.0, WebKitWebDriver, `wmctrl` y un escritorio con gestor de
ventanas. `TAURI_DRIVER` permite indicar la ruta del controlador. Con Rustty
abierto, usar un bus aparte para que la instancia única no enfoque la app real:

```sh
dbus-run-session -- npm run e2e:smoke
```

Para un escritorio virtual independiente:

```sh
npm run e2e:headless
```

Este comando necesita además Xvfb, xauth, Openbox y D-Bus. Conserva logs y
capturas en `E2E_ARTIFACT_DIR`, o en una carpeta temporal si no se indica.
`openssh-server` habilita la sección SFTP; con `E2E_REQUIRE_SFTP=1` su ausencia
es un error en lugar de omitirla. Los diálogos nativos se detectan y cancelan;
elegir archivos dentro del selector sigue requiriendo validación manual.

El workflow **E2E Rustty** se lanza desde GitHub Actions → Run workflow. Ejecuta
la misma prueba bajo Xvfb/Openbox con SFTP obligatorio y publica logs y capturas
durante siete días, también cuando falla. Solo tiene permisos de lectura del
repositorio. No forma parte del proceso que compila y publica releases.
