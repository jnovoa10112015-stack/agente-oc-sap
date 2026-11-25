#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
imagen=${1:-agente-oc:evaluacion-local}
docker run --rm --pull=never --network none \
  --mount "type=bind,source=$PWD/scripts/smoke-container.ts,target=/app/scripts/smoke-container.ts,readonly" \
  "$imagen" bun /app/scripts/smoke-container.ts

# Arranque con el CMD real de la imagen y apagado por SIGTERM. Sin llaves ni red externa.
contenedor=$(docker run --detach --pull=never --network none "$imagen")
limpiar() {
  docker stop --time 5 "$contenedor" >/dev/null 2>&1 || true
  docker rm "$contenedor" >/dev/null 2>&1 || true
}
trap limpiar EXIT
listo=false
for intento in {1..30}; do
  if docker exec "$contenedor" bun -e '
    const base = `http://127.0.0.1:${process.env.PORT}`;
    if ((await fetch(`${base}/api/live`)).status !== 200) process.exit(1);
    if ((await fetch(`${base}/api/health`)).status !== 503) process.exit(1);
    if ((await fetch(base)).status !== 200) process.exit(1);
  ' 2>/dev/null; then
    listo=true
    break
  fi
  sleep 0.2
done
if [ "$listo" != true ]; then
  docker logs "$contenedor"
  echo 'El CMD real de la imagen no superó las comprobaciones HTTP.' >&2
  exit 1
fi
docker stop --time 10 "$contenedor" >/dev/null
estado=$(docker inspect --format '{{.State.ExitCode}}' "$contenedor")
if [ "$estado" != 0 ]; then
  echo "El apagado del servidor terminó con código $estado." >&2
  exit 1
fi
echo '{"startup":"ok","shutdownExitCode":0,"redExterna":false}'
