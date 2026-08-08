import { describe, expect, it } from "vitest";
import express from "express";

import { registerRoutes } from "./routes.js";

/**
 * Inventário de rotas HTTP (DC-283 / Fase 20).
 *
 * Este teste NÃO verifica autenticação — ele obriga uma DECISÃO consciente
 * sempre que a superfície HTTP muda.
 *
 * Foi assim que o CRIT-3 aconteceu: `GET /api/candidatura/draft/me` nasceu
 * público, autorizando por CPF, e ninguém percebeu até a auditoria. Com este
 * guard, a rota nova quebra o teste, e quem a adicionou precisa declarar
 * explicitamente que ela existe — e, ao fazer isso, decidir quem pode chamá-la.
 *
 * Quando o teste falhar:
 *   1. rota NOVA        → confirme quem pode chamar (sessão de operador? de
 *                         motorista? pública mesmo?) e acrescente à lista;
 *   2. rota REMOVIDA    → remova da lista;
 *   3. rota RENOMEADA   → é remoção + adição; confira se algum cliente ainda
 *                         chama o caminho antigo antes de trocar.
 *
 * NUNCA atualize esta lista sem olhar a rota. Uma lista atualizada no
 * automático é pior que nenhuma lista: dá a impressão de que alguém revisou.
 */
const ROTAS_CONHECIDAS = [
  "DELETE /api/operator/cadastros/:id",
  "DELETE /api/operator/cargas-casadas/:pacoteId/cargas/:cargaId",
  "DELETE /api/operator/cargas/:cargoId",
  "DELETE /api/operator/clientes/:clienteId",
  "DELETE /api/operator/clientes/:clienteId/rotas/:rotaId",
  "DELETE /api/operator/outreach/optout/:driverKey",
  "DELETE /api/operator/programacao/route-colors",
  "DELETE /api/operator/sheet-monitor/reserva",
  "GET /api/admin/aspx-sync-health",
  "GET /api/candidatura/draft/me",
  "GET /api/client-logo",
  "GET /api/driver/cadastros/incompletos",
  "GET /api/driver/cargas/:cargoId",
  "GET /api/driver/loads",
  "GET /api/driver/loads/digest",
  "GET /api/driver/loads/facets",
  "GET /api/driver/pacotes/:pacoteId",
  "GET /api/drivers/me",
  "GET /api/load-claims/maintenance",
  "GET /api/loads/:loadId/claim-status",
  "GET /api/operator/allocation-changes",
  "GET /api/operator/aspx/status",
  "GET /api/operator/audit-logs",
  "GET /api/operator/brk/status",
  "GET /api/operator/cadastro-bots/health",
  "GET /api/operator/cadastros-com-erro",
  "GET /api/operator/cadastros-incompletos",
  "GET /api/operator/cadastros-pendentes",
  "GET /api/operator/cadastros/:id",
  "GET /api/operator/cadastros/:id/arquivo",
  "GET /api/operator/cadastros/:id/doc-migrado",
  "GET /api/operator/cadastros/:id/docs-migrados",
  "GET /api/operator/cadastros/:id/external-jobs",
  "GET /api/operator/cadastros/:id/torre",
  "GET /api/operator/cadastros/rascunhos",
  "GET /api/operator/cargas",
  "GET /api/operator/cargas-casadas",
  "GET /api/operator/cargas-casadas/:pacoteId",
  "GET /api/operator/cargas/historico",
  "GET /api/operator/cargas/lookup/codigo-viagem",
  "GET /api/operator/chat/conversations",
  "GET /api/operator/chat/messages",
  "GET /api/operator/clientes",
  "GET /api/operator/clientes/:clienteId/rotas",
  "GET /api/operator/dashboard",
  "GET /api/operator/driver-flow-metrics",
  "GET /api/operator/driver-opportunities",
  "GET /api/operator/drivers/:cpf/torre",
  "GET /api/operator/leads",
  "GET /api/operator/mass-outreach/routes",
  "GET /api/operator/motoristas",
  "GET /api/operator/notifications",
  "GET /api/operator/outreach/message-templates",
  "GET /api/operator/outreach/overview",
  "GET /api/operator/outreach/queue/:id",
  "GET /api/operator/outreach/whatsapp/status",
  "GET /api/operator/overview/digest",
  "GET /api/operator/overview/snapshot",
  "GET /api/operator/programacao",
  "GET /api/operator/programacao/route-colors",
  "GET /api/operator/programacao/settings",
  "GET /api/operator/repom/whatsapp/status",
  "GET /api/operator/routes",
  "GET /api/operator/settings/auto-approve-angellira",
  "GET /api/operator/sheet-monitor",
  "GET /api/operator/sheet-monitor/route-history",
  "GET /api/operator/sheet-monitor/row",
  "GET /api/operator/sponsor-clicks",
  "GET /api/operator/vehicle-checklist",
  "GET /api/operator/vehicle-checklist/levels",
  "GET /api/operator/veiculos",
  "GET /api/route-info",
  "GET /api/sheet-sync",
  "PATCH /api/operator/cadastros/:id/dados",
  "PATCH /api/operator/cargas/:cargoId",
  "PATCH /api/operator/clientes/:clienteId",
  "PATCH /api/operator/motoristas/:driverId",
  "PATCH /api/operator/outreach/message-templates",
  "PATCH /api/operator/outreach/queue/:id",
  "PATCH /api/operator/outreach/settings",
  "PATCH /api/operator/programacao/settings",
  "PATCH /api/operator/routes/:routeId",
  "PATCH /api/operator/sheet-monitor",
  "PATCH /api/operator/sheet-monitor/cargo",
  "PATCH /api/operator/sheet-monitor/reserva",
  "POST /api/cadastro/lookup-pis",
  "POST /api/cadastro/upload-draft-file",
  "POST /api/candidatura/antt-precheck",
  "POST /api/candidatura/attach-selfie",
  "POST /api/candidatura/draft",
  "POST /api/candidatura/pre-check",
  "POST /api/candidatura/submit",
  "POST /api/candidatura/verify-document",
  "POST /api/cargas/advance-recurring",
  "POST /api/driver/portal-view",
  "POST /api/driver/sponsor-click",
  "POST /api/drivers/register",
  "POST /api/load-claims/maintenance",
  "POST /api/loads/:loadId/claims",
  "POST /api/loads/:loadId/claims/:claimId/cancel",
  "POST /api/loads/:loadId/claims/:claimId/confirm",
  "POST /api/loads/:loadId/leads/:leadId/approve",
  "POST /api/loads/:loadId/leads/:leadId/cancel",
  "POST /api/loads/:loadId/leads/:leadId/whatsapp",
  "POST /api/loads/:loadId/pre-registration",
  "POST /api/operator/allocation-changes/revert",
  "POST /api/operator/aspx/cookies",
  "POST /api/operator/aspx/refresh",
  "POST /api/operator/aspx/sync",
  "POST /api/operator/brk/cookie",
  "POST /api/operator/cadastros/:id/anexar-documento",
  "POST /api/operator/cadastros/:id/anexar-selfie",
  "POST /api/operator/cadastros/:id/angellira/cadastrar",
  "POST /api/operator/cadastros/:id/angellira/cadastrar/:step",
  "POST /api/operator/cadastros/:id/angellira/check-owner",
  "POST /api/operator/cadastros/:id/angellira/precheck",
  "POST /api/operator/cadastros/:id/aprovar",
  "POST /api/operator/cadastros/:id/nao-conformidade",
  "POST /api/operator/cadastros/:id/rejeitar",
  "POST /api/operator/cadastros/:id/reprocessar-documentos",
  "POST /api/operator/cadastros/:id/spx/cadastrar",
  "POST /api/operator/cadastros/:id/spx/precheck",
  "POST /api/operator/cadastros/:id/submeter",
  "POST /api/operator/cadastros/:id/unificada/gerar-pdf",
  "POST /api/operator/cadastros/auto-approve-angellira/run",
  "POST /api/operator/cargas",
  "POST /api/operator/cargas-casadas",
  "POST /api/operator/cargas-casadas/:pacoteId/cancel",
  "POST /api/operator/cargas-casadas/:pacoteId/cargas",
  "POST /api/operator/cargas-casadas/:pacoteId/publish",
  "POST /api/operator/cargas/:cargoId/duplicate",
  "POST /api/operator/cargas/:cargoId/toggle-status",
  "POST /api/operator/cargas/import",
  "POST /api/operator/cargas/sync-sheet",
  "POST /api/operator/chat/send",
  "POST /api/operator/clientes",
  "POST /api/operator/clientes/:clienteId/rotas",
  "POST /api/operator/leads/revalidate-queued",
  "POST /api/operator/leads/revalidate-queued-aspx",
  "POST /api/operator/loads/:loadId/direct-allocation",
  "POST /api/operator/mass-outreach/enqueue",
  "POST /api/operator/mass-outreach/preview",
  "POST /api/operator/motoristas/cadastrar",
  "POST /api/operator/notifications/clear",
  "POST /api/operator/notifications/seen",
  "POST /api/operator/notifications/test-spot",
  "POST /api/operator/outreach/optout",
  "POST /api/operator/outreach/queue",
  "POST /api/operator/outreach/queue/:id/cancel",
  "POST /api/operator/outreach/queue/:id/send",
  "POST /api/operator/outreach/queue/revalidate",
  "POST /api/operator/outreach/reconcile-registrations",
  "POST /api/operator/outreach/scan",
  "POST /api/operator/outreach/whatsapp/connect",
  "POST /api/operator/outreach/whatsapp/disconnect",
  "POST /api/operator/outreach/whatsapp/test",
  "POST /api/operator/pii-redaction",
  "POST /api/operator/programacao/auto-launch",
  "POST /api/operator/programacao/launch",
  "POST /api/operator/programacao/route-colors",
  "POST /api/operator/repom/whatsapp/connect",
  "POST /api/operator/repom/whatsapp/disconnect",
  "POST /api/operator/routes",
  "POST /api/operator/sheet-monitor/aspx-accept",
  "POST /api/operator/sheet-monitor/aspx-assign",
  "POST /api/operator/sheet-monitor/aspx-assigned",
  "POST /api/operator/sheet-monitor/aspx-preview",
  "POST /api/operator/sheet-monitor/assign-reserva",
  "POST /api/operator/sheet-monitor/conformity-override",
  "POST /api/operator/sheet-monitor/descend",
  "POST /api/operator/sheet-monitor/enrich",
  "POST /api/operator/sheet-monitor/pin",
  "POST /api/operator/sheet-monitor/reassign",
  "POST /api/operator/sheet-monitor/reserva",
  "POST /api/operator/sheet-monitor/rodopar",
  "POST /api/operator/veiculos/revalidate",
  "POST /api/public/cadastro/finalizar",
  "POST /api/webhooks/evolution",
  "PUT /api/drivers/me",
  "PUT /api/operator/cargas-casadas/:pacoteId",
  "PUT /api/operator/cargas-casadas/:pacoteId/cargas/reorder",
  "PUT /api/operator/routes/trecho",
  "PUT /api/operator/settings/auto-approve-angellira",];

/**
 * Rotas ja revisadas que chegam por PRs irmaos do mesmo plano (DC-283) e podem
 * ou nao estar presentes, dependendo da ordem de merge.
 *
 * Existe pra o guard nao virar um problema de ordenacao: sem isto, mergear o
 * #486/#487 deixaria a main vermelha ate alguem editar esta lista, e teste que
 * fica vermelho por motivo burocratico e teste que o time aprende a ignorar.
 *
 * Ambas ja passaram pela decisao que o guard existe pra forcar:
 *  - POST /api/auth/session-event (ALTO-16): exige Bearer token; o ator sai do
 *    TOKEN, nunca do corpo — nao da pra registrar login de terceiro.
 *  - POST /api/csp-report (MED-3): PUBLICA por necessidade (o navegador manda
 *    sem credencial, inclusive na tela de login), contida por teto de 60/min/IP
 *    e por nao registrar PII do relatorio.
 *
 * Ao mergear tudo, mova as duas pra ROTAS_CONHECIDAS e esvazie esta lista.
 */
const ROTAS_DE_PRS_IRMAOS = [
  "POST /api/auth/session-event",
  "POST /api/csp-report",
];

function inventariarRotas() {
  const app = express();
  registerRoutes(app);

  const rotas = [];
  for (const layer of app._router.stack) {
    if (layer.name === "router" && layer.handle?.stack) {
      for (const l of layer.handle.stack) {
        if (l.route) {
          const metodo = Object.keys(l.route.methods)[0].toUpperCase();
          rotas.push(`${metodo} ${l.route.path}`);
        }
      }
    }
  }
  return rotas.sort();
}

describe("inventario de rotas HTTP", () => {
  it("nenhuma rota entra ou sai sem alguem declarar", () => {
    const atuais = inventariarRotas();
    const conhecidas = [...ROTAS_CONHECIDAS].sort();

    const novas = atuais.filter(
      (r) => !conhecidas.includes(r) && !ROTAS_DE_PRS_IRMAOS.includes(r),
    );
    const sumidas = conhecidas.filter((r) => !atuais.includes(r));

    expect(
      { novas, sumidas },
      "A superficie HTTP mudou. Para cada rota NOVA, decida quem pode chama-la " +
        "(operador? motorista? publica?) antes de adicionar aqui. Foi uma rota " +
        "publica despercebida que virou o BOLA do DC-283/CRIT-3.",
    ).toEqual({ novas: [], sumidas: [] });
  });

  it("nao ha rota duplicada — a segunda registrada fica inalcancavel", () => {
    const atuais = inventariarRotas();
    const vistas = new Set();
    const duplicadas = atuais.filter((r) => (vistas.has(r) ? true : (vistas.add(r), false)));

    // Rota repetida e bug silencioso: o Express atende sempre a PRIMEIRA, entao
    // a segunda (que pode ser a que tem o guard de auth) nunca roda.
    expect(duplicadas).toEqual([]);
  });
});
