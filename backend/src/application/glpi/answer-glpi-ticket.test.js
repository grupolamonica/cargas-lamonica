import { describe, expect, it, vi } from "vitest";

import { GLPI_TICKET_STATUS } from "../../infrastructure/glpi/glpi-client.js";
import { answerGlpiTicket, marcadorDaAutomacao } from "./answer-glpi-ticket.js";

const PROVA = { filename: "chamado-40-comprovacao.md", content: "# antes x depois\n12 → 0" };
const RESPOSTA = "A tradução do status foi corrigida. Confira no Monitor.";

/** Dublês com o caminho feliz; cada teste sobrescreve só o que lhe interessa. */
function fazDeps(overrides = {}) {
  return {
    initSession: vi.fn().mockResolvedValue("sess-1"),
    killSession: vi.fn().mockResolvedValue(undefined),
    lerChamado: vi.fn().mockResolvedValue({ id: 40, status: GLPI_TICKET_STATUS.EM_ATENDIMENTO_ATRIBUIDO }),
    lerSubItens: vi.fn().mockResolvedValue([]),
    anexar: vi.fn().mockResolvedValue({ id: 900 }),
    registrarSolucao: vi.fn().mockResolvedValue({ id: 901 }),
    ...overrides,
  };
}

describe("answerGlpiTicket", () => {
  describe("caminho feliz", () => {
    it("anexa a prova e registra a solução com a marca da automação", async () => {
      const deps = fazDeps();

      const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);

      expect(resultado).toEqual({ acao: "respondido", ticketId: 40 });
      expect(deps.anexar).toHaveBeenCalledOnce();
      expect(deps.registrarSolucao).toHaveBeenCalledOnce();

      const [, , conteudo] = deps.registrarSolucao.mock.calls[0];
      expect(conteudo).toContain(RESPOSTA);
      expect(conteudo).toContain(marcadorDaAutomacao(40));
    });

    it("a marca é comentário HTML — invisível para quem lê o chamado", () => {
      expect(marcadorDaAutomacao(40)).toBe("<!-- lmc-auto:chamado-40 -->");
    });

    it("sempre derruba a sessão, inclusive quando dá erro no meio", async () => {
      const deps = fazDeps({ anexar: vi.fn().mockRejectedValue(new Error("GLPI_API_ERROR:400")) });

      await expect(
        answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps),
      ).rejects.toThrow("GLPI_API_ERROR:400");

      expect(deps.killSession).toHaveBeenCalledWith("sess-1", expect.anything());
    });
  });

  describe("trava 1 — sem prova não responde", () => {
    it.each([
      ["prova ausente", undefined],
      ["conteúdo vazio", { filename: "x.md", content: "" }],
      ["conteúdo só espaço", { filename: "x.md", content: "   \n " }],
      ["sem nome de arquivo", { filename: "", content: "algo" }],
    ])("%s → CHAMADO_SEM_PROVA, e nem abre sessão", async (_caso, prova) => {
      const deps = fazDeps();

      await expect(
        answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova }, deps),
      ).rejects.toThrow("CHAMADO_SEM_PROVA");

      // Falha ANTES de qualquer efeito colateral: no modo automático, "resolvido"
      // sem comprovação é exatamente o erro que não pode chegar ao operador.
      expect(deps.initSession).not.toHaveBeenCalled();
      expect(deps.registrarSolucao).not.toHaveBeenCalled();
    });

    it("resposta vazia também barra", async () => {
      const deps = fazDeps();
      await expect(
        answerGlpiTicket({ ticketId: 40, resposta: "  ", prova: PROVA }, deps),
      ).rejects.toThrow("CHAMADO_SEM_RESPOSTA");
      expect(deps.initSession).not.toHaveBeenCalled();
    });

    it("id inválido barra antes de tudo", async () => {
      const deps = fazDeps();
      await expect(
        answerGlpiTicket({ ticketId: "abc", resposta: RESPOSTA, prova: PROVA }, deps),
      ).rejects.toThrow("CHAMADO_ID_INVALIDO");
      expect(deps.initSession).not.toHaveBeenCalled();
    });
  });

  describe("trava 2 — anexo antes da solução", () => {
    it("upload falhou → não publica solução nenhuma", async () => {
      const deps = fazDeps({ anexar: vi.fn().mockRejectedValue(new Error("GLPI_SOURCE_TIMEOUT")) });

      await expect(
        answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps),
      ).rejects.toThrow("GLPI_SOURCE_TIMEOUT");

      // Sem isto, o chamado receberia "resolvido, veja o anexo" sem anexo algum.
      expect(deps.registrarSolucao).not.toHaveBeenCalled();
    });

    it("a ordem é anexar e só então solucionar", async () => {
      const ordem = [];
      const deps = fazDeps({
        anexar: vi.fn(async () => { ordem.push("anexar"); return { id: 1 }; }),
        registrarSolucao: vi.fn(async () => { ordem.push("solucionar"); return { id: 2 }; }),
      });

      await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);

      expect(ordem).toEqual(["anexar", "solucionar"]);
    });
  });

  describe("trava 3 — não toca no que já foi concluído", () => {
    it.each([
      ["solucionado", GLPI_TICKET_STATUS.SOLUCIONADO],
      ["fechado", GLPI_TICKET_STATUS.FECHADO],
    ])("chamado %s é ignorado sem escrever nada", async (_nome, status) => {
      const deps = fazDeps({ lerChamado: vi.fn().mockResolvedValue({ id: 40, status }) });

      const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);

      expect(resultado).toEqual({ acao: "ignorado", motivo: "ja_fechado", ticketId: 40 });
      expect(deps.anexar).not.toHaveBeenCalled();
      expect(deps.registrarSolucao).not.toHaveBeenCalled();
    });

    it("chamado em aberto (novo/atendimento/pendente) segue normalmente", async () => {
      for (const status of [
        GLPI_TICKET_STATUS.NOVO,
        GLPI_TICKET_STATUS.EM_ATENDIMENTO_ATRIBUIDO,
        GLPI_TICKET_STATUS.EM_ATENDIMENTO_PLANEJADO,
        GLPI_TICKET_STATUS.PENDENTE,
      ]) {
        const deps = fazDeps({ lerChamado: vi.fn().mockResolvedValue({ id: 40, status }) });
        const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);
        expect(resultado.acao, `status ${status}`).toBe("respondido");
      }
    });
  });

  describe("trava 4 — idempotência", () => {
    it("já respondido antes → ignora, sem duplicar notificação para quem abriu", async () => {
      const deps = fazDeps({
        lerSubItens: vi.fn(async (_s, _id, itemtype) =>
          itemtype === "ITILSolution"
            ? [{ content: `Já resolvemos.\n${marcadorDaAutomacao(40)}` }]
            : [],
        ),
      });

      const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);

      expect(resultado).toEqual({ acao: "ignorado", motivo: "ja_respondido", ticketId: 40 });
      expect(deps.anexar).not.toHaveBeenCalled();
    });

    it("acha a marca também quando ficou como ACOMPANHAMENTO", async () => {
      const deps = fazDeps({
        lerSubItens: vi.fn(async (_s, _id, itemtype) =>
          itemtype === "ITILFollowup" ? [{ content: marcadorDaAutomacao(40) }] : [],
        ),
      });
      const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);
      expect(resultado.motivo).toBe("ja_respondido");
    });

    it("marca de OUTRO chamado não conta como respondido", async () => {
      // Sem o id na marca, um histórico copiado entre chamados silenciaria a
      // resposta do chamado certo.
      const deps = fazDeps({
        lerSubItens: vi.fn().mockResolvedValue([{ content: marcadorDaAutomacao(41) }]),
      });
      const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);
      expect(resultado.acao).toBe("respondido");
    });

    it("histórico humano sem a nossa marca não bloqueia a resposta", async () => {
      const deps = fazDeps({
        lerSubItens: vi.fn().mockResolvedValue([
          { content: "Bom dia, alguém pode olhar?" },
          { content: "Estamos verificando." },
        ]),
      });
      const resultado = await answerGlpiTicket({ ticketId: 40, resposta: RESPOSTA, prova: PROVA }, deps);
      expect(resultado.acao).toBe("respondido");
    });
  });
});
