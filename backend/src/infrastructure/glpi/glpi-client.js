// backend/src/infrastructure/glpi/glpi-client.js
//
// Cliente HTTP para a API REST do GLPI (`/apirest.php`) — o sistema de chamados
// da operação (http://10.100.100.6/glpi).
//
// POR QUE EXISTE: até aqui, responder um chamado exigia sessão de navegador com
// login manual. A automação de fechamento de chamado (DC) precisa ler, comentar,
// anexar prova e marcar como solucionado sem depender de ninguém estar logado.
//
// AUTENTICAÇÃO (dois tokens, é assim que o GLPI funciona):
//   - `App-Token`  — identifica a APLICAÇÃO cliente. Gerado em
//                    Configurar → Geral → API → "Adicionar cliente de API".
//   - `user_token` — identifica o USUÁRIO em nome de quem agimos. Gerado no
//                    perfil do usuário ("Chave de API remota").
// Ambos vivem no `.env` do servidor, no mesmo padrão de TORRE_API_KEY e das
// credenciais Angellira. NUNCA usar login/senha aqui: o GLPI aceita Basic auth
// no initSession, mas isso colocaria senha de AD em variável de ambiente.
//
// SESSÃO: initSession devolve um `Session-Token` de vida curta que precisa ir em
// todas as chamadas seguintes. Reaproveitamos a sessão entre chamadas (o GLPI
// tem limite de sessões concorrentes) e derrubamos com killSession no fim de
// cada operação composta.

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BASE_URL = "http://10.100.100.6/glpi/apirest.php";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 120;

/**
 * Status de chamado do GLPI (tabela `glpi_tickets.status`).
 * Os números são do produto — não inventar nem reordenar.
 */
export const GLPI_TICKET_STATUS = {
  NOVO: 1,
  EM_ATENDIMENTO_ATRIBUIDO: 2,
  EM_ATENDIMENTO_PLANEJADO: 3,
  PENDENTE: 4,
  SOLUCIONADO: 5,
  FECHADO: 6,
};

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallbackValue;
  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getBaseUrl() {
  const raw = process.env.GLPI_API_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("GLPI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function getFailureThreshold() {
  return parsePositiveIntegerEnv("GLPI_CIRCUIT_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}

function getCooldownMs() {
  return parsePositiveIntegerEnv("GLPI_CIRCUIT_BREAKER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS) * 1000;
}

/** Credenciais configuradas? Usado pelos callers para degradar sem quebrar. */
export function isGlpiConfigured() {
  return Boolean(process.env.GLPI_APP_TOKEN?.trim() && process.env.GLPI_USER_TOKEN?.trim());
}

const circuitState = { failures: 0, openUntil: 0 };

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function markSourceFailure() {
  circuitState.failures += 1;
  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }
}

function markSourceSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

/** Só para teste — o circuit breaker é módulo-global e vaza entre casos. */
export function __resetGlpiCircuitForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || getTimeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * O GLPI devolve erro como array `["ERROR_CODE", "mensagem legível"]` — inclusive
 * com HTTP 200 em alguns caminhos. Extraímos o código para as mensagens de log.
 */
function extractGlpiErrorCode(body) {
  if (Array.isArray(body) && typeof body[0] === "string") return body[0];
  if (body && typeof body === "object" && typeof body.error === "string") return body.error;
  return null;
}

function isGlpiErrorBody(body) {
  return extractGlpiErrorCode(body) !== null;
}

/**
 * "API desativada" é o estado de fábrica do GLPI: a REST API existe mas vem
 * DESLIGADA (Configurar → Geral → API → "Ativar a API REST"). O servidor
 * responde HTTP 400 com `["ERROR","API desativada"]` — sem este reconhecimento
 * cairia em GLPI_SOURCE_UNAVAILABLE, que manda investigar rede/carga quando na
 * verdade falta um clique numa tela de configuração.
 */
function isApiDisabledBody(body) {
  const mensagem = Array.isArray(body) ? String(body[1] ?? "") : "";
  return /api\s+(desativada|disabled)/i.test(mensagem);
}

/**
 * Abre sessão no GLPI.
 * @returns {Promise<string>} session token
 * @throws Error("GLPI_NOT_CONFIGURED" | "GLPI_UNAUTHORIZED" | "GLPI_SOURCE_TIMEOUT" | "GLPI_SOURCE_UNAVAILABLE")
 */
export async function initGlpiSession({ correlationId } = {}) {
  const appToken = process.env.GLPI_APP_TOKEN?.trim();
  const userToken = process.env.GLPI_USER_TOKEN?.trim();
  if (!appToken || !userToken) throw new Error("GLPI_NOT_CONFIGURED");

  if (isCircuitOpen()) {
    logStructuredEvent("warn", "glpi.init_session.circuit_open", { correlationId: correlationId || null });
    throw new Error("GLPI_SOURCE_UNAVAILABLE");
  }

  let response;
  try {
    response = await fetchWithTimeout(`${getBaseUrl()}/initSession`, {
      method: "GET",
      headers: {
        "App-Token": appToken,
        Authorization: `user_token ${userToken}`,
        Accept: "application/json",
      },
    });
  } catch (networkError) {
    markSourceFailure();
    logStructuredEvent("warn", "glpi.init_session.network_error", {
      correlationId: correlationId || null,
      message: networkError instanceof Error ? networkError.message : String(networkError),
    });
    throw new Error("GLPI_SOURCE_TIMEOUT", { cause: networkError });
  }

  const body = await readBody(response);

  if (isApiDisabledBody(body)) {
    // Não conta para o breaker: é configuração, não falha transitória. Continuar
    // tentando não piora nada e o erro fica legível no log até alguém ligar a API.
    logStructuredEvent("error", "glpi.init_session.api_disabled", { correlationId: correlationId || null });
    throw new Error("GLPI_API_DISABLED");
  }

  if (response.status === 401 || response.status === 403) {
    // Token errado não é falha transitória — não conta para o breaker, senão um
    // token inválido cria janela de indisponibilidade que some sozinha e volta.
    logStructuredEvent("error", "glpi.init_session.unauthorized", {
      correlationId: correlationId || null,
      httpStatus: response.status,
      glpiError: extractGlpiErrorCode(body),
    });
    throw new Error("GLPI_UNAUTHORIZED");
  }

  if (response.status >= 500) {
    markSourceFailure();
    throw new Error("GLPI_SOURCE_UNAVAILABLE");
  }

  const sessionToken = body && typeof body === "object" ? body.session_token : null;
  if (!sessionToken) {
    markSourceFailure();
    logStructuredEvent("error", "glpi.init_session.no_token", {
      correlationId: correlationId || null,
      httpStatus: response.status,
      glpiError: extractGlpiErrorCode(body),
    });
    throw new Error("GLPI_SOURCE_UNAVAILABLE");
  }

  markSourceSuccess();
  return sessionToken;
}

/** Derruba a sessão. Falha aqui é irrelevante — nunca propaga. */
export async function killGlpiSession(sessionToken, { correlationId } = {}) {
  if (!sessionToken) return;
  try {
    await fetchWithTimeout(`${getBaseUrl()}/killSession`, {
      method: "GET",
      headers: {
        "App-Token": process.env.GLPI_APP_TOKEN?.trim() || "",
        "Session-Token": sessionToken,
      },
    });
  } catch (error) {
    logStructuredEvent("warn", "glpi.kill_session.failed", {
      correlationId: correlationId || null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Chamada autenticada genérica. Todas as operações abaixo passam por aqui.
 * @throws Error("GLPI_NOT_FOUND" | "GLPI_UNAUTHORIZED" | "GLPI_SOURCE_TIMEOUT" | "GLPI_SOURCE_UNAVAILABLE" | "GLPI_API_ERROR:<status>")
 */
async function glpiRequest(sessionToken, path, { method = "GET", body, correlationId } = {}) {
  const headers = {
    "App-Token": process.env.GLPI_APP_TOKEN?.trim() || "",
    "Session-Token": sessionToken,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetchWithTimeout(`${getBaseUrl()}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (networkError) {
    markSourceFailure();
    throw new Error("GLPI_SOURCE_TIMEOUT", { cause: networkError });
  }

  const parsed = await readBody(response);

  if (response.status === 404) throw new Error("GLPI_NOT_FOUND");
  if (response.status === 401 || response.status === 403) {
    logStructuredEvent("error", "glpi.request.unauthorized", {
      correlationId: correlationId || null,
      path,
      httpStatus: response.status,
      glpiError: extractGlpiErrorCode(parsed),
    });
    throw new Error("GLPI_UNAUTHORIZED");
  }
  if (response.status >= 500) {
    markSourceFailure();
    throw new Error("GLPI_SOURCE_UNAVAILABLE");
  }
  if (!response.ok) {
    logStructuredEvent("error", "glpi.request.http_error", {
      correlationId: correlationId || null,
      path,
      httpStatus: response.status,
      glpiError: extractGlpiErrorCode(parsed),
    });
    throw new Error(`GLPI_API_ERROR:${response.status}`);
  }
  // 200 com corpo de erro acontece no GLPI — tratar como falha, não como sucesso.
  if (isGlpiErrorBody(parsed)) {
    logStructuredEvent("error", "glpi.request.error_body", {
      correlationId: correlationId || null,
      path,
      glpiError: extractGlpiErrorCode(parsed),
    });
    throw new Error(`GLPI_API_ERROR:${extractGlpiErrorCode(parsed)}`);
  }

  markSourceSuccess();
  return parsed;
}

/** Lê um chamado. @returns {Promise<object>} */
export async function getGlpiTicket(sessionToken, ticketId, { correlationId } = {}) {
  return glpiRequest(sessionToken, `/Ticket/${Number(ticketId)}`, { correlationId });
}

/**
 * Publica um acompanhamento (comentário visível para quem abriu o chamado).
 * `isPrivate` true = só o time de TI vê. O padrão é PÚBLICO — a resposta ao
 * operador é o ponto de todo o fluxo.
 */
export async function addGlpiFollowup(
  sessionToken,
  ticketId,
  content,
  { isPrivate = false, correlationId } = {},
) {
  return glpiRequest(sessionToken, "/ITILFollowup", {
    method: "POST",
    correlationId,
    body: {
      input: {
        itemtype: "Ticket",
        items_id: Number(ticketId),
        content,
        is_private: isPrivate ? 1 : 0,
      },
    },
  });
}

/**
 * Registra a SOLUÇÃO do chamado. No GLPI isso já move o status para
 * "Solucionado" (5) automaticamente — não é preciso um PUT de status junto, e
 * fazer os dois cria acompanhamento duplicado no histórico.
 */
export async function addGlpiSolution(sessionToken, ticketId, content, { correlationId } = {}) {
  return glpiRequest(sessionToken, "/ITILSolution", {
    method: "POST",
    correlationId,
    body: {
      input: {
        itemtype: "Ticket",
        items_id: Number(ticketId),
        content,
      },
    },
  });
}

/** Muda o status do chamado. Ver GLPI_TICKET_STATUS. */
export async function setGlpiTicketStatus(sessionToken, ticketId, status, { correlationId } = {}) {
  return glpiRequest(sessionToken, `/Ticket/${Number(ticketId)}`, {
    method: "PUT",
    correlationId,
    body: { input: { id: Number(ticketId), status: Number(status) } },
  });
}

/**
 * Anexa um arquivo ao chamado (a "prova de que resolveu").
 *
 * O upload do GLPI é multipart com formato próprio: um campo `uploadManifest`
 * com o JSON do documento e o arquivo em `filename[0]`. O nome declarado no
 * manifesto (`_filename`) TEM de bater com o nome enviado na parte do arquivo,
 * senão o GLPI aceita a requisição e descarta o conteúdo.
 */
export async function uploadGlpiDocument(
  sessionToken,
  ticketId,
  { filename, content, contentType = "text/markdown", name },
  { correlationId } = {},
) {
  const appToken = process.env.GLPI_APP_TOKEN?.trim() || "";
  const manifest = {
    input: {
      name: name || filename,
      _filename: [filename],
      itemtype: "Ticket",
      items_id: Number(ticketId),
    },
  };

  const form = new FormData();
  form.append("uploadManifest", JSON.stringify(manifest));
  form.append("filename[0]", new Blob([content], { type: contentType }), filename);

  let response;
  try {
    response = await fetchWithTimeout(`${getBaseUrl()}/Document`, {
      method: "POST",
      headers: {
        "App-Token": appToken,
        "Session-Token": sessionToken,
        Accept: "application/json",
        // Content-Type é omitido de propósito: o fetch precisa gerar o boundary.
      },
      body: form,
    });
  } catch (networkError) {
    markSourceFailure();
    throw new Error("GLPI_SOURCE_TIMEOUT", { cause: networkError });
  }

  const parsed = await readBody(response);
  if (!response.ok || isGlpiErrorBody(parsed)) {
    logStructuredEvent("error", "glpi.upload_document.failed", {
      correlationId: correlationId || null,
      ticketId: Number(ticketId),
      httpStatus: response.status,
      glpiError: extractGlpiErrorCode(parsed),
    });
    throw new Error(`GLPI_API_ERROR:${response.status}`);
  }

  markSourceSuccess();
  return parsed;
}

/**
 * Busca chamados por status usando a API de busca do GLPI.
 * Campo 12 = status (uid `Ticket.status`), campo 15 = data de abertura.
 *
 * @param {number[]} statuses códigos de GLPI_TICKET_STATUS
 * @returns {Promise<Array<{ id: number, title: string, status: number, openedAt: string | null }>>}
 */
export async function searchGlpiTicketsByStatus(sessionToken, statuses, { limit = 50, correlationId } = {}) {
  const criteria = statuses.map((status, index) => {
    const prefix = `criteria[${index}]`;
    const link = index === 0 ? "" : `&${prefix}[link]=OR`;
    return `${link}&${prefix}[field]=12&${prefix}[searchtype]=equals&${prefix}[value]=${Number(status)}`;
  });

  const query =
    `/search/Ticket?forcedisplay[0]=2&forcedisplay[1]=1&forcedisplay[2]=12&forcedisplay[3]=15` +
    `&range=0-${Math.max(0, Number(limit) - 1)}${criteria.join("")}`;

  const result = await glpiRequest(sessionToken, query, { correlationId });
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.map((row) => ({
    id: Number(row["2"]),
    title: String(row["1"] ?? ""),
    status: Number(row["12"]),
    openedAt: row["15"] ? String(row["15"]) : null,
  }));
}
