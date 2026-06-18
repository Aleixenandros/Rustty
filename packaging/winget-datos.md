# Publicación en winget

Rustty se distribuye en el [Windows Package Manager](https://github.com/microsoft/winget-pkgs).

- **Identificador**: `rustty.Rustty`
- **Moniker**: `rustty`
- **Instalación**: `winget install rustty`
- **Instalador usado**: el MSI WiX del release (`Rustty_<version>_x64.msi`).

## Metadatos del manifiesto (locale es-ES)

Estos son los valores con los que se generó el manifiesto. Sirven de referencia
para regenerarlo a mano con `wingetcreate` si hiciera falta.

| Campo | Valor |
|---|---|
| PackageIdentifier | `rustty.Rustty` |
| PackageLocale | `es-ES` |
| Publisher | `rustty` |
| PublisherUrl | `https://rustty.es` |
| PublisherSupportUrl | `https://github.com/Aleixenandros/Rustty/issues` |
| PrivacyUrl | `https://rustty.es/politica-privacidad` |
| Author | `Alejandro Soriano` |
| PackageName | `Rustty` |
| PackageUrl | `https://rustty.es` |
| License | `Apache-2.0` |
| LicenseUrl | `https://github.com/Aleixenandros/Rustty/blob/main/LICENSE` |
| Copyright | `Copyright 2026 Alejandro Soriano` |
| CopyrightUrl | `https://github.com/Aleixenandros/Rustty/blob/main/NOTICE` |
| ShortDescription | `Cliente de terminal y gestor de conexiones SSH/SFTP/RDP multiplataforma, escrito en Rust` |
| Moniker | `rustty` |
| ReleaseNotesUrl | `https://github.com/Aleixenandros/Rustty/blob/main/CHANGELOG.md` |
| DocumentLabel / DocumentUrl | `Documentación` / `https://rustty.es/docs/` |

**Tags** (cada uno como elemento individual, sin comas):
`ssh`, `sftp`, `ftp`, `ftps`, `rdp`, `terminal`, `console`, `rust`, `tauri`

## Actualización automática

Cada release etiquetado (`git tag vX.Y.Z`) dispara el workflow `build.yml`. Tras
publicar el release, el job **`winget`** ejecuta
[`winget-releaser`](https://github.com/vedantmgoyal9/winget-releaser), que abre
solo el pull request de actualización en `microsoft/winget-pkgs` filtrando el
asset `_x64.msi`.

Requisitos:

- Secreto de repositorio **`WINGET_TOKEN`**: un PAT *classic* de GitHub con
  scope `public_repo` (el action hace fork de `winget-pkgs` y empuja el PR desde
  él). Si el secreto falta, el job se omite con un aviso, sin romper el release.

## Actualización manual (alternativa)

Desde una carpeta con permisos de escritura (no `System32`):

```powershell
wingetcreate update rustty.Rustty `
  --version <X.Y.Z> `
  --urls https://github.com/Aleixenandros/Rustty/releases/download/v<X.Y.Z>/Rustty_<X.Y.Z>_x64.msi `
  --submit --token <PAT>
```

## Notas

- El primer envío de un paquete nuevo requiere firmar una sola vez el CLA de
  Microsoft (comentando `@microsoft-github-policy-service agree` en el PR).
- El MSI no está firmado con Authenticode; winget no lo exige, pero un moderador
  puede revisar el PR a mano. Los MSI de Tauri suelen pasar la validación.
