#!/usr/bin/env bash
# Paquete de fuentes del árbol de trabajo actual; nunca incluye .git ni out/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out
paquete=out/agente-oc-periferia-dev.tar.gz
COPYFILE_DISABLE=1 tar \
  --exclude='.env' --exclude='.env.local' --exclude='.env.*.local' \
  --exclude='*.pem' --exclude='*-key.json' --exclude='*service-account*.json' \
  --exclude='credentials' --exclude='node_modules' --exclude='.DS_Store' --exclude='._*' \
  -czf "$paquete" \
  package.json bun.lock tsconfig.json Dockerfile compose.yaml compose.vertex.yaml \
  .env.example .env.vertex.example .gitignore .dockerignore .gcloudignore \
  README.md SOLUCION.md EVALUACION.md demo.ts src web fixtures conocimiento modulo deploy scripts .github
nombre=${paquete##*/}
if command -v sha256sum >/dev/null; then
  (cd out && sha256sum "$nombre" > "$nombre.sha256")
else
  (cd out && shasum -a 256 "$nombre" > "$nombre.sha256")
fi
echo "$paquete"
echo "$paquete.sha256"
