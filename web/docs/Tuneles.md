# Túneles SSH

Rustty permite crear redirecciones de puertos sin lanzar un proceso externo de `ssh`. Puedes gestionarlas desde el panel de una sesión SSH concreta o desde el acceso global de túneles del rail lateral.

## Abrir desde una sesión

1. Conecta a un perfil SSH.
2. Pulsa el botón **⇄** de la pestaña.
3. El panel muestra el formulario de nuevo túnel y la lista de túneles activos.

También puedes hacer clic derecho sobre un perfil SSH en la sidebar y usar **Nuevo túnel…**. Si el perfil aún no tiene sesión abierta, Rustty intentará conectarlo primero.

## Abrir desde el acceso global

El rail lateral incluye un botón **⇄ Túneles SSH**. Desde ahí puedes:

- Crear un túnel eligiendo el perfil SSH de destino.
- Ver todos los túneles activos de las sesiones abiertas.
- Arrancar túneles guardados de cualquier perfil SSH.
- Detener túneles activos o borrar túneles guardados.

Si el perfil elegido ya tiene una sesión SSH conectada, Rustty reutiliza esa sesión. Si no hay sesión activa, abre una conexión nueva y levanta el túnel cuando la autenticación termina correctamente.

## Tipos soportados

### Local (`-L`)

Escucha en tu equipo y reenvía hacia un destino visto desde el servidor SSH:

```text
127.0.0.1:8080 -> remote-host:80
```

Equivale a:

```bash
ssh -L 8080:remote-host:80 usuario@servidor
```

### Remoto (`-R`)

Pide al servidor SSH que escuche un puerto remoto y lo reenvíe hacia tu equipo local:

```text
servidor:9000 -> 127.0.0.1:3000
```

Equivale a:

```bash
ssh -R 9000:127.0.0.1:3000 usuario@servidor
```

La dirección remota real puede depender de la configuración del servidor SSH, especialmente de `GatewayPorts`.

### Dinámico / SOCKS (`-D`)

Crea un proxy SOCKS5 local:

```text
127.0.0.1:1080 SOCKS
```

Equivale a:

```bash
ssh -D 1080 usuario@servidor
```

## Guardar y autoconectar

Al crear un túnel puedes marcar:

- **Guardar**: lo añade al perfil para reutilizarlo más adelante.
- **Auto**: lo guarda y lo levanta automáticamente cuando la sesión SSH del perfil se conecte.

Los túneles guardados forman parte del perfil, así que viajan con copias de seguridad y sincronización cifrada.

## Estado y tráfico

La lista del panel y la vista global muestran:

- Tipo de túnel.
- Dirección de escucha y destino.
- Perfil o sesión asociada.
- Tráfico subido / descargado.
- Botón para cerrar el túnel.

Al cerrar la sesión SSH, Rustty cierra también todos los túneles asociados.
