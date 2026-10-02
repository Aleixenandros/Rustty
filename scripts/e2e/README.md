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

La sección de atajos recorre Preferencias con eventos de teclado en el WebView,
captura combinaciones ya asignadas sin ejecutarlas, cancela con Escape, cambia y
restablece atajos, confirma/cancela presets y abre el formulario de conexión con
una combinación personalizada. Comprueba el foco y los datos persistidos; no
simula la distribución física del teclado ni los atajos reservados por el SO.

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
