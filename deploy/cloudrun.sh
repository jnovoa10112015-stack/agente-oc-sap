#!/usr/bin/env bash
# Demostración privada: no concede roles de proyecto ni habilita APIs.
set -euo pipefail
if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo 'Uso: bash deploy/cloudrun.sh PROYECTO REGION CUENTA_SERVICIO [SERVICIO]' >&2
  exit 2
fi
proyecto=$1
region=$2
cuenta=$3
servicio=${4:-agente-oc-periferia}
if [[ ! $proyecto =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ || ! $region =~ ^[a-z]+-[a-z]+[0-9]$ || ! $cuenta =~ ^[a-zA-Z0-9._-]+@${proyecto}\.iam\.gserviceaccount\.com$ || ! $servicio =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]; then
  echo 'Proyecto, región, cuenta de servicio o nombre de servicio inválidos.' >&2
  exit 2
fi
command -v gcloud >/dev/null || { echo 'Instala Google Cloud CLI.' >&2; exit 1; }
cd "$(dirname "$0")/.."
echo 'Desplegando una demostración privada de una sola instancia.'
echo 'El almacenamiento y las sesiones de Cloud Run son efímeros; consulta deploy/README.md.'
gcloud run deploy "$servicio" \
  --project "$proyecto" \
  --region "$region" \
  --source . \
  --service-account "$cuenta" \
  --no-allow-unauthenticated \
  --invoker-iam-check \
  --port 8080 \
  --concurrency 1 \
  --max-instances 1 \
  --min-instances 0 \
  --memory 512Mi \
  --timeout 600 \
  --set-env-vars "LLM_PROVIDER=vertex,GOOGLE_CLOUD_PROJECT=$proyecto,GOOGLE_CLOUD_LOCATION=global,GEMINI_MODEL=gemini-3.5-flash-lite"
