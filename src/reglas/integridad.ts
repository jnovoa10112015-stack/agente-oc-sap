/** Calidad de datos y consistencia entre fuentes, antes de RC1–RC10. */
import { PaqueteSchema, type Paquete, type ResultadoHerramienta } from "../tipos";
import type { Maestros } from "../maestros";
import { normalizarNombre, normalizarNit as nit } from "./identidad";

export function validarIntegridad(entrada: unknown, maestros: Maestros): ResultadoHerramienta<Paquete> {
  const parseado = PaqueteSchema.safeParse(entrada);
  if (!parseado.success) return { ok: false, codigo: "DATOS_INVALIDOS", error: `Paquete inválido: ${parseado.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const p = parseado.data;
  const errores: string[] = [];
  const s = p.solicitud;
  if (s.indicador_iva && !maestros.indicadoresIva.some((i) => i.codigo === s.indicador_iva)) errores.push("El indicador de IVA no existe en el maestro.");
  if (s.condiciones_pago && !maestros.condicionesPago.some((c) => c.codigo === s.condiciones_pago)) errores.push("Las condiciones de pago no existen en el maestro.");
  if (p.cotizacion) {
    if (s.moneda !== p.cotizacion.moneda) errores.push("La cotización y la solicitud usan monedas distintas; no se comparan importes sin conversión autorizada.");
    const encontrados = maestros.proveedores.filter((proveedor) => s.proveedor_nit
      ? nit(proveedor.nit) === nit(s.proveedor_nit)
      : normalizarNombre(proveedor.nombre) === normalizarNombre(s.proveedor_nombre));
    const nitSolicitud = s.proveedor_nit ?? (encontrados.length === 1 ? encontrados[0]!.nit : null);
    if (p.cotizacion.nit && nitSolicitud && nit(p.cotizacion.nit) !== nit(nitSolicitud)) errores.push("El NIT de la cotización no corresponde al proveedor de la solicitud.");
    if (!p.cotizacion.nit && normalizarNombre(p.cotizacion.proveedor) !== normalizarNombre(s.proveedor_nombre)) errores.push("No se puede identificar la cotización con el proveedor de la solicitud.");
  }
  if (errores.length) return { ok: false, codigo: "DATOS_INVALIDOS", error: errores.join(" ") };
  return { ok: true, data: p };
}
