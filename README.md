# Agente de órdenes de compra · Periferia

Agente conversacional que lee una solicitud, cotización y aprobación, valida
los datos contra los maestros y crea una orden en un **SAP simulado**.
Si hay bloqueos, se detiene; si hay excepciones, pide confirmación humana.
Las diez reglas RC1–RC10 se ejecutan en código, sin delegarlas al modelo.

Este proyecto corresponde al Reto 03 de Periferia IT Group. El diseño está
en [SOLUCION.md](SOLUCION.md); la verificación realizada, en
[EVALUACION.md](EVALUACION.md); la configuración y distribución vigentes, en
[deploy/README.md](deploy/README.md).

## Cómo correrlo

### Con Docker Compose (no requiere instalar nada más)

Solo necesitas Docker con Compose. El chat necesita una clave de Gemini en
`.env`, porque `compose.yaml` lo lee al arrancar:

```bash
cp .env.example .env        # y completa GEMINI_API_KEY en .env
docker compose up --build
```

Abre http://localhost:3000. La clave solo se usa en el backend. Las órdenes
se conservan en un volumen de Docker entre reinicios.

**Límite de la capa gratuita.** El chat usa la capa gratuita de la API de
Gemini, con un límite de 15 peticiones por minuto, salvo que se cargue
crédito en la cuenta de Google. Un turno de chat puede encadenar varias
llamadas al modelo, así que procesar un caso puede acercarse a ese límite;
si lo superas, el chat devuelve un error de cuota (429) con instrucciones y
basta con esperar un minuto.

### Con Bun

Requiere **Bun 1.4.4**, la versión fijada en `package.json`
(`packageManager`), en el `Dockerfile` y en CI. `engines` exige `>=1.4.4`.

```bash
cp .env.example .env        # y completa GEMINI_API_KEY en .env
bun install --frozen-lockfile
bun run doctor              # revisa la configuración local
bun start
```

Abre http://localhost:3000. El proyecto corre con Bun o con Docker; **no
corre solo con Node**, porque el servidor y los scripts usan APIs de Bun. Si
ya tienes Node/npm y no quieres instalar Bun, `npx --yes bun@1.4.4` ejecuta
la versión fijada de Bun en lugar de Node: sustituye `bun` por ese comando.

### Con Vertex AI en lugar de la API key de Gemini

```bash
cp .env.vertex.example .env
# Completar GOOGLE_CLOUD_PROJECT con el proyecto autorizado
# Configurar ADC o GOOGLE_APPLICATION_CREDENTIALS fuera del repositorio
bun install --frozen-lockfile
bun run doctor
bun start
```

Vertex usa `LLM_PROVIDER=vertex`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION` y `GEMINI_MODEL`. **No necesita una API key de Gemini.**
El SDK oficial obtiene credenciales mediante ADC: una cuenta de servicio,
ADC de desarrollo o la identidad asignada en Cloud Run. Para una API key de
**Vertex Express**, selecciona `VERTEX_AUTH_MODE=api-key`, configura
`VERTEX_API_KEY` y un `GEMINI_MODEL` habilitado explícitamente en tu cuenta;
ese modo usa otro endpoint y no utiliza ADC.

La API de Vertex debe estar habilitada y la identidad debe tener acceso al
modelo en el proyecto indicado. Consulta la [guía de Vertex y diagnóstico](deploy/README.md).
`doctor` solo verifica la configuración local; no solicita tokens ni prueba
permisos contra GCP. Con Docker, el overlay `compose.vertex.yaml` monta una
credencial Vertex en solo lectura, según esa misma guía.

## Probarlo sin Google

Las pruebas y la demo no necesitan credenciales ni llamadas a Google.

```bash
bun run verify
```

Ejecuta el chequeo de TypeScript, las pruebas y la demo. También se pueden
usar por separado:

```bash
bun run typecheck
bun test
bun run demo
```

La demo corre los seis casos sin modelo y verifica 34 condiciones. Las pruebas
recorren HTTP/SSE, el adaptador, las herramientas reales y SAP simulado con
respuestas de Google guionadas: firmas e IDs de herramientas, errores de
autenticación y cuota, concurrencia, confirmaciones, evidencia y prevención de
duplicados. Las pruebas de transporte usan el SDK y OAuth reales, con tokens
ficticios en memoria y todas las respuestas HTTP sustituidas localmente; no
verifican disponibilidad real de Vertex. La [evaluación](EVALUACION.md) detalla
qué se verificó y qué falta.

Las pruebas y la demo regeneran `out/`. Ejecútalas en un checkout de
desarrollo, nunca sobre datos de una instancia en uso.

## Casos incluidos

| Caso | Resultado esperado |
|---|---|
| `sol-001` | Creación normal; repetir devuelve la misma orden. |
| `sol-002` | Bloqueo: proveedor inexistente. |
| `sol-003` | Bloqueos: aprobador incorrecto y monto fuera de tope. |
| `sol-004` | Confirmación: diferencia con la cotización. |
| `sol-005` | Confirmación: compra retroactiva. |
| `sol-006` | IVA derivado con confirmación y condiciones de pago derivadas. |

En el chat, escribe `procesa la solicitud sol-004`. Confirma mediante el
botón **Confirmar**, que envía el literal `confirmo` para el caso pendiente.
Un mensaje diferente abandona la confirmación vigente; se debe plantear de
nuevo. El agente no puede autoconfirmarse dentro del mismo turno.

## Distribución

Para generar un paquete de fuentes con checksum SHA-256:

```bash
bun run package
```

El resultado queda en `out/agente-oc-periferia-dev.tar.gz`. Incluye código,
fixtures, documentación, ejemplos de entorno y configuración de despliegue;
excluye `.git`, dependencias instaladas, credenciales y resultados locales.

Para verificar la imagen de producción sin acceso a red externa:

```bash
docker build --platform linux/amd64 -t agente-oc:evaluacion-local .
DOCKER_DEFAULT_PLATFORM=linux/amd64 bun run test:container
```

La prueba recorre los seis casos, verifica escritura sin root, HTTP/SSE y
el arranque y apagado del servidor con el CMD real de la imagen.

La imagen utiliza Bun fijado, dependencias de producción y usuario sin
privilegios. `.dockerignore` y `.gcloudignore` excluyen credenciales, archivos
locales y resultados. CI verifica el proyecto, construye la imagen y adjunta
el paquete de fuentes como artifact; no despliega automáticamente.

`deploy/cloudrun.sh` prepara una demostración **privada** en un proyecto
explícito y con una cuenta de servicio. El filesystem de Cloud Run es
efímero: esta versión no es un registro durable de compras en Cloud Run.
Para producción se necesitan persistencia transaccional, identidad real del
confirmador y el adaptador a SAP real. Consulta los límites y requisitos en
la guía antes de desplegar.

## Arquitectura

- `web/`: chat en HTML, CSS y JavaScript; recibe eventos SSE. Los mensajes del
  agente se muestran con markdown (`marked` 15.0.12 desde cdnjs, con
  integridad verificada y sin HTML crudo); los del usuario, como texto. El
  navegador necesita acceso a cdnjs.cloudflare.com: sin él, el chat funciona y
  muestra el texto del agente sin formato.
- `src/server.ts`: HTTP, validación de peticiones y exclusión de turnos por sesión.
- `src/config.ts`: selección y validación del proveedor.
- `src/agente/`: ciclo, prompt y SDK de Google para Gemini/Vertex.
- `src/tools/oc.ts`: leer, validar, evidenciar, preparar y crear la OC.
- `src/reglas/controles.ts`: controles RC1–RC10, funciones puras.
- `src/sap/`: interfaz e implementación simulada con idempotencia.
- `fixtures/reto-03/`: maestros y seis paquetes de ejemplo, de solo lectura.
- `out/`: órdenes JSONL, auditoría CSV/JSONL, evidencia de aprobación en TXT y
  PDF (`out/<caso>/aprobacion.txt` y `aprobacion.pdf`) y trazabilidad.

El estado de chat vive en memoria del proceso. Tras un reinicio, abre una
conversación nueva; el registro local de órdenes permite evitar duplicados
si `out/` se conserva. La lectura de Excel sigue pendiente: es una extensión
del alcance opcional original.

## Configuración y errores

Además del proveedor, `.env.example` expone límites de iteraciones, tokens,
costo estimado, timeout y reintentos. El límite USD usa una estimación de
tarifa; no equivale a un límite de facturación de Google. Configura
`PRECIO_ENTRADA_USD_POR_MILLON` y `PRECIO_SALIDA_USD_POR_MILLON` con la tarifa
vigente al cambiar de modelo. Cada llamada ya iniciada puede superar
el presupuesto estimado antes de que se revise el acumulado.

`GET /api/live` confirma que el proceso responde. `GET /api/health` comprueba
la configuración y devuelve proveedor y modelo, sin credenciales. No llaman
al modelo ni comprueban permisos de Vertex. Los errores 401, 403, 404, 429 y
timeout se traducen a instrucciones de diagnóstico sin devolver el mensaje
crudo del SDK.

Los datos se validan antes de aplicar RC1–RC10: cantidades e importes válidos,
fechas de calendario, códigos de IVA y pago existentes, y consistencia del
proveedor y moneda entre documentos. `DATOS_INVALIDOS` y `MAESTROS_INVALIDOS`
detienen el flujo sin inventar nuevos valores. Si una OC ya existe pero falla
la auditoría, `AUDITORIA_INCOMPLETA` lo indica y permite recuperar el registro
reprocesando la misma solicitud sin duplicarla.
