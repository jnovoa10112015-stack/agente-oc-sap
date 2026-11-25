import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { cargarMaestros } from "./maestros";

async function conMaestros(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-maestros-"));
  try {
    await cp(path.join(process.cwd(), "fixtures"), path.join(dir, "fixtures"), { recursive: true });
    await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
describe("maestros e integridad de catálogos", () => {
  test.each(["inexistente", "JSON roto", "IVA por defecto inválido", "NIT duplicado"])("rechaza %s sin lanzar excepción", async (caso) => {
    await conMaestros(async (dir) => {
      const ruta = path.join(dir, "fixtures", "reto-03", "maestros", "proveedores.json");
      if (caso === "inexistente") await rm(ruta);
      if (caso === "JSON roto") await Bun.write(ruta, "{");
      if (caso === "IVA por defecto inválido" || caso === "NIT duplicado") {
        const datos = await Bun.file(ruta).json();
        if (caso === "IVA por defecto inválido") datos[0].indicador_iva_default = "DESCONOCIDO";
        else datos.push({ ...datos[0], codigo_sap: "DUPLICADO" });
        await Bun.write(ruta, JSON.stringify(datos));
      }
      const r = await cargarMaestros(dir);
      expect(r.ok).toBe(false);
      if (caso.includes("defecto") || caso.includes("duplicado")) expect(!r.ok && r.codigo).toBe("MAESTROS_INVALIDOS");
    });
  });
});
