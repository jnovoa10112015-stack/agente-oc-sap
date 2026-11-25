/** Se ejecuta dentro de la imagen de producción, con --network none. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { leer_paquete, validar, generar_evidencia, construir_payload, crear } from "../src/tools/oc";
import { crearAplicacion } from "../src/server";
import { leerConfiguracionLLM } from "../src/config";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid?.(), 0, "El contenedor no debe ejecutarse como root");
assert.equal(await Bun.file("/app/.env").exists(), false);
assert.equal(await Bun.file("/app/src/server.test.ts").exists(), false);
await Bun.write("/app/out/prueba-escritura.txt", "ok");
const ctx = { directory: "/app", sessionId: "prueba-contenedor" };
let creadas = 0;
for (const caso of ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]) {
  const p = JSON.parse(await leer_paquete.execute({ caso }, ctx)); assert.equal(p.ok, true);
  const v = JSON.parse(await validar.execute({ caso, paquete: p.data }, ctx)); assert.equal(v.ok, true);
  const e = JSON.parse(await generar_evidencia.execute({ caso }, ctx)); assert.equal(e.ok, true);
  const b = JSON.parse(await construir_payload.execute({ caso, paquete: p.data, validacion: v.data, derivados: v.data.derivados, evidencia_sha256: e.data.sha256 }, ctx));
  assert.equal(b.ok, true);
  const primera = JSON.parse(await crear.execute({ caso, payload: b.data.payload, confirmado: false }, ctx));
  if (v.data.bloqueos.length) assert.equal(primera.ok, false);
  else if (v.data.confirmaciones.length) {
    assert.equal(primera.ok, false);
    // Consentimiento explícito del arnés de prueba, sin modelo ni usuario real.
    const confirmada = JSON.parse(await crear.execute({ caso, payload: b.data.payload, confirmado: true }, ctx));
    assert.equal(confirmada.ok, true); creadas++;
  } else {
    assert.equal(primera.ok, true); creadas++;
    const repetida = JSON.parse(await crear.execute({ caso, payload: b.data.payload, confirmado: false }, ctx));
    assert.equal(repetida.data.idempotente, true);
    assert.equal(repetida.data.numero_oc, primera.data.numero_oc);
  }
}
const lineas = (await readFile("/app/out/sap/ordenes.jsonl", "utf-8")).trim().split("\n");
assert.equal(lineas.length, 4);
assert.equal(creadas, 4);

const app = crearAplicacion({ configuracion: leerConfiguracionLLM({}), llm: {
  enviar: async () => ({ ok: true, data: { texto: "Respuesta simulada local.", llamadas_herramienta: [], tokens_entrada: 1, tokens_salida: 1 } }),
} });
const servidor = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app });
try {
  const live = await fetch(new URL("/api/live", servidor.url)); assert.equal(live.status, 200);
  const health = await fetch(new URL("/api/health", servidor.url)); assert.equal(health.status, 503);
  const pagina = await fetch(servidor.url); assert.equal(pagina.status, 200);
  const chat = await fetch(new URL("/api/chat", servidor.url), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "contenedor-http", message: "hola" }),
  });
  assert.equal(chat.status, 200);
  const contenido = await chat.text();
  assert.ok(contenido.includes("event: message")); assert.ok(contenido.includes("event: done"));
} finally { await servidor.stop(true); }
console.log(JSON.stringify({ ok: true, runtime: Bun.version, platform: process.platform, architecture: process.arch, uid: process.getuid?.(), casos: 6, ordenes: creadas, httpSse: true, redExterna: false }));
