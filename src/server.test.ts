import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FinishReason, GoogleGenAI, type Content } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import { crearAplicacion, DIRECTORIO_PROYECTO } from "./server";
import { leerConfiguracionLLM } from "./config";
import { crearAdaptadorLLM, type AdaptadorLLM } from "./agente/llm";

const configuracion = leerConfiguracionLLM({ LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proyecto-de-prueba" });
const request = (sessionId: string, message: string) => new Request("http://local/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message }),
});
const texto: AdaptadorLLM = { enviar: async () => ({ ok: true, data: { texto: "Listo.", llamadas_herramienta: [], tokens_entrada: 1, tokens_salida: 1 } }) };
function eventos(sse: string): Array<{ evento: string; data: Record<string, unknown> }> {
  return sse.split("\n\n").filter((f) => f.startsWith("event:")).map((f) => {
    const lineas = f.split("\n");
    return { evento: lineas[0]!.slice(7), data: JSON.parse(lineas.find((l) => l.startsWith("data: "))!.slice(6)) };
  });
}

/** Proveedor guionado: sustituye solo la red, conserva SDK -> ciclo -> tools -> SAP. */
function proveedorLocal(caso: string) {
  let paso = 0;
  let confirmacionCreada = false;
  const pasos = ["oc_leer_paquete", "oc_validar", "oc_generar_evidencia", "oc_construir_payload", "oc_crear"];
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: "token-local-ficticio", expiry_date: Date.now() + 3_600_000 });
  return crearAdaptadorLLM({ configuracion, crearCliente: (opciones) => new GoogleGenAI({
    ...opciones,
    googleAuthOptions: { authClient: auth },
    httpOptions: { ...opciones.httpOptions, fetch: async (_url, init) => {
    const cuerpo = JSON.parse(String(init?.body));
    const historial = cuerpo.contents as Content[];
    for (const content of historial) {
      for (const parte of content.parts ?? []) {
        if (parte.functionCall) expect(parte.thoughtSignature).toBe("firma-local");
      }
    }
    const ultimoUsuario = historial.filter((c) => c.role === "user" && c.parts?.some((p) => p.text)).at(-1);
    const confirma = ultimoUsuario?.parts?.[0]?.text === "confirmo";
    const nombre = confirma ? (confirmacionCreada ? undefined : "oc_crear") : pasos[paso++];
    if (confirma) confirmacionCreada = true;
    return Response.json({
      candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: nombre
        ? [{ functionCall: { id: crypto.randomUUID(), name: nombre, args: { caso, ...(nombre === "oc_crear" ? { confirmado: true } : {}) } }, thoughtSignature: "firma-local" }]
        : [{ text: "Resultado disponible para revisión." }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    } },
  }) });
}

let raizTemporal: string;
beforeAll(async () => { raizTemporal = await mkdtemp(path.join(tmpdir(), "oc-http-")); });
afterAll(async () => { await rm(raizTemporal, { recursive: true, force: true }); });
async function directorioCaso(caso: string): Promise<string> {
  const dir = path.join(raizTemporal, caso);
  await mkdir(path.join(dir, "src", "agente"), { recursive: true });
  await cp(path.join(DIRECTORIO_PROYECTO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  await cp(path.join(DIRECTORIO_PROYECTO, "src", "agente", "prompt.md"), path.join(dir, "src", "agente", "prompt.md"));
  return dir;
}

describe("HTTP y SSE locales", () => {
  test("el servidor entrega SSE por HTTP real en loopback", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: crearAplicacion({ llm: texto, configuracion }) });
    try {
      const r = await fetch(new URL("/api/chat", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: crypto.randomUUID(), message: "hola" }),
      });
      expect(r.status).toBe(200);
      expect(eventos(await r.text()).map((e) => e.evento)).toEqual(["message", "done"]);
    } finally { await server.stop(true); }
  });
  test("liveness y readiness distinguen configuración ausente", async () => {
    const app = crearAplicacion({ configuracion: leerConfiguracionLLM({}) });
    expect((await app(new Request("http://local/api/live"))).status).toBe(200);
    expect((await app(new Request("http://local/api/health"))).status).toBe(503);
  });
  test("health de Vertex no exige API key ni expone credenciales", async () => {
    const app = crearAplicacion({ configuracion });
    const r = await app(new Request("http://local/api/health"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ provider: "vertex", configured: true });
  });
  test("no publica archivos ajenos al front", async () => {
    const app = crearAplicacion({ configuracion });
    expect((await app(new Request("http://local/"))).status).toBe(200);
    for (const ruta of ["/.env", "/src/config.ts", "/%2e%2e/README.md", "/fixtures/reto-03/maestros/proveedores.json"]) {
      expect((await app(new Request(`http://local${ruta}`))).status).toBe(404);
    }
  });
  test("valida JSON, tamaño, texto y sesión antes de llamar al modelo", async () => {
    const app = crearAplicacion({ llm: texto, configuracion });
    for (const [sessionId, message] of [["../secret", "hola"], ["sesion", " "], ["sesion", "x".repeat(8001)]]) {
      expect((await app(request(sessionId!, message!))).status).toBe(400);
    }
    expect((await app(new Request("http://local/api/chat", { method: "POST", body: "{}" }))).status).toBe(415);
    expect((await app(new Request("http://local/api/chat", { method: "POST", headers: { "Content-Type": "application/json-invalido" }, body: "{}" }))).status).toBe(415);
    expect((await app(new Request("http://local/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status).toBe(400);
    expect((await app(request("sesion", "x".repeat(40_000)))).status).toBe(413);
    expect((await app(new Request("http://local/api/sessions/%GG"))).status).toBe(400);
  });
  test("impide dos turnos simultáneos de la misma sesión", async () => {
    let liberar!: () => void;
    const pendiente = new Promise<void>((resolve) => { liberar = resolve; });
    const app = crearAplicacion({ configuracion, llm: { enviar: async (...args) => { await pendiente; return texto.enviar(...args); } } });
    const id = crypto.randomUUID();
    const primero = await app(request(id, "hola"));
    expect((await app(request(id, "otro mensaje"))).status).toBe(409);
    liberar();
    expect(eventos(await primero.text()).at(-1)?.evento).toBe("done");
  });
  test("un error imprevisto termina SSE y permite continuar", async () => {
    let falla = true;
    const app = crearAplicacion({ configuracion, llm: { enviar: async (...args) => { if (falla) throw new Error("secreto-no-publicable"); return texto.enviar(...args); } } });
    const id = crypto.randomUUID();
    const primero = await (await app(request(id, "hola"))).text();
    expect(primero).not.toContain("secreto-no-publicable");
    expect(eventos(primero).map((e) => e.evento)).toEqual(["error", "done"]);
    falla = false;
    expect(eventos(await (await app(request(id, "reintenta"))).text()).at(-1)?.evento).toBe("done");
  });
});

describe("flujo completo local con los seis paquetes", () => {
  test.each(["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"])("%s mantiene controles, evidencia, confirmación e idempotencia", async (caso) => {
    const directorio = await directorioCaso(caso);
    const app = crearAplicacion({ directorio, configuracion, llm: proveedorLocal(caso) });
    const sessionId = crypto.randomUUID();
    const primera = await app(request(sessionId, `procesa ${caso}`));
    expect(primera.headers.get("content-type")).toContain("text/event-stream");
    const flujo = eventos(await primera.text());
    expect(flujo.at(-1)?.evento).toBe("done");
    expect(flujo.filter((e) => e.evento === "tool_result")).toHaveLength(5);
    const requiereConfirmar = ["sol-004", "sol-005", "sol-006"].includes(caso);
    const bloqueado = ["sol-002", "sol-003"].includes(caso);
    const rutaOrdenes = path.join(directorio, "out", "sap", "ordenes.jsonl");
    if (requiereConfirmar || bloqueado) expect(await Bun.file(rutaOrdenes).exists()).toBe(false);
    if (requiereConfirmar) {
      expect(flujo.some((e) => e.evento === "needs_confirmation")).toBe(true);
      const confirmado = eventos(await (await app(request(sessionId, "confirmo"))).text());
      expect(confirmado.some((e) => e.evento === "tool_result" && e.data.ok === true)).toBe(true);
      expect(confirmado.at(-1)?.data.needsConfirmation).toBe(false);
    }
    if (!bloqueado) {
      const ordenes = (await readFile(rutaOrdenes, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(ordenes).toHaveLength(1);
      expect(ordenes[0].orden.aprobador.evidencia_sha256).toMatch(/^[a-f0-9]{64}$/);
      const otro = crearAplicacion({ directorio, configuracion, llm: proveedorLocal(caso) });
      const otroId = crypto.randomUUID();
      await (await otro(request(otroId, `procesa ${caso}`))).text();
      if (requiereConfirmar) await (await otro(request(otroId, "confirmo"))).text();
      expect((await readFile(rutaOrdenes, "utf-8")).trim().split("\n")).toHaveLength(1);
    }
    const historial = await app(new Request(`http://local/api/sessions/${sessionId}`));
    expect(historial.status).toBe(200);
    expect(await historial.text()).not.toContain("firma-local");
  });
});
