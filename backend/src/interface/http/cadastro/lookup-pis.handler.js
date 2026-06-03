// backend/src/interface/http/cadastro/lookup-pis.handler.js
//
// POST /api/cadastro/lookup-pis — driver-authenticated.
// Consulta o PIS no CNIS via Infosimples para auto-preencher o wizard /cadastro.
//
// Plan: 260515-loi T2.

import "../../../infrastructure/config/load-env.js";

import { ZodError } from "zod";

import { resolveCandidaturaActor } from "../../../application/load-claims/candidatura-actor.js";
import { lookupPis } from "../../../application/cadastro/use-cases/lookup-pis.js";
import {
  getAuthorizationHeader,
  getCorrelationId,
  getRequestIp,
  parseJsonBody,
} from "../http-utils.js";
import { lookupPisSchema } from "../schemas/cadastro-schemas.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";

// Rate-limit dedicado: 10 req/min/IP. Mesmo padrao de `candidatura/handlers.js`.
// In-memory: nao cluster-safe — aceitavel pra v1 (cf. CONCERNS H-01).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const ipRateLimitMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of ipRateLimitMap) {
    if (entry.resetAt <= now) ipRateLimitMap.delete(key);
  }
}, 60_000).unref();

function checkRateLimit(ip) {
  if (!ip) return { limited: false, retryAfterSeconds: 0 };
  const now = Date.now();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false, retryAfterSeconds: 0 };
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { limited: true, retryAfterSeconds };
  }
  return { limited: false, retryAfterSeconds: 0 };
}

export async function resolveLookupPisResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  const { limited, retryAfterSeconds } = checkRateLimit(requestIp);
  if (limited) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas consultas. Aguarde alguns instantes e tente novamente.",
        retryAfterSeconds,
        meta: { correlationId },
      },
    };
  }

  // Aceita sessão de motorista OU de operador (resgate de rascunho). Público
  // (sem token) é rejeitado — a consulta CNIS/Infosimples exige autenticação.
  const { actor, errorResponse } = await resolveCandidaturaActor(
    getAuthorizationHeader(request),
    correlationId,
  );
  if (errorResponse) return errorResponse;
  if (actor.type === "public") {
    return {
      statusCode: 401,
      payload: {
        error: "Unauthorized",
        message: "Autenticação obrigatória para consultar o PIS.",
        meta: { correlationId },
      },
    };
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  try {
    const parsed = lookupPisSchema.parse(body);
    return await lookupPis({
      cpf: parsed.cpf,
      nome: parsed.nome,
      dataNascimento: parsed.dataNascimento,
      correlationId,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    return {
      statusCode: 500,
      payload: {
        error: "InternalServerError",
        message: "Falha inesperada ao consultar PIS.",
        meta: { correlationId },
      },
    };
  }
}
