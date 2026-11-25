/**
 * Implementación simulada de SapAdapter sobre archivos en out/sap/.
 *
 * Todas las rutas se resuelven desde `directory` (raíz del proyecto), nunca
 * absolutas. Una falla leyendo las órdenes o un registro corrupto impide
 * nuevas creaciones. La herramienta convierte ese fallo en un resultado de
 * error; nunca se interpreta almacenamiento dañado como una lista vacía.
 *
 * Concurrencia: `crearOrden` y `buscarOrdenPorReferencia` comparten una sola
 * cola de promesas (`conMutex`) para que dos llamadas simultáneas nunca lean
 * y escriban `ordenes.jsonl` entrelazadas. Además, `crearOrden` es
 * idempotente por sí misma (no solo por el chequeo previo que hace
 * `src/tools/oc.ts`): si dos pedidos concurrentes para el mismo
 * `solicitud_id` llegan igual a `crearOrden`, la segunda encuentra la
 * primera dentro de la misma sección crítica y devuelve esa, nunca crea un
 * número duplicado.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProveedorSchema, OrdenCompraSchema, type OrdenCompra, type SapAdapter } from "../tipos";
import { normalizarNit } from "../reglas/identidad";

type RegistroOrdenAlmacenado = {
  numero_oc: string;
  fecha: string;
  solicitud_id: string;
  orden: OrdenCompra;
};

const PRIMER_NUMERO_OC = 4500000001;

function esArchivoInexistente(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Parsea una línea de `ordenes.jsonl` de forma segura: una línea corrupta
 * (JSON inválido o `numero_oc` inválido) devuelve null. La lectura completa
 * rechaza esa situación para evitar duplicados o reiniciar el consecutivo.
 */
function parsearLineaOrdenSegura(linea: string): RegistroOrdenAlmacenado | null {
  try {
    const registro = JSON.parse(linea) as RegistroOrdenAlmacenado;
    if (
      typeof registro?.numero_oc !== "string" ||
      typeof registro?.solicitud_id !== "string" ||
      !/^\d+$/.test(registro.numero_oc) ||
      !Number.isSafeInteger(Number(registro.numero_oc)) ||
      Number(registro.numero_oc) < PRIMER_NUMERO_OC ||
      !Number.isFinite(Date.parse(registro.fecha)) ||
      !OrdenCompraSchema.safeParse(registro.orden).success ||
      registro.orden?.referencia?.solicitud_id !== registro.solicitud_id
    ) {
      return null;
    }
    return registro;
  } catch {
    return null;
  }
}

/**
 * Crea un SapAdapter simulado cuyo estado vive en `${directory}/out/sap/`.
 */
export function crearSapMock(directory: string): SapAdapter {
  const rutaProveedores = path.join(
    directory,
    "fixtures",
    "reto-03",
    "maestros",
    "proveedores.json"
  );
  const dirSap = path.join(directory, "out", "sap");
  const rutaOrdenes = path.join(dirSap, "ordenes.jsonl");

  // Mutex a nivel de módulo: serializa toda lectura+escritura de
  // ordenes.jsonl entre llamadas concurrentes a crearOrden/buscarOrdenPorReferencia
  // de esta misma instancia (una por `directory`, cacheada en oc.ts).
  let cola: Promise<unknown> = Promise.resolve();
  function conMutex<T>(tarea: () => Promise<T>): Promise<T> {
    const resultado = cola.then(tarea, tarea);
    // Si `tarea` rechaza, la cola tiene que seguir viva para la próxima
    // llamada — de lo contrario un solo fallo dejaría la cola envenenada.
    cola = resultado.then(
      () => undefined,
      () => undefined
    );
    return resultado;
  }

  // Devuelve los registros válidos de ordenes.jsonl, o [] si el archivo
  // todavía no existe (primer uso: no es un error, es "sin órdenes aún").
  // Una falla real bloquea la creación; solo ENOENT significa primer uso.
  async function leerRegistrosOrdenes(): Promise<RegistroOrdenAlmacenado[]> {
    let contenido: string;
    try {
      contenido = await readFile(rutaOrdenes, "utf-8");
    } catch (err) {
      if (esArchivoInexistente(err)) return [];
      throw new Error("No se puede leer el registro de órdenes existente.");
    }
    if (!contenido.trim()) throw new Error("El registro de órdenes existente está vacío. Se requiere recuperación antes de reiniciar el consecutivo.");
    const registros = contenido
      .split("\n")
      .filter((linea) => linea.trim().length > 0)
      .map(parsearLineaOrdenSegura);
    if (registros.some((registro) => registro === null)) {
      throw new Error("El registro de órdenes está dañado. Se requiere recuperación antes de crear otra orden.");
    }
    if (new Set(registros.map((r) => r!.numero_oc)).size !== registros.length ||
      new Set(registros.map((r) => r!.solicitud_id)).size !== registros.length) {
      throw new Error("El registro de órdenes contiene duplicados. Se requiere recuperación.");
    }
    return registros as RegistroOrdenAlmacenado[];
  }

  return {
    async consultarProveedor(nit) {
      try {
        const contenido = await readFile(rutaProveedores, "utf-8");
        const proveedores = z.array(ProveedorSchema).parse(JSON.parse(contenido));
        const buscado = normalizarNit(nit);
        const encontrado = proveedores.find((p) => normalizarNit(p.nit) === buscado);
        if (!encontrado) return null;
        return { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo };
      } catch {
        // La interfaz SapAdapter no tiene una variante de error para este
        // método (solo `{codigo_sap, activo} | null`): una falla de lectura
        // o de esquema del maestro se trata como "no encontrado" — falla
        // cerrado (dispara RC1 en vez de afirmar un proveedor inexistente),
        // y nunca lanza hacia quien la llama.
        return null;
      }
    },

    async crearOrden(orden) {
      return conMutex(async () => {
        await mkdir(dirSap, { recursive: true });
        const registros = await leerRegistrosOrdenes();

        // Idempotencia real, dentro de la misma sección crítica: si dos
        // llamadas concurrentes llegan para el mismo solicitud_id, la
        // segunda encuentra acá el registro que acaba de escribir la
        // primera y devuelve ese — nunca asigna un número nuevo. Esto es
        // además de (no en lugar de) el chequeo previo que ya hace
        // `oc_crear` en src/tools/oc.ts vía `buscarOrdenPorReferencia`.
        const existente = registros.find((r) => r.solicitud_id === orden.referencia.solicitud_id);
        if (existente) {
          return { numero_oc: existente.numero_oc, fecha: existente.fecha };
        }

        let siguiente = PRIMER_NUMERO_OC;
        if (registros.length > 0) {
          siguiente = Math.max(...registros.map((r) => Number(r.numero_oc))) + 1;
        }

        const numero_oc = String(siguiente);
        const fecha = new Date().toISOString();
        const registro: RegistroOrdenAlmacenado = {
          numero_oc,
          fecha,
          solicitud_id: orden.referencia.solicitud_id,
          orden,
        };
        await appendFile(rutaOrdenes, `${JSON.stringify(registro)}\n`, "utf-8");

        return { numero_oc, fecha };
      });
    },

    async buscarOrdenPorReferencia(solicitud_id) {
      return conMutex(async () => {
        const registros = await leerRegistrosOrdenes();
        const encontrado = registros.find((r) => r.solicitud_id === solicitud_id);
        return encontrado ? { numero_oc: encontrado.numero_oc } : null;
      });
    },
  };
}
