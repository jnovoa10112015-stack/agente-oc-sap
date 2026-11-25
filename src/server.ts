/** HTTP/SSE y archivos web. Importar este módulo no abre un puerto. */
import path from "node:path";
import { crearAdaptadorLLM, type AdaptadorLLM } from "./agente/llm";
import { procesarMensaje, obtenerHistorialSesion, type EventoCiclo } from "./agente/ciclo";
import { leerConfiguracionLLM, type ResultadoConfiguracion } from "./config";

export const DIRECTORIO_PROYECTO = path.resolve(import.meta.dir, "..");
const MAX_CUERPO_BYTES = 32_768;
const ARCHIVOS_WEB: Record<string, string> = {
  "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css",
};
const CABECERAS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

type OpcionesAplicacion = {
  directorio?: string;
  llm?: AdaptadorLLM;
  configuracion?: ResultadoConfiguracion;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { ...CABECERAS, "Cache-Control": "no-store" } });
}

export function crearAplicacion(opciones: OpcionesAplicacion = {}): (req: Request) => Promise<Response> {
  const directorio = opciones.directorio ?? DIRECTORIO_PROYECTO;
  const configuracion = opciones.configuracion ?? leerConfiguracionLLM();
  const llm = opciones.llm ?? crearAdaptadorLLM({ configuracion });
  const sesionesActivas = new Set<string>();

  async function chat(req: Request): Promise<Response> {
    if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return json({ ok: false, error: "Usa Content-Type: application/json." }, 415);
    }
    if (Number(req.headers.get("content-length")) > MAX_CUERPO_BYTES) {
      return json({ ok: false, error: "La petición supera el tamaño permitido." }, 413);
    }
    let cuerpo: unknown;
    try {
      const texto = await req.text();
      if (new TextEncoder().encode(texto).byteLength > MAX_CUERPO_BYTES) {
        return json({ ok: false, error: "La petición supera el tamaño permitido." }, 413);
      }
      cuerpo = JSON.parse(texto);
    } catch {
      return json({ ok: false, error: "El cuerpo de la petición no es JSON válido." }, 400);
    }
    if (!cuerpo || typeof cuerpo !== "object") return json({ ok: false, error: "Se esperaba un objeto JSON." }, 400);
    const { sessionId, message } = cuerpo as Record<string, unknown>;
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) ||
      typeof message !== "string" || !message.trim() || message.length > 8000) {
      return json({ ok: false, error: "sessionId debe tener 1–128 letras, números, guiones o guiones bajos; message debe tener 1–8000 caracteres." }, 400);
    }
    if (!configuracion.ok && !opciones.llm) return json({ ok: false, error: configuracion.error }, 503);
    if (sesionesActivas.has(sessionId)) return json({ ok: false, error: "Esta sesión ya está procesando un mensaje. Espera a que termine." }, 409);
    if (sesionesActivas.size >= 16) return json({ ok: false, error: "El servicio está ocupado. Intenta nuevamente en unos segundos." }, 503);
    sesionesActivas.add(sessionId);
    let conectado = true;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let terminado = false;
        function escribir(texto: string) {
          if (!conectado) return;
          try { controller.enqueue(encoder.encode(texto)); } catch { conectado = false; }
        }
        const emitir = (evento: EventoCiclo) => {
          if (evento.evento === "done") terminado = true;
          escribir(`event: ${evento.evento}\ndata: ${JSON.stringify(evento.data)}\n\n`);
        };
        const latido = setInterval(() => escribir(": keep-alive\n\n"), 10_000);
        try {
          await procesarMensaje(llm, directorio, sessionId, message.trim(), emitir);
        } catch {
          emitir({ evento: "error", data: { message: "No se pudo completar el turno. Revisa el historial antes de reintentar.", recoverable: true } });
        } finally {
          clearInterval(latido);
          if (!terminado) emitir({ evento: "done", data: { needsConfirmation: false } });
          sesionesActivas.delete(sessionId);
          try { controller.close(); } catch { /* Cliente desconectado. */ }
        }
      },
      cancel() { conectado = false; },
    });
    return new Response(stream, { headers: {
      ...CABECERAS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    } });
  }

  return async (req) => {
    try {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/live") return json({ ok: true });
      if (req.method === "GET" && url.pathname === "/api/health") {
        if (!configuracion.ok) return json({ ok: false, error: configuracion.error }, 503);
        const c = configuracion.data;
        // Configuración válida no implica conectividad ni permisos verificados.
        return json({ ok: true, configured: true, provider: c.proveedor, model: c.modelo });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req);
      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        let sessionId: string;
        try { sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length)); }
        catch { return json({ ok: false, error: "Identificador de sesión inválido." }, 400); }
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return json({ ok: false, error: "Identificador de sesión inválido." }, 400);
        const mensajes = obtenerHistorialSesion(sessionId);
        return mensajes ? json({ ok: true, sessionId, mensajes }) : json({ ok: false, error: "Sesión no encontrada." }, 404);
      }
      if (req.method === "GET") {
        const nombre = ARCHIVOS_WEB[url.pathname];
        if (!nombre) return json({ ok: false, error: "No encontrado." }, 404);
        const archivo = Bun.file(path.join(directorio, "web", nombre));
        if (!await archivo.exists()) return json({ ok: false, error: "No encontrado." }, 404);
        return new Response(archivo, { headers: CABECERAS });
      }
      return json({ ok: false, error: "Método no soportado." }, 405);
    } catch {
      return json({ ok: false, error: "No se pudo procesar la petición." }, 500);
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT debe ser un entero entre 1 y 65535.");
  const configuracion = leerConfiguracionLLM();
  if (!configuracion.ok) console.error(`[config] ${configuracion.error}`);
  const servidor = Bun.serve({ hostname: "0.0.0.0", port, idleTimeout: 255, maxRequestBodySize: MAX_CUERPO_BYTES,
    fetch: crearAplicacion({ configuracion }),
  });
  console.log(`Servidor escuchando en http://localhost:${servidor.port}`);
  const cerrar = async () => { await servidor.stop(false); process.exit(0); };
  process.once("SIGTERM", cerrar);
  process.once("SIGINT", cerrar);
}
