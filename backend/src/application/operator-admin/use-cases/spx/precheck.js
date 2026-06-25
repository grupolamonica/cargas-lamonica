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

// Cache server-side curto — chave (cadastroId), TTL 60s.
// Coerente com cache Angellira (mesmo TTL).
const PRECHECK_CACHE = new Map();
const PRECHECK_CACHE_TTL_MS = 60_000;
const PRECHECK_CACHE_MAX_SIZE = 500;

function getCached(cadastroId) {
  const entry = PRECHECK_CACHE.get(cadastroId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    PRECHECK_CACHE.delete(cadastroId);
    return null;
  }
  return entry.value;
}
function setCached(cadastroId, value) {
  if (PRECHECK_CACHE.size >= PRECHECK_CACHE_MAX_SIZE) {
    PRECHECK_CACHE.delete(PRECHECK_CACHE.keys().next().value);
  }
  PRECHECK_CACHE.set(cadastroId, { value, expiresAt: Date.now() + PRECHECK_CACHE_TTL_MS });
}
export function invalidateSpxPrecheckCache(cadastroId) {
  if (cadastroId) PRECHECK_CACHE.delete(cadastroId);
}

/**
 * Executa precheck SPX para o motorista do cadastro.
 *
 * @param {object} args
 * @param {object} args.cadastro       — row de pending_driver_registrations
 * @param {string} [args.correlationId]
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'NOT_FOUND'|'IS_MATCHED_NOSSA'|'IS_MATCHED_OUTRA'|'REQUEST_PENDENTE'|'INATIVO'|'BLOQUEADO'|'UNAVAILABLE',
 *   driverInfo?: object,
 *   existingDriverId?: number,
 *   existingRequestId?: number,
 *   requestStatus?: string,
 *   message?: string,
 * }>}
 */
export async function performSpxPrecheck({ cadastro, correlationId = null, skipCache = false }) {
  // Cache hit?
  if (!skipCache && cadastro?.id) {
    const cached = getCached(cadastro.id);
    if (cached) return { ...cached, _cached: true, _durationMs: 0 };
  }
  const startedAt = Date.now();
  const result = await _performSpxPrecheckInner({ cadastro, correlationId });
  result._cached = false;
  result._durationMs = Date.now() - startedAt;
  // Cacheia só sucesso (UNAVAILABLE → retry no próximo modal)
  if (cadastro?.id && result.status !== "UNAVAILABLE") {
    const { _cached, _durationMs, ...cachable } = result;
    setCached(cadastro.id, cachable);
  }
  return result;
}

async function _performSpxPrecheckInner({ cadastro, correlationId = null }) {
  const motorista = cadastro?.dados?.motorista || {};
  const cpf = digitsOnly(motorista.cpf);
  const driverName = String(motorista.nome || "").trim().toUpperCase();
  const contactNumber = digitsOnly(
    motorista.telefone_primario
    || (Array.isArray(motorista.telefones) ? motorista.telefones[0] : "")
    || motorista.telefone,
  );
  // license_number ajuda o bot a passar pelo validate/basic do SPX
  // (sem ele, retcode 271605013 "CNH vazia" e o bot manda placeholder, que pode
  // COLIDIR com outro motorista e dar 271605059/271605005 FALSO — daí perdemos a
  // deteccao real de cross-agency). dados.motorista.cnh pode vir como STRING (o
  // numero direto) OU objeto {registro|numero}; o payload-mapper usa cnh.registro.
  // Tem que bater com o mapper, senao o precheck e o disparo divergem.
  const cnhRaw = motorista.cnh ?? cadastro?.dados?.cnh;
  const licenseNumber = digitsOnly(
    (typeof cnhRaw === "string" ? cnhRaw : (cnhRaw?.registro || cnhRaw?.numero))
    || motorista.cnh_registro
    || motorista.cnh_numero
    || "",
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
      cpf, driverName, contactNumber, licenseNumber, correlationId,
    });

    // Inconclusivo: o bot usou placeholder de CNH/telefone (faltavam no cadastro)
    // e colidiu com outro motorista — não dá pra afirmar nada. Default seguro =
    // NOT_FOUND (libera cadastro novo; se existir, o submit pega o retcode real),
    // mas sinaliza pro operador completar os dados.
    if (r.inconclusivo) {
      return {
        ok: true,
        status: "NOT_FOUND",
        retcode: r.retcode,
        message: r.motivo
          || "Status no SPX indeterminado — complete a CNH/telefone do cadastro e refaça a verificação.",
        _inconclusivo: true,
      };
    }

    if (!r.encontrado) {
      return { ok: true, status: "NOT_FOUND" };
    }

    // Já cadastrado na NOSSA agência (LAMONICA) — sem ação
    if (r.na_minha_agencia) {
      return {
        ok: true,
        status: "IS_MATCHED_NOSSA",
        existingDriverId: r.existing_driver_id ?? r.driver_info?.driver_id ?? null,
        driverInfo: r.driver_info ?? null,
        message: "Motorista já cadastrado na nossa agência. Use re-cadastrar para atualizar.",
      };
    }

    // Request pendente (rascunho aberto / em revisão / em progresso)
    if (r.request_pendente) {
      return {
        ok: true,
        status: "REQUEST_PENDENTE",
        retcode: r.retcode,
        message: r.erro_validate || "Já existe request aberta para este motorista — aguarde processamento.",
      };
    }

    // Motorista inativo na agência — precisa ativar via /spx/motorista/ativar.
    // Devolve driver_id pra o pipeline conseguir reativar (sem ele, não dá).
    if (r.inativo) {
      return {
        ok: true,
        status: "INATIVO",
        retcode: r.retcode,
        existingDriverId: r.existing_driver_id ?? r.driver_info?.driver_id ?? null,
        driverInfo: r.driver_info ?? null,
        message: "Motorista cadastrado mas inativo. Use 'Ativar' antes de cadastrar de novo.",
      };
    }

    // Bloqueado pela Shopee
    if (r.bloqueado) {
      return {
        ok: true,
        status: "BLOQUEADO",
        retcode: r.retcode,
        message: "Motorista bloqueado pela Shopee Express. Contate o suporte.",
      };
    }

    // Existe em OUTRA agência (DRIVER_IN_OTHER_AGENCY, LICENSE_ALREADY_REGISTERED,
    // DRIVER_REPEAT). is_matched=true por validate/basic ou retcode-mapping.
    if (r.is_matched || r.outra_agencia || r.license_collision) {
      const motivo = r.outra_agencia
        ? "Motorista cadastrado em OUTRA agência da Shopee — telefone pode divergir, confirme com o motorista."
        : r.license_collision
          ? "CNH deste motorista já registrada (provavelmente em outra agência). Use 'Importar matched' ou confirme via /diagnostico."
          : "Motorista existe em outra agência. Use 'Importar matched' para criar request nossa.";
      return {
        ok: true,
        status: "IS_MATCHED_OUTRA",
        retcode: r.retcode,
        existingDriverId: r.existing_driver_id ?? r.driver_info?.driver_id ?? null,
        driverInfo: r.driver_info ?? null,
        message: motivo,
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
