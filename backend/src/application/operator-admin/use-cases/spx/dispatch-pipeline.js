/**
 * Pipeline de cadastro SPX: precheck → cadastrar (ou importarMatched).
 *
 * Diferente do Angellira (4 steps), SPX tem essencialmente 1 step
 * (motorista) com 3 caminhos:
 *   1. Não existe → POST /spx/motorista (cria)
 *   2. Existe em outra agência → POST /spx/motorista/importar_matched
 *   3. Já existe na nossa agência → SKIP (job=OK_CACHED)
 *
 * Persiste em driver_profiles.spx_* + external_registration_jobs target=spx.
 *
 * Epic DC-111 / extensão SPX.
 */

import {
  SpxBotError,
  cadastrarMotorista as botCadastrarMotorista,
  importarMatched as botImportarMatched,
} from "../../../../infrastructure/cadastro-bots/spx-bot-client.js";
import { insertSecurityAuditEvent } from "../../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

import { stripUuidIfInvalid } from "../angellira/_utils.js";
import {
  findExistingOkJob,
  markJobError,
  markJobInProgress,
  markJobOk,
} from "../angellira/jobs-repository.js";

import { performSpxPrecheck } from "./precheck.js";
import { mapSpxMotoristaPayload } from "./payload-mapper.js";

const STEP = "spx_motorista";

/**
 * Executa o pipeline SPX para o cadastro aprovado.
 *
 * @param {object} args
 * @param {import('pg').PoolClient} args.client
 * @param {object} args.cadastro
 * @param {string} [args.driverUserId]
 * @param {string} [args.operatorId]
 * @param {string} [args.correlationId]
 * @param {object} [args.overrides]  — overrides do operador (station, etc)
 * @returns {Promise<{ok, results: Array<{step,status,external_id?,error?}>}>}
 */
export async function runSpxPipeline({
  client,
  cadastro,
  driverUserId = null,
  operatorId = null,
  correlationId = null,
  overrides = {},
}) {
  const cadastroId = cadastro?.id;
  if (!cadastroId) throw new Error("cadastro.id ausente — pipeline SPX abortado");

  logStructuredEvent("info", "spx.pipeline.start", {
    cadastroId, driverUserId, correlationId,
  });

  // Idempotência: se já tem job OK pra spx_motorista, pula
  const existing = await findExistingOkJob({ client, cadastroId, step: STEP });
  if (existing) {
    logStructuredEvent("info", "spx.pipeline.skipped_already_ok", {
      cadastroId, existingJobId: existing.id,
    });
    return {
      ok: true,
      results: [{
        step: STEP,
        status: "OK_CACHED",
        external_id: existing.external_id,
        response: existing.response,
      }],
    };
  }

  // Cria job IN_PROGRESS
  const jobId = await markJobInProgress({
    client, cadastroId, step: STEP,
    payload: { cadastroId, cpf: cadastro?.dados?.motorista?.cpf || "" },
  });

  let stepResult;
  try {
    // 1. Precheck (read-only)
    const precheck = await performSpxPrecheck({ cadastro, correlationId });
    logStructuredEvent("info", "spx.pipeline.precheck", {
      cadastroId, status: precheck.status,
    });

    if (precheck.status === "IS_MATCHED_NOSSA") {
      // Já cadastrado na nossa agência — sucesso sem ação
      stepResult = {
        externalId: precheck.existingDriverId ? String(precheck.existingDriverId) : null,
        response: { etapa: "ja_cadastrado_nossa_agencia", precheck },
      };
    } else if (precheck.status === "IS_MATCHED_OUTRA") {
      // Existe em outra agência → importar_matched (cria request nossa)
      const payload = mapSpxMotoristaPayload(cadastro.dados, overrides);
      const r = await botImportarMatched({
        cpf: payload.cpf,
        driverInfo: precheck.driverInfo || { driver_id: precheck.existingDriverId },
        contractType: payload.contract_type,
        functionTypeList: payload.function_type_list,
        linehaulStationName: payload.linehaul_station_name,
        vehicleTypeName: payload.vehicle_type_name,
        licensePlate: payload.license_plate,
        renavam: payload.renavam,
        vehicleManufacturer: payload.vehicle_manufacturer,
        vehicleManufacturingYear: payload.vehicle_manufacturing_year,
        vehicleOwnerName: payload.vehicle_owner_name,
        dryRun: false,
        idempotencyKey: `${cadastroId}:spx_motorista`,
        correlationId,
      });
      stepResult = {
        externalId: r.request_id ? String(r.request_id) : (r.driver_id ? String(r.driver_id) : null),
        response: { etapa: "importado", ...r.raw },
      };
    } else if (precheck.status === "REQUEST_PENDENTE") {
      // Já tem request aberta — não pode criar nova. Marca OK com referência.
      stepResult = {
        externalId: precheck.existingRequestId ? String(precheck.existingRequestId) : null,
        response: { etapa: "request_pendente", precheck },
      };
    } else if (precheck.status === "BLOQUEADO") {
      throw new SpxBotError({
        code: "SPX_DRIVER_BLOQUEADO",
        message: "Motorista bloqueado no SPX — contate Shopee Express.",
        acao: "Desbloqueio só pelo portal SPX.",
      });
    } else if (precheck.status === "UNAVAILABLE") {
      throw new SpxBotError({
        code: "SPX_BOT_INDISPONIVEL",
        message: precheck.message || "SPX indisponível",
        acao: "Verifique o container spx-bot e os cookies no Supabase.",
      });
    } else {
      // NOT_FOUND → cadastro novo
      const payload = mapSpxMotoristaPayload(cadastro.dados, overrides);
      const r = await botCadastrarMotorista({
        payload,
        idempotencyKey: `${cadastroId}:spx_motorista`,
        correlationId,
      });
      stepResult = {
        externalId: r.driverId ? String(r.driverId) : (r.requestId ? String(r.requestId) : null),
        response: { etapa: r.etapa || "completo", ...r.raw },
      };
    }

    await markJobOk({
      client, jobId,
      response: stepResult.response,
      externalId: stepResult.externalId,
    });

    await updateDriverProfileFromResult({
      client, driverUserId,
      externalId: stepResult.externalId,
      requestId: stepResult.response?.request_id,
    });

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cadastro.spx_dispatched",
      actorUserId: operatorId, actorRole: "operator",
      resourceType: "pending_driver_registration", resourceId: cadastroId,
      action: "spx_dispatch", outcome: "success",
      correlationId,
      metadata: { etapa: stepResult.response?.etapa },
    });

    return {
      ok: true,
      results: [{
        step: STEP,
        status: "OK",
        external_id: stepResult.externalId,
        response: stepResult.response,
      }],
    };
  } catch (err) {
    const errorPayload = err instanceof SpxBotError
      ? err.toJSON()
      : { code: "SPX_PIPELINE_UNEXPECTED", message: err?.message || String(err) };
    await markJobError({ client, jobId, error: errorPayload });

    await updateDriverProfileErrorFromResult({ client, driverUserId, error: errorPayload });

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cadastro.spx_step_failed",
      actorUserId: operatorId, actorRole: "operator",
      resourceType: "pending_driver_registration", resourceId: cadastroId,
      action: "spx_dispatch", outcome: "failure",
      correlationId,
      metadata: { code: errorPayload.code },
    });

    return {
      ok: false,
      results: [{ step: STEP, status: "ERROR", error: errorPayload }],
    };
  }
}

async function updateDriverProfileFromResult({ client, driverUserId, externalId, requestId }) {
  const userId = stripUuidIfInvalid(driverUserId);
  if (!userId) return;
  await client.query(
    `
      UPDATE public.driver_profiles
      SET spx_registration_status = 'OK',
          spx_driver_id  = COALESCE($1, spx_driver_id),
          spx_request_id = COALESCE($2, spx_request_id),
          spx_registration_at = now(),
          spx_last_error = NULL,
          updated_at = now()
      WHERE user_id = $3
    `,
    [externalId || null, requestId || null, userId],
  );
}

async function updateDriverProfileErrorFromResult({ client, driverUserId, error }) {
  const userId = stripUuidIfInvalid(driverUserId);
  if (!userId) return;
  await client.query(
    `
      UPDATE public.driver_profiles
      SET spx_registration_status = 'ERROR',
          spx_last_error = $1,
          updated_at = now()
      WHERE user_id = $2
    `,
    [error, userId],
  );
}
