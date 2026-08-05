// backend/src/infrastructure/jira/jira-client.js
//
// Cliente da API REST v3 do Jira Cloud (https://gestaolamonica.atlassian.net).
//
// POR QUE EXISTE: a convenção do projeto manda todo chamado atendido virar card no
// board DC. Até aqui isso dependia de alguém criar o card à mão. O worker de
// chamados (scripts/glpi-worker.mjs) usa este cliente para abrir o card sozinho.
//
// AUTENTICAÇÃO: Basic com e-mail + API token pessoal (gerado em
// id.atlassian.com → Segurança → Criar token de API). Vive no `.env`, como as
// demais credenciais de integração. Não existe token de "aplicação" no Jira Cloud
// para este caso — o card é criado em nome de uma pessoa, e é isso que aparece
// como relator no board.
//
// FORMATO DO CORPO: a v3 exige ADF (Atlassian Document Format) na descrição — um
// JSON de nós, não texto. Mandar string crua faz a API responder 400.

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BASE_URL = "https://gestaolamonica.atlassian.net";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PROJECT_KEY = "DC";

/** IDs verificados no projeto DC (getJiraProjectIssueTypesMetadata, 05/08/2026). */
export const JIRA_ISSUE_TYPE = {
  EPIC: "10041",
  TAREFA: "10043",
  HISTORIA: "10044",
  BUG: "10047",
};

function getBaseUrl() {
  const raw = process.env.JIRA_BASE_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getTimeoutMs() {
  const raw = Number.parseInt(process.env.JIRA_TIMEOUT_MS?.trim() ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function getJiraProjectKey() {
  return process.env.JIRA_PROJECT_KEY?.trim() || DEFAULT_PROJECT_KEY;
}

/** Credenciais presentes? Usado para degradar sem quebrar o ciclo do worker. */
export function isJiraConfigured() {
  return Boolean(process.env.JIRA_EMAIL?.trim() && process.env.JIRA_API_TOKEN?.trim());
}

function authHeader() {
  const email = process.env.JIRA_EMAIL?.trim();
  const token = process.env.JIRA_API_TOKEN?.trim();
  if (!email || !token) throw new Error("JIRA_NOT_CONFIGURED");
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function jiraRequest(path, { method = "GET", body, correlationId } = {}) {
  const headers = { Authorization: authHeader(), Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetchWithTimeout(`${getBaseUrl()}/rest/api/3${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (networkError) {
    throw new Error("JIRA_SOURCE_TIMEOUT", { cause: networkError });
  }

  const texto = await response.text().catch(() => "");
  let parsed = null;
  if (texto) {
    try {
      parsed = JSON.parse(texto);
    } catch {
      parsed = texto;
    }
  }

  if (response.status === 401 || response.status === 403) {
    logStructuredEvent("error", "jira.request.unauthorized", {
      correlationId: correlationId || null,
      path,
      httpStatus: response.status,
    });
    throw new Error("JIRA_UNAUTHORIZED");
  }
  if (!response.ok) {
    // A mensagem útil do Jira vem em errorMessages/errors — sem ela o diagnóstico
    // vira "400" e some o motivo real (campo obrigatório, tipo inválido, etc).
    const detalhe =
      parsed?.errorMessages?.join("; ") ||
      (parsed?.errors ? JSON.stringify(parsed.errors) : "") ||
      String(response.status);
    logStructuredEvent("error", "jira.request.http_error", {
      correlationId: correlationId || null,
      path,
      httpStatus: response.status,
      detalhe,
    });
    throw new Error(`JIRA_API_ERROR:${detalhe}`);
  }

  return parsed;
}

/**
 * Converte texto simples em ADF. Cobre só parágrafo — é o que a descrição gerada
 * a partir de um chamado precisa, e ADF rejeita nó vazio.
 */
export function textoParaAdf(texto) {
  const paragrafos = String(texto ?? "")
    .split(/\n\s*\n/)
    .map((bloco) => bloco.trim())
    .filter(Boolean);

  return {
    type: "doc",
    version: 1,
    content:
      paragrafos.length > 0
        ? paragrafos.map((bloco) => ({
            type: "paragraph",
            content: [{ type: "text", text: bloco }],
          }))
        : [{ type: "paragraph", content: [] }],
  };
}

/**
 * Busca issues por JQL. Usado para deduplicar antes de criar card.
 * @returns {Promise<Array<{ key: string, summary: string }>>}
 */
export async function searchJiraIssues(jql, { maxResults = 10, correlationId } = {}) {
  const resultado = await jiraRequest("/search/jql", {
    method: "POST",
    correlationId,
    body: { jql, maxResults, fields: ["summary"] },
  });
  const issues = Array.isArray(resultado?.issues) ? resultado.issues : [];
  return issues.map((issue) => ({ key: issue.key, summary: issue.fields?.summary ?? "" }));
}

/**
 * Cria uma issue.
 * @returns {Promise<{ key: string, url: string }>}
 */
export async function createJiraIssue(
  { summary, descricao, issueTypeId = JIRA_ISSUE_TYPE.BUG, labels = [], parentKey },
  { correlationId } = {},
) {
  const fields = {
    project: { key: getJiraProjectKey() },
    issuetype: { id: String(issueTypeId) },
    summary: String(summary),
    description: textoParaAdf(descricao),
  };
  if (labels.length > 0) fields.labels = labels;
  if (parentKey) fields.parent = { key: parentKey };

  const criada = await jiraRequest("/issue", { method: "POST", correlationId, body: { fields } });
  return { key: criada.key, url: `${getBaseUrl()}/browse/${criada.key}` };
}
