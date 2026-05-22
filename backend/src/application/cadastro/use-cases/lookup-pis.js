// backend/src/application/cadastro/use-cases/lookup-pis.js
//
// Use case: orquestra a chamada ao client Infosimples e mapeia os outcomes
// para tuplas HTTP `{ statusCode, payload }`. Mantem o handler agnostico do
// vocabulario do client.

import { lookupPisCnis } from "../../../infrastructure/infosimples/infosimples-client.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

/**
 * @param {object} params
 * @param {string} params.cpf  CPF normalizado (digits only).
 * @param {string} params.nome Nome (trim, >=1 char).
 * @param {string} params.dataNascimento ISO yyyy-mm-dd.
 * @param {string} [params.correlationId]
 *
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function lookupPis({ cpf, nome, dataNascimento, correlationId }) {
  try {
    const result = await lookupPisCnis({ cpf, nome, dataNascimento, correlationId });

    if (result.pis) {
      return {
        statusCode: 200,
        payload: {
          pis: result.pis,
          source: result.source,
          meta: { correlationId },
        },
      };
    }

    return {
      statusCode: 404,
      payload: {
        error: "PisNotFound",
        message: "PIS nao localizado no CNIS para o CPF informado.",
        meta: { correlationId },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "INFOSIMPLES_INVALID_INPUT") {
      return {
        statusCode: 400,
        payload: {
          error: "InvalidInput",
          message: "Dados invalidos para consulta de PIS (CPF, nome ou data de nascimento).",
          meta: { correlationId },
        },
      };
    }

    if (message === "INFOSIMPLES_SOURCE_TIMEOUT") {
      return {
        statusCode: 504,
        payload: {
          error: "SourceTimeout",
          message: "A consulta automatica expirou. Informe o PIS manualmente.",
          meta: { correlationId },
        },
      };
    }

    if (message === "INFOSIMPLES_SOURCE_UNAVAILABLE") {
      logStructuredEvent("warn", "infosimples.lookup_pis.source_unavailable", {
        correlationId: correlationId || null,
      });
      return {
        statusCode: 503,
        payload: {
          error: "SourceUnavailable",
          message:
            "Consulta automatica do PIS temporariamente indisponivel (fonte oficial fora do ar). Informe manualmente.",
          meta: { correlationId },
        },
      };
    }

    if (message === "INFOSIMPLES_NO_CREDIT") {
      logStructuredEvent("warn", "infosimples.lookup_pis.no_credit", {
        correlationId: correlationId || null,
      });
      return {
        statusCode: 502,
        payload: {
          error: "SourceUnavailable",
          message: "Consulta automatica indisponivel. Informe o PIS manualmente.",
          meta: { correlationId },
        },
      };
    }

    if (message === "INFOSIMPLES_NOT_CONFIGURED") {
      return {
        statusCode: 503,
        payload: {
          error: "ServiceNotConfigured",
          message: "Servico de consulta automatica nao configurado. Informe o PIS manualmente.",
          meta: { correlationId },
        },
      };
    }

    // INFOSIMPLES_API_ERROR:* ou qualquer outro
    logStructuredEvent("warn", "infosimples.lookup_pis.api_error", {
      correlationId: correlationId || null,
      errorMessage: message,
    });
    return {
      statusCode: 502,
      payload: {
        error: "SourceError",
        message: "Falha na consulta automatica. Informe o PIS manualmente.",
        meta: { correlationId },
      },
    };
  }
}
