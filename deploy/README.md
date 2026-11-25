# Distribución y Vertex AI

## Alcance

Este servicio conserva el objetivo del reto: validar paquetes locales y crear
órdenes en SAP **simulado**. Vertex AI es el proveedor del modelo; no sustituye
la integración con un SAP real. El modelo coordina herramientas y el código
aplica RC1–RC10.

La imagen está preparada para ejecutarse sin root, con Bun y dependencias
fijadas. Los contextos Docker y Cloud Build solo incluyen código, assets y
fixtures del reto. Las credenciales y `.env` no se incorporan a la imagen.

## Vertex en desarrollo local

1. Usa un proyecto autorizado con facturación y Vertex AI API habilitados.
2. La identidad necesita `roles/aiplatform.user` en ese proyecto. El responsable
   de GCP debe concederlo; este repositorio no concede roles de proyecto.
3. Copia `.env.vertex.example` a `.env` y completa `GOOGLE_CLOUD_PROJECT`.
4. Autentica por **una** de estas vías:
   - ADC local: `gcloud auth application-default login`.
   - Cuenta de servicio: `GOOGLE_APPLICATION_CREDENTIALS` con la ruta absoluta
     de su JSON, guardado fuera del repositorio.
   - Cloud Run: cuenta de servicio asignada al servicio, sin montar llaves.
5. Ejecuta `bun install --frozen-lockfile`, `bun run doctor` y `bun start`.

`gcloud auth login` y `gcloud auth application-default login` son mecanismos
diferentes. El SDK usa ADC. El proyecto y el proyecto de cuota de las
credenciales deben corresponder al entorno autorizado. No pruebes con
credenciales de otro entorno.

`GOOGLE_GENAI_USE_VERTEXAI=true` es una alternativa a `LLM_PROVIDER=vertex`.
Si se configuran ambos, deben coincidir. Se acepta `GCLOUD_PROJECT` como
alternativa a `GOOGLE_CLOUD_PROJECT`. Vertex no requiere `GEMINI_API_KEY`.

El modelo predeterminado de Vertex es `gemini-3.5-flash-lite`, publicado por
Google y comprobado en la documentación el 22 de octubre de 2026. Configura
`GEMINI_MODEL` para cambiarlo y verifica disponibilidad en tu región. Los
aliases `gemini-flash-lite-latest` y `gemini-flash-latest` pertenecen al modo
Gemini Developer API y se rechazan en modo Vertex para evitar un 404 tardío.

### Si la credencial es una API key de Vertex Express

No se usa una llave JSON ni ADC. Configura `LLM_PROVIDER=vertex`,
`VERTEX_AUTH_MODE=api-key`, `VERTEX_API_KEY` y `GOOGLE_CLOUD_LOCATION=global`.
También debes indicar `GEMINI_MODEL` con un modelo habilitado en tu cuenta;
no se asume que el catálogo de Express sea igual al de ADC. En este modo no
se necesita `GOOGLE_CLOUD_PROJECT` y no se usa `GEMINI_API_KEY` como sustituto.
El SDK envía la API key al endpoint global de Express, sin un token ADC,
según la [documentación oficial de Express](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview).

## Docker local

Para Gemini, completa `.env` a partir de `.env.example` y ejecuta:

```bash
docker compose up --build
```

Abre http://localhost:3000. El volumen `ordenes` conserva las órdenes y la
auditoría entre recreaciones del contenedor. Las sesiones de chat viven en
memoria: un reinicio exige abrir una nueva conversación. Reprocesar una
solicitud ya creada devuelve su OC existente.

Para Vertex, configura `.env` a partir de `.env.vertex.example` y proporciona
la ruta de una credencial autorizada en el host:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/ruta/segura/credencial-autorizada.json
docker compose -f compose.yaml -f compose.vertex.yaml up --build
```

La credencial se monta en solo lectura; el SDK dentro del contenedor usa la
ruta de montaje, no la ruta del host. No copies el JSON a la imagen.

## Cloud Run: demostración privada

Se requieren APIs de Cloud Run, Cloud Build, Artifact Registry y Vertex AI,
además de los permisos de despliegue y una cuenta de servicio del proyecto con
acceso a Vertex. Este script **no** habilita APIs, concede roles de proyecto
ni selecciona otro proyecto mediante `gcloud config`. Solicita al despliegue
exigir autenticación y habilitar la comprobación IAM de invocación del
servicio, mediante `--no-allow-unauthenticated --invoker-iam-check`.

```bash
bash deploy/cloudrun.sh \
  tu-proyecto-autorizado \
  us-central1 \
  agente-oc@tu-proyecto-autorizado.iam.gserviceaccount.com
```

El script crea o actualiza el servicio indicado con acceso privado, puerto
8080, timeout de 600 segundos, concurrencia 1 y máximo 1 instancia. Cloud Run
puede usar instancias distintas al reiniciar o cambiar revisiones: ese límite
no ofrece persistencia ni exclusión mutua entre revisiones.

Si construyes la imagen en un Mac ARM para subirla por tu cuenta, usa
`docker build --platform linux/amd64`. Una imagen ARM local no basta para
Cloud Run: su [contrato requiere soporte linux/amd64](https://docs.cloud.google.com/run/docs/container-contract).
La evaluación local construye y ejecuta ambas arquitecturas; CI comprueba
explícitamente amd64. No se ha desplegado este cambio en GCP.

Para abrirlo durante una demostración autenticada:

```bash
gcloud run services proxy agente-oc-periferia \
  --project tu-proyecto-autorizado --region us-central1 --port 3000
```

**No usar Cloud Run como registro persistente de compras en esta versión.**
El filesystem de Cloud Run desaparece con la instancia y las sesiones viven
en memoria. Eso puede perder órdenes simuladas y reiniciar el consecutivo.
Para operación durable o varias réplicas se necesita una base de datos con
transacciones para órdenes, consecutivos y sesiones, almacenamiento externo
de evidencia, e identidad real del confirmador. Un volumen de Cloud Storage
no sustituye esas transacciones. El adaptador `SapAdapter` permite añadir la
integración real conservando las reglas.

## Diagnóstico

`bun run doctor` valida configuración y archivos localmente. No llama a
Google, no solicita tokens y no confirma permisos ni cuota.

| Síntoma | Acción |
|---|---|
| Configuración pide API key al usar una llave GCP | Selecciona `LLM_PROVIDER=vertex` y configura proyecto. |
| 401 o ADC ausentes | Revisa la ruta de la credencial o renueva ADC. |
| 403 | Revisa proyecto, facturación, API habilitada y rol de la identidad. |
| 404 | Verifica modelo y región; usa un ID de Vertex, no un alias de AI Studio. |
| 429 | Espera o solicita cuota/capacidad en el proyecto correcto. |
| Timeout | Revisa conectividad y `LLM_TIMEOUT_MS`. Incluye los reintentos. |
| Chat ocupado (409) | Espera a que termine el turno anterior de esa sesión. |
| Registro SAP dañado | Recupera el archivo; el sistema bloquea nuevas creaciones para no duplicar órdenes. |
| DATOS_INVALIDOS | Corrige las fuentes: cantidades, fechas, moneda, proveedor o códigos de catálogo. |
| MAESTROS_INVALIDOS | Corrige identificadores duplicados o referencias de IVA/pago inválidas en los maestros. |
| AUDITORIA_INCOMPLETA | La OC indicada ya existe; repara el control y reprocesa el mismo caso para recuperar la auditoría sin duplicarla. |

`GET /api/live` comprueba que el proceso responde. `GET /api/health` valida
configuración local. Ninguno llama al proveedor ni implica que los permisos
de Vertex se hayan probado. Las respuestas no incluyen llaves o tokens.

## Verificación local y CI

```bash
bun install --frozen-lockfile
bun run verify
```

Esto ejecuta TypeScript, pruebas unitarias e integración HTTP/SSE con un
proveedor guionado, y la demo de 28 comprobaciones. No necesita credenciales
ni red hacia Google. Las pruebas de integración usan directorios temporales.
Los tests históricos y `demo.ts` regeneran `out/`: ejecuta las verificaciones
en un checkout de desarrollo, nunca contra un registro de compras en uso.

El workflow `.github/workflows/verify.yml` repite esas verificaciones y
construye la imagen. No despliega ni necesita secretos GCP.

## Referencias oficiales

- [SDK Google GenAI y selección de backend](https://googleapis.github.io/js-genai/release_docs/classes/client.GoogleGenAI.html)
- [Configurar ADC](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth)
- [Firmas e IDs en function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Versiones y ciclo de vida de modelos](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)
- [Contrato de contenedores Cloud Run](https://docs.cloud.google.com/run/docs/container-contract)
