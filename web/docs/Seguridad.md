# Seguridad

Rustty está diseñado como aplicación local-first: no requiere cuenta propia, no envía telemetría y no tiene servidores de Rustty entre tu equipo y tus máquinas.

## Credenciales

- Las contraseñas guardadas van al keyring del sistema operativo.
- Las passphrases de claves privadas también pueden guardarse en el keyring.
- Las bases KeePass se descifran solo en memoria mientras están desbloqueadas.
- Los perfiles no guardan contraseñas en texto plano.
- La sincronización de contraseñas guardadas es opcional y viaja cifrada E2E dentro de `rustty-sync.bin`.
- La base KeePass desbloqueada nunca se sincroniza.
- En Unix, `profiles.json` se escribe con permisos privados `0600`.

## Sincronización cifrada

Cuando activas sincronización o exportas un backup cifrado, Rustty genera `rustty-sync.bin` con `age` y tu passphrase maestra. El backend remoto recibe ese fichero ya cifrado.

Rustty puede conectar con Google Drive, WebDAV, iCloud Drive o una carpeta local/NAS solo cuando lo configuras expresamente en **Preferencias → Copias de seguridad**.

Antes de sobrescribir el estado remoto, Rustty crea snapshots históricos cifrados. Esto ayuda a recuperar estados anteriores si una sincronización no era la esperada.

Si marcas **Contraseñas guardadas (cifradas E2E)**, Rustty lee del keyring local las contraseñas/passphrases guardadas, las mete en el estado cifrado y las restaura en el keyring local de otros equipos. Sin la passphrase de sync no se pueden descifrar.

## Verificación de host SSH

Rustty usa verificación de `known_hosts` con modelo TOFU: la primera huella conocida de un servidor se recuerda, y si más adelante cambia, la app avisa antes de continuar. Un cambio inesperado de fingerprint puede indicar una reinstalación legítima del servidor o un ataque de intermediario.

## Datos excluidos

Por diseño quedan fuera de la sincronización:

- Bases KeePass desbloqueadas en memoria.
- Rutas locales como `keepassPath` y `keepassKeyfile`.
- Ficheros transferidos por SFTP.
- Contenido de sesiones SSH/RDP.

Los exports JSON locales sí pueden incluir una sección `secrets`, pero solo después de confirmación explícita. Ese JSON no va cifrado por sí mismo.

## Sitio web

rustty.es es estático, sin cookies de analítica ni SDKs de tracking. Consulta GitHub para mostrar la última versión publicada y carga fuentes desde Google Fonts.
