/**
 * Render del PDF de evidencia de aprobación (PRD 6.4, entregable P1).
 *
 * Es una función pura sobre el texto que `oc_generar_evidencia` ya escribe en
 * aprobacion.txt: mismo contenido, más el sha256 de ese texto. No lee ni
 * escribe archivos; quien la llama decide dónde guardar los bytes.
 */

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

const MARGEN = 56;
const TAMANO_FUENTE = 10;
const INTERLINEADO = 14;
const PAGINA = { ancho: 595.28, alto: 841.89 }; // A4 en puntos

/** Las fuentes estándar del PDF solo codifican WinAnsi: lo que no entra se
 * reemplaza por "?" en lugar de hacer fallar la generación de la evidencia. */
function codificable(texto: string, fuente: PDFFont): string {
  const soportados = new Set(fuente.getCharacterSet());
  let salida = "";
  for (const caracter of texto.replace(/\t/g, "    ").replace(/\r/g, "")) {
    const codigo = caracter.codePointAt(0);
    salida += codigo !== undefined && soportados.has(codigo) ? caracter : "?";
  }
  return salida;
}

/** Parte una línea en tramos que caben en el ancho útil. Corta por palabras;
 * una palabra más larga que la línea (p. ej. un hash) se corta por caracteres. */
function ajustarLinea(linea: string, fuente: PDFFont, anchoMax: number): string[] {
  if (linea === "") return [""];
  const tramos: string[] = [];
  let actual = "";
  const cabe = (t: string): boolean => fuente.widthOfTextAtSize(t, TAMANO_FUENTE) <= anchoMax;

  for (const palabra of linea.split(" ")) {
    const candidata = actual === "" ? palabra : `${actual} ${palabra}`;
    if (cabe(candidata)) {
      actual = candidata;
      continue;
    }
    if (actual !== "") tramos.push(actual);
    actual = "";
    let resto = palabra;
    while (!cabe(resto)) {
      let corte = resto.length - 1;
      while (corte > 1 && !cabe(resto.slice(0, corte))) corte--;
      tramos.push(resto.slice(0, corte));
      resto = resto.slice(corte);
    }
    actual = resto;
  }
  if (actual !== "") tramos.push(actual);
  return tramos;
}

/** Genera el PDF. `contenido` es el texto exacto de aprobacion.txt y `sha256`
 * su huella; el hash se imprime en una línea propia y también se guarda en las
 * palabras clave del documento. */
export async function generarPdfEvidencia(contenido: string, sha256: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fuente = await pdf.embedFont(StandardFonts.Courier);
  const negrita = await pdf.embedFont(StandardFonts.CourierBold);
  const anchoUtil = PAGINA.ancho - 2 * MARGEN;

  pdf.setTitle("Evidencia de aprobación");
  pdf.setKeywords([`sha256:${sha256}`]);

  const lineas: { texto: string; fuente: PDFFont }[] = [];
  for (const cruda of contenido.replace(/\n+$/, "").split("\n")) {
    for (const tramo of ajustarLinea(codificable(cruda, fuente), fuente, anchoUtil)) {
      lineas.push({ texto: tramo, fuente });
    }
  }
  lineas.push({ texto: "", fuente });
  lineas.push({ texto: "SHA-256 del texto de la evidencia (aprobacion.txt):", fuente: negrita });
  for (const tramo of ajustarLinea(sha256, fuente, anchoUtil)) lineas.push({ texto: tramo, fuente });

  let pagina = pdf.addPage([PAGINA.ancho, PAGINA.alto]);
  let y = PAGINA.alto - MARGEN;
  for (const { texto, fuente: f } of lineas) {
    if (y < MARGEN) {
      pagina = pdf.addPage([PAGINA.ancho, PAGINA.alto]);
      y = PAGINA.alto - MARGEN;
    }
    if (texto !== "") pagina.drawText(texto, { x: MARGEN, y, size: TAMANO_FUENTE, font: f });
    y -= INTERLINEADO;
  }

  return pdf.save();
}
