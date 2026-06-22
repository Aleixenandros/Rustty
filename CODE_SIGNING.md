# Política de firma de código

Este documento describe cómo se firman los binarios de Rustty, quién puede
autorizar una firma y cómo verificar que un artefacto descargado es auténtico.

> Estado: los instaladores de **Windows** se publican por ahora **sin firma
> Authenticode**; la firma de código de Windows está **en evaluación** (ver «Plan
> de firma de Windows»). El resto de garantías de este documento (macOS,
> actualizador automático) ya están en vigor.

## Estado actual de la firma

| Plataforma | Firma | Mecanismo |
| --- | --- | --- |
| **macOS** (Apple Silicon) | Sí | Firmado con **Apple Developer ID Application** y **notarizado** por Apple. Gatekeeper no muestra avisos en una instalación limpia. |
| **Windows** | **Todavía no** (firma en evaluación) | Pendiente de certificado. Verifica el `sha256` publicado en el release. |
| **Linux** (`.deb`/`.rpm`/`.AppImage`/`.pkg.tar.zst`/Flatpak) | No aplica firma de código de SO | La integridad se valida por el gestor de paquetes y el `sha256` del release. |
| **Actualizaciones automáticas** (todas las plataformas con updater) | Sí | Cada artefacto del updater de Tauri se firma con una clave **minisign**; la app verifica la firma contra la **clave pública** embebida antes de instalar. |

Los secretos de firma viven exclusivamente en los secretos cifrados de GitHub
Actions del repositorio y nunca se incluyen en el código fuente ni en los
artefactos publicados:

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Updater de Tauri: `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Plan de firma de Windows

La firma de código de Windows está **en evaluación**. Mientras tanto, los
instaladores (`.msi`, `.exe` NSIS y portable) se publican sin firma Authenticode
y deben verificarse por su `sha256`. Las vías que se consideran:

- **SignPath Foundation** (gratuita para OSS) — objetivo preferido. Rustty cumple
  los criterios técnicos de elegibilidad (licencia [Apache-2.0](LICENSE) aprobada
  por la OSI sin doble licencia, sin componentes propietarios más allá de las
  librerías del sistema, mantenido activamente, publicado y documentado). El
  programa, además, valora la **visibilidad y reputación pública** del proyecto
  (adopción, referencias externas), por lo que la concesión queda supeditada a que
  Rustty alcance ese umbral; se reaplicará cuando así sea.
- **Certificado de validación individual** de una CA comercial (p. ej.
  [Certum Open Source](https://www.certum.eu/en/code-signing-certificates/) o
  [SSL.com](https://www.ssl.com/) IV con eSigner), que verifica la identidad del
  autor y no exige reputación del proyecto. Implica un coste anual.

Cuando exista un certificado, los binarios de Windows se firmarán dentro del flujo
de GitHub Actions descrito abajo y se actualizará la tabla de estado.

## Construcción verificable

Todos los binarios oficiales se construyen **a partir del código fuente público**
de este repositorio mediante GitHub Actions (`.github/workflows/build.yml`), que
se dispara al publicar una etiqueta `v*`. No se firman binarios construidos en
equipos locales. Cada artefacto lleva sus metadatos (nombre de producto y
versión) fijados desde la fuente única de versión (`package.json`, propagada por
`scripts/sync-version.mjs`). Los scripts de construcción y la configuración de CI
son públicos y están sujetos a revisión de código.

## Roles y aprobación de releases

Rustty está mantenido por **Alejandro Soriano** ([@Aleixenandros](https://github.com/Aleixenandros)),
que asume los tres roles definidos por la SignPath Foundation:

- **Autores / Committers**: personas con permiso para modificar el código fuente.
  Actualmente: [@Aleixenandros](https://github.com/Aleixenandros).
- **Revisores (Reviewers)**: revisan los cambios procedentes de personas que no
  son committers antes de integrarlos. Actualmente: [@Aleixenandros](https://github.com/Aleixenandros).
- **Aprobadores (Approvers)**: deciden si una release puede firmarse.
  Actualmente: [@Aleixenandros](https://github.com/Aleixenandros).

**Cada release requiere aprobación manual antes de firmarse.** Ningún artefacto se
firma de forma automática sin que un aprobador valide explícitamente esa versión
concreta.

Todas las cuentas con acceso al repositorio de código fuente y a la firma de
código (GitHub y SignPath) tienen activada la **autenticación multifactor (MFA)**.

## Declaración de privacidad

Rustty es una aplicación *local-first* y **no transmite información a otros
sistemas en red salvo que lo solicite expresamente la persona que lo instala o lo
opera** (sus propias conexiones SSH/SFTP/RDP, el proveedor de sincronización que
configure o la comprobación de actualizaciones, todos opcionales y bajo su
control). Los detalles completos están en la
[política de privacidad](https://rustty.es/politica-privacidad).

## Cómo verificar la integridad de una descarga

- **`sha256`**: cada release de GitHub publica el hash SHA-256 de cada fichero.
  Compáralo con el de tu descarga:

  ```bash
  sha256sum Rustty_*_amd64.deb
  # comparar con el hash indicado en la página del release
  ```

- **macOS**: el sistema valida automáticamente la firma de Apple Developer ID y la
  notarización al abrir la aplicación.
- **Windows** (cuando la firma esté activa): el binario mostrará el editor
  verificado en el diálogo de SmartScreen / UAC y en
  *Propiedades → Firmas digitales*.
- **Actualizaciones automáticas**: la verificación de la firma minisign es
  automática; el updater rechaza cualquier artefacto cuya firma no cuadre con la
  clave pública embebida.

## Atribución

Una vez activa la firma con la SignPath Foundation, el sitio del proyecto mostrará
la siguiente atribución, tal como exige el programa:

> Free code signing provided by [SignPath.io](https://about.signpath.io),
> certificate by [SignPath Foundation](https://signpath.org).

## Reporte de problemas de firma

Si encuentras un binario que dice ser de Rustty pero cuya firma o `sha256` no
coincide con lo publicado, **no lo ejecutes** y repórtalo de forma privada según
el procedimiento de [`SECURITY.md`](SECURITY.md).
