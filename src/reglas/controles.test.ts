import { beforeAll, describe, expect, test } from "bun:test";
import { cargarMaestros, type Maestros } from "../maestros";
import { leer_paquete, validar as herramientaValidar } from "../tools/oc";
import { PaqueteSchema, type Paquete } from "../tipos";
import { validar } from "./controles";

let paquete: Paquete;
let maestros: Maestros;
const ctx = { directory: process.cwd(), sessionId: "controles-locales" };
beforeAll(async () => {
  const p = JSON.parse(await leer_paquete.execute({ caso: "sol-001" }, ctx));
  const m = await cargarMaestros(ctx.directory);
  if (!p.ok || !m.ok) throw new Error("Fixtures no válidos");
  paquete = p.data;
  maestros = m.data;
});
function caso(cambiar: (p: Paquete) => void) { const p = structuredClone(paquete); cambiar(p); return validar(p, maestros); }

describe("RC1–RC10 y sus límites", () => {
  test("RC1 acepta el NIT con puntos y sufijo de verificación explícito", () => {
    expect(caso((p) => { p.solicitud.proveedor_nit = "900.555.111-2"; }).derivados.proveedor_codigo_sap).toBe("100234");
  });
  test("RC1 bloquea un proveedor inactivo", () => {
    const m = structuredClone(maestros);
    m.proveedores.find((p) => p.nit === paquete.solicitud.proveedor_nit)!.activo = false;
    expect(validar(paquete, m).bloqueos.some((h) => h.codigo === "RC1")).toBe(true);
  });
  test.each(["Tecnosuministros SAS", "TECNoSUMINISTROS S.A.S.", "Tecnosuministros S A S"])("RC1 reconoce %s sin NIT", (nombre) => {
    const r = caso((p) => { p.solicitud.proveedor_nit = null; p.solicitud.proveedor_nombre = nombre; });
    expect(r.derivados.proveedor_codigo_sap).toBe("100234");
  });
  test("RC1 no elige arbitrariamente entre nombres normalizados duplicados", () => {
    const m = structuredClone(maestros);
    const proveedor = m.proveedores.find((p) => p.nit === paquete.solicitud.proveedor_nit)!;
    m.proveedores.push({ ...proveedor, codigo_sap: "OTRO", nit: "999999999" });
    const p = structuredClone(paquete); p.solicitud.proveedor_nit = null;
    const r = validar(p, m);
    expect(r.apta).toBe(false);
    expect(r.bloqueos.some((h) => h.codigo === "RC1")).toBe(true);
  });
  test("RC2 bloquea aprobación ausente", () => {
    expect(caso((p) => { p.aprobacion = null; }).bloqueos.some((h) => h.codigo === "RC2")).toBe(true);
  });
  test("RC2 reconoce el correo del aprobador sin depender de mayúsculas", () => {
    expect(caso((p) => { p.aprobacion!.de = p.aprobacion!.de.toUpperCase(); }).bloqueos.some((h) => h.codigo === "RC2")).toBe(false);
  });
  test("RC3 permite el tope exacto y bloquea una unidad por encima", () => {
    const tope = maestros.centrosCosto.find((c) => c.centro_costo === paquete.solicitud.centro_costo)!.aprobadores.find((a) => a.email === paquete.aprobacion!.de)!.tope;
    expect(caso((p) => { p.solicitud.valor_total = tope; }).bloqueos.some((h) => h.codigo === "RC3")).toBe(false);
    expect(caso((p) => { p.solicitud.valor_total = tope + 1; }).bloqueos.some((h) => h.codigo === "RC3")).toBe(true);
  });
  test("RC4 bloquea un centro o subárea inexistente", () => {
    for (const campo of ["centro_costo", "subarea"] as const) {
      expect(caso((p) => { p.solicitud[campo] = "INEXISTENTE"; }).bloqueos.some((h) => h.codigo === "RC4")).toBe(true);
    }
  });
  test("RC5 permite diferencia exacta del 2% y pide confirmación si la supera", () => {
    expect(caso((p) => { p.cotizacion!.total = p.solicitud.valor_total * 1.02; }).confirmaciones.some((h) => h.codigo === "RC5")).toBe(false);
    expect(caso((p) => { p.cotizacion!.total = p.solicitud.valor_total * 1.02 + 1; }).confirmaciones.some((h) => h.codigo === "RC5")).toBe(true);
  });
  test("RC5 pide confirmación cuando no hay cotización", () => {
    expect(caso((p) => { p.cotizacion = null; }).confirmaciones.some((h) => h.codigo === "RC5")).toBe(true);
  });
  test("RC6 deriva IVA con confirmación y RC7 deriva pago sin confirmación", () => {
    const r = caso((p) => { p.solicitud.indicador_iva = null; p.solicitud.condiciones_pago = null; });
    expect(r.derivados).toMatchObject({ indicador_iva: "C1", condiciones_pago: "Z030" });
    expect(r.confirmaciones.map((h) => h.codigo)).toContain("RC6");
    expect(r.confirmaciones.map((h) => h.codigo)).not.toContain("RC7");
  });
  test("RC8 marca factura anterior, pero no una del mismo día", () => {
    expect(caso((p) => { p.factura = { numero: "FV1", fecha: "2026-08-19", total: 100 }; }).retroactiva).toBe(true);
    expect(caso((p) => { p.factura = { numero: "FV1", fecha: "2026-08-20", total: 100 }; }).retroactiva).toBe(false);
  });
  test("RC9 detecta fecha de aprobación anterior", () => {
    expect(caso((p) => { p.aprobacion!.fecha = "2026-08-19T23:59:00-05:00"; }).confirmaciones.some((h) => h.codigo === "RC9")).toBe(true);
  });
  test("RC10 tolera una unidad monetaria y bloquea dos", () => {
    expect(caso((p) => { p.solicitud.valor_total += 1; }).bloqueos.some((h) => h.codigo === "RC10")).toBe(false);
    expect(caso((p) => { p.solicitud.valor_total += 2; }).bloqueos.some((h) => h.codigo === "RC10")).toBe(true);
  });
});

describe("calidad de los datos antes de aplicar reglas", () => {
  test.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY])("rechaza cantidad inválida %s", (valor) => {
    const p = structuredClone(paquete); p.solicitud.cantidad = valor;
    expect(PaqueteSchema.safeParse(p).success).toBe(false);
  });
  test.each(["2026-02-30", "2026-13-01", "ayer", "2025-02-29"])("rechaza fecha de solicitud inválida %s", (fecha) => {
    const p = structuredClone(paquete); p.solicitud.fecha_solicitud = fecha;
    expect(PaqueteSchema.safeParse(p).success).toBe(false);
  });
  test.each(["IVA desconocido", "pago desconocido", "moneda distinta", "proveedor de cotización distinto"])("rechaza %s", async (nombre) => {
    const p = structuredClone(paquete);
    if (nombre === "IVA desconocido") p.solicitud.indicador_iva = "INVALIDO";
    if (nombre === "pago desconocido") p.solicitud.condiciones_pago = "INVALIDO";
    if (nombre === "moneda distinta") p.cotizacion!.moneda = "USD";
    if (nombre === "proveedor de cotización distinto") p.cotizacion!.nit = "999999999";
    const r = JSON.parse(await herramientaValidar.execute({ caso: "sol-001", paquete: p }, ctx));
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe("DATOS_INVALIDOS");
  });
});
