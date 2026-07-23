/**
 * Gate de CRLV do cavalo × SPX (DC-304).
 *
 * O SPX faz OCR da IMAGEM da CRLV do cavalo e casa placa/renavam/marca 1:1;
 * sem a imagem ele falha com um 502 opaco ("Falha SPX em etapa desconhecida").
 * Isso acontece no cadastro "só motorista": quando a placa do cavalo já está
 * vigente no Angellira, o wizard pula o Step B (onde se anexa a CRLV), então o
 * cadastro persiste `cavalo.placa` SEM `cavalo.crlv_url`.
 *
 * Não dá para recuperar a imagem do Angellira (a API só devolve metadados, não
 * baixa anexo). Então este gate barra ANTES do disparo, com mensagem acionável
 * — o operador anexa a CRLV no painel e dispara o SPX de novo. Troca o 502
 * críptico por um estado claro. Espelha o `checkCnhCategoryGate`.
 *
 * @param {object} dados — pending_driver_registrations.dados
 * @returns {{code,message,acao,blocked_by,placa}|null} bloqueio, ou null se OK.
 */
export function checkCrlvGate(dados) {
  const cavalo = dados && typeof dados === "object" ? dados.cavalo : null;
  const placa = String(cavalo?.placa || "").trim();
  // Sem cavalo/placa, o SPX não manda veículo → o gate não se aplica.
  if (!placa) return null;
  const crlvUrl = String(cavalo?.crlv_url || "").trim();
  if (crlvUrl) return null; // CRLV anexada → segue o disparo.

  return {
    code: "SPX_CRLV_CAVALO_AUSENTE",
    message: `CRLV do cavalo (placa ${placa.toUpperCase()}) não foi anexada. A placa foi validada, mas o SPX precisa da imagem da CRLV para concluir.`,
    acao: "Anexe a CRLV do cavalo no cadastro e dispare o SPX novamente.",
    blocked_by: "crlv_cavalo",
    placa: placa.toUpperCase(),
  };
}
