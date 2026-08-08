import { z } from "zod";

import { resolveCandidaturaActor } from "../../application/load-claims/candidatura-actor.js";
import { recordSecurityAuditEvent } from "../../infrastructure/security-audit.js";
import { getAuthorizationHeader, getCorrelationId, getRequestIp, parseJsonBody } from "./http-utils.js";
import { zodErrorToHttpResponse } from "./schemas/common.js";

/**
 * POST /api/auth/session-event — DC-283 / ALTO-16.
 *
 * Nenhum evento do ciclo de autenticacao entrava em security_audit_logs: quem
 * entrou no sistema, quando e de onde simplesmente nao era registrado. Numa
 * investigacao, isso e a primeira pergunta — e a trilha nao respondia.
 *
 * A autenticacao roda no GoTrue do lado do CLIENTE (supabase-js), entao o
 * backend nunca ve o login acontecer. Este endpoint e o beacon que fecha essa
 * lacuna: o frontend avisa depois do onAuthStateChange.
 *
 * O que impede forjar evento em nome de outro: o beacon exige o proprio Bearer
 * token da sessao, e o ator sai do token — nunca do corpo. Nao da pra registrar
 * login de terceiro.
 *
 * LIMITES CONHECIDOS, de propósito (o GoTrue segue sendo o system-of-record):
 *  - login que FALHA nao chega aqui: sem sessao, nao ha token pra apresentar.
 *    Cobrir tentativa malsucedida exige ingerir o audit do Supabase Auth;
 *  - logout so registra se o frontend avisar ANTES de destruir a sessao;
 *  - fechar a aba nao gera evento.
 * Ou seja: isto prova acesso ocorrido, nao serve pra detectar forca bruta.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitByIp = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitByIp) {
    if (entry.resetAt <= now) rateLimitByIp.delete(key);
  }
}, 60_000).unref();

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

export function resetAuthEventsRateLimitForTests() {
  rateLimitByIp.clear();
}

// Enum fechado: o corpo escolhe QUAL evento, nunca DE QUEM.
const sessionEventSchema = z.object({
  event: z.enum(["signed_in", "signed_out"]),
});

const EVENT_TYPE_BY_KIND = {
  signed_in: "auth.session.signed_in",
  signed_out: "auth.session.signed_out",
};

export async function resolveAuthSessionEventResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes.",
        meta: { correlationId },
      },
    };
  }

  let parsed;
  try {
    parsed = sessionEventSchema.parse(await parseJsonBody(request));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  // O ator vem do TOKEN. Sessao invalida devolve o 401 do proprio resolvedor.
  const { actor, errorResponse } = await resolveCandidaturaActor(
    getAuthorizationHeader(request),
    correlationId,
  );

  if (errorResponse) return errorResponse;

  if (!actor || actor.type === "public") {
    return {
      statusCode: 401,
      payload: {
        error: "Unauthorized",
        message: "Sessao necessaria para registrar evento de autenticacao.",
        meta: { correlationId },
      },
    };
  }

  await recordSecurityAuditEvent({
    eventType: EVENT_TYPE_BY_KIND[parsed.event],
    severity: "info",
    actorUserId: actor.user?.id || null,
    actorRole: actor.type,
    resourceType: "session",
    action: parsed.event,
    outcome: "success",
    requestIp,
    correlationId,
    // Sem PII no metadata: quem e o ator ja esta em actor_user_id/actor_email,
    // e de onde ja esta em request_ip.
    metadata: { origem: "beacon-frontend" },
  });

  return { statusCode: 204 };
}
