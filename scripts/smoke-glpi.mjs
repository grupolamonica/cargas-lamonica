#!/usr/bin/env node
// scripts/smoke-glpi.mjs
//
// Valida a integração com o GLPI contra o servidor REAL. Os testes unitários do
// cliente rodam com fetch mockado — eles provam o CONTRATO que escrevemos, não
// que o GLPI daquela instalação responde assim. Este script fecha essa lacuna.
//
// Uso (a partir da raiz do repositório):
//
//   node scripts/smoke-glpi.mjs            # só leitura: sessão + busca de chamados
//   node scripts/smoke-glpi.mjs --ticket 40   # lê também um chamado específico
//
// SOMENTE LEITURA por definição: não publica acompanhamento, não anexa arquivo e
// não muda status de nada. Rodar isto num GLPI de produção é seguro.
//
// Requer GLPI_APP_TOKEN e GLPI_USER_TOKEN no ambiente (ou no backend/.env).

import {
  GLPI_TICKET_STATUS,
  getGlpiTicket,
  initGlpiSession,
  isGlpiConfigured,
  killGlpiSession,
  searchGlpiTicketsByStatus,
} from "../backend/src/infrastructure/glpi/glpi-client.js";

const NOMES_DE_STATUS = Object.fromEntries(
  Object.entries(GLPI_TICKET_STATUS).map(([nome, codigo]) => [codigo, nome]),
);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  if (!isGlpiConfigured()) {
    console.error("GLPI não configurado: faltam GLPI_APP_TOKEN e/ou GLPI_USER_TOKEN.");
    console.error("Gere em Configurar → Geral → API (app) e no perfil do usuário (user).");
    process.exit(2);
  }

  console.log(`URL: ${process.env.GLPI_API_URL || "http://10.100.100.6/glpi/apirest.php"}`);

  let sessionToken = null;
  try {
    sessionToken = await initGlpiSession({ correlationId: "smoke-glpi" });
    console.log("[ok] sessão aberta");

    const abertos = await searchGlpiTicketsByStatus(
      sessionToken,
      [
        GLPI_TICKET_STATUS.NOVO,
        GLPI_TICKET_STATUS.EM_ATENDIMENTO_ATRIBUIDO,
        GLPI_TICKET_STATUS.EM_ATENDIMENTO_PLANEJADO,
        GLPI_TICKET_STATUS.PENDENTE,
      ],
      { limit: 50, correlationId: "smoke-glpi" },
    );
    console.log(`[ok] busca respondeu: ${abertos.length} chamado(s) em aberto`);
    for (const chamado of abertos) {
      const status = NOMES_DE_STATUS[chamado.status] || chamado.status;
      console.log(`     #${chamado.id}  ${status.padEnd(26)}  ${chamado.openedAt || "?"}  ${chamado.title}`);
    }

    const ticketId = argValue("--ticket");
    if (ticketId) {
      const chamado = await getGlpiTicket(sessionToken, ticketId, { correlationId: "smoke-glpi" });
      console.log(`[ok] chamado #${ticketId} lido`);
      console.log(`     título: ${chamado?.name ?? "(sem título)"}`);
      console.log(`     status: ${NOMES_DE_STATUS[chamado?.status] || chamado?.status}`);
      console.log(`     aberto: ${chamado?.date ?? "?"}`);
    }

    console.log("\nSMOKE OK — o cliente fala com este GLPI.");
  } catch (error) {
    const codigo = error instanceof Error ? error.message : String(error);
    console.error(`\nSMOKE FALHOU: ${codigo}`);
    if (codigo === "GLPI_API_DISABLED") {
      console.error("A API REST do GLPI está DESLIGADA neste servidor (é o padrão de fábrica).");
      console.error("Ligar em: Configurar → Geral → aba API → 'Ativar a API REST' = Sim.");
    }
    if (codigo === "GLPI_UNAUTHORIZED") {
      console.error("Causa provável: token errado, API desabilitada, ou o cliente de API");
      console.error("não permite o IP de origem (Configurar → Geral → API → filtro de IP).");
    }
    if (codigo === "GLPI_SOURCE_TIMEOUT") {
      console.error("Causa provável: sem rota até 10.100.100.6 a partir daqui (rede interna).");
    }
    process.exitCode = 1;
  } finally {
    await killGlpiSession(sessionToken, { correlationId: "smoke-glpi" });
  }
}

main();
