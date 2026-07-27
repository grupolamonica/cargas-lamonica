// Conformidade do Angellira — regra ÚNICA de "está Conforme?" usada pela
// auto-aprovação e pela conciliação.
//
// CONTEXTO (bug DC): o backend Node vinha tratando "conforme" como apenas
// `status === "FOUND" && validUntil >= hoje`, IGNORANDO o rótulo real do portal
// (`status.description`, exposto como `statusText`). Só que o portal registra o
// conjunto em HOMOLOGADORA/em análise ANTES de virar "Conforme" — e nesse
// estado o registro já pode vir FOUND com uma validade (limitDate) preenchida.
// Resultado: cadastros em homologação eram tratados como conformes e
// aprovados/concluídos cedo demais — e o robô da UNIFICADA (que exige
// literalmente "Conforme") gerava o GR em BRANCO. (Caso JOSE EDUARDO.)
//
// Esta função espelha EXATAMENTE a regra do robô Angellira
// (`bots/angelira/backend/angelira_robo/api_query/precheck.py`
//  → `_detectar_situacao_por_descricao`): normaliza o texto (NFKD, tira o que
// não é letra, maiúsculas) e exige "CONFORME" SEM ser "NAOCONFORME". Qualquer
// outro rótulo (homologadora, em análise, atualizando, vazio…) ⇒ ainda NÃO
// conforme. Assim o Node passa a decidir igual ao robô e à unificada.

/**
 * O rótulo do portal (`statusText` / `status.description`) diz "Conforme"?
 * - "Conforme" → true
 * - "Não Conforme" / "NÃO CONFORME" → false (checado antes, é superstring)
 * - homologadora / em análise / atualizando / vazio / null → false
 *
 * @param {string|null|undefined} statusText
 * @returns {boolean}
 */
export function isStatusTextConforme(statusText) {
  const n = String(statusText ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
  if (!n) return false;
  if (n.includes("NAOCONFORME")) return false;
  return n.includes("CONFORME");
}
