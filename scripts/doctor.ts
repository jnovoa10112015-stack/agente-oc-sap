/** Diagnóstico local: no solicita tokens ADC ni llama a Google. */
import { access } from "node:fs/promises";
import path from "node:path";
import { leerConfiguracionLLM } from "../src/config";

const config = leerConfiguracionLLM();
if (!config.ok) {
  console.error(config.error);
  process.exit(1);
}
const c = config.data;
const raiz = path.resolve(import.meta.dir, "..");
try {
  for (const ruta of ["web/index.html", "src/agente/prompt.md", "fixtures/reto-03/maestros/proveedores.json"]) {
    await access(path.join(raiz, ruta));
  }
  if (c.proveedor === "vertex" && c.autenticacion === "adc" && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    await access(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  console.log(JSON.stringify({
    ok: true, provider: c.proveedor, model: c.modelo,
    ...(c.proveedor === "vertex" ? { project: c.proyecto, location: c.ubicacion } : {}),
    authentication: c.autenticacion === "adc" ? "ADC" : "API key configurada",
    networkChecked: false,
  }, null, 2));
  console.log("Configuración y archivos locales correctos. Este diagnóstico no verifica permisos, cuota ni conectividad con Google.");
} catch {
  console.error("Falta un archivo del proyecto o no se puede leer la ruta GOOGLE_APPLICATION_CREDENTIALS. No se mostraron credenciales.");
  process.exitCode = 1;
}
