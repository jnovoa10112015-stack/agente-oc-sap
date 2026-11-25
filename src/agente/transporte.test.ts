/** SDK y OAuth reales; tokens ficticios en memoria y fetch completamente sustituido. */
import { describe, expect, test } from "bun:test";
import { GoogleGenAI, type Content } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { leerConfiguracionLLM } from "../config";
import { crearAdaptadorLLM, type MensajeLLM } from "./llm";

type Peticion = { url: URL; headers: Headers; body: Record<string, any> };
const herramientas = [{ nombre: "consultar", description: "consulta local", parametros: { caso: z.string() } }];
function crearPrueba(proveedor: "vertex" | "gemini", region = "global", estados = [200], express = false) {
  const peticiones: Peticion[] = [];
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: "token-ficticio-sin-red", expiry_date: Date.now() + 3_600_000 });
  const configuracion = leerConfiguracionLLM(proveedor === "vertex"
    ? { LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proyecto-de-prueba", GOOGLE_CLOUD_LOCATION: region, LLM_MAX_ATTEMPTS: "2", ...(express ? { VERTEX_AUTH_MODE: "api-key", VERTEX_API_KEY: "clave-express-ficticia", GEMINI_MODEL: "modelo-de-prueba" } : {}) }
    : { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "clave-ficticia-sin-red", LLM_MAX_ATTEMPTS: "2" });
  const llm = crearAdaptadorLLM({ configuracion, crearCliente: (opciones) => new GoogleGenAI({
    ...opciones,
    ...(proveedor === "vertex" ? { googleAuthOptions: { authClient: auth } } : {}),
    httpOptions: { ...opciones.httpOptions, fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(["aiplatform.googleapis.com", "us-central1-aiplatform.googleapis.com", "generativelanguage.googleapis.com"]).toContain(url.hostname);
      const body = JSON.parse(String(init?.body));
      peticiones.push({ url, headers: new Headers(init?.headers), body });
      const status = estados[Math.min(peticiones.length - 1, estados.length - 1)]!;
      const response = status !== 200 ? { error: { code: status, status: "RESOURCE_EXHAUSTED", message: "detalle-privado-no-publicar" } } : {
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{
          functionCall: { id: "id-google", name: "consultar", args: { caso: "sol-001" } }, thoughtSignature: "firma-ficticia",
        }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      };
      return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
    } },
  }) });
  return { llm, peticiones };
}

describe("transporte real del SDK sin salir a internet", () => {
  test("un transporte que no responde se cancela por el timeout del SDK", async () => {
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: "token-local", expiry_date: Date.now() + 3_600_000 });
    const c = leerConfiguracionLLM({ LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proyecto-de-prueba", LLM_TIMEOUT_MS: "1000", LLM_MAX_ATTEMPTS: "1" });
    const llm = crearAdaptadorLLM({ configuracion: c, crearCliente: (opciones) => new GoogleGenAI({
      ...opciones, googleAuthOptions: { authClient: auth },
      httpOptions: { ...opciones.httpOptions, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) { reject(new Error("El SDK no propagó la señal de cancelación")); return; }
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) },
    }) });
    const r = await llm.enviar("reglas", [{ rol: "user", texto: "hola" }], []);
    expect(!r.ok && r.codigo).toBe("LLM_TIMEOUT");
  });
  test("Vertex Express usa su API key y no envía token ADC", async () => {
    const { llm, peticiones } = crearPrueba("vertex", "global", [200], true);
    const r = await llm.enviar("reglas", [{ rol: "user", texto: "hola" }], herramientas);
    expect(r.ok).toBe(true);
    expect(peticiones[0]?.url.hostname).toBe("aiplatform.googleapis.com");
    expect(peticiones[0]?.url.pathname).not.toContain("proyecto-de-prueba");
    expect(peticiones[0]?.headers.get("x-goog-api-key")).toBe("clave-express-ficticia");
    expect(peticiones[0]?.headers.has("authorization")).toBe(false);
  });
  test.each(["vertex", "gemini"] as const)("%s conserva contratos, autenticación y firmas al serializar", async (proveedor) => {
    const { llm, peticiones } = crearPrueba(proveedor);
    const user: MensajeLLM = { rol: "user", texto: "procesa" };
    const r = await llm.enviar("reglas", [user], herramientas);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const primero = peticiones[0]!;
    if (proveedor === "vertex") {
      expect(primero.url.hostname).toBe("aiplatform.googleapis.com");
      expect(primero.url.pathname).toContain("projects/proyecto-de-prueba/locations/global/publishers/google/models/");
      expect(primero.headers.get("authorization")).toBe("Bearer token-ficticio-sin-red");
      expect(primero.headers.has("x-goog-api-key")).toBe(false);
    } else {
      expect(primero.url.hostname).toBe("generativelanguage.googleapis.com");
      expect(primero.headers.get("x-goog-api-key")).toBe("clave-ficticia-sin-red");
      expect(primero.headers.has("authorization")).toBe(false);
    }
    expect(primero.body.tools[0].functionDeclarations[0].parametersJsonSchema.properties.caso.type).toBe("string");
    expect(primero.body.generationConfig.maxOutputTokens).toBe(8192);
    expect(r.data.llamadas_herramienta[0]?.id).toBe("id-google");
    await llm.enviar("reglas", [user, { rol: "assistant", ...r.data }, {
      rol: "tool", id_llamada: "id-google", nombre: "consultar", contenido: '{"ok":true}',
    }], herramientas);
    const segundo = peticiones[1]!;
    expect(segundo.body.contents[1].parts[0].thoughtSignature).toBe("firma-ficticia");
    expect(segundo.body.contents[2].parts[0].functionResponse.id).toBe("id-google");
    expect((r.data.contenidoProveedor as Content).parts?.[0]?.thoughtSignature).toBe("firma-ficticia");
  });
  test("usa el endpoint regional elegido", async () => {
    const { llm, peticiones } = crearPrueba("vertex", "us-central1");
    expect((await llm.enviar("reglas", [{ rol: "user", texto: "hola" }], [])).ok).toBe(true);
    expect(peticiones[0]?.url.hostname).toBe("us-central1-aiplatform.googleapis.com");
  });
  test("reintenta 429 de forma acotada con el SDK real", async () => {
    const { llm, peticiones } = crearPrueba("vertex", "global", [429, 200]);
    expect((await llm.enviar("reglas", [{ rol: "user", texto: "hola" }], [])).ok).toBe(true);
    expect(peticiones).toHaveLength(2);
  }, 10000);
  test("403 no se reintenta ni expone detalles privados", async () => {
    const { llm, peticiones } = crearPrueba("vertex", "global", [403]);
    const r = await llm.enviar("reglas", [{ rol: "user", texto: "hola" }], []);
    expect(!r.ok && r.codigo).toBe("LLM_PERMISSION");
    expect(JSON.stringify(r)).not.toContain("detalle-privado");
    expect(peticiones).toHaveLength(1);
  });
});
