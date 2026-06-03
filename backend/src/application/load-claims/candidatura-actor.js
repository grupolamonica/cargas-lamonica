import { ForbiddenError, UnauthorizedError } from "../../domain/load-claims/errors.js";
import { requireDriverSession, requireOperatorSession } from "./auth.js";

/**
 * Resolve quem está fazendo uma requisição de candidatura, aceitando tanto a
 * sessão do motorista quanto a do operador (resgate de rascunho pelo painel).
 *
 * - Bearer de motorista  → { actor: { type: "driver", driverUserId, user } }
 * - Bearer de operador   → { actor: { type: "operator", operatorId, accessLevel, user } }
 * - Sem header Authorization → { actor: { type: "public" } } (fluxo público por CPF)
 * - Token presente mas inválido para ambos → { errorResponse } (401/403)
 *
 * A ordem tenta driver primeiro (fluxo majoritário); um Bearer de operador
 * falha em `requireDriverSession` com ForbiddenError (token válido, role errada)
 * e cai no fallback de operador.
 *
 * @param {string|null|undefined} authorizationHeader
 * @param {string} [correlationId]
 */
export async function resolveCandidaturaActor(authorizationHeader, correlationId) {
  const hasHeader = !!(authorizationHeader && String(authorizationHeader).trim());
  if (!hasHeader) {
    return { actor: { type: "public" } };
  }

  let driverErr;
  try {
    const session = await requireDriverSession(authorizationHeader);
    return { actor: { type: "driver", driverUserId: session.user.id, user: session.user } };
  } catch (err) {
    driverErr = err;
  }

  try {
    const op = await requireOperatorSession(authorizationHeader);
    if (!op.accessLevel) {
      return {
        errorResponse: {
          statusCode: 403,
          payload: {
            error: "Forbidden",
            message: "Operador sem nível de acesso para esta operação.",
            meta: { correlationId },
          },
        },
      };
    }
    return {
      actor: { type: "operator", operatorId: op.user.id, accessLevel: op.accessLevel, user: op.user },
    };
  } catch (opErr) {
    // Não é driver nem operador. Token inválido/expirado para ambos → 401;
    // token válido mas sem role aceita (improvável aqui) → 403.
    const bothUnauthorized =
      driverErr instanceof UnauthorizedError && opErr instanceof UnauthorizedError;
    if (bothUnauthorized) {
      return {
        errorResponse: {
          statusCode: 401,
          payload: {
            error: "Unauthorized",
            message: "Sessão inválida ou expirada.",
            meta: { correlationId },
          },
        },
      };
    }
    const message =
      opErr instanceof ForbiddenError || driverErr instanceof ForbiddenError
        ? "Token sem permissão para esta operação."
        : "Não foi possível validar a sessão.";
    return {
      errorResponse: {
        statusCode: 403,
        payload: { error: "Forbidden", message, meta: { correlationId } },
      },
    };
  }
}
