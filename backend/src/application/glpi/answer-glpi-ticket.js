// backend/src/application/glpi/answer-glpi-ticket.js
//
// Fecha o ciclo de um chamado do GLPI sem humano no meio: anexa a prova,
// registra a solução em linguagem do operador e marca como Solucionado.
//
// ─── POR QUE ESTE ARQUIVO É CHEIO DE TRAVA ───────────────────────────────────
//
// A automação é TOTALMENTE automática por decisão do usuário (05/08/2026), com o
// risco declarado: se o diagnóstico estiver errado, o operador recebe "resolvido"
// sem estar. Como não há revisor humano, as travas abaixo fazem esse papel — e
// todas falham para o lado de NÃO RESPONDER:
//
//   1. Sem prova anexável, não responde.  A evidência é pré-requisito, não enfeite.
//      Quem escreve o fix é obrigado a produzir a comprovação; a falta dela barra
//      o "resolvido" falso na origem.
//   2. Anexo ANTES da solução.  Se o upload falhar, nada é publicado. O contrário
//      produziria "resolvido, veja o anexo" sem anexo nenhum.
//   3. Chamado já solucionado/fechado não é tocado.  A automação não reabre nem
//      re-responde o que um humano já concluiu.
//   4. Idempotência por marca no histórico.  Reexecutar o worker não gera resposta
//      repetida para quem abriu o chamado.
//
// A marca é um comentário HTML: o GLPI renderiza o conteúdo como HTML, então ela
// fica invisível para quem lê o chamado e continua legível para a automação.

import {
  GLPI_TICKET_STATUS,
  addGlpiSolution,
  getGlpiTicket,
  getGlpiTicketSubItems,
  initGlpiSession,
  killGlpiSession,
  uploadGlpiDocument,
} from "../../infrastructure/glpi/glpi-client.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";

/** Marca invisível que identifica uma resposta nossa no histórico do chamado. */
export function marcadorDaAutomacao(ticketId) {
  return `<!-- lmc-auto:chamado-${Number(ticketId)} -->`;
}

const STATUS_JA_CONCLUIDO = new Set([GLPI_TICKET_STATUS.SOLUCIONADO, GLPI_TICKET_STATUS.FECHADO]);

/** O histórico do GLPI já contém uma resposta nossa? */
function jaRespondido(subItens, marcador) {
  return subItens.some((item) => String(item?.content ?? "").includes(marcador));
}

/**
 * @param {object} params
 * @param {number|string} params.ticketId
 * @param {string} params.resposta   Texto para o operador (HTML simples). Obrigatório.
 * @param {{ filename: string, content: string, contentType?: string }} params.prova
 *        Arquivo de comprovação. Obrigatório — ver trava 1.
 * @param {string} [params.correlationId]
 * @param {object} [deps] Injeção para teste.
 *
 * @returns {Promise<{ acao: "respondido"|"ignorado", motivo?: string, ticketId: number }>}
 *
 * @throws Error("CHAMADO_SEM_RESPOSTA") texto vazio
 * @throws Error("CHAMADO_SEM_PROVA")    comprovação ausente ou vazia
 * @throws erros do cliente GLPI (GLPI_NOT_CONFIGURED, GLPI_API_DISABLED, ...)
 */
export async function answerGlpiTicket(
  { ticketId, resposta, prova, correlationId } = {},
  deps = {},
) {
  const {
    initSession = initGlpiSession,
    killSession = killGlpiSession,
    lerChamado = getGlpiTicket,
    lerSubItens = getGlpiTicketSubItems,
    anexar = uploadGlpiDocument,
    registrarSolucao = addGlpiSolution,
  } = deps;

  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("CHAMADO_ID_INVALIDO");

  const texto = String(resposta ?? "").trim();
  if (!texto) throw new Error("CHAMADO_SEM_RESPOSTA");

  // Trava 1 — a mais importante de todas neste modo automático.
  if (!prova || !String(prova.content ?? "").trim() || !String(prova.filename ?? "").trim()) {
    logStructuredEvent("error", "glpi.answer_ticket.sem_prova", {
      correlationId: correlationId || null,
      ticketId: id,
    });
    throw new Error("CHAMADO_SEM_PROVA");
  }

  const marcador = marcadorDaAutomacao(id);
  let sessionToken = null;

  try {
    sessionToken = await initSession({ correlationId });

    const chamado = await lerChamado(sessionToken, id, { correlationId });

    // Trava 3 — não mexe no que já foi concluído.
    if (STATUS_JA_CONCLUIDO.has(Number(chamado?.status))) {
      logStructuredEvent("info", "glpi.answer_ticket.ignorado", {
        correlationId: correlationId || null,
        ticketId: id,
        motivo: "ja_fechado",
        status: Number(chamado?.status),
      });
      return { acao: "ignorado", motivo: "ja_fechado", ticketId: id };
    }

    // Trava 4 — idempotência. Olha acompanhamentos E soluções: a resposta pode ter
    // sido publicada como qualquer um dos dois em execuções anteriores.
    const [acompanhamentos, solucoes] = await Promise.all([
      lerSubItens(sessionToken, id, "ITILFollowup", { correlationId }),
      lerSubItens(sessionToken, id, "ITILSolution", { correlationId }),
    ]);
    if (jaRespondido([...acompanhamentos, ...solucoes], marcador)) {
      logStructuredEvent("info", "glpi.answer_ticket.ignorado", {
        correlationId: correlationId || null,
        ticketId: id,
        motivo: "ja_respondido",
      });
      return { acao: "ignorado", motivo: "ja_respondido", ticketId: id };
    }

    // Trava 2 — anexo primeiro. Se falhar, propaga e NADA é publicado.
    await anexar(
      sessionToken,
      id,
      {
        filename: prova.filename,
        content: prova.content,
        contentType: prova.contentType || "text/markdown",
        name: `Comprovação — chamado ${id}`,
      },
      { correlationId },
    );

    await registrarSolucao(sessionToken, id, `${texto}\n${marcador}`, { correlationId });

    logStructuredEvent("info", "glpi.answer_ticket.respondido", {
      correlationId: correlationId || null,
      ticketId: id,
      anexo: prova.filename,
    });
    return { acao: "respondido", ticketId: id };
  } finally {
    await killSession(sessionToken, { correlationId });
  }
}
