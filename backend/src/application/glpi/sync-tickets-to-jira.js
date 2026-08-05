// backend/src/application/glpi/sync-tickets-to-jira.js
//
// Todo chamado novo no GLPI vira card no board DC, automaticamente.
//
// A convenção do projeto já mandava fazer isso à mão ("todo chamado atendido vira
// card no Jira"); na prática, o trabalho só aparecia no board quando alguém
// lembrava. Este caso de uso fecha a lacuna.
//
// DEDUPLICAÇÃO por LABEL, não por título. O label `glpi-40` é exato em JQL, então
// um card renomeado por qualquer pessoa continua sendo encontrado. Casar por
// título quebraria no primeiro ajuste de texto e o board ganharia duplicatas —
// que é justamente o que uma automação de criação não pode produzir.

import {
  GLPI_TICKET_STATUS,
  initGlpiSession,
  killGlpiSession,
  searchGlpiTicketsByStatus,
} from "../../infrastructure/glpi/glpi-client.js";
import {
  JIRA_ISSUE_TYPE,
  createJiraIssue,
  getJiraProjectKey,
  searchJiraIssues,
} from "../../infrastructure/jira/jira-client.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";

/** Status do GLPI que contam como "ainda precisa de trabalho". */
const STATUS_EM_ABERTO = [
  GLPI_TICKET_STATUS.NOVO,
  GLPI_TICKET_STATUS.EM_ATENDIMENTO_ATRIBUIDO,
  GLPI_TICKET_STATUS.EM_ATENDIMENTO_PLANEJADO,
  GLPI_TICKET_STATUS.PENDENTE,
];

export function labelDoChamado(ticketId) {
  return `glpi-${Number(ticketId)}`;
}

/** Escapa aspas para não quebrar a JQL com um label malformado. */
function jqlDoChamado(ticketId) {
  const label = labelDoChamado(ticketId).replace(/"/g, '\\"');
  return `project = "${getJiraProjectKey()}" AND labels = "${label}"`;
}

function descricaoDoCard(chamado, urlDoChamado) {
  return [
    `Chamado aberto no GLPI por quem usa o sistema.`,
    `Chamado: #${chamado.id} — ${chamado.title}`,
    `Aberto em: ${chamado.openedAt || "(sem data)"}`,
    `Link: ${urlDoChamado}`,
    `Card criado automaticamente pelo worker de chamados. Ao corrigir, use o trailer "Chamado: GLPI #${chamado.id}" no commit e crie a comprovação em docs/chamados/${chamado.id}.md — o chamado é respondido e fechado sozinho quando a correção entrar em produção.`,
  ].join("\n\n");
}

/**
 * @param {object} [params]
 * @param {number} [params.limite] máximo de chamados examinados por ciclo
 * @param {string} [params.glpiWebUrl] base para montar o link do chamado
 * @param {string} [params.correlationId]
 * @param {object} [deps] injeção para teste
 *
 * @returns {Promise<{ criados: Array<{ chamadoId: number, key: string, url: string }>,
 *                     jaExistiam: number, examinados: number }>}
 */
export async function syncTicketsToJira(
  { limite = 50, glpiWebUrl = "http://10.100.100.6/glpi", correlationId } = {},
  deps = {},
) {
  const {
    initSession = initGlpiSession,
    killSession = killGlpiSession,
    buscarChamados = searchGlpiTicketsByStatus,
    buscarIssues = searchJiraIssues,
    criarIssue = createJiraIssue,
  } = deps;

  let sessionToken = null;

  try {
    sessionToken = await initSession({ correlationId });
    // O cliente do GLPI espera `limit` (não `limite`) — nome errado aqui viraria
    // silenciosamente o default de 50, sem erro nenhum para denunciar.
    const chamados = await buscarChamados(sessionToken, STATUS_EM_ABERTO, { limit: limite, correlationId });

    const criados = [];
    let jaExistiam = 0;

    for (const chamado of chamados) {
      const existentes = await buscarIssues(jqlDoChamado(chamado.id), { maxResults: 1, correlationId });
      if (existentes.length > 0) {
        jaExistiam += 1;
        continue;
      }

      const urlDoChamado = `${String(glpiWebUrl).replace(/\/+$/, "")}/front/ticket.form.php?id=${chamado.id}`;
      const criada = await criarIssue(
        {
          summary: `[GLPI #${chamado.id}] ${chamado.title}`,
          descricao: descricaoDoCard(chamado, urlDoChamado),
          issueTypeId: JIRA_ISSUE_TYPE.BUG,
          labels: ["chamado-glpi", labelDoChamado(chamado.id)],
        },
        { correlationId },
      );

      logStructuredEvent("info", "glpi.sync_jira.card_criado", {
        correlationId: correlationId || null,
        ticketId: chamado.id,
        jiraKey: criada.key,
      });
      criados.push({ chamadoId: chamado.id, key: criada.key, url: criada.url });
    }

    return { criados, jaExistiam, examinados: chamados.length };
  } finally {
    await killSession(sessionToken, { correlationId });
  }
}
