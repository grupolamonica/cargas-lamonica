/**
 * Regra de elegibilidade de categoria da CNH (domínio candidatura).
 *
 * Regra de negócio Lamônica: para se cadastrar e puxar cargas o motorista
 * precisa de CNH categoria **D pra cima** — D ou E (inclui as combinações que
 * contêm D ou E: AD, AE, BD, BE, CD, CE, DE…). As categorias que topam em C
 * (A, B, C, AB, AC, BC…) NÃO habilitam e são barradas ANTES do submit.
 *
 * ATENÇÃO — esta regra é a da CANDIDATURA (D ou E). O gate do SPX
 * (`checkCnhCategoryGate`) tem regra PRÓPRIA e mais estrita (o portal SPX exige
 * categoria E de fato) — NÃO reusa este helper de propósito.
 */

/** Normaliza a categoria: string aparada e em maiúsculas. */
export function normalizeCnhCategoria(value) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * A categoria habilita a puxar carga? (regra da candidatura: D pra cima).
 *
 * @param {string} categoria
 * @returns {boolean} true quando a categoria contém D ou E (D/E/AD/AE/CD/CE/DE…)
 *   OU quando está vazia/desconhecida — nesse caso é best-effort e NÃO bloqueia
 *   (a obrigatoriedade do campo é responsabilidade de outra validação; empty
 *   aqui costuma ser re-submit legado sem categoria).
 */
export function isCnhCategoriaElegivel(categoria) {
  const norm = normalizeCnhCategoria(categoria);
  if (!norm) return true;
  return norm.includes("D") || norm.includes("E");
}

/**
 * Lê a categoria da CNH do payload do wizard (`dados`) e avalia a elegibilidade.
 * Espelha os caminhos que `buildSubmitDados` grava
 * (`dados.motorista.cnh.categoria`) e o fallback que `mapMotoristaPayload` lê.
 *
 * @param {object} dados — pending_driver_registrations.dados (formato wizard v2)
 * @returns {null | {error:string, categoria:string, message:string}} bloqueio, ou
 *   null quando elegível.
 */
export function evaluateCandidaturaCnhCategoria(dados) {
  const categoria = normalizeCnhCategoria(
    dados?.motorista?.cnh?.categoria
      ?? dados?.cnh?.categoria
      ?? dados?.motorista?.categoria,
  );
  if (isCnhCategoriaElegivel(categoria)) return null;
  return {
    error: "CNH_CATEGORIA_INCOMPATIVEL",
    categoria,
    message:
      `A CNH informada é categoria ${categoria}. Para se cadastrar e puxar cargas é `
      + "necessário CNH categoria D ou superior (D, E ou combinações como AD, AE, CD, CE, DE).",
  };
}
