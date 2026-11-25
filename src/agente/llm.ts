/** SDK oficial: Gemini Developer API con API key o Vertex AI con ADC. */
import { GoogleGenAI, type GoogleGenAIOptions, type Content, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { leerConfiguracionLLM, type ResultadoConfiguracion } from "../config";
import type { ResultadoHerramienta } from "../tipos";

export type LlamadaHerramienta = { id: string; nombre: string; args: unknown };
export type MensajeLLM =
  | { rol: "user"; texto: string }
  | { rol: "assistant"; texto: string | null; llamadas_herramienta: LlamadaHerramienta[]; contenidoProveedor?: unknown }
  | { rol: "tool"; id_llamada: string; nombre: string; contenido: string };
export type DescripcionHerramienta = {
  nombre: string;
  description: string;
  parametros: Record<string, z.ZodTypeAny>;
};
export type RespuestaLLM = {
  texto: string | null;
  llamadas_herramienta: LlamadaHerramienta[];
  tokens_entrada: number;
  tokens_salida: number;
  /** Content original, incluidas firmas; nunca se envía al front. */
  contenidoProveedor?: unknown;
};
export interface AdaptadorLLM {
  enviar(systemPrompt: string, mensajes: MensajeLLM[], herramientas: DescripcionHerramienta[]): Promise<ResultadoHerramienta<RespuestaLLM>>;
}
type GenerarContenido = (args: GenerateContentParameters) => Promise<GenerateContentResponse>;

/** Agrupa respuestas de herramientas paralelas y conserva IDs y firmas. */
export function convertirHistorial(mensajes: MensajeLLM[]): Content[] {
  const contenidos: Content[] = [];
  let anteriorEraHerramienta = false;
  for (const mensaje of mensajes) {
    if (mensaje.rol === "user") {
      contenidos.push({ role: "user", parts: [{ text: mensaje.texto }] });
    } else if (mensaje.rol === "assistant") {
      if (mensaje.contenidoProveedor) {
        // Reproducir el Content intacto preserva firmas en sus Parts originales.
        contenidos.push(mensaje.contenidoProveedor as Content);
      } else {
        contenidos.push({ role: "model", parts: [
          ...(mensaje.texto ? [{ text: mensaje.texto }] : []),
          ...mensaje.llamadas_herramienta.map((llamada) => ({
            functionCall: { id: llamada.id, name: llamada.nombre, args: llamada.args as Record<string, unknown> },
          })),
        ] });
      }
    } else {
      let resultado: unknown;
      try { resultado = JSON.parse(mensaje.contenido); }
      catch { resultado = { error: "La herramienta devolvió un JSON inválido." }; }
      const parte = { functionResponse: { id: mensaje.id_llamada, name: mensaje.nombre, response: { output: resultado } } };
      const ultimo = contenidos.at(-1);
      if (anteriorEraHerramienta && ultimo?.role === "user") ultimo.parts!.push(parte);
      else contenidos.push({ role: "user", parts: [parte] });
    }
    anteriorEraHerramienta = mensaje.rol === "tool";
  }
  return contenidos;
}

/** No propaga mensajes crudos del SDK: pueden contener URLs o credenciales. */
export function describirErrorProveedor(error: unknown): { error: string; codigo: string } {
  const e = error as { status?: number; code?: string | number; name?: string; message?: string } | null;
  const estado = e?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  if (estado === 408 || e?.name === "AbortError" || e?.name === "TimeoutError" || /timed out|timeout|aborted/i.test(e?.message ?? "")) {
    return { codigo: "LLM_TIMEOUT", error: "El modelo no respondió dentro del tiempo configurado. Intenta de nuevo." };
  }
  switch (estado) {
    case 400: return { codigo: "LLM_BAD_REQUEST", error: "Google rechazó la petición (400). Revisa el modelo, la región y la compatibilidad de las herramientas." };
    case 401: return { codigo: "LLM_AUTH", error: "Google rechazó la autenticación (401). Renueva las credenciales ADC o revisa la API key del proveedor seleccionado." };
    case 403: return { codigo: "LLM_PERMISSION", error: "Google denegó el acceso (403). Revisa el proyecto, la API de Vertex AI, la facturación y el rol roles/aiplatform.user de la identidad configurada." };
    case 404: return { codigo: "LLM_MODEL_NOT_FOUND", error: "El modelo no está disponible (404). Revisa GEMINI_MODEL y GOOGLE_CLOUD_LOCATION para este proyecto." };
    case 429: return { codigo: "LLM_QUOTA", error: "Se agotó la cuota o capacidad del modelo (429). Espera y reintenta, o revisa las cuotas del proyecto." };
  }
  if (estado && estado >= 500) return { codigo: "LLM_UNAVAILABLE", error: "El proveedor del modelo no está disponible temporalmente. Intenta de nuevo." };
  if (/default credentials|credential|invalid_grant|reauth/i.test(e?.message ?? "")) {
    return { codigo: "LLM_AUTH", error: "No se pudieron obtener credenciales GCP. Configura ADC con gcloud auth application-default login o GOOGLE_APPLICATION_CREDENTIALS; en Cloud Run, usa una cuenta de servicio con acceso a Vertex AI." };
  }
  return { codigo: "LLM_CONNECTION", error: "No se pudo completar la comunicación con el modelo. Revisa la conexión y la configuración del proveedor." };
}

export function crearAdaptadorLLM(opciones: {
  configuracion?: ResultadoConfiguracion;
  generar?: GenerarContenido;
  crearCliente?: (opciones: GoogleGenAIOptions) => Pick<GoogleGenAI, "models">;
} = {}): AdaptadorLLM {
  const configuracion = opciones.configuracion ?? leerConfiguracionLLM();
  let generar = opciones.generar;
  return {
    async enviar(systemPrompt, mensajes, herramientas) {
      if (!configuracion.ok) return { ok: false, error: configuracion.error, codigo: "LLM_CONFIG" };
      const c = configuracion.data;
      try {
        if (!generar) {
          const crearCliente = opciones.crearCliente ?? ((args: GoogleGenAIOptions) => new GoogleGenAI(args));
          const cliente = crearCliente({
            ...(c.proveedor === "vertex"
              ? c.autenticacion === "api-key"
                ? { vertexai: true, apiKey: c.apiKey }
                : { vertexai: true, project: c.proyecto, location: c.ubicacion }
              : { vertexai: false, apiKey: c.apiKey }),
            httpOptions: { timeout: c.timeoutMs, retryOptions: {
              attempts: c.intentos, initialDelay: 1, maxDelay: 8,
              httpStatusCodes: [408, 429, 500, 502, 503, 504],
            } },
          });
          generar = (args) => cliente.models.generateContent(args);
        }
        const respuesta = await generar({
          model: c.modelo,
          contents: convertirHistorial(mensajes),
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: 8192,
            abortSignal: AbortSignal.timeout(c.timeoutMs),
            ...(herramientas.length ? { tools: [{ functionDeclarations: herramientas.map((h) => ({
              name: h.nombre, description: h.description,
              parametersJsonSchema: z.toJSONSchema(z.object(h.parametros)),
            })) }] } : {}),
          },
        });
        if (respuesta.promptFeedback?.blockReason) {
          return { ok: false, codigo: "LLM_BLOCKED", error: "El proveedor bloqueó la petición. Revisa el contenido de la solicitud." };
        }
        const candidato = respuesta.candidates?.[0];
        if (!candidato?.content?.parts?.length) {
          return { ok: false, codigo: "LLM_EMPTY", error: "El modelo no devolvió una respuesta utilizable. Intenta de nuevo." };
        }
        if (candidato.finishReason && candidato.finishReason !== "STOP") {
          return { ok: false, codigo: candidato.finishReason === "MAX_TOKENS" ? "LLM_TRUNCATED" : "LLM_BLOCKED",
            error: "El modelo no pudo completar la respuesta. No se ejecutaron nuevas herramientas; reduce el alcance del mensaje y reintenta." };
        }
        const llamadas: LlamadaHerramienta[] = [];
        const textos: string[] = [];
        const contenido = structuredClone(candidato.content);
        for (const parte of contenido.parts ?? []) {
          if (parte.text && !parte.thought) textos.push(parte.text);
          if (parte.functionCall?.name) {
            const llamada = parte.functionCall;
            llamada.id ??= crypto.randomUUID();
            llamadas.push({ id: llamada.id, nombre: llamada.name!, args: llamada.args ?? {} });
          }
        }
        if (!llamadas.length && !textos.join("").trim()) {
          return { ok: false, codigo: "LLM_EMPTY", error: "El modelo no devolvió texto ni herramientas utilizables." };
        }
        return { ok: true, data: {
          texto: textos.length ? textos.join("") : null,
          llamadas_herramienta: llamadas,
          tokens_entrada: respuesta.usageMetadata?.promptTokenCount ?? 0,
          tokens_salida: (respuesta.usageMetadata?.candidatesTokenCount ?? 0) + (respuesta.usageMetadata?.thoughtsTokenCount ?? 0),
          contenidoProveedor: contenido,
        } };
      } catch (error) {
        return { ok: false, ...describirErrorProveedor(error) };
      }
    },
  };
}
