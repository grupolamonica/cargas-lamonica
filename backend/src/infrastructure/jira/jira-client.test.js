import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  JIRA_ISSUE_TYPE,
  createJiraIssue,
  isJiraConfigured,
  searchJiraIssues,
  textoParaAdf,
} from "./jira-client.js";

const BASE = "https://exemplo.atlassian.net";

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

describe("jira-client", () => {
  beforeEach(() => {
    process.env.JIRA_BASE_URL = BASE;
    process.env.JIRA_EMAIL = "tecnico@exemplo.com";
    process.env.JIRA_API_TOKEN = "token-123";
    process.env.JIRA_PROJECT_KEY = "DC";
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"]) {
      delete process.env[k];
    }
  });

  describe("isJiraConfigured", () => {
    it("exige e-mail e token", () => {
      expect(isJiraConfigured()).toBe(true);
      delete process.env.JIRA_API_TOKEN;
      expect(isJiraConfigured()).toBe(false);
    });
  });

  describe("textoParaAdf", () => {
    it("cada bloco separado por linha em branco vira um parágrafo", () => {
      expect(textoParaAdf("um\n\ndois")).toEqual({
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "um" }] },
          { type: "paragraph", content: [{ type: "text", text: "dois" }] },
        ],
      });
    });

    it("texto vazio gera um parágrafo vazio — ADF rejeita conteúdo nulo", () => {
      expect(textoParaAdf("")).toEqual({
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [] }],
      });
    });
  });

  describe("createJiraIssue", () => {
    it("cria com projeto, tipo e descrição em ADF", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ key: "DC-400" }, 201));

      const criada = await createJiraIssue({
        summary: "[GLPI #40] status errado",
        descricao: "texto do chamado",
        issueTypeId: JIRA_ISSUE_TYPE.BUG,
        labels: ["chamado-glpi", "glpi-40"],
      });

      expect(criada).toEqual({ key: "DC-400", url: `${BASE}/browse/DC-400` });

      const [url, options] = lastCall();
      expect(url).toBe(`${BASE}/rest/api/3/issue`);
      const { fields } = JSON.parse(options.body);
      expect(fields.project).toEqual({ key: "DC" });
      expect(fields.issuetype).toEqual({ id: "10047" });
      expect(fields.labels).toEqual(["chamado-glpi", "glpi-40"]);
      // v3 exige ADF: string crua faz a API responder 400.
      expect(fields.description.type).toBe("doc");
    });

    it("autentica com Basic de e-mail:token", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ key: "DC-1" }, 201));
      await createJiraIssue({ summary: "x", descricao: "y" });

      const esperado = Buffer.from("tecnico@exemplo.com:token-123").toString("base64");
      expect(lastCall()[1].headers.Authorization).toBe(`Basic ${esperado}`);
    });

    it("sem credencial não faz request", async () => {
      delete process.env.JIRA_EMAIL;
      await expect(createJiraIssue({ summary: "x", descricao: "y" })).rejects.toThrow(
        "JIRA_NOT_CONFIGURED",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("sem labels não manda o campo — Jira rejeita array vazio em alguns schemas", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({ key: "DC-1" }, 201));
      await createJiraIssue({ summary: "x", descricao: "y" });
      expect(JSON.parse(lastCall()[1].body).fields).not.toHaveProperty("labels");
    });

    it("erro do Jira preserva o motivo real, não só o código HTTP", async () => {
      // Sem isto o diagnóstico vira "400" e some o campo que causou a recusa.
      globalThis.fetch.mockResolvedValue(
        jsonResponse({ errorMessages: [], errors: { summary: "Summary is required" } }, 400),
      );
      await expect(createJiraIssue({ summary: "", descricao: "y" })).rejects.toThrow(
        /Summary is required/,
      );
    });

    it("401 vira JIRA_UNAUTHORIZED", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse("", 401));
      await expect(createJiraIssue({ summary: "x", descricao: "y" })).rejects.toThrow(
        "JIRA_UNAUTHORIZED",
      );
    });
  });

  describe("searchJiraIssues", () => {
    it("busca por JQL e devolve chave + título", async () => {
      globalThis.fetch.mockResolvedValue(
        jsonResponse({ issues: [{ key: "DC-399", fields: { summary: "[GLPI #40] x" } }] }),
      );

      const issues = await searchJiraIssues('project = "DC" AND labels = "glpi-40"');

      expect(issues).toEqual([{ key: "DC-399", summary: "[GLPI #40] x" }]);
      expect(lastCall()[0]).toBe(`${BASE}/rest/api/3/search/jql`);
      expect(JSON.parse(lastCall()[1].body).jql).toContain('labels = "glpi-40"');
    });

    it("nenhum resultado devolve lista vazia", async () => {
      globalThis.fetch.mockResolvedValue(jsonResponse({}));
      await expect(searchJiraIssues("project = DC")).resolves.toEqual([]);
    });
  });
});
