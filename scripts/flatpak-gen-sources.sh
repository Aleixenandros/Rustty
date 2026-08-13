#!/usr/bin/env bash
#
# Genera las fuentes offline que Flathub exige para Rustty:
#
#   packaging/flatpak/cargo-sources.json  ← src-tauri/Cargo.lock
#   packaging/flatpak/node-sources.json   ← package-lock.json
#
# Flathub compila sin red: cada dependencia de Cargo y de npm tiene que estar
# declarada en el manifest con su URL y su hash. Estos dos ficheros son esa
# declaración, y hay que regenerarlos **cada vez que cambie un lockfile**.
#
# Uso:  scripts/flatpak-gen-sources.sh
#
# Requisitos: python3, y `flatpak-builder-tools` (se clona solo en un temporal).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/packaging/flatpak"

# Commit fijado de flatpak-builder-tools: los generadores cambian de formato
# entre revisiones y una actualización silenciosa rompería el build sin que
# nadie hubiera tocado el manifest. Subirlo es una decisión, igual que el
# canal de `rust-toolchain.toml`.
TOOLS_REPO="https://github.com/flatpak/flatpak-builder-tools.git"
TOOLS_REF="${FLATPAK_BUILDER_TOOLS_REF:-master}"

command -v python3 >/dev/null || { echo "Falta python3" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ Clonando flatpak-builder-tools ($TOOLS_REF)…"
git clone --quiet --depth 1 --branch "$TOOLS_REF" "$TOOLS_REPO" "$WORK/tools"

# Los dos generadores se instalan distinto: el de Cargo es un script suelto con
# sus dependencias en `requirements.txt`, y el de Node es un paquete Python que
# se instala desde su subdirectorio. Comparten venv desechable para no tocar el
# Python del sistema.
echo "→ Preparando entorno de Python…"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install --quiet --upgrade pip

if [ -f "$WORK/tools/cargo/requirements.txt" ]; then
  "$WORK/venv/bin/pip" install --quiet -r "$WORK/tools/cargo/requirements.txt"
else
  # Respaldo por si el repositorio deja de declararlas.
  "$WORK/venv/bin/pip" install --quiet aiohttp aiohttp-retry tomlkit
fi
"$WORK/venv/bin/pip" install --quiet "$WORK/tools/node"

echo "→ Generando cargo-sources.json…"
"$WORK/venv/bin/python" "$WORK/tools/cargo/flatpak-cargo-generator.py" \
  "$REPO_ROOT/src-tauri/Cargo.lock" \
  -o "$OUT_DIR/cargo-sources.json"

# `--xdg-layout` es el comportamiento por defecto desde hace varias versiones:
# deja el caché en `flatpak-node/npm-cache`, que es la ruta que el manifest le
# pasa a `npm ci --cache=`.
echo "→ Generando node-sources.json…"
"$WORK/venv/bin/flatpak-node-generator" npm \
  "$REPO_ROOT/package-lock.json" \
  -o "$OUT_DIR/node-sources.json"

echo
echo "Listo:"
ls -lh "$OUT_DIR/cargo-sources.json" "$OUT_DIR/node-sources.json"
echo
echo "Recuerda regenerarlos ante cualquier cambio en Cargo.lock o package-lock.json."
