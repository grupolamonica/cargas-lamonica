/**
 * Pipeline de cadastro Angellira: proprietário → cavalo → carreta → motorista.
 *
 * Idempotente: cada step verifica se já existe `external_registration_jobs`
 * com `status='OK'` antes de disparar. Atualiza `driver_profiles.angellira_*`
 * conforme cada etapa completa.
 *
 * Não interrompe o fluxo em erro de etapa intermediária (proprietario ok mas
 * cavalo falhou): registra ERROR na job e continua tentando o próximo step
 * **opcional** (motorista pode ser cadastrado mesmo sem cavalo).
 *
 * Epic DC-111 / Sprint 1 / DC-116.
 */

import {
  AngelliraBotError,
  cadastrarMotorista,
  cadastrarProprietario,
  cadastrarVeiculo,
} from "../../../../infrastructure/cadastro-bots/angellira-bot-client.js";
import { insertSecurityAuditEvent } from "../../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

import { stripUuidIfInvalid } from "./_utils.js";
import {
  findExistingOkJob,
  markJobError,
  markJobInProgress,
  markJobOk,
} from "./jobs-repository.js";
import {
  extractCarretaOwner,
  extractOwnerDocType,
  extractPlacas,
  mapMotoristaPayload,
  mapProprietarioPayload,
  mapVeiculoPayload,
  ownerReusesCavalo,
  resolveVehicleOwner,
} from "./payload-mapper.js";

const ALL_STEPS = [
  "proprietario_cavalo",
  "cavalo",
  "proprietario_carreta",
  "carreta",
  "motorista",
];

/**
 * Executa o pipeline completo Angellira para um cadastro aprovado.
 *
 * @param {object} args
 * @param {import('pg').PoolClient} args.client
 * @param {object} args.cadastro         — row de pending_driver_registrations
 * @param {string} [args.driverUserId]
 * @param {string} [args.operatorId]
 * @param {string} [args.correlationId]
 * @param {string[]} [args.onlySteps]    — limita a re-tentar uma etapa
 * @returns {Promise<{ok:boolean, results:Array<{step,status,external_id?,error?}>}>}
 */
export async function runAngelliraPipeline({
  client,
  cadastro,
  driverUserId = null,
  operatorId = null,
  correlationId = null,
  onlySteps = null,
}) {
  const dados = cadastro?.dados || {};
  const cadastroId = cadastro?.id;
  if (!cadastroId) throw new Error("cadastro.id ausente — pipeline Angellira abortado");

  const steps = Array.isArray(onlySteps) && onlySteps.length
    ? onlySteps.filter((s) => ALL_STEPS.includes(s))
    : determineStepsFromDados(dados);

  logStructuredEvent("info", "angellira.pipeline.start", {
    cadastroId,
    driverUserId,
    correlationId,
    steps,
  });

  const ctx = {
    client,
    cadastro,
    cadastroId,
    driverUserId,
    operatorId,
    correlationId,
    dados,
    // Estado entre etapas — passado pra próximas
    state: {
      cavaloOwnerId: null,
      cavaloOwnerDocType: null,
      cavaloOwnerDoc: null,
      carretaOwnerId: null,
      carretaOwnerDocType: null,
      carretaOwnerDoc: null,
      cavaloVehicleId: null,
      carretaVehicleId: null,
      motoristaDriverId: null,
    },
  };

  const results = [];
  for (const step of steps) {
    const stepResult = await runStep(step, ctx);
    results.push({ step, ...stepResult });
    // proprietario_cavalo falhou → não conseguimos cadastrar cavalo
    // (regra estrita do bot). Vamos pular cavalo mas tentar carreta+motorista.
    if (!stepResult.ok) {
      logStructuredEvent("warn", "angellira.pipeline.step_failed", {
        cadastroId, step, code: stepResult.error?.code,
      });
    }
  }

  logStructuredEvent("info", "angellira.pipeline.end", {
    cadastroId,
    results: results.map((r) => ({ step: r.step, status: r.status })),
  });

  // Atualiza driver_profiles.angellira_registration_status com snapshot final
  await updateDriverProfileFromResults({ client, driverUserId, results });

  // Audit log
  await insertSecurityAuditEvent(client, {
    eventType: "operator.cadastro.angellira_pipeline_finished",
    actorUserId: operatorId,
    actorRole: "operator",
    resourceType: "pending_driver_registration",
    resourceId: cadastroId,
    action: "angellira_pipeline",
    outcome: results.every((r) => r.ok) ? "success" : "partial",
    correlationId,
    metadata: { steps: results.map((r) => ({ step: r.step, status: r.status })) },
  });

  return { ok: results.every((r) => r.ok), results };
}

/**
 * Decide quais steps rodar baseado nos dados do cadastro:
 *   - cavalo presente? → proprietario_cavalo + cavalo
 *   - carreta presente? → proprietario_carreta + carreta
 *   - sempre motorista
 *
 * Se motorista é dono do cavalo, ainda cadastramos owner explícito (mais
 * seguro pra reutilização em outras situações).
 */
function determineStepsFromDados(dados) {
  const steps = [];
  const { cavalo, carreta } = extractPlacas(dados);
  if (cavalo) {
    steps.push("proprietario_cavalo");
    steps.push("cavalo");
  }
  if (carreta) {
    steps.push("proprietario_carreta");
    steps.push("carreta");
  }
  steps.push("motorista");
  return steps;
}

async function runStep(step, ctx) {
  // Idempotência: se já existe job OK pra esta etapa, pula
  const existing = await findExistingOkJob({
    client: ctx.client,
    cadastroId: ctx.cadastroId,
    step,
  });
  if (existing) {
    logStructuredEvent("info", "angellira.pipeline.step_skipped_already_ok", {
      cadastroId: ctx.cadastroId, step, existingJobId: existing.id,
    });
    // Restaura estado pra etapa próxima
    restoreStateFromExistingJob(step, existing, ctx.state);
    return { ok: true, status: "OK_CACHED", external_id: existing.external_id, response: existing.response };
  }

  const jobId = await markJobInProgress({
    client: ctx.client,
    cadastroId: ctx.cadastroId,
    step,
    payload: buildJobPayloadSnapshot(step, ctx),
  });

  try {
    let result;
    switch (step) {
      case "proprietario_cavalo":
        result = await stepProprietarioCavalo(ctx);
        break;
      case "cavalo":
        result = await stepVeiculo(ctx, "cavalo");
        break;
      case "proprietario_carreta":
        result = await stepProprietarioCarreta(ctx);
        break;
      case "carreta":
        result = await stepVeiculo(ctx, "carreta");
        break;
      case "motorista":
        result = await stepMotorista(ctx);
        break;
      default:
        throw new Error(`Step desconhecido: ${step}`);
    }
    await markJobOk({
      client: ctx.client,
      jobId,
      response: result.response,
      externalId: result.externalId,
    });
    return { ok: true, status: "OK", external_id: result.externalId, response: result.response };
  } catch (err) {
    const errorPayload = err instanceof AngelliraBotError
      ? err.toJSON()
      : { code: "PIPELINE_UNEXPECTED", message: err?.message || String(err) };
    await markJobError({ client: ctx.client, jobId, error: errorPayload });
    return { ok: false, status: "ERROR", error: errorPayload };
  }
}

function buildJobPayloadSnapshot(step, ctx) {
  // Snapshot só pra audit — não inclui PII completa
  return { step, cadastroId: ctx.cadastroId };
}

function restoreStateFromExistingJob(step, existing, state) {
  if (step === "proprietario_cavalo" && existing.external_id) {
    state.cavaloOwnerId = existing.external_id;
  }
  if (step === "proprietario_carreta" && existing.external_id) {
    state.carretaOwnerId = existing.external_id;
  }
  if (step === "cavalo" && existing.external_id) {
    state.cavaloVehicleId = existing.external_id;
  }
  if (step === "carreta" && existing.external_id) {
    state.carretaVehicleId = existing.external_id;
  }
  if (step === "motorista" && existing.external_id) {
    state.motoristaDriverId = existing.external_id;
  }
}

// ── Steps ────────────────────────────────────────────────────────────────

async function stepProprietarioCavalo(ctx) {
  // Wizard v2: owner embutido em dados.cavalo (owner_doc/owner_doc_type).
  const owner = resolveVehicleOwner(ctx.dados, ctx.dados?.cavalo);
  if (!owner || !owner.doc) {
    throw new AngelliraBotError({
      code: "OWNER_CAVALO_AUSENTE",
      message: "Proprietário do cavalo não informado (owner_doc ausente em dados.cavalo).",
      acao: "Confirme a etapa de veículo/proprietário no wizard de cadastro.",
    });
  }
  const docType = owner.doc_type || extractOwnerDocType(ctx.dados?.cavalo);
  const fallbackEndereco = ctx.dados?.motorista?.endereco || ctx.dados?.endereco;
  const { tipo, payload } = mapProprietarioPayload(owner, docType, fallbackEndereco);

  ctx.state.cavaloOwnerDocType = docType;
  ctx.state.cavaloOwnerDoc = digitsOnly(payload.cpf || payload.cnpj);

  const result = await cadastrarProprietario({
    idCadastro: ctx.cadastroId,
    tipo,
    payload,
    correlationId: ctx.correlationId,
  });
  ctx.state.cavaloOwnerId = result.ownerId;
  return { externalId: toExternalId(result.ownerId), response: result.raw };
}

async function stepProprietarioCarreta(ctx) {
  const carretaEntry = Array.isArray(ctx.dados?.carretas)
    ? ctx.dados.carretas[0]
    : ctx.dados?.carreta;

  // 1) owner explícito legado (dados.carreta_owner(s)); 2) embutido no veículo.
  let owner = extractCarretaOwner(ctx.dados, 0);
  if (!owner) owner = resolveVehicleOwner(ctx.dados, carretaEntry);

  // Reaproveita o proprietário do cavalo quando: owner_reuse pede, OU é o mesmo
  // doc do cavalo, OU não há owner próprio identificável na carreta.
  const sameDocAsCavalo = !!owner?.doc && !!ctx.state.cavaloOwnerDoc
    && digitsOnly(owner.doc) === ctx.state.cavaloOwnerDoc;
  const reuseCavalo = ownerReusesCavalo(ctx.dados) || sameDocAsCavalo || !owner?.doc;

  if (reuseCavalo) {
    if (!ctx.state.cavaloOwnerId) {
      throw new AngelliraBotError({
        code: "OWNER_CARRETA_AUSENTE",
        message: "Proprietário da carreta reaproveita o do cavalo, mas o cavalo owner não foi cadastrado.",
        acao: "Verifique a etapa proprietario_cavalo (deve rodar antes).",
      });
    }
    ctx.state.carretaOwnerId = ctx.state.cavaloOwnerId;
    ctx.state.carretaOwnerDocType = ctx.state.cavaloOwnerDocType;
    ctx.state.carretaOwnerDoc = ctx.state.cavaloOwnerDoc;
    return { externalId: toExternalId(ctx.state.cavaloOwnerId), response: { reused_from_cavalo: true } };
  }

  // owner próprio da carreta (doc diferente do cavalo)
  const docType = owner.doc_type || extractOwnerDocType(carretaEntry);
  const fallbackEndereco = ctx.dados?.motorista?.endereco || ctx.dados?.endereco;
  const { tipo, payload } = mapProprietarioPayload(owner, docType, fallbackEndereco);

  ctx.state.carretaOwnerDocType = docType;
  ctx.state.carretaOwnerDoc = digitsOnly(payload.cpf || payload.cnpj);

  const result = await cadastrarProprietario({
    idCadastro: ctx.cadastroId,
    tipo,
    payload,
    correlationId: ctx.correlationId,
  });
  ctx.state.carretaOwnerId = result.ownerId;
  return { externalId: toExternalId(result.ownerId), response: result.raw };
}

async function stepVeiculo(ctx, sub) {
  const veiculoData = sub === "cavalo"
    ? ctx.dados?.cavalo
    : (Array.isArray(ctx.dados?.carretas) ? ctx.dados.carretas[0] : ctx.dados?.carreta);

  if (!veiculoData || !veiculoData.placa) {
    throw new AngelliraBotError({
      code: "VEICULO_PAYLOAD_AUSENTE",
      message: `Dados do ${sub} ausentes — etapa pulada.`,
    });
  }

  const ownerCpf = sub === "cavalo"
    ? (ctx.state.cavaloOwnerDocType === "cpf" ? ctx.state.cavaloOwnerDoc : "")
    : (ctx.state.carretaOwnerDocType === "cpf" ? ctx.state.carretaOwnerDoc : "");
  const ownerCnpj = sub === "cavalo"
    ? (ctx.state.cavaloOwnerDocType === "cnpj" ? ctx.state.cavaloOwnerDoc : "")
    : (ctx.state.carretaOwnerDocType === "cnpj" ? ctx.state.carretaOwnerDoc : "");
  // Fallback robusto: quando o proprietário veio de job OK em cache, só o ownerId
  // é restaurado (não o doc/docType) — então passamos owner_id pro bot resolver
  // direto, evitando resolve_owner com cpf vazio em re-tentativas de veículo.
  const ownerId = Number(
    sub === "cavalo" ? ctx.state.cavaloOwnerId : ctx.state.carretaOwnerId,
  ) || 0;

  const result = await cadastrarVeiculo({
    idCadastro: ctx.cadastroId,
    sub,
    payload: mapVeiculoPayload(veiculoData),
    ownerCpf,
    ownerCnpj,
    ownerId,
    correlationId: ctx.correlationId,
  });
  if (sub === "cavalo") ctx.state.cavaloVehicleId = result.vehicleId;
  if (sub === "carreta") ctx.state.carretaVehicleId = result.vehicleId;
  return { externalId: toExternalId(result.vehicleId), response: result.raw };
}

async function stepMotorista(ctx) {
  const payload = mapMotoristaPayload(ctx.dados);
  const result = await cadastrarMotorista({
    idCadastro: ctx.cadastroId,
    payload,
    correlationId: ctx.correlationId,
  });
  ctx.state.motoristaDriverId = result.driverId;
  return { externalId: toExternalId(result.driverId), response: result.raw };
}

/**
 * Converte um id externo (number|string|null|undefined) em string ou null.
 * Sem isso, `String(null)` virava a string literal `"null"` no banco.
 * Test E2E (DC-111 / 2026-05-28): bot Angellira pode retornar vehicleId
 * null quando o veículo já existia (etapa OK mas sem novo id atribuído).
 */
function toExternalId(value) {
  if (value === null || value === undefined || value === "" || value === "null") {
    return null;
  }
  return String(value);
}

// ── Atualiza driver_profiles ─────────────────────────────────────────────

async function updateDriverProfileFromResults({ client, driverUserId, results }) {
  const userId = stripUuidIfInvalid(driverUserId);
  if (!userId) return;

  const motoristaJob = results.find((r) => r.step === "motorista");
  const cavaloJob = results.find((r) => r.step === "cavalo");
  const carretaJob = results.find((r) => r.step === "carreta");
  const proprietarioCavaloJob = results.find((r) => r.step === "proprietario_cavalo");

  const overallOk = results.every((r) => r.ok);
  const someError = results.some((r) => !r.ok);
  const status = overallOk
    ? "OK"
    : (someError ? "ERROR" : "IN_PROGRESS");

  const lastError = results
    .filter((r) => !r.ok && r.error)
    .map((r) => ({ step: r.step, ...r.error }))[0] || null;

  const vehicleIds = {};
  if (cavaloJob?.external_id) vehicleIds.cavalo = cavaloJob.external_id;
  if (carretaJob?.external_id) vehicleIds.carreta = carretaJob.external_id;

  await client.query(
    `
      UPDATE public.driver_profiles
      SET angellira_registration_status = $1,
          angellira_driver_id = COALESCE($2, angellira_driver_id),
          angellira_owner_id = COALESCE($3, angellira_owner_id),
          angellira_vehicle_ids = COALESCE(angellira_vehicle_ids, '{}'::jsonb) || $4::jsonb,
          angellira_registration_at = now(),
          angellira_last_error = $5,
          updated_at = now()
      WHERE user_id = $6
    `,
    [
      status,
      motoristaJob?.external_id || null,
      proprietarioCavaloJob?.external_id || null,
      JSON.stringify(vehicleIds),
      lastError,
      userId,
    ],
  );
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}
