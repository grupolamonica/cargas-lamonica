import "../../../infrastructure/config/load-env.js";

import { ZodError } from "zod";

import {
  getCorrelationId,
  getRequestIp,
  parseJsonBody,
} from "../http-utils.js";
import { finalizarCadastroSchema } from "../schemas/cadastro-schemas.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";
import { finalizarCadastro } from "../../../application/cadastro/use-cases/finalizar-cadastro.js";
import { checkRateLimit } from "../../../infrastructure/rate-limit-redis.js";

// Submissão rate-limit por IP: máx 10 cadastros por IP por 60 segundos.
// Estado compartilhado via Redis — funciona em múltiplas réplicas.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

async function isRateLimited(ip) {
  if (!ip) return false;
  const allowed = await checkRateLimit(`ratelimit:cadastro:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  return !allowed;
}

/**
 * POST /api/public/cadastro/finalizar
 * Endpoint público — sem auth. Rate-limit por IP.
 */
export async function resolveFinalizarCadastroResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (await isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
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
      payload: { error: "BadRequest", message: "Corpo da requisição inválido (esperado JSON).", meta: { correlationId } },
    };
  }

  try {
    const { id_cadastro, dados } = finalizarCadastroSchema.parse(body);
    return await finalizarCadastro({ id_cadastro, dados, requestIp, correlationId });
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    throw err;
  }
}
