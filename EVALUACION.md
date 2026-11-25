# Verificación del proyecto

Fecha: 24 de noviembre de 2026. Rama: `main`. Runtime fijado: Bun 1.4.4
(`package.json`, `Dockerfile` y CI).

Este documento separa cuatro cosas: lo que verifiqué en mi máquina, lo que
verificó el CI de GitHub Actions, lo que registré en versiones anteriores y no
repetí, y lo que sigue sin probarse. No afirmo como verificado nada que no
haya vuelto a ejecutar.

## Qué verifiqué hoy

Máquina: Windows 11, Bun 1.4.5 (la última disponible al hacerlo; cumple
`engines: bun >=1.4.4`). Esta máquina no tiene Docker instalado. No usé
credenciales reales ni hice llamadas a las APIs de Google.

| Comprobación | Comando | Resultado de hoy |
|---|---|---|
| Instalación | `bun install` sobre un clon nuevo | Funciona tras limpiar la caché global de Bun (ver abajo) |
| Tipos | `bunx tsc --noEmit` | Sin errores |
| Pruebas | `bun test` | 135 pruebas en 10 archivos, 584 aserciones `expect()`, 0 fallos |
| Demo | `bun run demo` | 34 de 34 comprobaciones sobre los seis paquetes |

**Un fallo de instalación que encontré.** En el primer intento, `bun install`
dijo haber instalado `zod`, pero `node_modules/zod` no existía y todo lo que
lo importa fallaba (`Cannot find package 'zod'`). Ocurrió igual con Bun 1.4.2
y 1.4.5, dentro y fuera de OneDrive, y con `--force`. La causa era una caché
global de Bun dañada; `bun pm cache rm` y una reinstalación lo resolvieron.
El `package.json` y el lockfile estaban bien. Si te pasa lo mismo, es lo
primero que debes probar.

Los tests que pasaron hoy son los que cubren las filas siguientes. No volví a
leer cada test al escribir este documento: el alcance de cada fila es el que
declaré al escribirlos.

| Componente | Método | Alcance |
|---|---|---|
| Reglas y datos | Pruebas de RC1–RC10 y de calidad de datos | Bloqueos, confirmaciones y rechazo de datos inválidos antes de aplicar reglas |
| Gemini | SDK oficial + fetch sustituido | Endpoint, API key, schemas, firmas e IDs |
| Vertex ADC | OAuth2Client con token ficticio + fetch sustituido | Bearer ficticio, proyecto y endpoints global y regional |
| Vertex Express | SDK oficial + API key ficticia + fetch sustituido | Endpoint sin proyecto ni token ADC; modelo explícito |
| Fallos del proveedor | Respuestas HTTP locales 400/401/403/404/429/503 y timeout | Mensajes seguros y reintentos acotados; 403 no se reintenta |
| HTTP/SSE | Requests en proceso | Validación, historial, fin de turno y exclusión por sesión |
| Herramientas y SAP | Fixtures y directorios temporales | Bloqueos, confirmaciones, evidencia TXT y PDF, prevención de duplicados |
| Concurrencia | 20 intentos simultáneos | Un registro de orden y todas las filas de auditoría, dentro de un proceso |
| Evidencia PDF | `src/tools/evidencia-pdf.test.ts` y una aserción por caso en la demo | El PDF existe, no está vacío y contiene el sha256 del `.txt` |
| Front con markdown | Edge headless (Windows) controlado por CDP contra el servidor real con un modelo simulado que devuelve markdown; más 16 casos del renderizador con el `marked` fijado | Tabla, negritas, lista y encabezado se renderizan; el HTML crudo, los enlaces `javascript:` y las imágenes quedan como texto o sin enlace; el mensaje del usuario se muestra como texto; la consola del navegador queda sin entradas. Lo corrí una vez a mano con un script que no está en el repo: no forma parte de la suite ni del CI, y solo lo probé en Edge |

Los tests de transporte no son llamadas reales a Google. Ejecutan la
serialización y los reintentos del SDK, pero el token OAuth y las respuestas
son ficticios. No demuestran permisos IAM, facturación, cuotas ni acceso a
un modelo en una cuenta real.

Del PDF de evidencia solo comprobé que empieza con `%PDF-`, que se vuelve a
cargar con `pdf-lib` y que su texto extraído contiene el sha256. No lo abrí en
un visor, así que no sé cómo se ve la maquetación.

## Verificado vía CI de GitHub Actions

El workflow `.github/workflows/verify.yml` corrió en GitHub sobre dos pushes a
`main` y las dos corridas terminaron en éxito:

| Corrida | Commit | Hora (UTC) |
|---|---|---|
| 45542710939 | `Agente conversacional de órdenes de compra sobre SAP simulado` | 2026-11-25 03:50 |
| 45543413028 | `Nombre del servicio` | 2026-11-25 03:56 |

Corre en `ubuntu-latest` con Bun 1.4.4 fijado. Leí el workflow y el resultado
de cada job, pero no abrí los logs de los pasos: no tengo a la vista las
cifras de pruebas que imprimió el CI. Un job en éxito significa que cada paso
terminó con código 0. Qué demuestra cada paso:

| Paso del workflow | Qué demuestra |
|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | El lockfile instala tal cual en una máquina limpia, con red |
| `bun run verify` | Chequeo de tipos, pruebas y demo pasan en Linux con Bun 1.4.4 |
| `docker build --platform linux/amd64` | La imagen de producción se construye para `linux/amd64`, la arquitectura que exige Cloud Run |
| `scripts/smoke-container.sh` | Dentro de la imagen y con `--network none`: no corre como root, escribe en `out/`, procesa los seis casos y crea 4 órdenes, y atiende HTTP/SSE con un modelo simulado en `127.0.0.1`. Después arranca el CMD real de la imagen (liveness 200, readiness 503 sin llaves, front 200) y lo apaga con SIGTERM con código de salida 0 |
| `bun test /app/src` en la imagen, `--network none` | La suite pasa con las dependencias de producción y sin red |
| `bun run package` y extracción en otra carpeta | El paquete se genera y, ya extraído, instala con lockfile fijado y pasa `bun run verify` |

Lo verificado es lo que ese workflow ejecuta y nada más. Una anotación de GitHub avisa de que
`actions/checkout@v4` y `actions/upload-artifact@v4` usan Node 20, en desuso, y
se fuerzan a Node 24. Es una advertencia, no un fallo.

## Pendiente de reverificar

Estas comprobaciones no las repetí hoy ni las cubre el workflow. Una versión
anterior de este documento daba por hechas varias de ellas, con las cifras de
entonces (130 pruebas, 28 comprobaciones de la demo):

| Comprobación | Estado |
|---|---|
| Suite completa en macOS | Pendiente de reverificar; el CI solo corre en Linux |
| Imagen de producción Linux ARM64, `--network none` | Pendiente de reverificar; el CI construye solo `linux/amd64` y en esta máquina no hay Docker |
| `docker compose up --build` con `.env` | Pendiente de reverificar; ni yo ni el workflow lo ejecutamos |
| Verificación del checksum del paquete (`shasum -a 256 -c`) | Pendiente de reverificar; el workflow genera el `.sha256` pero no lo comprueba |
| Instalación offline con lockfile fijado | Pendiente de reverificar; el CI instala con red y en mi máquina instalé con red y sin `--frozen-lockfile` |

## Defectos corregidos

Las correcciones están hechas y cubiertas por la suite que pasó hoy. El código
original solo conectaba con Gemini Developer API; una configuración de Vertex
no era equivalente a ese contrato. Antes había 61 pruebas que sustituían el punto de generación del SDK y no
cubrían varios datos inválidos; las amplié y ahora también ejecuto el SDK real
con su transporte sustituido.

| Hallazgo | Comportamiento anterior | Corrección |
|---|---|---|
| Proveedor por nombre | SAS y S.A.S. podían normalizarse de forma diferente | Normalización común de sufijos y tildes |
| Proveedor ambiguo | Se elegía la primera coincidencia | RC1 bloquea coincidencias múltiples; los catálogos rechazan NIT y códigos duplicados |
| NIT con formato | Puntos y dígito de verificación explícito podían impedir la comparación | Se compara la base del NIT en el formato de los fixtures; no se calcula su checksum |
| Correo del aprobador | Las mayúsculas impedían reconocer una identidad conocida | Comparación de correos normalizada |
| Cantidades e importes | Se aceptaban cantidades negativas o cero | Validación numérica antes de las reglas; importes no finitos rechazados |
| Fechas | Una fecha imposible podía pasar como string | Validación de fecha real y timestamp ISO |
| IVA y pago | Se aceptaban códigos inexistentes o defaults inválidos | Integridad de catálogos y referencias |
| Fuentes incompatibles | Se comparaban importes en monedas distintas o cotizaciones de otro NIT | `DATOS_INVALIDOS`; se exige corregir las fuentes |
| Importes de texto | Se borraban separadores decimales | Parseo explícito de agrupación y decimales; rechazo de texto parcialmente numérico |
| Aprobación ambigua | Una condición, pregunta, cita o rechazo podía contarse como aprobación | Solo afirmaciones explícitas y sin contradicciones detectadas |
| Registro vacío o corrupto | Un registro vacío reiniciaba el consecutivo | Se bloquea la creación y se requiere recuperación |
| Auditoría fallida | Una OC podía informarse como éxito completo aunque fallara el CSV | `AUDITORIA_INCOMPLETA` identifica la OC existente; el reintento es idempotente |
| Backend de Google | El adaptador solo admitía Gemini con API key | Selección explícita de Gemini, Vertex ADC y Vertex Express |
| Historial Google | Se podían perder IDs y Parts firmadas | Se conserva el contenido original y se agrupan respuestas de herramientas |

Mantuve los nombres y el sentido de RC1–RC10. Los errores de formato o
integridad no inventan nuevos controles de autorización: se rechazan antes
de aplicar las reglas. Cantidad y total deben ser positivos; el precio unitario,
no negativo. Se admiten los correos Unicode usados por los fixtures.

Además, agregué hoy la evidencia de aprobación en PDF (`out/<caso>/aprobacion.pdf`,
`pdf-lib` 1.17.1), que `oc_generar_evidencia` escribe junto al `.txt`.

## Mensaje de error esperado en los tests

Al correr `bun test` aparece una línea
`[oc_crear] No se pudo escribir out/control.csv: EISDIR`. No es un fallo. La
provoca a propósito el test de `AUDITORIA_INCOMPLETA`, que crea
`control.csv` como carpeta dentro de un directorio temporal para forzar el
error de auditoría; la línea es el log de ese error esperado y no toca el
`out/` del repositorio.

## Repetir las comprobaciones

```bash
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

Si después de instalar falta `node_modules/zod`, limpia la caché global con
`bun pm cache rm` y reinstala.

Las pruebas y la demo regeneran `out/`; deben ejecutarse en un checkout de
desarrollo, separado de cualquier registro de compras en uso.

Pruebas de la imagen de producción, sin red externa durante la ejecución:

```bash
docker build --platform linux/amd64 -t agente-oc:evaluacion-amd64 .
DOCKER_DEFAULT_PLATFORM=linux/amd64 bash scripts/smoke-container.sh agente-oc:evaluacion-amd64
docker run --rm --pull=never --platform linux/amd64 --network none \
  --mount "type=bind,source=$PWD/src,target=/app/src,readonly" \
  agente-oc:evaluacion-amd64 bun test /app/src
```

El build descarga dependencias públicas de Docker Hub y npm. La ejecución de
los tests del contenedor usa `--network none`, sin llaves ni volúmenes de
credenciales. No publico la imagen ni despliego un servicio.

Para distribuir y comprobar el checksum:

```bash
bun run package
(cd out && shasum -a 256 -c agente-oc-periferia-dev.tar.gz.sha256)
```

El workflow de CI también extrae el paquete en otra carpeta, instala sus
dependencias y vuelve a ejecutar la verificación. No necesita secretos GCP.

## Qué sigue pendiente de un entorno real

- Conectar con una identidad y un proyecto expresamente autorizados para
  comprobar OAuth/IAM o la API key real, API habilitada, facturación, cuota,
  modelo y región. `doctor` y `/api/health` solo validan configuración local.
- Desplegar y probar Cloud Run con su identidad de servicio y proxy real.
  Cloud Run exige una imagen con soporte `linux/amd64`; una imagen ARM de
  un Mac no cumple por sí sola ese requisito. [Contrato oficial](https://docs.cloud.google.com/run/docs/container-contract).
- Sustituir los archivos locales por persistencia transaccional y evidencia
  externa para operación durable o múltiples instancias. El mutex actual es
  de un proceso. La prueba concurrente no demuestra seguridad entre procesos.
  La traza JSONL es de mejor esfuerzo; los archivos de órdenes y auditoría
  no constituyen una transacción única.
- Incorporar autenticación de la analista y un origen de aprobación fiable
  para operación real. Un correo JSON del fixture y un nombre fijo en
  `USUARIO_CONFIRMADOR` no acreditan identidad. La detección textual de
  aprobación es deliberadamente conservadora y no comprende toda la prosa.
- Implementar la conexión a SAP real y la lectura de Excel, que sigue siendo
  una extensión opcional pendiente; no la presento como terminada.

Las dos primeras verificaciones necesitan un entorno autorizado; no las
realicé. Las restantes son límites del alcance actual, no fallos ocultos por
los tests.
