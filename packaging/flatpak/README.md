# Rustty en Flatpak

En este directorio conviven **dos manifests distintos**. Confundirlos es el
error más fácil de cometer:

| Fichero | Para qué | Cómo compila |
|---|---|---|
| `es.rustty.Rustty.yml` | Flathub | Desde fuente, **sin red**, con las dependencias declaradas en `cargo-sources.json` y `node-sources.json` |
| `es.rustty.Rustty.bundle.yml` | El `.flatpak` suelto de cada release de GitHub | Empaqueta el binario que `tauri-action` ya compiló |

Los metadatos (`es.rustty.Rustty.desktop`, `es.rustty.Rustty.metainfo.xml`) son
comunes a los dos.

## El runtime no es negociable

`org.gnome.Platform`, nunca `org.freedesktop.Platform`. Tauri 2 en Linux enlaza
contra `libwebkit2gtk-4.1`, que solo trae el runtime de GNOME. Con el de
freedesktop el bundle se genera sin dar error y la app **no arranca** — así
estuvo el `.flatpak` de las releases desde la v1.10.2 hasta la v2.1.0.

Para comprobarlo en cualquier runtime:

```bash
flatpak run --command=sh org.gnome.Platform//50 -c 'ls /usr/lib/*/libwebkit2gtk-4.1.so.0'
```

El emparejamiento de versiones tampoco es libre: GNOME 50 se apoya en
freedesktop 25.08, así que las extensiones del SDK van en esa misma serie.
`rust-stable//25.08` trae Rust 1.97.1, compatible con el 1.97.0 que fija
`src-tauri/rust-toolchain.toml`.

## La bandeja del sistema hay que compilarla

El runtime tampoco trae AppIndicator, y aquí el fallo es peor que perder la
bandeja: `libappindicator-sys` —que llega vía el crate `tray-icon` de Tauri—
**entra en pánico** cuando el `dlopen` falla, así que la aplicación muere al
arrancar. El `if let Err` de `app_tray::setup` no lo captura: es un panic, no un
`Result`.

Hay dos defensas, y las dos hacen falta:

1. [`app_tray.rs`](../../src-tauri/src/app_tray.rs) comprueba la biblioteca con
   `dlopen` **antes** de que lo intente `libappindicator-sys`. Si no está, la
   app arranca sin bandeja en vez de morir. Esto protege a cualquier Linux sin
   AppIndicator instalado, no solo a Flatpak.
2. [`modules/libayatana-appindicator.yml`](modules/libayatana-appindicator.yml)
   compila la cadena entera (intltool → libdbusmenu → ayatana-ido →
   libayatana-indicator → libayatana-appindicator) para que la bandeja
   **funcione** de verdad. Lo incluyen **los dos** manifests.

Esa cadena tiene tres escollos, todos ya resueltos en el módulo. Se documentan
porque cualquiera de ellos reaparece si se toca una versión:

- **`libdbusmenu` tiene que ser el tarball de release de Launchpad**, no los
  `orig.tar` de Debian ni de Ubuntu: solo aquel trae el `configure` generado.
  Regenerarlo aquí no es viable, porque el `configure.ac` usa macros que
  autoconf ya retiró y pide `intltoolize` y `gtkdocize`, ausentes del SDK.
  Como Launchpad responde con un 303 hacia un CDN que se queda a 0 B/s en
  algunas redes, el módulo lleva un `mirror-urls` al lookaside de Fedora, que
  sirve el fichero idéntico (mismo sha256).
- **No se le puede pasar `--disable-tests`**: define
  `AM_CONDITIONAL([HAVE_VALGRIND])` dentro del `AS_IF` de los tests, así que
  desactivarlos hace que `configure` aborte con «conditional "HAVE_VALGRIND"
  was never defined».
- **`libayatana-appindicator` necesita `-DENABLE_GTKDOC=OFF`**: su paso
  `scangobj` enlaza un binario de prueba contra las tres bibliotecas anteriores,
  que aún no están en la ruta del enlazador, y revienta con la biblioteca ya
  compilada.

## Por qué la app sale al host

Rustty pide `--talk-name=org.freedesktop.Flatpak`, que permite `flatpak-spawn
--host`. Es un permiso fuerte y conviene saber exactamente para qué está:

- **Consola local**: el `sh` del contenedor no tiene los dotfiles ni las
  herramientas del usuario. Una consola local que abriera ese shell no cumpliría
  su función.
- **RDP y visores externos**: `xfreerdp`, `vncviewer` y `telnet` viven en el
  sistema del usuario, no en el runtime.

Es la misma vía que usan los emuladores de terminal ya publicados en Flathub
(Ptyxis, Black Box). La lógica está aislada en
[`src-tauri/src/sandbox.rs`](../../src-tauri/src/sandbox.rs); fuera de Flatpak
es transparente y no envuelve nada.

`--filesystem=home` va aparte y tiene su propia justificación: `~/.ssh/id_*`,
`~/.ssh/known_hosts` (que se lee y reescribe sin intervención del usuario en
cada conexión), `~/.ssh/config`, bases KeePass, y el panel SFTP moviendo
archivos arbitrarios en ambos sentidos. Los portales no cubren ese uso.

## Actualizaciones

El updater de Tauri queda desactivado bajo Flatpak: `commands::is_flatpak` lo
detecta y el frontend ni siquiera ofrece comprobar. La versión la gobierna el
remote (Flathub), y avisar de releases de GitHub llevaría al usuario a descargar
un paquete que no es el que tiene instalado.

## Regenerar las fuentes offline

Obligatorio **cada vez que cambie `Cargo.lock` o `package-lock.json`**:

```bash
scripts/flatpak-gen-sources.sh
```

Deja `cargo-sources.json` y `node-sources.json` en este directorio. No se
versionan en este repositorio (pesan varios MB y se derivan de los lockfiles):
viven en el repositorio de Flathub, adonde los lleva el workflow.

## Construir y probar en local

```bash
# Una vez: herramientas y runtimes
flatpak install -y --user flathub org.flatpak.Builder org.gnome.Sdk//50 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08 \
  org.freedesktop.Sdk.Extension.node24//25.08

# Fuentes offline
scripts/flatpak-gen-sources.sh

# Build completa (compila Rust dentro del sandbox: unos 40 min la primera vez)
flatpak run org.flatpak.Builder --force-clean --repo=repo \
  build-dir packaging/flatpak/es.rustty.Rustty.yml

# Arrancar lo construido sin instalarlo. Es la comprobación que más pronto
# detecta los fallos de empaquetado: si falta una biblioteca, muere aquí.
flatpak build --share=network build-dir rustty
```

Un par de detalles del entorno que cuestan un rato averiguar:

- `org.flatpak.Builder` no ve `/tmp` (su `--filesystem=host` lo excluye), así
  que el directorio de trabajo tiene que estar bajo `$HOME`.
- `--install` falla en Fedora con «permiso denegado» al desplegar. Para
  instalarlo de verdad, exporta a un repositorio con `--repo` y añádelo como
  remote local (`flatpak remote-add --user --no-gpg-verify`).

Antes de enviar nada, pasa el linter oficial de Flathub — es el mismo que
ejecuta su CI:

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder \
  manifest packaging/flatpak/es.rustty.Rustty.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder \
  appstream packaging/flatpak/es.rustty.Rustty.metainfo.xml
```

## Enviar la aplicación a Flathub (una sola vez)

Esto lo hace una persona con la cuenta de GitHub del proyecto; no está
automatizado y no debería estarlo.

**Requisito previo:** la cuenta de GitHub necesita **2FA activo**. Al aprobarse
el envío, Flathub manda una invitación de escritura que caduca en una semana y
que no se puede aceptar sin doble factor.

### 1. Preparar los ficheros

El manifest debe apuntar al tag publicado, con su SHA explícito, y las fuentes
offline tienen que salir de los lockfiles de **ese** tag:

```bash
scripts/flatpak-gen-sources.sh
# y en el manifest: tag: vX.Y.Z + commit: $(git rev-list -n1 vX.Y.Z)
```

### 2. Validar como lo hará su CI

`flathub-build` aplica las mismas comprobaciones que el bot de Flathub, así que
lo que pase aquí pasa allí:

```bash
flatpak run --command=flathub-build org.flatpak.Builder es.rustty.Rustty.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest es.rustty.Rustty.yml
```

### 3. Abrir el PR

```bash
# Fork de https://github.com/flathub/flathub/fork
# IMPORTANTE: desmarcar «Copy the master branch only», o no habrá rama `new-pr`.
git clone --branch=new-pr git@github.com:<tu-usuario>/flathub.git && cd flathub
git checkout -b add-es-rustty-rustty new-pr
```

En la raíz van **cuatro** ficheros: `es.rustty.Rustty.yml`,
`cargo-sources.json`, `node-sources.json` y `modules/libayatana-appindicator.yml`.
El `.desktop`, el `metainfo.xml` y los iconos **no**: los toma `flatpak-builder`
del propio checkout de Rustty (la fuente `git` del módulo principal).

El PR va **contra la rama `new-pr`**, nunca contra `master`, y se titula
`Add es.rustty.Rustty`. No hay que mergear `master` en la rama en ningún
momento. Para lanzar una build de prueba, comentar `bot, build` en el PR.

### 4. La revisión

Los dos permisos que se discuten siempre son `--filesystem=home` y
`--talk-name=org.freedesktop.Flatpak`; las justificaciones están más arriba en
este documento y en los comentarios del manifest.

Al aceptarse, Flathub crea `github.com/flathub/es.rustty.Rustty` e invita a la
cuenta como mantenedora. **Después** hay que dar de alta el secreto
`FLATHUB_TOKEN` en este repositorio para que
[`flathub.yml`](../../.github/workflows/flathub.yml) publique las siguientes
versiones solo.

## Publicar cada nueva versión (ya automatizado)

`.github/workflows/flathub.yml` se encarga: regenera las fuentes, fija el
manifest al commit del tag y abre un PR en `flathub/es.rustty.Rustty`. El bot de
Flathub lo construye; mergearlo publica.

Necesita un secreto de repositorio **`FLATHUB_TOKEN`**: un Personal Access Token
con permiso `repo` sobre ese repositorio. El `GITHUB_TOKEN` por defecto no sirve
porque el destino está en otra organización.

## Pendiente

- **Capturas nuevas.** Las de `images/` son de la 1.x: muestran la app vacía
  («Sin conexiones guardadas») y en español. Flathub las descarga de la URL del
  tag, así que basta con reemplazar los ficheros y volver a etiquetar. Convienen
  capturas con una sesión SSH real, el panel SFTP y el modo control de tmux, que
  es lo que distingue a Rustty.
- **aarch64.** Flathub construye para `x86_64` y `aarch64`. Si la segunda falla,
  se limita con un `flathub.json` en el repositorio de Flathub:
  `{"only-arches": ["x86_64"]}`.
