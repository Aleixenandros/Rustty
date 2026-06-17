# Migración del IPC de terminal a `Channel` binario

> Estado: **IMPLEMENTADO en v1.32.0** (2026-06-18) · Creado: 2026-06-15
> Ámbito: rendimiento del streaming de datos del terminal (SSH y consola local).
> Relacionado: fix del cuelgue con `cat` de logs grandes (WebGL + cola con descarte + buffer de 64 KiB).
>
> ## Resumen de lo implementado
>
> - `ssh_connect` y `local_shell_open` reciben `on_data: Channel<tauri::ipc::Response>`.
> - Backend: `SshManager::connect`/`run_session_with_reconnect`/`run_session` y
>   `LocalShellManager::open` envían el caudal con `on_data.send(Response::new(bytes))`
>   (`InvokeResponseBody::Raw`); el canal se clona por intento de reconexión.
> - **Coalescing SSH**: `SSH_DATA_FLUSH_THRESHOLD` = 32 KiB con vaciado por
>   inactividad `SSH_DATA_FLUSH_QUIET` = 4 ms (rama de timer en el `select!`) y
>   flush final al cerrar. Consola local: bloques de 64 KiB (sin coalescing extra).
> - Frontend: `import { Channel }`, `channelBytesToU8` (defensivo), handler de
>   datos movido a `dataChannel.onmessage` en `registerSshListeners`,
>   `openLocalShell` y `reconnectLocalInPlace`; se pasa `onData` a los `invoke`.
> - Eliminados `EventKind::SshData`/`ShellData` (ipc.rs) y `EVENT_PREFIX.sshData`/
>   `shellData` (events.js) con sus tests.
> - **Fase 0 resuelta por análisis de fuentes** (`tauri-2.10.3/src/ipc/channel.rs`):
>   el payload de `onmessage` es siempre `ArrayBuffer` y el umbral binario nativo
>   es `MAX_RAW_DIRECT_EXECUTE_THRESHOLD` = 1024 B. `cargo test` (71) + vitest (24)
>   + `vite build` verdes. **Pendiente**: medición comparativa de CPU/RAM y prueba
>   multiplataforma (WebKitGTK/WebView2/WKWebView) en máquina real.

## 1. Motivación

Hoy el caudal de bytes del terminal se entrega al frontend con el sistema de
eventos de Tauri:

- `src-tauri/src/ssh_manager.rs:1247` y `:1255` → `app_handle.emit("ssh-data-{id}", data.to_vec())`
- `src-tauri/src/local_shell_manager.rs:107` → `app_handle.emit("shell-data-{id}", buf[..n].to_vec())`

`emit` serializa el payload con `serde_json`. Un `Vec<u8>` se convierte en un
**array JSON de enteros** (`[104,101,108,...]`), con dos costes:

1. **Inflado ~3-4×**: un chunk de 64 KiB viaja como ~200-250 KB de texto.
2. **Coste en el frontend**: `JSON.parse` reconstruye un array de `Number`s
   (presión de GC) y luego `new Uint8Array(array)` copia byte a byte.

Para salida sostenida (descargas de MB/s, `journalctl -f` ruidoso, `yes`) este
coste por byte marca el techo de rendimiento del terminal, independientemente
del renderer.

## 2. Objetivo

Sustituir el transporte del **stream de datos** por `tauri::ipc::Channel`, que
entrega los bytes como `ArrayBuffer` binario en el frontend (sin pasar por JSON).
Los eventos de **control** (baja frecuencia) se quedan como están.

| Evento            | Frecuencia | Transporte tras la migración |
| ----------------- | ---------- | ---------------------------- |
| `ssh-data-*`      | Alta       | **Channel (binario)**        |
| `shell-data-*`    | Alta       | **Channel (binario)**        |
| `ssh-closed-*`    | Baja       | `emit` (sin cambios)         |
| `ssh-error-*`     | Baja       | `emit` (sin cambios)         |
| `ssh-connected-*` | Baja       | `emit` (sin cambios)         |
| `ssh-log-*`       | Baja       | `emit` (sin cambios)         |
| `shell-closed-*`  | Baja       | `emit` (sin cambios)         |

Acotar el cambio al caudal de datos mantiene el riesgo bajo: el resto del
protocolo de sesión (reconexión, overlays, logs) no se toca.

## 3. Cómo transporta bytes `Channel` en Tauri v2 (importante)

`Channel<T>` exige `T: IpcResponse`. Para bytes crudos se envía
`InvokeResponseBody::Raw(bytes)` (o el envoltorio `tauri::ipc::Response::new(bytes)`,
equivalente). El runtime entonces:

- Si el payload **supera** `MAX_RAW_DIRECT_EXECUTE_THRESHOLD` → usa el canal
  binario nativo (rápido, sin JSON). **Este es el caso que nos interesa.**
- Si el payload es **pequeño** → todavía lo emite como
  `new Uint8Array([...array json...]).buffer`, es decir, sigue pagando la
  serialización JSON aunque acabe en `ArrayBuffer`.

**Conclusión:** el beneficio binario solo se materializa con **chunks grandes**.
Por eso esta migración debe ir acompañada de coalescing en el origen:

- Consola local: ya leemos en bloques de 64 KiB (hecho).
- SSH: `russh` entrega `ChannelMsg::Data` de tamaño variable (a menudo < 32 KiB).
  Conviene **acumular** datos contiguos hasta ~32-64 KiB (o hasta que el canal
  se vacíe momentáneamente) antes de `channel.send`, para cruzar el umbral.

`Channel` **garantiza el orden** de entrega, requisito imprescindible para un
terminal.

## 4. Diseño

### Backend
- `SshManager::connect` y `LocalShellManager::open` reciben un
  `Channel<tauri::ipc::Response>` adicional y lo mueven al hilo/loop de E/S.
- El loop de E/S sustituye `emit("…-data-…")` por `channel.send(Response::new(bytes))`.
- Se conserva `app_handle` para los eventos de control.
- **Reconexión**: cada `ssh_connect` recibe un canal nuevo creado por el
  frontend; no se reutilizan canales entre reconexiones.

### Frontend
- Importar `Channel` desde `@tauri-apps/api/core`.
- Antes de `invoke("ssh_connect"/"local_shell_open", …)`, crear
  `const dataChannel = new Channel()`, asignar `dataChannel.onmessage` con el
  handler de datos actual y pasar `dataChannel` como argumento del `invoke`.
- El handler de datos se **mueve** del callback de `listen("…-data-…")` a
  `dataChannel.onmessage`. Se eliminan los `listen("ssh-data-*")` y
  `listen("shell-data-*")`.
- `onmessage` recibe el payload como `ArrayBuffer` (verificar empíricamente; ver
  §7). El resto de la cadena no cambia: `decoder.decode` →
  `filterSuppressedTerminalOutput` → `applyHighlightRules` →
  `enqueueTerminalOutput` → `captureScreenChunk`.

## 5. Cambios por archivo

| Archivo | Punto actual | Cambio |
| ------- | ------------ | ------ |
| `src-tauri/src/commands.rs` | `ssh_connect` (175-230) | Añadir parámetro `on_data: Channel<Response>` y pasarlo a `ssh_state.connect(...)` |
| `src-tauri/src/commands.rs` | `local_shell_open` (543-552) | Añadir parámetro `on_data: Channel<Response>` y pasarlo a `shell_state.open(...)` |
| `src-tauri/src/ssh_manager.rs` | `connect(...)` firma + loop E/S (1238-1262) | Aceptar el canal; reemplazar los dos `emit("ssh-data-…")` (1247, 1255) por `on_data.send(...)`; añadir coalescing |
| `src-tauri/src/local_shell_manager.rs` | `open(...)` firma + hilo lectura (94-107) | Aceptar el canal; reemplazar `emit("shell-data-…")` (107) por `on_data.send(...)` |
| `src/main.js` | imports (6-7) | `import { Channel } from "@tauri-apps/api/core";` |
| `src/main.js` | `registerSshListeners` (9668+) e `invoke("ssh_connect")` (7472, 8492) | Crear `Channel`, mover el handler de `listen("ssh-data-*")` (9672) a `channel.onmessage`, pasar el canal al `invoke` |
| `src/main.js` | `openLocalShell` (11078) y `reconnectLocalInPlace` (8429) | Crear `Channel`, mover el handler de `listen("shell-data-*")` (8440, 11087) a `channel.onmessage`, pasar el canal al `invoke` |

> Nota: el handler de `ssh-data` en el frontend obtiene `s = sessions.get(sessionId)`
> en cada mensaje; conservar ese patrón dentro de `onmessage`.

## 6. Tareas

### Fase 0 — Spike de validación (1 sesión)
- [ ] Prototipar un comando de prueba que envíe ~64 KiB por `Channel<Response>` y
      confirmar en el frontend el **tipo exacto** del payload de `onmessage`
      (`ArrayBuffer` vs `Uint8Array`) y que NO pasa por JSON (medir).
- [ ] Confirmar la firma de `channel.send` con `tauri::ipc::Response::new(...)`
      frente a `InvokeResponseBody::Raw(...)` y fijar cuál se usa.

### Fase 1 — Consola local (camino más simple, sin reconexión SSH)
- [ ] `local_shell_open`: añadir parámetro `Channel`.
- [ ] `LocalShellManager::open`: aceptar y usar el canal en el hilo de lectura.
- [ ] Frontend `openLocalShell`: crear canal, `onmessage`, pasar al `invoke`,
      eliminar `listen("shell-data-*")`.
- [ ] Frontend `reconnectLocalInPlace`: ídem (canal nuevo por reconexión).
- [ ] `cargo check` + `vite build` verdes.
- [ ] Prueba manual: `cat` de un fichero grande en consola local; medir CPU/fluidez.

### Fase 2 — SSH
- [ ] `ssh_connect`: añadir parámetro `Channel`.
- [ ] `SshManager::connect`: aceptar el canal; reemplazar ambos `emit("ssh-data-…")`.
- [ ] Implementar **coalescing** en el loop (acumular hasta ~32-64 KiB / vaciado).
- [ ] Frontend conexión (7472) y reconexión (8492): crear canal, `onmessage`,
      pasar al `invoke`, eliminar `listen("ssh-data-*")`.
- [ ] `cargo check` + `vite build` verdes.
- [ ] Pruebas manuales contra servidor real (ver §7).

### Fase 3 — Limpieza y cierre
- [ ] Verificar que no quedan `listen("ssh-data"|"shell-data")` ni `emit("…-data-…")`.
- [ ] Revisar `closeSession` / `_closeOverride`: el canal se libera al cerrar la
      sesión (no requiere `unlisten`, pero confirmar que no se reutiliza).
- [ ] Actualizar CHANGELOG y, si procede, README.
- [ ] Actualizar la memoria del proyecto (`perf_terminal_massive_output.md`).

## 7. Plan de validación

- **Funcional**: conexión, reconexión (host key, caída de red), salida normal,
  colores/secuencias ANSI, `vim`/`top`/`htop`, redimensionado.
- **Carga**: `cat` de log de 10-100 MB, `yes | head -c 200M`, `journalctl -f`.
  Comparar antes/después: uso de CPU del proceso de la WebView, fluidez del
  scroll, tiempo hasta volver al prompt.
- **Orden e integridad**: que no haya bytes perdidos ni reordenados; que el
  aviso de "salida omitida" siga funcionando bajo ráfaga extrema.
- **Multiplataforma**: Linux (WebKitGTK), Windows (WebView2), macOS (WKWebView).
- **Verde de build**: `cargo check` y `npx vite build` en cada fase.

## 8. Riesgos y mitigación

- **Tipo del payload en `onmessage`**: incierto hasta el spike (Fase 0). Manejar
  defensivamente `ArrayBuffer`/`Uint8Array`.
- **Carrera dato/control**: el último `data` (Channel) y el `closed` (emit) viajan
  por vías distintas; el `closed` podría adelantarse al último chunk. Impacto bajo
  (solo afecta a un overlay/mensaje final); si molesta, drenar la cola del front
  antes de pintar el overlay de cierre.
- **Chunks pequeños sin coalescing en SSH**: anularían el beneficio (siguen yendo
  por JSON). El coalescing de Fase 2 es obligatorio, no opcional.
- **Regresión en reconexión**: cubrir explícitamente en pruebas; el canal debe
  recrearse en cada `invoke`.

## 9. Rollback

Cambio aislable en una rama. Si surge regresión, revertir restaura el modelo
`emit`/`listen` actual sin tocar el resto del protocolo de sesión. La red de
seguridad del frontend (WebGL + cola con descarte) permanece intacta en cualquier
caso.

## Referencias

- Tauri v2 — Calling the Frontend (Channels): https://v2.tauri.app/develop/calling-frontend/
- Tauri v2 — Calling Rust (`ipc::Response` para binario): https://v2.tauri.app/develop/calling-rust/
- Fuente `tauri/ipc/channel.rs` (`send`, `InvokeResponseBody::Raw`, umbral): https://docs.rs/tauri/latest/x86_64-apple-ios/src/tauri/ipc/channel.rs.html
- Issue: Deprecate JSON in IPC — https://github.com/tauri-apps/tauri/issues/7706
