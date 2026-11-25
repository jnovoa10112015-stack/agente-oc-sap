/**
 * Cubre tres hallazgos de auditoría externa sobre src/tools/oc.ts:
 * - RC2: `cuerpo.includes("Aprobado")` da un falso positivo con "No Aprobado,
 *   revisar presupuesto" (la subcadena "Aprobado" está igual presente).
 *   `estaAprobado` tiene que exigir la palabra completa y descartar la
 *   oración cuando aparece negada.
 * - Identificador de caso: viaja directo a rutas de archivo sin validar
 *   formato, lo que permitía un intento de path traversal (ej. "../../..").
 * - `oc_crear` confiaba en la `validacion` que recibía como argumento: un
 *   payload de un caso combinado con la validación (o solo el payload) de
 *   otro caso creaba una OC saltándose bloqueos/confirmaciones reales.
 */

import { describe, test, expect } from "bun:test";
import { rm, mkdtemp, cp, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { estaAprobado, parseMontoDocumento, leer_paquete, generar_evidencia, construir_payload, validar, crear } from "./oc";
import type { Paquete, Validacion, OrdenCompra } from "../tipos";

const ctx = { directory: process.cwd(), sessionId: "test-oc" };

function parsear<T>(resultadoStr: string): { ok: true; data: T } | { ok: false; error: string } {
  return JSON.parse(resultadoStr) as { ok: true; data: T } | { ok: false; error: string };
}

describe("estaAprobado (RC2 — detección de aprobación en el correo)", () => {
  test.each([
    "Aprobado. No proceder con la compra.",
    "Cuando esté aprobado, procederemos.",
    "Aprobado si recibimos presupuesto.",
    "No ha sido aprobado.",
    "Pendiente.\n> Aprobado por el líder en el correo anterior.",
    "Estado: aprobado: false",
    "Aprobado?",
    "No autorizado. Aprobado.",
    "Aprobado, sin autorización presupuestaria.",
  ])("rechaza aprobación condicional, citada o contradictoria: %s", (texto) => {
    expect(estaAprobado(texto)).toBe(false);
  });
  test("rechaza 'No Aprobado, revisar presupuesto' (el bug reportado: antes daba true por subcadena)", () => {
    expect(estaAprobado("No Aprobado, revisar presupuesto.")).toBe(false);
  });

  test("rechaza variantes de negación: 'sin aprobar', 'rechazado'", () => {
    expect(estaAprobado("Sin aprobar todavía, falta el visto bueno de finanzas.")).toBe(false);
    expect(estaAprobado("Rechazado. No procede la compra en estos términos.")).toBe(false);
  });

  test("acepta los cuerpos reales de los fixtures (sol-001/002/003)", () => {
    expect(estaAprobado("Aprobado, proceder con la orden de compra.\n\nMariana López\nGerente de Tecnología")).toBe(true);
    expect(estaAprobado("Aprobado.\n\nMariana López")).toBe(true);
    expect(
      estaAprobado(
        "Aprobado desde comercial, es para el equipo de preventa que se muda a la nueva sede.\n\nFelipe Vargas"
      )
    ).toBe(true);
  });

  test("acepta una negación que no toca la aprobación misma ('aprobado, sin objeciones')", () => {
    expect(estaAprobado("Aprobado, sin objeciones de mi parte.")).toBe(true);
  });

  test("es insensible a mayúsculas y a tildes", () => {
    expect(estaAprobado("APROBADA la compra.")).toBe(true);
    expect(estaAprobado("NO APROBADA, falta justificación.")).toBe(false);
  });
});

describe("importes de documentos", () => {
  test.each([
    ["11.400.000", 11400000], ["1234,56", 1234.56], ["1.234,56", 1234.56],
    ["1,234.56", 1234.56], ["1234.56", 1234.56], ["1,234,567", 1234567],
  ] as const)("interpreta %s sin perder decimales", (texto, esperado) => {
    expect(parseMontoDocumento(texto)).toBe(esperado);
  });
  test.each(["12.34.567", "-100", "0", "NaN", "100USD", "1,23,456", ""]) ("rechaza un importe ambiguo o inválido: %s", (texto) => {
    expect(parseMontoDocumento(texto)).toBeNull();
  });
});

describe("integridad de la orden y auditoría", () => {
  async function conCaso(fn: (contexto: typeof ctx, payload: OrdenCompra) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-integridad-"));
    const contexto = { directory: dir, sessionId: crypto.randomUUID() };
    try {
      await cp(path.join(ctx.directory, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
      const p = parsear<Paquete>(await leer_paquete.execute({ caso: "sol-001" }, contexto));
      if (!p.ok) throw new Error(p.error);
      const v = parsear<Validacion>(await validar.execute({ caso: "sol-001", paquete: p.data }, contexto));
      if (!v.ok) throw new Error(v.error);
      const e = parsear<{ sha256: string }>(await generar_evidencia.execute({ caso: "sol-001" }, contexto));
      if (!e.ok) throw new Error(e.error);
      const b = parsear<{ payload: OrdenCompra }>(await construir_payload.execute({
        caso: "sol-001", paquete: p.data, validacion: v.data, derivados: v.data.derivados, evidencia_sha256: e.data.sha256,
      }, contexto));
      if (!b.ok) throw new Error(b.error);
      await fn(contexto, b.data.payload);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  test("la lectura real conserva decimales y rechaza importes parcialmente numéricos", async () => {
    await conCaso(async (contexto) => {
      const ruta = path.join(contexto.directory, "fixtures", "reto-03", "solicitudes", "sol-001", "cotizacion.txt");
      const original = await Bun.file(ruta).text();
      for (const importe of ["1.234,56", "1,234.56", "1234.56"]) {
        await Bun.write(ruta, original.replace(/^TOTAL.*$/m, `TOTAL: COP ${importe}`));
        const r = JSON.parse(await leer_paquete.execute({ caso: "sol-001" }, contexto));
        expect(r.ok).toBe(true);
        expect(r.data.cotizacion.total).toBe(1234.56);
      }
      for (const importe of ["1e3", "100USD", "12.34.567", "0"]) {
        await Bun.write(ruta, original.replace(/^TOTAL.*$/m, `TOTAL: COP ${importe}`));
        expect(JSON.parse(await leer_paquete.execute({ caso: "sol-001" }, contexto)).ok).toBe(false);
      }
    });
  });

  test("rechaza cambios de monto, proveedor, centro de costo y hash para el mismo solicitud_id", async () => {
    await conCaso(async (contexto, payload) => {
      const variantes = [
        { ...payload, posiciones: [{ ...payload.posiciones[0]!, precio_unitario: 1 }] },
        { ...payload, proveedor: { ...payload.proveedor, codigo_sap: "alterado" } },
        { ...payload, posiciones: [{ ...payload.posiciones[0]!, centro_costo: "otro" }] },
        { ...payload, aprobador: { ...payload.aprobador, evidencia_sha256: "0".repeat(64) } },
      ];
      for (const variante of variantes) {
        const r = parsear(await crear.execute({ caso: "sol-001", payload: variante, confirmado: false }, contexto));
        expect(r.ok).toBe(false);
      }
      expect(await Bun.file(path.join(contexto.directory, "out", "sap", "ordenes.jsonl")).exists()).toBe(false);
    });
  });
  test("20 intentos concurrentes conservan 20 filas de auditoría y una sola orden", async () => {
    await conCaso(async (contexto, payload) => {
      const resultados = await Promise.all(Array.from({ length: 20 }, () => crear.execute({ caso: "sol-001", payload, confirmado: false }, contexto)));
      expect(resultados.every((r) => JSON.parse(r).ok)).toBe(true);
      const control = await readFile(path.join(contexto.directory, "out", "control.csv"), "utf-8");
      expect(control.trim().split("\n")).toHaveLength(21);
      expect(control.match(/solicitud_id,resultado/g)).toHaveLength(1);
      const ordenes = await readFile(path.join(contexto.directory, "out", "sap", "ordenes.jsonl"), "utf-8");
      expect(ordenes.trim().split("\n")).toHaveLength(1);
    });
  });
  test("un fallo de almacenamiento se devuelve como error de herramienta", async () => {
    await conCaso(async (contexto, payload) => {
      await Bun.write(path.join(contexto.directory, "out", "sap", "ordenes.jsonl"), "archivo corrupto");
      const r = parsear(await crear.execute({ caso: "sol-001", payload, confirmado: false }, contexto));
      expect(r.ok).toBe(false);
      expect(await Bun.file(path.join(contexto.directory, "out", "sap", "ordenes.jsonl")).text()).toBe("archivo corrupto");
    });
  });
  test("una OC creada con auditoría fallida se identifica y puede recuperarse sin duplicar", async () => {
    await conCaso(async (contexto, payload) => {
      const control = path.join(contexto.directory, "out", "control.csv");
      await mkdir(control);
      const r = JSON.parse(await crear.execute({ caso: "sol-001", payload, confirmado: false }, contexto));
      expect(r.ok).toBe(false);
      expect(r.codigo).toBe("AUDITORIA_INCOMPLETA");
      expect(r.error).toContain("4500000001");
      const ordenes = path.join(contexto.directory, "out", "sap", "ordenes.jsonl");
      expect((await readFile(ordenes, "utf-8")).trim().split("\n")).toHaveLength(1);
      await rm(control, { recursive: true });
      const recuperado = JSON.parse(await crear.execute({ caso: "sol-001", payload, confirmado: false }, contexto));
      expect(recuperado.ok).toBe(true);
      expect(recuperado.data.idempotente).toBe(true);
      expect((await readFile(ordenes, "utf-8")).trim().split("\n")).toHaveLength(1);
    });
  });
});

describe("validación de formato del identificador de caso (path traversal)", () => {
  test("oc_leer_paquete rechaza un caso con '../' antes de tocar cualquier ruta", async () => {
    const resultadoStr = await leer_paquete.execute({ caso: "../../../etc" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean; error?: string };
    expect(resultado.ok).toBe(false);
    expect(resultado.error).toContain("../../../etc");
  });

  test("oc_leer_paquete rechaza un caso con separador de ruta absoluta", async () => {
    const resultadoStr = await leer_paquete.execute({ caso: "sol-001/../../secrets" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean };
    expect(resultado.ok).toBe(false);
  });

  test("oc_generar_evidencia rechaza el mismo formato inválido antes de escribir en out/", async () => {
    const resultadoStr = await generar_evidencia.execute({ caso: "../fuera-de-out" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean };
    expect(resultado.ok).toBe(false);
  });

  test("un identificador de caso válido (real) no se ve afectado por la validación de formato", async () => {
    const resultadoStr = await leer_paquete.execute({ caso: "sol-001" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean };
    expect(resultado.ok).toBe(true);
  });
});

describe("oc_crear re-deriva la validación desde el caso (no confía en la del llamador)", () => {
  test("rechaza un payload cuya solicitud_id no corresponde al caso indicado", async () => {
    await rm(`${ctx.directory}/out/sap`, { recursive: true, force: true });

    const paqueteResp = parsear<Paquete>(await leer_paquete.execute({ caso: "sol-001" }, ctx));
    if (!paqueteResp.ok) throw new Error(`no se pudo leer sol-001: ${paqueteResp.error}`);
    const validacionResp = parsear<Validacion>(
      await validar.execute({ caso: "sol-001", paquete: paqueteResp.data }, ctx)
    );
    if (!validacionResp.ok) throw new Error(`no se pudo validar sol-001: ${validacionResp.error}`);
    const payloadResp = parsear<{ payload: OrdenCompra }>(
      await construir_payload.execute(
        {
          caso: "sol-001",
          paquete: paqueteResp.data,
          derivados: validacionResp.data.derivados,
          validacion: validacionResp.data,
          evidencia_sha256: undefined,
        },
        ctx
      )
    );
    if (!payloadResp.ok) throw new Error(`no se pudo construir el payload de sol-001: ${payloadResp.error}`);

    // El payload es legítimo para sol-001, pero se le adultera la
    // referencia para que apunte a una solicitud que no es la del caso
    // "sol-001" que se le va a pasar a oc_crear.
    const payloadAdulterado: OrdenCompra = {
      ...payloadResp.data.payload,
      referencia: { ...payloadResp.data.payload.referencia, solicitud_id: "SOL-9999-INEXISTENTE" },
    };

    const crearResp = parsear<{ numero_oc: string }>(
      await crear.execute({ caso: "sol-001", payload: payloadAdulterado, confirmado: true }, ctx)
    );
    expect(crearResp.ok).toBe(false);
    if (!crearResp.ok) {
      expect(crearResp.error).toContain("no coinciden");
    }
  });

  test("un payload legítimo para el caso correcto sigue creando la OC (la re-derivación no rompe el flujo normal)", async () => {
    await rm(`${ctx.directory}/out/sap`, { recursive: true, force: true });

    const paqueteResp = parsear<Paquete>(await leer_paquete.execute({ caso: "sol-001" }, ctx));
    if (!paqueteResp.ok) throw new Error(`no se pudo leer sol-001: ${paqueteResp.error}`);
    const validacionResp = parsear<Validacion>(
      await validar.execute({ caso: "sol-001", paquete: paqueteResp.data }, ctx)
    );
    if (!validacionResp.ok) throw new Error(`no se pudo validar sol-001: ${validacionResp.error}`);
    const evidencia = parsear<{ sha256: string }>(await generar_evidencia.execute({ caso: "sol-001" }, ctx));
    if (!evidencia.ok) throw new Error(evidencia.error);
    const payloadResp = parsear<{ payload: OrdenCompra }>(
      await construir_payload.execute(
        {
          caso: "sol-001",
          paquete: paqueteResp.data,
          derivados: validacionResp.data.derivados,
          validacion: validacionResp.data,
          evidencia_sha256: evidencia.data.sha256,
        },
        ctx
      )
    );
    if (!payloadResp.ok) throw new Error(`no se pudo construir el payload de sol-001: ${payloadResp.error}`);

    const crearResp = parsear<{ numero_oc: string; idempotente: boolean }>(
      await crear.execute({ caso: "sol-001", payload: payloadResp.data.payload, confirmado: true }, ctx)
    );
    expect(crearResp.ok).toBe(true);
    if (crearResp.ok) {
      expect(crearResp.data.numero_oc).toBe("4500000001");
      expect(crearResp.data.idempotente).toBe(false);
    }
  });
});
