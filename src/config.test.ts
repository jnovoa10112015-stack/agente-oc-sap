import { describe, expect, test } from "bun:test";
import { leerConfiguracionLLM } from "./config";

describe("configuración de proveedor", () => {
  test("Vertex Express exige selección explícita y no requiere ADC", () => {
    const r = leerConfiguracionLLM({ LLM_PROVIDER: "vertex", VERTEX_AUTH_MODE: "api-key", VERTEX_API_KEY: "clave-ficticia", GEMINI_MODEL: "modelo-de-prueba" });
    expect(r.ok && r.data.autenticacion).toBe("api-key");
    expect(r.ok && r.data.proyecto).toBeUndefined();
  });
  test.each([
    { LLM_PROVIDER: "vertex", VERTEX_AUTH_MODE: "api-key" },
    { LLM_PROVIDER: "vertex", VERTEX_AUTH_MODE: "api-key", VERTEX_API_KEY: "clave" },
    { LLM_PROVIDER: "vertex", VERTEX_AUTH_MODE: "invalido" },
    { LLM_PROVIDER: "vertex", VERTEX_AUTH_MODE: "api-key", VERTEX_API_KEY: "clave", GOOGLE_CLOUD_LOCATION: "us-central1" },
  ])("rechaza autenticación Vertex ambigua o incompleta: %j", (env) => {
    expect(leerConfiguracionLLM(env).ok).toBe(false);
  });
  test("Gemini sigue aceptando GEMINI_API_KEY sin seleccionar proveedor", () => {
    const c = leerConfiguracionLLM({ GEMINI_API_KEY: "clave-de-prueba" });
    expect(c.ok && c.data.proveedor).toBe("gemini");
  });
  test("Vertex usa proyecto y ADC sin requerir API key", () => {
    const c = leerConfiguracionLLM({ LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proyecto-de-prueba" });
    expect(c.ok && c.data).toMatchObject({ proveedor: "vertex", proyecto: "proyecto-de-prueba", ubicacion: "global", modelo: "gemini-3.5-flash-lite" });
    expect(c.ok && c.data.apiKey).toBeUndefined();
  });
  test("admite la selección estándar de Google y una región explícita", () => {
    const c = leerConfiguracionLLM({ GOOGLE_GENAI_USE_VERTEXAI: "true", GCLOUD_PROJECT: "proyecto-de-prueba", GOOGLE_CLOUD_LOCATION: "us-central1" });
    expect(c.ok && c.data.proveedor).toBe("vertex");
    expect(c.ok && c.data.ubicacion).toBe("us-central1");
  });
  test.each([
    {},
    { LLM_PROVIDER: "vertex" },
    { LLM_PROVIDER: "otro" },
    { LLM_PROVIDER: "gemini", GOOGLE_GENAI_USE_VERTEXAI: "true" },
    { GOOGLE_GENAI_USE_VERTEXAI: "quizás" },
    { LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proyecto-de-prueba", GEMINI_MODEL: "gemini-flash-lite-latest" },
    { GEMINI_API_KEY: "secreto", LLM_TIMEOUT_MS: "NaN" },
    { GEMINI_API_KEY: "secreto", LLM_MAX_ATTEMPTS: "20" },
    { GEMINI_API_KEY: "secreto", GEMINI_MODEL: "https://servidor/modelo" },
    { GEMINI_API_KEY: "secreto", GOOGLE_CLOUD_LOCATION: "../global" },
  ])("rechaza configuración inválida sin filtrar secretos: %j", (env) => {
    const c = leerConfiguracionLLM(env);
    expect(c.ok).toBe(false);
    expect(JSON.stringify(c)).not.toContain("secreto");
  });
});
