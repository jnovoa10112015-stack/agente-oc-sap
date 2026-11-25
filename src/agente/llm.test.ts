import { describe, expect, test } from "bun:test";
import { GenerateContentResponse, FinishReason, type Content, type GenerateContentParameters } from "@google/genai";
import { z } from "zod";
import { leerConfiguracionLLM } from "../config";
import { convertirHistorial, crearAdaptadorLLM, describirErrorProveedor, type MensajeLLM } from "./llm";

const configuracion = leerConfiguracionLLM({ LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proyecto-de-prueba" });
function respuesta(content: Content): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), { candidates: [{ content, finishReason: FinishReason.STOP }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3 } });
}

describe("adaptador Google sin red", () => {
  test("conserva todas las Parts y firmas, y agrupa resultados con sus IDs", async () => {
    const original: Content = { role: "model", parts: [
      { text: "razonamiento privado", thought: true, thoughtSignature: "firma-pensamiento" },
      { text: "Voy a consultar.", thoughtSignature: "firma-texto" },
      { functionCall: { id: "google-a", name: "oc_leer_paquete", args: { caso: "sol-001" } }, thoughtSignature: "firma-a" },
      { functionCall: { id: "google-b", name: "oc_validar", args: { caso: "sol-001" } }, thoughtSignature: "firma-b" },
    ] };
    const solicitudes: GenerateContentParameters[] = [];
    const llm = crearAdaptadorLLM({ configuracion, generar: async (args) => { solicitudes.push(args); return respuesta(original); } });
    const r = await llm.enviar("reglas", [{ rol: "user", texto: "procesa sol-001" }], [{ nombre: "oc_validar", description: "valida", parametros: { caso: z.string() } }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.texto).toBe("Voy a consultar.");
    expect(r.data.tokens_salida).toBe(5);
    expect(r.data.llamadas_herramienta.map((l) => l.id)).toEqual(["google-a", "google-b"]);
    const mensajes: MensajeLLM[] = [
      { rol: "user", texto: "procesa sol-001" },
      { rol: "assistant", ...r.data },
      { rol: "tool", id_llamada: "google-a", nombre: "oc_leer_paquete", contenido: '{"ok":true}' },
      { rol: "tool", id_llamada: "google-b", nombre: "oc_validar", contenido: '{"ok":true}' },
    ];
    const historial = convertirHistorial(mensajes);
    expect(historial[1]).toEqual(original);
    expect(historial).toHaveLength(3);
    expect(historial[2]?.parts?.map((p) => p.functionResponse?.id)).toEqual(["google-a", "google-b"]);
    await llm.enviar("reglas", mensajes, []);
    expect(solicitudes[1]?.contents).toEqual(historial);
    expect(JSON.stringify(solicitudes[0]?.config?.tools)).toContain("parametersJsonSchema");
  });
  test("genera IDs únicos cuando Google no envía uno", async () => {
    const llm = crearAdaptadorLLM({ configuracion, generar: async () => respuesta({ role: "model", parts: [
      { functionCall: { name: "oc_validar" }, thoughtSignature: "firma" },
      { functionCall: { name: "oc_validar" } },
    ] }) });
    const r = await llm.enviar("reglas", [], []);
    if (!r.ok) throw new Error(r.error);
    expect(new Set(r.data.llamadas_herramienta.map((l) => l.id)).size).toBe(2);
    expect((r.data.contenidoProveedor as Content).parts?.[0]?.functionCall?.id).toBe(r.data.llamadas_herramienta[0]?.id);
  });
  test.each([400, 401, 403, 404, 429, 503])("traduce HTTP %i sin revelar el error crudo", async (status) => {
    const llm = crearAdaptadorLLM({ configuracion, generar: async () => { throw { status, message: "credencial-supersecreta" }; } });
    const r = await llm.enviar("reglas", [], []);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("supersecreta");
    expect(!r.ok && r.codigo).toStartWith("LLM_");
  });
  test("credenciales ausentes y timeout son errores accionables", () => {
    expect(describirErrorProveedor(new Error("Could not load the default credentials")).codigo).toBe("LLM_AUTH");
    expect(describirErrorProveedor({ name: "TimeoutError" }).codigo).toBe("LLM_TIMEOUT");
  });
  test("una configuración inválida nunca invoca el SDK", async () => {
    let llamadas = 0;
    const llm = crearAdaptadorLLM({ configuracion: leerConfiguracionLLM({}), generar: async () => { llamadas++; return respuesta({}); } });
    expect((await llm.enviar("reglas", [], [])).ok).toBe(false);
    expect(llamadas).toBe(0);
  });
  test("rechaza respuestas truncadas antes de ejecutar sus herramientas", async () => {
    const llm = crearAdaptadorLLM({ configuracion, generar: async () => Object.assign(respuesta({ parts: [{ functionCall: { name: "oc_crear" } }] }), {
      candidates: [{ finishReason: FinishReason.MAX_TOKENS, content: { parts: [{ functionCall: { name: "oc_crear" } }] } }],
    }) });
    const r = await llm.enviar("reglas", [], []);
    expect(!r.ok && r.codigo).toBe("LLM_TRUNCATED");
  });
  test("rechaza respuestas vacías y bloqueadas", async () => {
    for (const raw of [new GenerateContentResponse(), Object.assign(new GenerateContentResponse(), { promptFeedback: { blockReason: "SAFETY" } })]) {
      const llm = crearAdaptadorLLM({ configuracion, generar: async () => raw });
      expect((await llm.enviar("reglas", [], [])).ok).toBe(false);
    }
  });
});
