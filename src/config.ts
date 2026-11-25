/** Una API key de Gemini no autentica Vertex AI. */
export type Entorno = Record<string, string | undefined>;
export type ConfiguracionLLM = {
  proveedor: "gemini" | "vertex";
  autenticacion?: "adc" | "api-key";
  modelo: string;
  apiKey?: string;
  proyecto?: string;
  ubicacion: string;
  timeoutMs: number;
  intentos: number;
};
export type ResultadoConfiguracion =
  | { ok: true; data: ConfiguracionLLM }
  | { ok: false; error: string };

export function leerConfiguracionLLM(env: Entorno = process.env): ResultadoConfiguracion {
  const valor = (nombre: string) => env[nombre]?.trim() || undefined;
  const modoVertex = valor("GOOGLE_GENAI_USE_VERTEXAI")?.toLowerCase();
  if (modoVertex && !["true", "false"].includes(modoVertex)) {
    return { ok: false, error: "GOOGLE_GENAI_USE_VERTEXAI debe ser true o false." };
  }
  const proveedor = valor("LLM_PROVIDER") || (modoVertex === "true" ? "vertex" : "gemini");
  if (proveedor !== "gemini" && proveedor !== "vertex") {
    return { ok: false, error: "LLM_PROVIDER debe ser gemini o vertex." };
  }
  if (modoVertex && (modoVertex === "true") !== (proveedor === "vertex")) {
    return { ok: false, error: "LLM_PROVIDER y GOOGLE_GENAI_USE_VERTEXAI se contradicen." };
  }
  const timeoutMs = Number(valor("LLM_TIMEOUT_MS") ?? 60_000);
  const intentos = Number(valor("LLM_MAX_ATTEMPTS") ?? 3);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    return { ok: false, error: "LLM_TIMEOUT_MS debe ser un entero entre 1000 y 300000." };
  }
  if (!Number.isInteger(intentos) || intentos < 1 || intentos > 5) {
    return { ok: false, error: "LLM_MAX_ATTEMPTS debe ser un entero entre 1 y 5." };
  }
  const modelo = valor("GEMINI_MODEL") || (proveedor === "vertex" ? "gemini-3.5-flash-lite" : "gemini-flash-lite-latest");
  if (!/^[a-zA-Z0-9._-]+$/.test(modelo)) {
    return { ok: false, error: "GEMINI_MODEL debe ser un identificador de modelo, sin URL ni ruta." };
  }
  const ubicacion = valor("GOOGLE_CLOUD_LOCATION") || "global";
  if (!/^[a-z0-9-]+$/.test(ubicacion)) {
    return { ok: false, error: "GOOGLE_CLOUD_LOCATION debe ser una región válida o global." };
  }
  if (proveedor === "vertex") {
    const autenticacion = valor("VERTEX_AUTH_MODE") || "adc";
    if (autenticacion !== "adc" && autenticacion !== "api-key") {
      return { ok: false, error: "VERTEX_AUTH_MODE debe ser adc o api-key (Vertex Express)." };
    }
    if (modelo === "gemini-flash-lite-latest" || modelo === "gemini-flash-latest") {
      return { ok: false, error: "Ese alias de Gemini no es válido para Vertex AI. Configura GEMINI_MODEL con un modelo publicado en tu región, por ejemplo gemini-3.5-flash-lite." };
    }
    if (autenticacion === "api-key") {
      const apiKey = valor("VERTEX_API_KEY") || valor("GOOGLE_API_KEY");
      if (!apiKey) return { ok: false, error: "Vertex Express requiere VERTEX_API_KEY o GOOGLE_API_KEY. Una llave JSON se usa con VERTEX_AUTH_MODE=adc." };
      if (!valor("GEMINI_MODEL")) return { ok: false, error: "Vertex Express requiere GEMINI_MODEL explícito con un modelo habilitado en tu cuenta. Su catálogo puede diferir de Vertex con ADC." };
      if (ubicacion !== "global") return { ok: false, error: "Vertex Express con API key usa GOOGLE_CLOUD_LOCATION=global. Para una región y proyecto específicos, usa ADC." };
      return { ok: true, data: { proveedor, autenticacion, apiKey, modelo, ubicacion, timeoutMs, intentos } };
    }
    const proyecto = valor("GOOGLE_CLOUD_PROJECT") || valor("GCLOUD_PROJECT");
    if (!proyecto || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(proyecto)) {
      return { ok: false, error: "Vertex AI requiere GOOGLE_CLOUD_PROJECT con el ID del proyecto autorizado." };
    }
    return { ok: true, data: { proveedor, autenticacion, modelo, proyecto, ubicacion, timeoutMs, intentos } };
  }
  const apiKey = valor("GEMINI_API_KEY") || valor("GOOGLE_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "Gemini requiere GEMINI_API_KEY. Para usar credenciales GCP, configura LLM_PROVIDER=vertex y GOOGLE_CLOUD_PROJECT." };
  }
  return { ok: true, data: { proveedor, autenticacion: "api-key", modelo, apiKey, ubicacion, timeoutMs, intentos } };
}
