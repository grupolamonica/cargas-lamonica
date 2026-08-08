import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { getRequestIp } from "./http-utils.js";

/**
 * POST /api/csp-report — coletor de violações de CSP (DC-283 / MED-3).
 *
 * A CSP sobe em modo relatório: ela não bloqueia nada, só avisa aqui o que
 * BLOQUEARIA se estivesse valendo. Sem este coletor o modo relatório não serve
 * pra nada — a violação morreria no console do navegador de um usuário que
 * nunca vai abrir o DevTools.
 *
 * Deliberadamente SEM autenticação: o navegador manda o relatório sozinho, sem
 * credencial, inclusive na tela de login. Exigir sessão cegaria justamente as
 * páginas públicas (portal do motorista, wizard de cadastro).
 *
 * Sendo público, precisa de contenção — daí o teto por IP e o recorte do que se
 * registra. NÃO gera evento de auditoria: violação de CSP é sinal operacional
 * de rollout, não fato de segurança sobre um titular; poluir a trilha com isso
 * atrapalharia quem for investigar de verdade.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
// Teto folgado: uma página com problema real dispara várias violações por
// carregamento, e a intenção do modo relatório é justamente enxergar o volume.
const RATE_LIMIT_MAX = 60;
const MAX_FIELD_LENGTH = 300;

const rateLimitByIp = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitByIp) {
    if (entry.resetAt <= now) rateLimitByIp.delete(key);
  }
}, 60_000).unref();

export function resetCspReportRateLimitForTests() {
  rateLimitByIp.clear();
}

function isRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const entry = rateLimitByIp.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitByIp.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function truncate(value) {
  if (typeof value !== "string") return null;
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}...` : value;
}

/**
 * Extrai só o que serve pra ajustar a política. O relatório do navegador traz
 * `script-sample` e a URL completa da página — que numa SPA pode carregar id de
 * recurso e, em tela pública, o CPF do fluxo. Nada disso entra no log.
 */
export function summarizeCspReport(body) {
  const report = body?.["csp-report"] || body || {};
  let documentPath = null;

  try {
    // Só o caminho, sem query string: a URL inteira pode carregar identificador.
    documentPath = report["document-uri"] ? new URL(report["document-uri"]).pathname : null;
  } catch {
    documentPath = null;
  }

  return {
    diretiva: truncate(report["effective-directive"] || report["violated-directive"]),
    bloqueado: truncate(report["blocked-uri"]),
    documento: truncate(documentPath),
    disposicao: truncate(report.disposition),
  };
}

export async function resolveCspReportResponse(request) {
  const requestIp = getRequestIp(request);

  // 204 mesmo quando limitado: o navegador não faz nada útil com erro aqui, e
  // devolver 429 só geraria ruído de rede no cliente.
  if (isRateLimited(requestIp)) {
    return { statusCode: 204 };
  }

  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }

  const resumo = summarizeCspReport(body);

  // Sem diretiva identificável não é relatório de CSP — provavelmente alguém
  // batendo no endpoint à toa. Descarta em silêncio.
  if (!resumo.diretiva) {
    return { statusCode: 204 };
  }

  logStructuredEvent("warn", "csp.violation", resumo);

  return { statusCode: 204 };
}
