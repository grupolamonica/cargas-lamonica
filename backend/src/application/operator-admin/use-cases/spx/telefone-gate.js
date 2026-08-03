/**
 * Gate de telefone do motorista × SPX.
 *
 * O SPX valida o telefone no endpoint `driver/request/validate/basic` e rejeita
 * com retcode 271605009 ("Telefone invalido, formato BR esperado: DDD + 9
 * digitos") quando o número não tem 11 dígitos (DDD 2 + celular 9). Sem número,
 * ou com 10 dígitos (formato antigo sem o 9), o robô devolve um 502 opaco
 * ("Falha SPX em etapa desconhecida") — foi o caso do JEAN DOMINGOS OLIVEIRA,
 * cujo cadastro chegou SEM telefone e só falhou lá no SPX.
 *
 * Este gate barra ANTES do disparo, com mensagem acionável — o operador corrige
 * o telefone no painel e dispara de novo. Espelha o `checkCrlvGate` /
 * `checkCnhCategoryGate`. Lê o telefone na MESMA ordem de prioridade que o
 * payload-mapper/precheck usam pra montar o `contact_number`.
 *
 * @param {object} dados — pending_driver_registrations.dados
 * @returns {{code,message,acao,blocked_by,telefone}|null} bloqueio, ou null se OK.
 */
const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

export function checkTelefoneGate(dados) {
  const motorista = dados && typeof dados === "object" ? dados.motorista : null;
  if (!motorista || typeof motorista !== "object") return null;

  const raw =
    (Array.isArray(motorista.telefones) && motorista.telefones[0]) ||
    motorista.telefone_primario ||
    motorista.telefone ||
    "";
  const tel = onlyDigits(raw);
  if (tel.length === 11) return null; // DDD + 9 dígitos → segue o disparo.

  const base = { code: "SPX_TELEFONE_INVALIDO", blocked_by: "telefone", telefone: tel || null };
  if (!tel) {
    return {
      ...base,
      message:
        "Telefone do motorista ausente. O SPX exige um celular com DDD + 9 dígitos (11 números).",
      acao: "Preencha o telefone (WhatsApp) do motorista no cadastro e dispare o SPX novamente.",
    };
  }
  return {
    ...base,
    message: `Telefone do motorista inválido (${tel.length} dígitos). O SPX exige DDD + 9 dígitos (11 números).`,
    acao:
      "Corrija o telefone (WhatsApp) do motorista — inclua o DDD e o 9 — e dispare o SPX novamente.",
  };
}
