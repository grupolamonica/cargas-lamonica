import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GLPI_TICKET_STATUS,
  __resetGlpiCircuitForTests,
  addGlpiFollowup,
  addGlpiSolution,
  getGlpiTicket,
  getGlpiTicketSubItems,
  initGlpiSession,
  isGlpiConfigured,
  searchGlpiTicketsByStatus,
  setGlpiTicketStatus,
  uploadGlpiDocument,
} from "./glpi-client.js";

const BASE = "http://glpi.test/apirest.php";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function lastCall() {
  return globalThis.fetch.mock.calls.at(-1);
}

describe("glpi-client", () => {
  beforeEach(() => {
    process.env.GLPI_API_URL = BASE;
    process.env.GLPI_APP_TOKEN = "app-token-abc";
    process.env.GLPI_USER_TOKEN = "user-token-xyz";
    __resetGlpiCircuitForTests();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GLPI_API_URL;
    delete process.env.GLPI_APP_TOKEN;
    delete process.env.GLPI_USER_TOKEN;
  });

  describe("isGlpiConfigured", () => {
    it("exige os DOIS tokens — o GLPI não autentica só com um", () => {
      expect(isGlpiConfigured()).toBe(true);
      delete process.env.GLPI_USER_TOKEN;
      expect(isGlpiConfigured()).toBe(false);
    });
  });

  describe("initGlpiSession", () => {
    it("manda App-Token e user_token e devolve o session token", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ session_token: "sess-1" }));

      await expect(initGlpiSession()).resolves.toBe("sess-1");

      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/initSession`);
      expect(options.headers["App-Token"]).toBe("app-token-abc");
      expect(options.headers.Authorization).toBe("user_token user-token-xyz");
    });

    it("sem credencial não chega a fazer request", async () => {
      delete process.env.GLPI_APP_TOKEN;
      await expect(initGlpiSession()).rejects.toThrow("GLPI_NOT_CONFIGURED");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("401 vira GLPI_UNAUTHORIZED", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR_LOGIN_PARAMETERS_MISSING", "..."], 401));
      await expect(initGlpiSession()).rejects.toThrow("GLPI_UNAUTHORIZED");
    });

    it("token inválido NÃO abre o circuit breaker (não é falha transitória)", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR_WRONG_APP_TOKEN"], 401));
      for (let i = 0; i < 5; i += 1) {
        await expect(initGlpiSession()).rejects.toThrow("GLPI_UNAUTHORIZED");
      }
      // Se o breaker tivesse aberto, a mensagem viraria GLPI_SOURCE_UNAVAILABLE e o
      // erro real (credencial errada) ficaria escondido atrás de "indisponível".
      globalThis.fetch.mockResolvedValue(jsonResponse({ session_token: "sess-ok" }));
      await expect(initGlpiSession()).resolves.toBe("sess-ok");
    });

    it('"API desativada" tem erro próprio — é configuração, não indisponibilidade', async () => {
      // Estado REAL do GLPI da operação em 05/08/2026: HTTP 400 + ["ERROR","API desativada"].
      // Sem este caso, o diagnóstico seria "fonte indisponível" e mandaria olhar rede.
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR", "API desativada"], 400));
      await expect(initGlpiSession()).rejects.toThrow("GLPI_API_DISABLED");
    });

    it("API desativada NÃO abre o circuit breaker", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR", "API desativada"], 400));
      for (let i = 0; i < 5; i += 1) {
        await expect(initGlpiSession()).rejects.toThrow("GLPI_API_DISABLED");
      }
      globalThis.fetch.mockResolvedValue(jsonResponse({ session_token: "sess-ok" }));
      await expect(initGlpiSession()).resolves.toBe("sess-ok");
    });

    it("resposta 200 sem session_token não passa por sucesso", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ algo: "inesperado" }));
      await expect(initGlpiSession()).rejects.toThrow("GLPI_SOURCE_UNAVAILABLE");
    });

    it("timeout de rede vira GLPI_SOURCE_TIMEOUT", async () => {
      globalThis.fetch.mockRejectedValue(new Error("aborted"));
      await expect(initGlpiSession()).rejects.toThrow("GLPI_SOURCE_TIMEOUT");
    });

    it("abre o circuit breaker depois do limiar de falhas de infra", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse("boom", 502));
      for (let i = 0; i < 3; i += 1) {
        await expect(initGlpiSession()).rejects.toThrow("GLPI_SOURCE_UNAVAILABLE");
      }
      globalThis.fetch.mockClear();
      await expect(initGlpiSession()).rejects.toThrow("GLPI_SOURCE_UNAVAILABLE");
      expect(globalThis.fetch).not.toHaveBeenCalled(); // curto-circuito: nem tenta
    });
  });

  describe("getGlpiTicket", () => {
    it("lê o chamado com o Session-Token", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ id: 40, name: "Status errado" }));

      const ticket = await getGlpiTicket("sess-1", 40);

      expect(ticket).toEqual({ id: 40, name: "Status errado" });
      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/Ticket/40`);
      expect(options.headers["Session-Token"]).toBe("sess-1");
    });

    it("chamado inexistente vira GLPI_NOT_FOUND", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR_ITEM_NOT_FOUND"], 404));
      await expect(getGlpiTicket("sess-1", 99999)).rejects.toThrow("GLPI_NOT_FOUND");
    });

    it("corpo de erro com HTTP 200 NÃO passa por sucesso", async () => {
      // O GLPI faz isso: devolve 200 com ["ERROR_...", "mensagem"]. Se tratássemos
      // como sucesso, a automação acharia que respondeu o chamado e não respondeu.
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR_RIGHT_MISSING", "sem permissão"], 200));
      await expect(getGlpiTicket("sess-1", 40)).rejects.toThrow("GLPI_API_ERROR:ERROR_RIGHT_MISSING");
    });
  });

  describe("getGlpiTicketSubItems", () => {
    it("lê os acompanhamentos já registrados no chamado", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse([{ id: 1, content: "olá" }]));

      const itens = await getGlpiTicketSubItems("sess-1", 40, "ITILFollowup");

      expect(itens).toEqual([{ id: 1, content: "olá" }]);
      expect(lastCall()[0]).toBe(`${BASE}/Ticket/40/ITILFollowup`);
    });

    it("chamado sem histórico devolve lista vazia", async () => {
      // O GLPI responde `{}` (não um array) quando não há sub-item nenhum. Devolver
      // isso cru quebraria o `.some()` de quem checa idempotência.
      globalThis.fetch.mockResolvedValue(jsonResponse({}));
      await expect(getGlpiTicketSubItems("sess-1", 40, "ITILSolution")).resolves.toEqual([]);
    });
  });

  describe("addGlpiFollowup", () => {
    it("publica acompanhamento PÚBLICO por padrão — quem abriu o chamado precisa ver", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ id: 101 }));

      await addGlpiFollowup("sess-1", 40, "Corrigido, veja na tela do Monitor.");

      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/ITILFollowup`);
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual({
        input: {
          itemtype: "Ticket",
          items_id: 40,
          content: "Corrigido, veja na tela do Monitor.",
          is_private: 0,
        },
      });
    });

    it("aceita acompanhamento privado quando pedido", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ id: 102 }));
      await addGlpiFollowup("sess-1", 40, "nota interna", { isPrivate: true });
      expect(JSON.parse(lastCall()[1].body).input.is_private).toBe(1);
    });
  });

  describe("addGlpiSolution", () => {
    it("registra a solução no endpoint que já move o chamado para Solucionado", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ id: 55 }));

      await addGlpiSolution("sess-1", 40, "Tradução do status corrigida (PR #452).");

      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/ITILSolution`);
      expect(JSON.parse(options.body).input).toMatchObject({ itemtype: "Ticket", items_id: 40 });
      // Uma chamada só: ITILSolution já muda o status. Um PUT extra duplicaria o
      // registro no histórico do chamado.
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("setGlpiTicketStatus", () => {
    it("faz PUT com o código numérico do GLPI", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse([{ 40: true }]));

      await setGlpiTicketStatus("sess-1", 40, GLPI_TICKET_STATUS.SOLUCIONADO);

      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/Ticket/40`);
      expect(options.method).toBe("PUT");
      expect(JSON.parse(options.body)).toEqual({ input: { id: 40, status: 5 } });
    });
  });

  describe("uploadGlpiDocument", () => {
    it("envia multipart com o manifesto e o arquivo sob o MESMO nome", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ id: 77, upload_result: {} }));

      await uploadGlpiDocument("sess-1", 40, {
        filename: "comprovacao-40.md",
        content: "# prova",
      });

      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/Document`);
      expect(options.body).toBeInstanceOf(FormData);

      const manifest = JSON.parse(options.body.get("uploadManifest"));
      expect(manifest.input.itemtype).toBe("Ticket");
      expect(manifest.input.items_id).toBe(40);
      // O GLPI descarta o conteúdo em silêncio se _filename divergir do nome do
      // arquivo enviado — o anexo aparece vazio no chamado.
      expect(manifest.input._filename).toEqual(["comprovacao-40.md"]);
      expect(options.body.get("filename[0]")).toBeInstanceOf(Blob);

      // Content-Type NÃO pode ser fixado à mão: o boundary é gerado pelo fetch.
      expect(options.headers["Content-Type"]).toBeUndefined();
    });

    it("falha do upload não passa por sucesso", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse(["ERROR_UPLOAD_FILE_TOO_BIG"], 400));
      await expect(
        uploadGlpiDocument("sess-1", 40, { filename: "x.md", content: "y" }),
      ).rejects.toThrow(/GLPI_API_ERROR/);
    });
  });

  describe("searchGlpiTicketsByStatus", () => {
    it("mapeia as colunas numéricas da busca para campos com nome", async () => {
      globalThis.fetch.mockResolvedValue(
        jsonResponse({
          totalcount: 2,
          data: [
            { 2: "40", 1: "Status aguardando descarga", 12: "5", 15: "2026-08-04 09:12:00" },
            { 2: "41", 1: "Portal não abre", 12: "1", 15: "2026-08-05 08:00:00" },
          ],
        }),
      );

      const tickets = await searchGlpiTicketsByStatus("sess-1", [GLPI_TICKET_STATUS.NOVO]);

      expect(tickets).toEqual([
        { id: 40, title: "Status aguardando descarga", status: 5, openedAt: "2026-08-04 09:12:00" },
        { id: 41, title: "Portal não abre", status: 1, openedAt: "2026-08-05 08:00:00" },
      ]);
    });

    it("vários status viram critérios ligados por OR", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ data: [] }));

      await searchGlpiTicketsByStatus("sess-1", [
        GLPI_TICKET_STATUS.NOVO,
        GLPI_TICKET_STATUS.EM_ATENDIMENTO_ATRIBUIDO,
      ]);

      const url = lastCall()[0];
      expect(url).toContain("criteria[0][value]=1");
      expect(url).toContain("criteria[1][link]=OR");
      expect(url).toContain("criteria[1][value]=2");
    });

    it("busca sem resultado devolve lista vazia, não quebra", async () => {
      // O GLPI responde 200 com `data` ausente quando nada casa.
      globalThis.fetch.mockResolvedValue(jsonResponse({ totalcount: 0 }));
      await expect(searchGlpiTicketsByStatus("sess-1", [1])).resolves.toEqual([]);
    });
  });
});
