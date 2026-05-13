# Instalación

Rustty ofrece binarios precompilados para Linux, Windows y macOS en la [página de releases](https://github.com/Aleixenandros/Rustty/releases).

La web y el instalador apuntan siempre al último release publicado. Desde Rustty puedes comprobarlo manualmente en **Preferencias → Acerca de**, o activar **Comprobar al iniciar** para que la app lo revise al arrancar.

## Linux

Rustty requiere **WebKitGTK 4.1** y **libayatana-appindicator** en tiempo de ejecución. En la mayoría de distribuciones ya están instalados o se resuelven como dependencia al instalar el paquete.

### Instalador automático

Detecta tu distribución (Arch / Debian / Fedora / openSUSE) y descarga el paquete nativo correcto del último release:

```bash
curl -sSf https://rustty.es/install.sh | sh
```

Si tu distro no se detecta, instala una AppImage en `~/.local/bin`. El script puede inspeccionarse antes de ejecutarse: `curl -sSf https://rustty.es/install.sh -o install.sh`.

### AppImage (portable)

No requiere instalación:

```bash
chmod +x Rustty_*_amd64.AppImage
./Rustty_*_amd64.AppImage
```

### .deb (Debian / Ubuntu / Mint)

```bash
sudo apt install ./Rustty_*_amd64.deb
```

### .rpm (Fedora / openSUSE / RHEL)

```bash
sudo dnf install ./Rustty-*-1.x86_64.rpm        # Fedora
sudo zypper install ./Rustty-*-1.x86_64.rpm     # openSUSE
```

### .pkg.tar.zst (Arch / Manjaro)

```bash
sudo pacman -U Rustty-*-1-x86_64.pkg.tar.zst
```

## Windows

En Windows 10 22H2 y Windows 11 el runtime **Microsoft Edge WebView2** viene preinstalado. Si tu sistema no lo tiene, el instalador MSI o NSIS lo descargará automáticamente.

- **MSI** (`Rustty_<version>_x64.msi`): instalador tradicional, doble clic y seguir.
- **NSIS** (`Rustty_<version>_x64-setup.exe`): instalador alternativo, más ligero.
- **Portable** (`Rustty_<version>_x64-portable.exe`): ejecutable único, ideal para USB o equipos bloqueados.

> Los binarios de Windows aún **no están firmados**. Algunos antivirus pueden marcar un falso positivo. Puedes verificar el `sha256` publicado junto al release para confirmar que el fichero no ha sido alterado.

## macOS (Apple Silicon)

- **DMG** (`Rustty_<version>_aarch64.dmg`): abrir el `.dmg` y arrastrar `Rustty.app` a **Aplicaciones**.
- **App bundle** (`Rustty_aarch64.app.tar.gz`): descomprimir y ejecutar `Rustty.app`.

Las builds publicadas están firmadas con **Apple Developer ID** y notarizadas, así que Gatekeeper no mostrará aviso. Para Intel Mac hay que compilar desde fuente.

## Verificar integridad

Junto a cada artefacto se publica su `.sig` (firma del updater de Tauri) y la página del release incluye el `sha256` de cada fichero:

```bash
sha256sum Rustty_*_amd64.deb
# comparar con el hash indicado en la release
```

## CLI SSH

Una vez instalado, el binario también permite listar perfiles SSH, abrir sesiones interactivas y ejecutar comandos remotos desde terminal. Consulta la [guía del CLI SSH](?page=CLI) para ejemplos y limitaciones.

## Compilar desde fuente

Si prefieres compilar tú mismo, consulta el [README del proyecto](https://github.com/Aleixenandros/Rustty#desarrollo-y-construcción) para la lista completa de dependencias por sistema.
