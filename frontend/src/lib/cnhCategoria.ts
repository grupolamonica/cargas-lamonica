/**
 * Regra de elegibilidade de categoria da CNH (espelho do backend
 * `domain/candidatura/cnh-category.js`).
 *
 * Para puxar cargas Lamônica a CNH precisa ser categoria D pra cima — D ou E
 * (inclui AD, AE, CD, CE, DE…). Categorias que topam em C (A, B, C, AB, AC…)
 * não habilitam.
 */

export function normalizeCnhCategoria(value: string | undefined | null): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * true quando a categoria contém D ou E (habilita) OU está vazia (best-effort —
 * a obrigatoriedade do campo é validada à parte, sem falso bloqueio).
 */
export function isCnhCategoriaElegivel(categoria: string | undefined | null): boolean {
  const norm = normalizeCnhCategoria(categoria);
  if (!norm) return true;
  return norm.includes("D") || norm.includes("E");
}

export const CNH_CATEGORIA_REQUER_E_MENSAGEM =
  "Esta categoria não habilita a puxar cargas. É necessário CNH categoria D ou superior (D, E ou combinações como AD, AE, DE).";
