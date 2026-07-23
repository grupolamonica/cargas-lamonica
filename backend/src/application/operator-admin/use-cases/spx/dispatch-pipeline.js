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
  ativarDriver as botAtivarDriver,
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
import { checkCnhCategoryGate } from "./cnh-category-gate.js";
import { checkCrlvGate } from "./crlv-gate.js";
import { mapSpxMotoristaPayload } from "./payload-mapper.js";
import { generateDossie } from "../unificada/generate-dossie.js";
import { stageSpxAnexos } from "./spx-anexos-stager.js";
import { consultRiskExpiry, defaultExpiryIso } from "./risk-expiry.js";

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
    cadastroId, driverUserId, correlationId, dryRun: overrides?.dry_run === true,
  });

  // ── DRY-RUN (preview): NÃO persiste job nem cria driver. Estaga os docs +
  // monta o payload + (NOT_FOUND) chama o bot com dry_run=true (sobe docs, NÃO
  // submete). Permite conferir tudo antes do disparo real sem poluir a
  // idempotência (um dry-run não pode marcar o job OK e bloquear o real). ──────
  if (overrides?.dry_run === true) {
    const precheck = await performSpxPrecheck({ cadastro, correlationId });
    const writePath = precheck.status === "NOT_FOUND" || precheck.status === "IS_MATCHED_OUTRA";
    if (!writePath) {
      return {
        ok: true, dry_run: true, precheck_status: precheck.status,
        results: [{ step: STEP, status: "DRY_RUN", response: { etapa: precheck.status, precheck } }],
      };
    }
    // Gate de categoria da CNH (cavalo/carreta exige E) — mostra o bloqueio no preview.
    const catBlockDry = checkCnhCategoryGate(cadastro?.dados);
    if (catBlockDry) {
      return {
        ok: true, dry_run: true, precheck_status: precheck.status,
        results: [{ step: STEP, status: "BLOCKED", error: catBlockDry }],
      };
    }
    // Gate de CRLV do cavalo (DC-304): placa presente mas CRLV não anexada → o
    // SPX falharia com 502 opaco. Mostra o bloqueio acionável no preview.
    const crlvBlockDry = checkCrlvGate(cadastro?.dados);
    if (crlvBlockDry) {
      return {
        ok: true, dry_run: true, precheck_status: precheck.status,
        results: [{ step: STEP, status: "BLOCKED", error: crlvBlockDry }],
      };
    }
    const { anexosMap, radExpireDate } = await prepareSpxDocs({ client, cadastro, operatorId, correlationId });
    const payload = mapSpxMotoristaPayload(cadastro.dados, {
      ...overrides, ...anexosMap, rad_expire_date: radExpireDate, dry_run: true,
    });
    let preview = null;
    if (precheck.status === "NOT_FOUND") {
      try {
        preview = await botCadastrarMotorista({ payload, correlationId });
      } catch (err) {
        preview = { ok: false, error: err instanceof SpxBotError ? err.toJSON() : { message: err?.message || String(err) } };
      }
    }
    logStructuredEvent("info", "spx.pipeline.dry_run", {
      cadastroId, precheckStatus: precheck.status, anexos: Object.keys(anexosMap),
    });
    return {
      ok: true, dry_run: true, precheck_status: precheck.status,
      anexos_estagados: Object.keys(anexosMap),
      payload_preview: payload,
      results: [{ step: STEP, status: "DRY_RUN", response: preview }],
    };
  }

  // Idempotência: se já tem job OK pra spx_motorista, pula
  const existing = await findExistingOkJob({ client, cadastroId, step: STEP, target: "spx" });
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
    client, cadastroId, step: STEP, target: "spx",
    payload: { cadastroId, cpf: cadastro?.dados?.motorista?.cpf || "" },
  });

  let stepResult;
  try {
    // 1. Precheck (read-only)
    const precheck = await performSpxPrecheck({ cadastro, correlationId });
    logStructuredEvent("info", "spx.pipeline.precheck", {
      cadastroId, status: precheck.status,
    });

    // Gate de categoria da CNH (paridade c/ produção): cavalo/carreta exige CNH
    // com E. Barra ANTES do disparo, com mensagem clara, só nos caminhos que
    // criariam uma request nova (não bloqueia já-cadastrado/pendente/inativo).
    if (precheck.status === "NOT_FOUND" || precheck.status === "IS_MATCHED_OUTRA") {
      const catBlock = checkCnhCategoryGate(cadastro?.dados);
      if (catBlock) {
        logStructuredEvent("warn", "spx.pipeline.cnh_category_block", {
          cadastroId, categoria: catBlock.categoria,
        });
        await markJobError({ client, jobId, error: catBlock });
        return { ok: false, results: [{ step: STEP, status: "BLOCKED", error: catBlock }] };
      }
      // Gate de CRLV do cavalo (DC-304): sem a imagem da CRLV o SPX falha com um
      // 502 opaco. Barra aqui com mensagem clara p/ o operador anexar e re-disparar.
      const crlvBlock = checkCrlvGate(cadastro?.dados);
      if (crlvBlock) {
        logStructuredEvent("warn", "spx.pipeline.crlv_block", {
          cadastroId, placa: crlvBlock.placa,
        });
        await markJobError({ client, jobId, error: crlvBlock });
        return { ok: false, results: [{ step: STEP, status: "BLOCKED", error: crlvBlock }] };
      }
    }

    if (precheck.status === "IS_MATCHED_NOSSA") {
      // Já cadastrado na nossa agência — sucesso sem ação
      stepResult = {
        externalId: precheck.existingDriverId ? String(precheck.existingDriverId) : null,
        response: { etapa: "ja_cadastrado_nossa_agencia", precheck },
      };
    } else if (precheck.status === "IS_MATCHED_OUTRA") {
      // Existe em outra agência → importar_matched (cria request nossa).
      // Gera dossiê + vigência + estaga docs (preenche só Risk Doc/CRLV vazios;
      // o bot NÃO toca campos locked).
      const { anexosMap, radExpireDate } = await prepareSpxDocs({ client, cadastro, operatorId, correlationId });
      const payload = mapSpxMotoristaPayload(cadastro.dados, { ...overrides, ...anexosMap, rad_expire_date: radExpireDate });
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
        // Fallback: quando driver_info do SPX não tem city_name/city_id
        // resolvível (ex: motorista de outra agência sem cidade mapeada),
        // usa a cidade do endereço do nosso cadastro.
        cityNameFallback: payload.city_name || null,
        // Risk Doc + CRLV + vigência (preenche campos vazios da request importada).
        crlvPath: anexosMap.crlv_path || null,
        riskDocPath: anexosMap.risk_doc_path || null,
        radExpireDate,
        dryRun: false,
        // Salva o rascunho ANTES do validate/detail — sem isso a Shopee rejeita com
        // 271626003 mesmo com tudo batendo 1:1 com o OCR (regra confirmada na produção).
        doDraftSave: true,
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
    } else if (precheck.status === "INATIVO") {
      // Driver_profile existe mas está inativo na agência (retcode 271605004).
      // NÃO recadastrar do zero — reativar via /spx/motorista/ativar (activation/update).
      const driverId = precheck.existingDriverId || precheck.driverInfo?.driver_id || null;
      if (!driverId) {
        throw new SpxBotError({
          code: "SPX_INATIVO_SEM_DRIVER_ID",
          message: "Motorista inativo no SPX, mas o driver_id não foi recuperado para reativar.",
          acao: "Reative manualmente no portal SPX (Agency > Driver Profile) ou rode o diagnóstico.",
        });
      }
      await botAtivarDriver({ driverId, correlationId });
      stepResult = {
        externalId: String(driverId),
        response: { etapa: "reativado", precheck },
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
      // NOT_FOUND → cadastro novo. Gera dossiê + vigência + estaga TODOS os docs
      // (CNH/selfie/CRLV/risk_doc) ANTES de montar o payload.
      const { anexosMap, radExpireDate } = await prepareSpxDocs({ client, cadastro, operatorId, correlationId });
      const payload = mapSpxMotoristaPayload(cadastro.dados, {
        ...overrides, ...anexosMap, rad_expire_date: radExpireDate,
      });
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

/**
 * Prepara dossiê + vigência + anexos pro disparo SPX (ramos que ESCREVEM:
 * NOT_FOUND e IS_MATCHED_OUTRA). Cada passo é best-effort — uma falha de doc não
 * derruba o disparo — MAS a vigência sempre volta válida (defaultExpiryIso).
 *
 * @returns {Promise<{anexosMap:object, radExpireDate:string, riskDocPath:string|null}>}
 */
async function prepareSpxDocs({ client, cadastro, operatorId = null, correlationId = null }) {
  const cadastroId = cadastro?.id;
  const cpf = String(cadastro?.dados?.motorista?.cpf || "").replace(/\D/g, "");

  // A) Dossiê (Risk Doc) — Fase 1; reusa se < 24h.
  let riskDocPath = null;
  try {
    const dossie = await generateDossie({ client, cadastro, operatorId, correlationId, force: false });
    if (dossie?.ok) {
      riskDocPath = dossie.storagePath || null;
      logStructuredEvent("info", "spx.pipeline.dossie_generated", { cadastroId, reused: !!dossie.reused });
    } else {
      logStructuredEvent("warn", "spx.pipeline.dossie_failed", { cadastroId, code: dossie?.error?.code || null });
    }
  } catch (err) {
    logStructuredEvent("warn", "spx.pipeline.dossie_exception", { cadastroId, message: err?.message || String(err) });
  }

  // B) Vigência (rad_expire_date) — NUNCA null (default hoje+90d).
  let radExpireDate = defaultExpiryIso();
  try {
    const exp = await consultRiskExpiry({ cpf, correlationId });
    if (exp?.ok && exp.found && exp.rad_expire_date) radExpireDate = exp.rad_expire_date;
  } catch (err) {
    logStructuredEvent("warn", "spx.pipeline.expiry_exception", { cadastroId, message: err?.message || String(err) });
  }

  // C) Estaga anexos (CNH/selfie/CRLV) + o dossiê no sandbox do bot.
  let anexosMap = {};
  try {
    const staged = await stageSpxAnexos({
      dados: cadastro?.dados, cadastroId, riskDocBucketPath: riskDocPath, correlationId,
    });
    if (staged) anexosMap = staged;
  } catch (err) {
    logStructuredEvent("warn", "spx.pipeline.anexos_exception", { cadastroId, message: err?.message || String(err) });
    anexosMap = {};
  }

  logStructuredEvent("info", "spx.pipeline.docs_ready", {
    cadastroId, anexos: Object.keys(anexosMap), temRiskDoc: !!riskDocPath, radExpireDate,
  });
  return { anexosMap, radExpireDate, riskDocPath };
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
