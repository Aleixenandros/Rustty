#!/usr/bin/env bash
# Imprime la sección de CHANGELOG.md correspondiente a una versión.
#
#   ./scripts/changelog-section.sh 2.7.0
#
# Lo usa `build.yml` para que las notas del release sean el changelog de esa
# versión, en vez de un texto genérico que obliga a salir de la página del
# release para saber qué cambia. Ejecutar desde la raíz del repo.
set -euo pipefail

VERSION="${1:?uso: changelog-section.sh <version>}"
ARCHIVO="${2:-CHANGELOG.md}"

awk -v v="$VERSION" '
  index($0, "## [" v "]") == 1 { dentro = 1; next }
  dentro && /^## \[/ { exit }
  dentro { print }
' "$ARCHIVO" | awk '
  # Recorta las líneas en blanco del principio y del final, pero conserva las
  # de dentro: sin ellas, Markdown no separa los apartados.
  NF { for (i = 0; i < pendientes; i++) print ""; pendientes = 0; print; next }
  { if (NR == 1) next; pendientes++ }
'
