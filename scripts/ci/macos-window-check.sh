#!/usr/bin/env bash
# Abre la aplicación en macOS y comprueba que la ventana trae los botones
# nativos (cerrar, minimizar, maximizar), con capturas de cada disposición.
#
# Por qué existe: hasta la 2.29.0 la ventana se creaba sin decoraciones también
# en macOS, y allí eso deja la ventana sin ningún botón mientras la interfaz
# escondía los suyos. Nadie lo vio porque ninguna prueba abre la app en un Mac.
#
# Uso: scripts/ci/macos-window-check.sh <binario> <carpeta-de-salida>
# Pensado para el runner de GitHub (osascript con permiso de accesibilidad).
set -uo pipefail

BIN="${1:?falta el binario}"
OUT="${2:?falta la carpeta de salida}"
mkdir -p "$OUT"

"$BIN" >"$OUT/app.log" 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

ax() {
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID) to $1" 2>>"$OUT/osascript.log"
}

# La ventana nace oculta y la enseña la interfaz cuando termina de arrancar.
windows=0
for _ in $(seq 1 90); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "::error::La aplicación se cerró antes de enseñar la ventana"
    cat "$OUT/app.log"
    exit 1
  fi
  windows="$(ax 'count windows' || echo 0)"
  [ "${windows:-0}" -ge 1 ] 2>/dev/null && break
  sleep 1
done
# Margen para que se retire la pantalla de carga.
sleep 6
ax 'set frontmost to true' >/dev/null
sleep 1

screencapture -x "$OUT/pantalla.png" || echo "::warning::No se pudo capturar la pantalla"

if [ "${windows:-0}" -lt 1 ] 2>/dev/null; then
  echo "::error::No apareció ninguna ventana (o falta el permiso de accesibilidad)"
  cat "$OUT/osascript.log" 2>/dev/null
  exit 1
fi

position="$(ax 'get position of window 1')"
size="$(ax 'get size of window 1')"
buttons="$(ax 'get subrole of every button of window 1')"
{
  echo "sistema:  $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
  echo "posición: $position"
  echo "tamaño:   $size"
  echo "botones:  $buttons"
} | tee "$OUT/ventana.txt"

wx="${position%%,*}"; wy="${position##*, }"
ww="${size%%,*}";     wh="${size##*, }"
shot() {
  screencapture -x -R "${wx},${wy},${ww},${wh}" "$OUT/$1.png" \
    || echo "::warning::No se pudo capturar $1"
}
shot ventana

# Barra lateral plegada: el conmutador es el primer botón de la barra de
# pestañas, justo a la derecha del rail (44) y de la barra lateral (240).
osascript -e "tell application \"System Events\" to click at {$((wx + 302)), $((wy + 19))}" \
  >/dev/null 2>>"$OUT/osascript.log" || echo "::warning::No se pudo plegar la barra lateral"
sleep 1
shot ventana-lateral-plegada
osascript -e "tell application \"System Events\" to click at {$((wx + 62)), $((wy + 19))}" \
  >/dev/null 2>>"$OUT/osascript.log" || true
sleep 1

# Modo zen (F11): no queda interfaz bajo los botones.
osascript -e 'tell application "System Events" to key code 103' \
  >/dev/null 2>>"$OUT/osascript.log" || echo "::warning::No se pudo entrar en modo zen"
sleep 1
shot ventana-zen
osascript -e 'tell application "System Events" to key code 103' >/dev/null 2>>"$OUT/osascript.log" || true

fail=0
for want in AXCloseButton AXMinimizeButton; do
  case "$buttons" in
    *"$want"*) ;;
    *) echo "::error::Falta el botón nativo $want"; fail=1 ;;
  esac
done
# El verde es «pantalla completa» o «zoom» según el sistema y la tecla Opción.
case "$buttons" in
  *AXFullScreenButton*|*AXZoomButton*) ;;
  *) echo "::error::Falta el botón nativo de maximizar"; fail=1 ;;
esac

if [ "$fail" -eq 0 ]; then
  echo "La ventana trae sus tres botones nativos."
fi
exit "$fail"
