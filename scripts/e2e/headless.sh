#!/usr/bin/env bash
# El mismo escritorio aislado en local y en el workflow manual de GitHub.
set -euo pipefail
cd "$(dirname "$0")/../.."

for command in xvfb-run dbus-run-session openbox wmctrl WebKitWebDriver; do
  command -v "$command" >/dev/null || { echo "Falta $command" >&2; exit 1; }
done

if [[ "${1:-}" != "--session" ]]; then
  exec xvfb-run -a -s '-screen 0 1440x1000x24' dbus-run-session -- bash scripts/e2e/headless.sh --session
fi

export E2E_ARTIFACT_DIR="${E2E_ARTIFACT_DIR:-$(mktemp -d /tmp/rustty-e2e-artifacts-XXXXXX)}"
mkdir -p "$E2E_ARTIFACT_DIR"
export E2E_SYNC_SCREENSHOT="$E2E_ARTIFACT_DIR/first-sync.png"
export E2E_SIDEBAR_SCREENSHOT="$E2E_ARTIFACT_DIR/sidebar-sync.png"
export E2E_SCREENSHOT="$E2E_ARTIFACT_DIR/final.png"
openbox >"$E2E_ARTIFACT_DIR/openbox.log" 2>&1 &
window_manager_pid=$!
trap 'kill "$window_manager_pid" 2>/dev/null || true' EXIT

# wmctrl necesita un gestor EWMH para detectar y cancelar diálogos nativos.
ready=false
for ((attempt = 0; attempt < 50; attempt++)); do
  if wmctrl -m >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo "Openbox no está listo" >&2; exit 1; fi

npm run e2e:smoke 2>&1 | tee "$E2E_ARTIFACT_DIR/smoke.log"
