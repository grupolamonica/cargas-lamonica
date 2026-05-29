/**
 * Pre-check SPX: consulta read-only se o motorista já existe no portal SPX,
 * e qual o estado dele (na minha agência / em outra / inativo / bloqueado).
 *
 * Diferente do precheck Angellira (que valida vigência via /profile/query
 * externo), aqui chamamos o sidecar spx-bot que faz lookup via API SPX
 * interna usando os cookies SSO armazenados no Supabase.
 *
 * Epic DC-111 / extensão SPX.
 */

import {
  SpxBotError,
  diagnostico as botDiagnostico,
  lookupMotorista as botLookupMotorista,
} from "../../../../infrastructure/cadastro-bots/spx-bot-client.js";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Executa precheck SPX para o motorista do cadastro.
 *
 * @param {object} args
 * @param {object} args.cadastro       — row de pending_driver_registrations
 * @param {string} [args.correlationId]
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'NOT_FOUND'|'IS_MATCHED_NOSSA'|'IS_MATCHED_OUTRA'|'REQUEST_PENDENTE'|'BLOQUEADO'|'UNAVAILABLE',
 *   driverInfo?: object,
 *   existingDriverId?: number,
 *   existingRequestId?: number,
 *   requestStatus?: string,
 *   message?: string,
 * }>}
 */
export async function performSpxPrecheck({ cadastro, correlationId = null }) {
  const motorista = cadastro?.dados?.motorista || {};
  const cpf = digitsOnly(motorista.cpf);
  const driverName = String(motorista.nome || "").trim().toUpperCase();
  const contactNumber = digitsOnly(
    motorista.telefone_primario
    || (Array.isArray(motorista.telefones) ? motorista.telefones[0] : "")
    || motorista.telefone,
  );

  if (!cpf || cpf.length !== 11) {
    return {
      ok: true,
      status: "NOT_FOUND",
      message: "CPF ausente ou inválido — sem como consultar SPX.",
    };
  }

  // Lookup leve: existe? na minha agência ou em outra?
  try {
    const r = await botLookupMotorista({
      cpf, driverName, contactNumber, correlationId,
    });

    if (!r.encontrado) {
      return { ok: true, status: "NOT_FOUND" };
    }

    // Existe driver_profile na Shopee.
    if (r.na_minha_agencia) {
      return {
        ok: true,
        status: "IS_MATCHED_NOSSA",
        existingDriverId: r.existing_driver_id ?? r.driver_info?.driver_id ?? null,
        driverInfo: r.driver_info ?? null,
        message: "Motorista já cadastrado na nossa agência. Use re-cadastrar para atualizar.",
      };
    }

    if (r.is_matched) {
      return {
        ok: true,
        status: "IS_MATCHED_OUTRA",
        existingDriverId: r.existing_driver_id ?? r.driver_info?.driver_id ?? null,
        driverInfo: r.driver_info ?? null,
        message: "Motorista existe em outra agência. Use 'Importar matched' para criar request nossa.",
      };
    }

    return { ok: true, status: "NOT_FOUND" };
  } catch (err) {
    if (err instanceof SpxBotError) {
      if (err.code === "SPX_REQUEST_IN_PROGRESS") {
        return {
          ok: true,
          status: "REQUEST_PENDENTE",
          existingRequestId: err.raw?.detail?.existing_request_id ?? null,
          message: err.message,
        };
      }
      if (err.code === "SPX_DRIVER_BLOQUEADO") {
        return { ok: true, status: "BLOQUEADO", message: err.message };
      }
      if (err.code === "SPX_SESSAO_EXPIRADA" || err.code === "SPX_BOT_INDISPONIVEL") {
        return {
          ok: false,
          status: "UNAVAILABLE",
          message: err.message,
        };
      }
    }
    return {
      ok: false,
      status: "UNAVAILABLE",
      message: err?.message || "Falha consultando SPX",
    };
  }
}

/**
 * Diagnóstico alternativo — usa `/spx/motorista/diagnostico` que é mais
 * conservador (não risca travar o motorista). Útil quando o lookup retorna
 * informação insuficiente.
 */
export async function performSpxDiagnostico({ cadastro, correlationId = null }) {
  const cpf = digitsOnly(cadastro?.dados?.motorista?.cpf);
  const placa = String(cadastro?.dados?.cavalo?.placa || "").trim().toUpperCase();
  if (!cpf || cpf.length !== 11) {
    return { ok: true, status: "NOT_FOUND" };
  }
  try {
    return await botDiagnostico({ cpf, placaNossa: placa, correlationId });
  } catch (err) {
    return {
      ok: false,
      status: "UNAVAILABLE",
      message: err?.message || "Falha no diagnóstico SPX",
    };
  }
}
