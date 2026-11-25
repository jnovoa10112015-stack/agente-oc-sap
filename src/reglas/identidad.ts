/** Formatos presentes en los fixtures; no calcula el dígito de verificación. */
export function normalizarNit(nit: string): string {
  return nit.trim().replace(/-\s*\d\s*$/, "").replace(/\D/g, "");
}

export function normalizarNombre(nombre: string): string {
  return nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\s+(s\s*a\s*s|s\s*a|ltda|limitada)$/, "").trim();
}

export const normalizarCorreo = (correo: string) => correo.trim().toLowerCase();
