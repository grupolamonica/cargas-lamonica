import { describe, expect, it, vi } from "vitest";

import { JIRA_ISSUE_TYPE } from "../../infrastructure/jira/jira-client.js";
import { labelDoChamado, syncTicketsToJira } from "./sync-tickets-to-jira.js";

const CHAMADO = {
  id: 40,
  title: "Status aguardando descarga no lugar de carregamento",
  status: 1,
  openedAt: "2026-08-04 09:12:00",
};

function fazDeps(overrides = {}) {
  return {
    initSession: vi.fn().mockResolvedValue("sess-1"),
    killSession: vi.fn().mockResolvedValue(undefined),
    buscarChamados: vi.fn().mockResolvedValue([CHAMADO]),
    buscarIssues: vi.fn().mockResolvedValue([]),
    criarIssue: vi.fn().mockResolvedValue({ key: "DC-400", url: "https://x/browse/DC-400" }),
    ...overrides,
  };
}

describe("syncTicketsToJira", () => {
  it("chamado novo vira Bug no board com título rastreável", async () => {
    const deps = fazDeps();

    const resultado = await syncTicketsToJira({}, deps);

    expect(resultado.criados).toEqual([{ chamadoId: 40, key: "DC-400", url: "https://x/browse/DC-400" }]);
    const [campos] = deps.criarIssue.mock.calls[0];
    expect(campos.summary).toBe("[GLPI #40] Status aguardando descarga no lugar de carregamento");
    expect(campos.issueTypeId).toBe(JIRA_ISSUE_TYPE.BUG);
  });

  it("o card carrega o label do chamado — é o que permite achar de novo", async () => {
    const deps = fazDeps();
    await syncTicketsToJira({}, deps);
    expect(deps.criarIssue.mock.calls[0][0].labels).toEqual(["chamado-glpi", "glpi-40"]);
  });

  it("a descrição leva o link do chamado e a receita para fechá-lo sozinho", async () => {
    const deps = fazDeps();
    await syncTicketsToJira({ glpiWebUrl: "http://10.100.100.6/glpi/" }, deps);

    const { descricao } = deps.criarIssue.mock.calls[0][0];
    expect(descricao).toContain("http://10.100.100.6/glpi/front/ticket.form.php?id=40");
    expect(descricao).toContain("Chamado: GLPI #40");
    expect(descricao).toContain("docs/chamados/40.md");
  });

  describe("deduplicação", () => {
    it("chamado que já tem card não cria outro", async () => {
      const deps = fazDeps({ buscarIssues: vi.fn().mockResolvedValue([{ key: "DC-399", summary: "..." }]) });

      const resultado = await syncTicketsToJira({}, deps);

      expect(resultado).toMatchObject({ criados: [], jaExistiam: 1, examinados: 1 });
      expect(deps.criarIssue).not.toHaveBeenCalled();
    });

    it("procura por LABEL, não por título — card renomeado continua sendo achado", async () => {
      const deps = fazDeps();
      await syncTicketsToJira({}, deps);

      const [jql] = deps.buscarIssues.mock.calls[0];
      expect(jql).toContain(`labels = "${labelDoChamado(40)}"`);
      expect(jql).not.toContain(CHAMADO.title);
    });

    it("a JQL fica escopada ao projeto DC", async () => {
      const deps = fazDeps();
      await syncTicketsToJira({}, deps);
      expect(deps.buscarIssues.mock.calls[0][0]).toContain('project = "DC"');
    });
  });

  it("repassa o limite com o nome que o cliente do GLPI espera", async () => {
    // `limite` em vez de `limit` cairia no default de 50 sem erro nenhum.
    const deps = fazDeps();
    await syncTicketsToJira({ limite: 7 }, deps);
    expect(deps.buscarChamados.mock.calls[0][2]).toMatchObject({ limit: 7 });
  });

  it("só examina chamados EM ABERTO — não recria card de coisa já resolvida", async () => {
    const deps = fazDeps();
    await syncTicketsToJira({}, deps);

    const [, statuses] = deps.buscarChamados.mock.calls[0];
    expect(statuses).toEqual([1, 2, 3, 4]);
    expect(statuses).not.toContain(5); // Solucionado
    expect(statuses).not.toContain(6); // Fechado
  });

  it("vários chamados: cria os que faltam e conta os que já existiam", async () => {
    const deps = fazDeps({
      buscarChamados: vi.fn().mockResolvedValue([
        { ...CHAMADO, id: 40 },
        { ...CHAMADO, id: 41, title: "Portal não abre" },
        { ...CHAMADO, id: 42, title: "Relatório vazio" },
      ]),
      buscarIssues: vi.fn(async (jql) => (jql.includes("glpi-41") ? [{ key: "DC-1" }] : [])),
      criarIssue: vi.fn(async ({ summary }) => ({
        key: `DC-${summary.match(/#(\d+)/)[1]}`,
        url: "https://x",
      })),
    });

    const resultado = await syncTicketsToJira({}, deps);

    expect(resultado.examinados).toBe(3);
    expect(resultado.jaExistiam).toBe(1);
    expect(resultado.criados.map((c) => c.chamadoId)).toEqual([40, 42]);
  });

  it("nenhum chamado em aberto não é erro", async () => {
    const deps = fazDeps({ buscarChamados: vi.fn().mockResolvedValue([]) });
    await expect(syncTicketsToJira({}, deps)).resolves.toEqual({
      criados: [],
      jaExistiam: 0,
      examinados: 0,
    });
  });

  it("sempre derruba a sessão do GLPI, mesmo com erro no meio", async () => {
    const deps = fazDeps({ criarIssue: vi.fn().mockRejectedValue(new Error("JIRA_UNAUTHORIZED")) });

    await expect(syncTicketsToJira({}, deps)).rejects.toThrow("JIRA_UNAUTHORIZED");
    expect(deps.killSession).toHaveBeenCalledWith("sess-1", expect.anything());
  });
});
