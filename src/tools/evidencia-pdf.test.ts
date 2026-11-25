/**
 * Evidencia en PDF (PRD 6.4, P1): out/<caso>/aprobacion.pdf lleva el mismo
 * contenido que aprobacion.txt y el sha256 de ese .txt.
 */

import { describe, test, expect } from "bun:test";
import { rm, mkdtemp, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { generar_evidencia } from "./oc";
import { generarPdfEvidencia } from "./evidencia-pdf";

const ctx = { directory: process.cwd(), sessionId: "test-evidencia-pdf" };

/** Texto dibujado en el PDF: pdf-lib comprime los content streams con Flate y
 * escribe las cadenas de las fuentes estándar como hex (`<48656c6c6f> Tj`). */
function extraerTexto(bytes: Uint8Array): string {
  const crudo = Buffer.from(bytes).toString("latin1");
  const lineas: string[] = [];
  for (const m of crudo.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const flujo = Buffer.from(m[1] ?? "", "latin1");
    let contenido: string;
    try {
      contenido = inflateSync(flujo).toString("latin1");
    } catch {
      contenido = flujo.toString("latin1");
    }
    for (const h of contenido.matchAll(/<([0-9a-fA-F]*)>\s*Tj/g)) {
      lineas.push(Buffer.from(h[1] ?? "", "hex").toString("latin1"));
    }
  }
  return lineas.join("\n");
}

describe("aprobacion.pdf generado por oc_generar_evidencia", () => {
  test("existe junto al .txt y contiene el sha256 del .txt y sus encabezados", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-evidencia-pdf-"));
    try {
      await cp(path.join(ctx.directory, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
      const respuesta = JSON.parse(
        await generar_evidencia.execute({ caso: "sol-001" }, { directory: dir, sessionId: ctx.sessionId })
      ) as { ok: true; data: { ruta: string; sha256: string } } | { ok: false; error: string };
      if (!respuesta.ok) throw new Error(respuesta.error);

      const txt = await readFile(path.join(dir, "out", "sol-001", "aprobacion.txt"), "utf-8");
      const shaDelTxt = createHash("sha256").update(txt).digest("hex");
      expect(respuesta.data.ruta).toBe("out/sol-001/aprobacion.txt");
      expect(respuesta.data.sha256).toBe(shaDelTxt);

      const pdfBytes = new Uint8Array(await readFile(path.join(dir, "out", "sol-001", "aprobacion.pdf")));
      expect(Buffer.from(pdfBytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");

      const texto = extraerTexto(pdfBytes);
      expect(texto).toContain(shaDelTxt);
      for (const encabezado of txt.split("\n\n")[0]?.split("\n") ?? []) {
        expect(texto).toContain(encabezado);
      }
      const doc = await PDFDocument.load(pdfBytes);
      expect(doc.getKeywords()).toContain(shaDelTxt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generarPdfEvidencia", () => {
  const sha = "a".repeat(64);

  test("caracteres fuera de WinAnsi no hacen fallar la generación", async () => {
    const bytes = await generarPdfEvidencia("De: a@b.co\n\nAprobado → sí ✓ 😀\ttab\n", sha);
    const texto = extraerTexto(bytes);
    expect(texto).toContain("Aprobado ? s");
    expect(texto).toContain(sha);
  });

  test("un cuerpo largo se parte en varias páginas y el sha256 queda completo", async () => {
    const cuerpo = Array.from({ length: 200 }, (_, i) => `Línea ${i} ${"palabra ".repeat(20)}`).join("\n");
    const bytes = await generarPdfEvidencia(`De: a@b.co\n\n${cuerpo}\n`, sha);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(extraerTexto(bytes)).toContain(sha);
  });

  test("una palabra más ancha que la página se corta en lugar de salirse", async () => {
    const bytes = await generarPdfEvidencia(`De: a@b.co\n\n${"x".repeat(500)}\n`, sha);
    expect(extraerTexto(bytes).replace(/\n/g, "")).toContain("x".repeat(500));
  });
});
