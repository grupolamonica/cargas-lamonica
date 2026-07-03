// Dossiê da Torre de Controle para a revisão de cadastro do operador.
//
// Consulta a API de integração da Torre por CPF e devolve um recorte enxuto do
// envelope (ranking + sinais operacionais) — o dossiê completo tem blocos
// pesados (viagens recentes, documentos, veículos) que a ficha não usa.

import { lookupTorreDriverByCpf } from "../../../infrastructure/torre/torre-client.js";

function pickRanking(ranking) {
  return {
    encontrado: ranking?.encontrado === true,
    posicao: ranking?.posicao ?? null,
    pontuacao: ranking?.pontuacao ?? null,
    vinculo: ranking?.vinculo ?? null,
    status: ranking?.status ?? null,
  };
}

function pickTorreSummary(data) {
  return {
    cadastroTorre: data?.cadastroTorre === true,
    fonte: data?.fonte ?? null,
    geradoEm: data?.geradoEm ?? null,
    ranking: pickRanking(data?.ranking),
    identidade: {
      nome: data?.identidade?.name ?? null,
      driverKind: data?.identidade?.driverKind ?? null,
      cidade: data?.identidade?.cidade ?? null,
      estado: data?.identidade?.estado ?? null,
      shopeeDriverId: data?.identidade?.shopeeDriverId ?? null,
    },
    conformidade: {
      operationalScore: data?.conformidade?.operationalScore ?? null,
      angelliraStatus: data?.conformidade?.angelliraStatus ?? null,
      angelliraValidUntil: data?.conformidade?.angelliraValidUntil ?? null,
      anttValid: data?.conformidade?.anttValid ?? null,
      documentsValid: data?.conformidade?.documentsValid ?? null,
      operationalBlocked: data?.conformidade?.operationalBlocked ?? null,
    },
    viagens: {
      total: data?.viagens?.total ?? 0,
      completas: data?.viagens?.completas ?? 0,
      canceladas: data?.viagens?.canceladas ?? 0,
      emAndamento: data?.viagens?.emAndamento ?? 0,
      pctNoPrazo: data?.viagens?.pctNoPrazo ?? null,
      ultima: data?.viagens?.ultima ?? null,
    },
    ocorrencias: { total: data?.ocorrencias?.total ?? 0 },
    ultimaPosicao: data?.localizacao?.ultimaPosicao ?? null,
  };
}

/**
 * @param {object} params
 * @param {string} params.cpf CPF do motorista (qualquer formato).
 * @param {string} [params.correlationId]
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function fetchTorreDriverInfo({ cpf, correlationId }) {
  try {
    const result = await lookupTorreDriverByCpf(cpf, { correlationId });
    if (!result.found) {
      return {
        statusCode: 200,
        payload: { ok: true, found: false, torre: null, meta: { correlationId } },
      };
    }
    return {
      statusCode: 200,
      payload: { ok: true, found: true, torre: pickTorreSummary(result.data), meta: { correlationId } },
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "TORRE_INVALID_INPUT") {
      return {
        statusCode: 400,
        payload: { error: "BadRequest", message: "CPF inválido para consulta na Torre.", meta: { correlationId } },
      };
    }
    if (code === "TORRE_NOT_CONFIGURED" || code === "TORRE_UNAUTHORIZED") {
      return {
        statusCode: 503,
        payload: {
          error: "TorreNotConfigured",
          message: "Integração com a Torre não configurada ou chave inválida.",
          meta: { correlationId },
        },
      };
    }
    if (code === "TORRE_SOURCE_TIMEOUT") {
      return {
        statusCode: 504,
        payload: { error: "TorreTimeout", message: "Torre não respondeu a tempo.", meta: { correlationId } },
      };
    }
    if (code === "TORRE_SOURCE_UNAVAILABLE") {
      return {
        statusCode: 503,
        payload: { error: "TorreUnavailable", message: "Torre indisponível no momento.", meta: { correlationId } },
      };
    }
    return {
      statusCode: 502,
      payload: { error: "TorreError", message: "Falha ao consultar a Torre.", meta: { correlationId } },
    };
  }
}
