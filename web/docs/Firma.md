# Política de firma de código

Esta página describe cómo se firman los binarios de Rustty, quién autoriza cada
firma y cómo comprobar que una descarga es auténtica.

> La firma de código de los binarios de **Windows** está **en evaluación**.
> Mientras tanto, los instaladores de Windows se publican sin firma Authenticode;
> verifica el `sha256` del release. El resto de garantías (macOS y actualizaciones
> automáticas) ya están en vigor.

## Estado de la firma por plataforma

- **macOS** (Apple Silicon): firmado con **Apple Developer ID Application** y
  **notarizado** por Apple. Gatekeeper no muestra avisos en una instalación
  limpia.
- **Windows**: firma de código **en evaluación**. Hasta entonces, verifica el
  `sha256` publicado en el release.
- **Linux** (`.deb` / `.rpm` / `.AppImage` / `.pkg.tar.zst` / Flatpak): no aplica
  firma de código del sistema operativo; la integridad la validan el gestor de
  paquetes y el `sha256` del release.
- **Actualizaciones automáticas** (updater de Tauri): cada artefacto se firma con
  una clave **minisign** y la app verifica la firma contra la **clave pública**
  embebida antes de instalar; rechaza cualquier descarga manipulada.

## Construcción verificable

Todos los binarios oficiales se construyen **a partir del código fuente público**
mediante GitHub Actions al publicar una etiqueta de versión. No se firman binarios
construidos en equipos locales y cada artefacto lleva sus metadatos (nombre de
producto y versión) fijados desde la fuente única de versión del repositorio.

## Roles y aprobación

Rustty está mantenido por **Alejandro Soriano**
([@Aleixenandros](https://github.com/Aleixenandros)), que asume los roles de
**autor/committer**, **revisor** y **aprobador**. **Cada release requiere
aprobación manual antes de firmarse**: ningún artefacto se firma de forma
automática sin validar esa versión concreta. Las cuentas con acceso al
repositorio y a la firma usan **autenticación multifactor**.

## Cómo verificar una descarga

- **`sha256`**: compáralo con el hash publicado en la página del release.

  ```bash
  sha256sum Rustty_*_amd64.deb
  # comparar con el hash indicado en la release
  ```

- **macOS**: el sistema valida la firma de Apple y la notarización al abrir la app.
- **Windows** (cuando la firma esté activa): el editor verificado aparecerá en
  SmartScreen / UAC y en *Propiedades → Firmas digitales*.
- **Actualizaciones automáticas**: la verificación minisign es automática.

## Privacidad

Rustty es *local-first* y **no transmite información a otros sistemas en red salvo
que lo solicite expresamente la persona que lo instala o lo opera**. Consulta la
[política de privacidad](/politica-privacidad) para el detalle.

## Reportar un problema de firma

Si un binario que dice ser de Rustty tiene una firma o un `sha256` que no coincide
con lo publicado, **no lo ejecutes** y repórtalo de forma privada según el
[`SECURITY.md`](https://github.com/Aleixenandros/Rustty/blob/main/SECURITY.md) del
repositorio.

El detalle técnico completo está en
[`CODE_SIGNING.md`](https://github.com/Aleixenandros/Rustty/blob/main/CODE_SIGNING.md).
