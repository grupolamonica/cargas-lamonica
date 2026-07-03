/**
 * Gate de categoria da CNH × veículo (paridade com a produção:
 * automations.js `checkAngelliraExportGate`, regra `cnh_category`).
 *
 * Cavalo mecânico e composição cavalo+carreta exigem CNH categoria com **E**
 * (AE, BE, CE, DE, ou E sozinha). Se a CNH do motorista tem categoria abaixo
 * (A, B, C, D, AB, AC, AD…), ele não está habilitado a conduzir o veículo — o
 * SPX rejeita no validate/detail com o críptico 271626003. Este gate barra ANTES
 * do disparo, com a MESMA mensagem clara da produção, poupando o round-trip.
 *
 * Best-effort: se não dá pra determinar a categoria (vazia), NÃO bloqueia —
 * deixa o SPX validar (a categoria pode vir só na imagem da CNH).
 */

import { mapMotoristaPayload, extractPlacas } from "../angellira/payload-mapper.js";

/**
 * @param {object} dados — pending_driver_registrations.dados
 * @returns {{code, message, blocked_by, categoria}|null} bloqueio, ou null se OK.
 */
export function checkCnhCategoryGate(dados) {
  const { cavalo, carreta } = extractPlacas(dados || {});
  // O SPX cadastra o cavalo (e a carreta). Sem veículo, o gate não se aplica.
  if (!cavalo && !carreta) return null;

  const ang = mapMotoristaPayload(dados || {});
  const categoria = String(ang?.cnh?.categoria || "").trim().toUpperCase();
  // Sem categoria conhecida → não bloqueia (deixa o SPX decidir pela imagem da CNH).
  if (!categoria) return null;
  // Aceita qualquer categoria que contenha 'E' (AE/BE/CE/DE/E). Rejeita o resto.
  if (categoria.includes("E")) return null;

  const alvo = carreta && carreta !== cavalo ? "cavalo+carreta" : "cavalo";
  return {
    code: "SPX_CNH_CATEGORIA_INCOMPATIVEL",
    message: `Motorista tem CNH categoria ${categoria} — incompatível com ${alvo}. Exige CNH com categoria E (AE/BE/CE/DE/E).`,
    blocked_by: "cnh_category",
    categoria,
  };
}
