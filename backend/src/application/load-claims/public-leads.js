import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../infrastructure/security-audit.js";
import {
  CANONICAL_VEHICLE_PROFILES,
  getTrailerPlateRequirement,
  normalizeVehicleProfile,
} from "../../domain/vehicle-profiles.js";
import {
  rehydrateStoredValidationSummary,
  validatePublicLeadPreRegistration,
} from "./public-lead-validation.js";

import {
  ConflictError,
  FeatureDisabledError,
  ForbiddenError,
  LoadClaimServiceError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from "../../domain/load-claims/errors.js";
import { createCorrelationId } from "./helpers.js";
import { logLoadClaimEvent } from "./logging.js";
import { LOAD_STATUS, PUBLIC_LEAD_EVENT_TYPE, PUBLIC_LEAD_STATUS } from "../../domain/load-claims/constants.js";
import { lookupAspxDriverByCpf } from "../../infrastructure/aspx/aspx-directory.js";
const DEFAULT_PUBLIC_LEAD_PRE_REGISTRATION_MAX_ATTEMPTS = 6;
const DEFAULT_PUBLIC_LEAD_PRE_REGISTRATION_WINDOW_SECONDS = 600;
const DEFAULT_PUBLIC_LEAD_WHATSAPP_QUEUE_MAX_ATTEMPTS = 8;
const DEFAULT_PUBLIC_LEAD_WHATSAPP_QUEUE_WINDOW_SECONDS = 600;
const SAVEPOINT_NAME = "public_lead_op";
const savepointSupportByClient = new WeakMap();

function parsePositiveIntegerEnv(name, defaultValue) {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
}

export function hasPublicLeadWhatsAppRouting() {
  return Boolean((process.env.PUBLIC_LOAD_WHATSAPP_NUMBER || "").replace(/\D/g, ""));
}

function getPublicLeadAbuseConfig() {
  return {
    preRegistrationMaxAttempts: parsePositiveIntegerEnv(
      "PUBLIC_LEAD_PRE_REGISTRATION_MAX_ATTEMPTS",
      DEFAULT_PUBLIC_LEAD_PRE_REGISTRATION_MAX_ATTEMPTS,
    ),
    preRegistrationWindowSeconds: parsePositiveIntegerEnv(
      "PUBLIC_LEAD_PRE_REGISTRATION_WINDOW_SECONDS",
      DEFAULT_PUBLIC_LEAD_PRE_REGISTRATION_WINDOW_SECONDS,
    ),
    whatsappQueueMaxAttempts: parsePositiveIntegerEnv(
      "PUBLIC_LEAD_WHATSAPP_QUEUE_MAX_ATTEMPTS",
      DEFAULT_PUBLIC_LEAD_WHATSAPP_QUEUE_MAX_ATTEMPTS,
    ),
    whatsappQueueWindowSeconds: parsePositiveIntegerEnv(
      "PUBLIC_LEAD_WHATSAPP_QUEUE_WINDOW_SECONDS",
      DEFAULT_PUBLIC_LEAD_WHATSAPP_QUEUE_WINDOW_SECONDS,
    ),
  };
}

function getPublicLeadWhatsAppNumber() {
  const digits = (process.env.PUBLIC_LOAD_WHATSAPP_NUMBER || "").replace(/\D/g, "");

  if (!digits) {
    throw new FeatureDisabledError("O canal do WhatsApp desta carga ainda nao foi configurado.");
  }

  if (digits.startsWith("55")) {
    return digits;
  }

  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }

  throw new FeatureDisabledError("O canal do WhatsApp desta carga ainda nao foi configurado corretamente.");
}

function assertPublicLeadWhatsAppRoutingConfigured({ loadId, leadId = null, correlationId, clientIp, scope }) {
  if (hasPublicLeadWhatsAppRouting()) {
    return;
  }

  logLoadClaimEvent("warn", "load-public-leads.whatsapp.unavailable", {
    correlation_id: correlationId,
    load_id: loadId,
    lead_id: leadId,
    request_ip: clientIp ?? null,
    scope,
  });

  throw new FeatureDisabledError("O canal do WhatsApp desta carga ainda nao foi configurado.");
}

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePlate(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeVehicleType(value) {
  return normalizeVehicleProfile(value, "");
}

function validateCpf(cpf) {
  if (cpf.length !== 11) {
    throw new ValidationError("CPF invalido. Informe um CPF com 11 digitos.", {
      field: "cpf",
    });
  }
}

function validatePhone(phone) {
  if (phone.length < 10 || phone.length > 13) {
    throw new ValidationError("Telefone invalido. Informe um numero com DDD.", {
      field: "phone",
    });
  }
}

function validatePlate(plate, field) {
  if (plate.length !== 7) {
    throw new ValidationError("Placa invalida. Informe uma placa com 7 caracteres.", {
      field,
    });
  }
}

function validateVehicleType(vehicleType) {
  if (!CANONICAL_VEHICLE_PROFILES.includes(vehicleType)) {
    throw new ValidationError("Tipo de veiculo invalido para a disputa publica.", {
      field: "vehicleType",
    });
  }
}

function normalizeTrailerPlates(vehicleType, trailerPlate, trailerPlate2) {
  const trailerPlateRequirement = getTrailerPlateRequirement(vehicleType);
  const normalizedTrailerPlate = trailerPlateRequirement >= 1 ? normalizePlate(trailerPlate) : "";
  const normalizedTrailerPlate2 = trailerPlateRequirement >= 2 ? normalizePlate(trailerPlate2) : "";

  if (trailerPlateRequirement >= 1) {
    validatePlate(normalizedTrailerPlate, "trailerPlate");
  }

  if (trailerPlateRequirement >= 2) {
    validatePlate(normalizedTrailerPlate2, "trailerPlate2");
  }

  return {
    trailerPlate: normalizedTrailerPlate,
    trailerPlate2: normalizedTrailerPlate2,
  };
}

function normalizePreRegistrationPayload(payload) {
  const vehicleType = normalizeVehicleType(payload?.vehicleType);
  validateVehicleType(vehicleType);
  const normalizedTrailerPlates = normalizeTrailerPlates(vehicleType, payload?.trailerPlate, payload?.trailerPlate2);
  const normalizedPayload = {
    cpf: normalizeCpf(payload?.cpf),
    phone: normalizePhone(payload?.phone),
    horsePlate: normalizePlate(payload?.horsePlate),
    trailerPlate: normalizedTrailerPlates.trailerPlate,
    trailerPlate2: normalizedTrailerPlates.trailerPlate2,
    vehicleType,
  };

  validateCpf(normalizedPayload.cpf);
  validatePhone(normalizedPayload.phone);
  validatePlate(normalizedPayload.horsePlate, "horsePlate");

  return normalizedPayload;
}

function assertVehicleTypeMatchesLoad(loadRow, vehicleType) {
  const requiredVehicleType = normalizeVehicleProfile(loadRow?.perfil, "CARRETA");

  if (requiredVehicleType !== vehicleType) {
    throw new ValidationError("Esta carga so aceita o tipo de veiculo solicitado nela.", {
      field: "vehicleType",
      requiredVehicleType,
    });
  }
}

function buildLoadUnavailableError(loadRow) {
  return new ConflictError("A carga nao esta mais disponivel para entrar na fila publica.", {
    code: "LOAD_NOT_OPEN",
    loadStatus: loadRow?.status || null,
  });
}

function serializePublicLead(leadRow, queuePosition = null) {
  if (!leadRow) {
    return null;
  }

  return {
    id: leadRow.id,
    status: leadRow.status,
    cpf: maskCpf(leadRow.cpf),
    phone: maskPhone(leadRow.phone),
    horsePlate: leadRow.horse_plate,
    trailerPlate: leadRow.trailer_plate,
    trailerPlate2: leadRow.trailer_plate_2 || "",
    vehicleType: leadRow.vehicle_type,
    preRegisteredAt: leadRow.pre_registered_at,
    queuedAt: leadRow.queued_at,
    whatsappClickedAt: leadRow.whatsapp_clicked_at,
    approvedAt: leadRow.approved_at,
    approvedBy: leadRow.approved_by,
    validation: rehydrateStoredValidationSummary(leadRow.validation_summary_json, {
      status: leadRow.validation_status,
      checkedAt: leadRow.validation_checked_at,
    }),
    queuePosition,
  };
}

function normalizeActorId(value) {
  const normalizedValue = String(value || "").trim();
  return normalizedValue ? normalizedValue.slice(0, 128) : null;
}

function isMissingPublicLeadRedactionColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("pii_redacted_at");
}

function isMissingPublicLeadSecondTrailerColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("trailer_plate_2");
}

function isMissingPublicLeadValidationColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("validation_status") ||
    combinedMessage.includes("validation_summary_json") ||
    combinedMessage.includes("validation_checked_at")
  );
}

function createPublicLeadSchemaUpdateError() {
  return new LoadClaimServiceError(
    "O pre-cadastro desta carga esta passando por uma atualizacao. Tente novamente em alguns instantes.",
    {
      code: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    },
  );
}

async function runWithTransactionSavepoint(client, callback) {
  if (savepointSupportByClient.get(client) === false) {
    return callback();
  }

  try {
    await client.query(`SAVEPOINT ${SAVEPOINT_NAME}`);
  } catch (error) {
    const normalizedMessage = `${error?.message || ""}`.toLowerCase();

    if (normalizedMessage.includes("failed to parse")) {
      savepointSupportByClient.set(client, false);
      return callback();
    }

    throw error;
  }

  try {
    const result = await callback();
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    throw error;
  }
}

function maskCpf(cpf) {
  const digits = normalizeCpf(cpf);

  if (digits.length !== 11) {
    return "***.***.***-**";
  }

  return `***.***.***-${digits.slice(-2)}`;
}

function maskPhone(phone) {
  const digits = normalizePhone(phone);

  if (digits.length < 4) {
    return "********";
  }

  const localNumber = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  const areaCode = localNumber.slice(0, 2);
  const suffix = localNumber.slice(-4);

  if (areaCode.length === 2) {
    return `(${areaCode}) *****-${suffix}`;
  }

  return `*******${suffix}`;
}

function maskPlate(plate) {
  const normalizedPlate = normalizePlate(plate);

  if (normalizedPlate.length !== 7) {
    return "*******";
  }

  return `${normalizedPlate.slice(0, 3)}***${normalizedPlate.slice(-1)}`;
}

function serializeLoadSummary(loadRow) {
  if (!loadRow) {
    return null;
  }

  return {
    id: loadRow.id,
    status: loadRow.status,
    origem: loadRow.origem,
    destino: loadRow.destino,
    perfil: loadRow.perfil,
    data: loadRow.data,
    horario: loadRow.horario,
    reservedAt: loadRow.reserved_at,
    reservedUntil: loadRow.reserved_until,
    reservedPublicLeadId: loadRow.reserved_public_lead_id,
  };
}

async function getLoadById(client, loadId, { lock = false } = {}) {
  const lockingClause = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `
      SELECT
        id,
        status,
        origem,
        destino,
        perfil,
        data,
        horario,
        reserved_at,
        reserved_until,
        reserved_driver_id,
        reserved_claim_id,
        reserved_public_lead_id,
        version
      FROM public.cargas
      WHERE id = $1
      ${lockingClause}
    `,
    [loadId],
  );

  return rows[0] ?? null;
}

async function getPublicLeadByIdentity(
  client,
  { loadId, cpf, phone, horsePlate, trailerPlate, trailerPlate2 },
  { lock = false } = {},
) {
  const lockingClause = lock ? "FOR UPDATE" : "";
  let rows;

  try {
    const result = await runWithTransactionSavepoint(client, () =>
      client.query(
        `
          SELECT *
          FROM public.load_public_leads
          WHERE load_id = $1
            AND cpf = $2
            AND phone = $3
            AND horse_plate = $4
            AND trailer_plate = $5
            AND trailer_plate_2 = $6
            AND status = ANY($7::text[])
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          ${lockingClause}
        `,
        [
          loadId,
          cpf,
          phone,
          horsePlate,
          trailerPlate,
          trailerPlate2,
          [PUBLIC_LEAD_STATUS.PRE_REGISTERED, PUBLIC_LEAD_STATUS.QUEUED, PUBLIC_LEAD_STATUS.APPROVED],
        ],
      ),
    );
    rows = result.rows;
  } catch (error) {
    if (!isMissingPublicLeadSecondTrailerColumnError(error)) {
      throw error;
    }

    if (trailerPlate2) {
      throw createPublicLeadSchemaUpdateError();
    }

    const fallbackResult = await client.query(
      `
        SELECT *
        FROM public.load_public_leads
        WHERE load_id = $1
          AND cpf = $2
          AND phone = $3
          AND horse_plate = $4
          AND trailer_plate = $5
          AND status = ANY($6::text[])
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        ${lockingClause}
      `,
      [
        loadId,
        cpf,
        phone,
        horsePlate,
        trailerPlate,
        [PUBLIC_LEAD_STATUS.PRE_REGISTERED, PUBLIC_LEAD_STATUS.QUEUED, PUBLIC_LEAD_STATUS.APPROVED],
      ],
    );
    rows = fallbackResult.rows;
  }

  return rows[0] ?? null;
}

async function getPublicLeadById(client, leadId, { lock = false } = {}) {
  const lockingClause = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.load_public_leads
      WHERE id = $1
      ${lockingClause}
    `,
    [leadId],
  );

  return rows[0] ?? null;
}

async function insertPublicLeadEvent(client, event) {
  await client.query(
    `
      INSERT INTO public.load_public_lead_events (
        load_id,
        lead_id,
        event_type,
        event_payload_json,
        actor_type,
        actor_id
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    `,
    [
      event.loadId,
      event.leadId,
      event.eventType,
      JSON.stringify(event.payload ?? {}),
      event.actorType,
      event.actorId ?? null,
    ],
  );
}

async function assertPublicLeadAttemptAllowed(
  client,
  { loadId, clientIp, eventTypes, maxAttempts, windowSeconds, scopeLabel, correlationId },
) {
  const actorId = normalizeActorId(clientIp);

  if (!actorId) {
    return;
  }

  const windowStart = new Date(Date.now() - windowSeconds * 1_000).toISOString();

  const { rows } = await client.query(
    `
      SELECT COUNT(*)::int AS attempt_count
      FROM public.load_public_lead_events
      WHERE load_id = $1
        AND actor_type = 'request-ip'
        AND actor_id = $2
        AND event_type = ANY($3::text[])
        AND created_at >= $4::timestamptz
    `,
    [loadId, actorId, eventTypes, windowStart],
  );

  const attemptCount = rows[0]?.attempt_count ?? 0;

  if (attemptCount >= maxAttempts) {
    await insertSecurityAuditEvent(client, {
      eventType: "public-leads.request.rate_limited",
      severity: "warn",
      actorRole: "public-driver",
      resourceType: "public-load-lead",
      resourceId: loadId,
      action: scopeLabel,
      outcome: "denied",
      requestIp: actorId,
      correlationId,
      metadata: {
        eventTypes,
        maxAttempts,
        windowSeconds,
      },
    });

    throw new TooManyRequestsError("Muitas tentativas para esta carga. Aguarde antes de tentar novamente.", {
      scope: scopeLabel,
      retryAfterSeconds: windowSeconds,
    });
  }
}

async function recordPublicLeadIpEvent(client, { loadId, leadId, eventType, clientIp, correlationId }) {
  const actorId = normalizeActorId(clientIp);

  if (!actorId) {
    return;
  }

  await insertPublicLeadEvent(client, {
    loadId,
    leadId,
    eventType,
    payload: {
      correlation_id: correlationId,
    },
    actorType: "request-ip",
    actorId,
  });
}

async function computeQueuedPosition(client, leadRow) {
  if (!leadRow?.queued_at || leadRow.status !== PUBLIC_LEAD_STATUS.QUEUED) {
    return null;
  }

  const { rows } = await client.query(
    `
      SELECT COUNT(*)::int AS position
      FROM public.load_public_leads
      WHERE load_id = $1
        AND status = $2
        AND queued_at IS NOT NULL
        AND (
          queued_at < $3
          OR (queued_at = $3 AND created_at < $4)
          OR (queued_at = $3 AND created_at = $4 AND id <= $5)
        )
    `,
    [
      leadRow.load_id,
      PUBLIC_LEAD_STATUS.QUEUED,
      leadRow.queued_at,
      leadRow.created_at,
      leadRow.id,
    ],
  );

  return rows[0]?.position ?? null;
}

function buildWhatsAppUrl(loadRow, leadRow, whatsappNumber = getPublicLeadWhatsAppNumber()) {
  const messageLines = [
    "Ola! Tenho interesse nesta carga.",
    `Carga: ${loadRow.id}`,
    `Rota: ${loadRow.origem} -> ${loadRow.destino}`,
    `Tipo de veiculo: ${leadRow.vehicle_type}`,
    `Placa cavalo: ${leadRow.horse_plate}`,
  ];

  if (leadRow.trailer_plate) {
    messageLines.push(`1a placa carreta: ${leadRow.trailer_plate}`);
  }

  if (leadRow.trailer_plate_2) {
    messageLines.push(`2a placa carreta: ${leadRow.trailer_plate_2}`);
  }

  const message = messageLines.join("\n");

  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
}

function buildPhoneWhatsAppUrl(phone) {
  const digits = normalizePhone(phone);
  const withCountryCode = digits.startsWith("55") ? digits : `55${digits}`;
  return `https://wa.me/${withCountryCode}`;
}

async function insertPreRegisteredLead(client, { loadId, normalizedPayload }) {
  let rows;

  try {
    const result = await runWithTransactionSavepoint(client, () =>
      client.query(
        `
          INSERT INTO public.load_public_leads (
            load_id,
            cpf,
            phone,
            horse_plate,
            trailer_plate,
            trailer_plate_2,
            vehicle_type,
            status,
            pre_registered_at,
            queued_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
          RETURNING *
        `,
        [
          loadId,
          normalizedPayload.cpf,
          normalizedPayload.phone,
          normalizedPayload.horsePlate,
          normalizedPayload.trailerPlate,
          normalizedPayload.trailerPlate2,
          normalizedPayload.vehicleType,
          PUBLIC_LEAD_STATUS.QUEUED,
        ],
      ),
    );
    rows = result.rows;
  } catch (error) {
    if (!isMissingPublicLeadSecondTrailerColumnError(error)) {
      throw error;
    }

    if (normalizedPayload.trailerPlate2) {
      throw createPublicLeadSchemaUpdateError();
    }

    const fallbackResult = await client.query(
      `
        INSERT INTO public.load_public_leads (
          load_id,
          cpf,
          phone,
            horse_plate,
            trailer_plate,
            vehicle_type,
            status,
            pre_registered_at,
            queued_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
        RETURNING *
      `,
      [
        loadId,
        normalizedPayload.cpf,
        normalizedPayload.phone,
        normalizedPayload.horsePlate,
        normalizedPayload.trailerPlate,
        normalizedPayload.vehicleType,
        PUBLIC_LEAD_STATUS.QUEUED,
      ],
    );
    rows = fallbackResult.rows;
  }

  return rows[0];
}

async function persistPublicLeadValidationSnapshot(client, { leadId, validationSummary, correlationId }) {
  if (!validationSummary) {
    return null;
  }

  try {
    const { rows } = await client.query(
      `
        UPDATE public.load_public_leads
        SET validation_status = $2,
            validation_checked_at = $3::timestamptz,
            validation_summary_json = $4::jsonb,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [leadId, validationSummary.overallStatus, validationSummary.checkedAt, JSON.stringify(validationSummary)],
    );

    return rows[0] ?? null;
  } catch (error) {
    if (!isMissingPublicLeadValidationColumnError(error)) {
      throw error;
    }

    logLoadClaimEvent("warn", "load-public-leads.validation.snapshot_unavailable", {
      correlation_id: correlationId,
      lead_id: leadId,
    });

    return null;
  }
}

/**
 * Roda a validacao do lead em background (fora da transacao principal) e
 * persiste o snapshot resultante. Disparado como fire-and-forget para que a
 * resposta ao motorista nao dependa das APIs externas.
 *
 * Em ambiente serverless (Vercel Node), a funcao continua viva ate o event loop
 * drenar, dentro do limite de `maxDuration` configurado em vercel.json.
 */
async function runDeferredPublicLeadValidation({ loadId, leadId, normalizedPayload, correlationId }) {
  try {
    const validationResult = await validatePublicLeadPreRegistration({
      loadId,
      payload: normalizedPayload,
      candidateSubmittedAt: new Date().toISOString(),
      correlationId,
    });

    await withPgClient((client) =>
      persistPublicLeadValidationSnapshot(client, {
        leadId,
        validationSummary: validationResult.storedSummary,
        correlationId,
      }),
    );

    logLoadClaimEvent("info", "load-public-leads.validation.deferred_completed", {
      correlation_id: correlationId,
      load_id: loadId,
      lead_id: leadId,
      overall_status: validationResult.storedSummary?.overallStatus || null,
    });
  } catch (error) {
    logLoadClaimEvent("error", "load-public-leads.validation.deferred_failed", {
      correlation_id: correlationId,
      load_id: loadId,
      lead_id: leadId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Revalida em lote os leads p\u00fablicos ativos (PRE_REGISTERED, QUEUED, APPROVED).
 * Usado pelo bot\u00e3o "Verificar no Angellira" na tela de Fila do operador.
 * Cancelados ficam de fora: motoristas j\u00e1 reprovados n\u00e3o precisam nova checagem.
 * Limitado para n\u00e3o estourar `maxDuration` do Vercel (30s).
 */
// Cap e deadline calibrados para caber no maxDuration do Vercel (30s).
// Um pool cold do Angellira pode levar 12-15s por CPF, ent\u00e3o com concorr\u00eancia
// 8 dois batches encadeados j\u00e1 encostariam em 30s. Reduzimos o teto e, al\u00e9m
// disso, abortamos graciosamente se faltar menos que X ms at\u00e9 o deadline.
const REVALIDATE_QUEUED_BATCH_LIMIT = 16;
const REVALIDATE_QUEUED_CONCURRENCY = 8;
// Margem entre o \u00faltimo batch e o maxDuration (resposta + DB + rede do cliente).
const REVALIDATE_SOFT_DEADLINE_MS = 22_000;
// Statuses a revalidar: tudo que ainda \u00e9 "ativo" na Fila. CANCELLED foge disso.
const REVALIDATE_ACTIVE_STATUSES = [
  PUBLIC_LEAD_STATUS.PRE_REGISTERED,
  PUBLIC_LEAD_STATUS.QUEUED,
  PUBLIC_LEAD_STATUS.APPROVED,
];

// Status terminais da carga (espelha TERMINAL_LOAD_STATUSES do frontend Leads.tsx).
// Histórico = carga em status terminal; Fila = carga viva.
const TERMINAL_LOAD_STATUSES_SQL = ["EXPIRED", "CANCELLED", "COMPLETED", "FAILED", "BOOKED"];

function buildLoadStatusScopeClause(scope) {
  // `fila`:      cargas.status NOT IN (terminais)
  // `historico`: cargas.status IN     (terminais)
  if (scope === "historico") {
    return { sql: "cargas.status = ANY($3::text[])", args: [TERMINAL_LOAD_STATUSES_SQL] };
  }
  return { sql: "cargas.status <> ALL($3::text[])", args: [TERMINAL_LOAD_STATUSES_SQL] };
}

export async function revalidateQueuedPublicLeads({ correlationId, scope = "fila" } = {}) {
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const scopeClause = buildLoadStatusScopeClause(scope);

  const leadRows = await withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT
          lpl.id,
          lpl.load_id,
          lpl.cpf,
          lpl.phone,
          lpl.horse_plate,
          lpl.trailer_plate,
          lpl.trailer_plate_2,
          lpl.vehicle_type
        FROM public.load_public_leads lpl
        JOIN public.cargas cargas ON cargas.id = lpl.load_id
        WHERE lpl.status = ANY($1::text[])
          AND ${scopeClause.sql}
        ORDER BY lpl.queued_at DESC NULLS LAST, lpl.created_at DESC
        LIMIT $2
      `,
      [REVALIDATE_ACTIVE_STATUSES, REVALIDATE_QUEUED_BATCH_LIMIT, ...scopeClause.args],
    );
    return rows;
  });

  const startedAt = Date.now();
  let revalidated = 0;
  let failed = 0;
  let processed = 0;
  let abortedByDeadline = false;

  for (let i = 0; i < leadRows.length; i += REVALIDATE_QUEUED_CONCURRENCY) {
    // Deadline guard: se o batch anterior j\u00e1 consumiu o or\u00e7amento, paramos
    // antes de iniciar o pr\u00f3ximo. O Angellira chegando em ~15s faz 2 batches
    // cheios estourarem o maxDuration=30s (FUNCTION_INVOCATION_TIMEOUT).
    if (Date.now() - startedAt >= REVALIDATE_SOFT_DEADLINE_MS) {
      abortedByDeadline = true;
      break;
    }

    const batch = leadRows.slice(i, i + REVALIDATE_QUEUED_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (leadRow) => {
        const payload = {
          cpf: leadRow.cpf || "",
          phone: leadRow.phone || "",
          horsePlate: leadRow.horse_plate || "",
          trailerPlate: leadRow.trailer_plate || "",
          trailerPlate2: leadRow.trailer_plate_2 || "",
          vehicleType: leadRow.vehicle_type || "",
        };
        const validationResult = await validatePublicLeadPreRegistration({
          loadId: leadRow.load_id,
          payload,
          candidateSubmittedAt: new Date().toISOString(),
          correlationId: resolvedCorrelationId,
        });
        await withPgClient((client) =>
          persistPublicLeadValidationSnapshot(client, {
            leadId: leadRow.id,
            validationSummary: validationResult.storedSummary,
            correlationId: resolvedCorrelationId,
          }),
        );
        return leadRow.id;
      }),
    );

    processed += batch.length;
    for (const result of results) {
      if (result.status === "fulfilled") {
        revalidated += 1;
      } else {
        failed += 1;
        logLoadClaimEvent("error", "load-public-leads.revalidate-queued.failed", {
          correlation_id: resolvedCorrelationId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  logLoadClaimEvent("info", "load-public-leads.revalidate-queued.completed", {
    correlation_id: resolvedCorrelationId,
    total: leadRows.length,
    processed,
    revalidated,
    failed,
    aborted_by_deadline: abortedByDeadline,
    duration_ms: Date.now() - startedAt,
    limit: REVALIDATE_QUEUED_BATCH_LIMIT,
  });

  return {
    statusCode: 200,
    payload: {
      ok: true,
      total: leadRows.length,
      revalidated,
      failed,
      limit: REVALIDATE_QUEUED_BATCH_LIMIT,
      // Truncado = ou batch cheio OU interrompido pelo deadline.
      truncated: leadRows.length === REVALIDATE_QUEUED_BATCH_LIMIT || abortedByDeadline,
      abortedByDeadline,
      meta: {
        correlationId: resolvedCorrelationId,
      },
    },
  };
}

/**
 * Revalida em lote apenas o ASPx para leads ativos (PRE_REGISTERED, QUEUED,
 * APPROVED) com CPF informado. Muito mais r\u00e1pido que a revalida\u00e7\u00e3o completa:
 * a planilha ASPx \u00e9 baixada 1x e consultada em mem\u00f3ria (cache in-process).
 *
 * Faz merge parcial em validation_summary_json.driver.aspx preservando o que
 * j\u00e1 existir sob `driver` (ex: angelira). Usa uma constru\u00e7\u00e3o via `jsonb_set`
 * aninhado em vez de um \u00fanico `jsonb_set('{driver,aspx}', ...)`, porque este
 * \u00faltimo \u00e9 no-op silencioso quando `driver` ainda n\u00e3o existe no JSON.
 */
// ASPx \u00e9 pr\u00f3ximo de instant\u00e2neo por CPF (map lookup em cache), ent\u00e3o podemos
// revalidar um cap maior que o Angellira sem risco de timeout.
const REVALIDATE_ASPX_BATCH_LIMIT = 200;
const REVALIDATE_ASPX_CONCURRENCY = 10;

export async function revalidateQueuedPublicLeadsAspx({ correlationId, scope = "fila" } = {}) {
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const scopeClause = buildLoadStatusScopeClause(scope);

  const leadRows = await withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT lpl.id, lpl.cpf
        FROM public.load_public_leads lpl
        JOIN public.cargas cargas ON cargas.id = lpl.load_id
        WHERE lpl.status = ANY($1::text[])
          AND lpl.cpf IS NOT NULL AND lpl.cpf <> ''
          AND ${scopeClause.sql}
        ORDER BY lpl.queued_at DESC NULLS LAST, lpl.created_at DESC
        LIMIT $2
      `,
      [REVALIDATE_ACTIVE_STATUSES, REVALIDATE_ASPX_BATCH_LIMIT, ...scopeClause.args],
    );
    return rows;
  });

  let revalidated = 0;
  let failed = 0;
  let updatedFound = 0;

  for (let i = 0; i < leadRows.length; i += REVALIDATE_ASPX_CONCURRENCY) {
    const batch = leadRows.slice(i, i + REVALIDATE_ASPX_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (leadRow) => {
        const lookup = await lookupAspxDriverByCpf(leadRow.cpf, {
          correlationId: resolvedCorrelationId,
        });
        if (lookup.availability !== "OK") {
          return { skipped: true };
        }
        const aspxSnapshot = {
          status: lookup.status || "NOT_FOUND",
          found: Boolean(lookup.found),
          displayName: lookup.displayName || null,
        };
        // jsonb_set com path '{driver,aspx}' n\u00e3o cria o n\u00f3 intermedi\u00e1rio
        // `driver` se ele n\u00e3o existir \u2014 o UPDATE vira no-op silencioso.
        // Solu\u00e7\u00e3o: setar o pr\u00f3prio n\u00f3 `driver` com o merge manual dos campos.
        await withPgClient((client) =>
          client.query(
            `
              UPDATE public.load_public_leads
              SET validation_summary_json = jsonb_set(
                    COALESCE(validation_summary_json, '{}'::jsonb),
                    '{driver}',
                    COALESCE(validation_summary_json -> 'driver', '{}'::jsonb)
                      || jsonb_build_object('aspx', $2::jsonb),
                    true
                  ),
                  updated_at = now()
              WHERE id = $1
            `,
            [leadRow.id, JSON.stringify(aspxSnapshot)],
          ),
        );
        return { updated: true, found: aspxSnapshot.found };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value?.updated) {
          revalidated += 1;
          if (result.value.found) updatedFound += 1;
        }
      } else {
        failed += 1;
        logLoadClaimEvent("warn", "load-public-leads.revalidate-aspx.failed", {
          correlation_id: resolvedCorrelationId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  logLoadClaimEvent("info", "load-public-leads.revalidate-aspx.completed", {
    correlation_id: resolvedCorrelationId,
    total: leadRows.length,
    revalidated,
    found: updatedFound,
    failed,
    limit: REVALIDATE_ASPX_BATCH_LIMIT,
  });

  return {
    statusCode: 200,
    payload: {
      ok: true,
      total: leadRows.length,
      revalidated,
      foundInAspx: updatedFound,
      failed,
      limit: REVALIDATE_ASPX_BATCH_LIMIT,
      truncated: leadRows.length === REVALIDATE_ASPX_BATCH_LIMIT,
      meta: { correlationId: resolvedCorrelationId },
    },
  };
}

export async function createPublicLoadLeadPreRegistration({ loadId, payload, correlationId, requestContext = {} }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const normalizedPayload = normalizePreRegistrationPayload(payload);
  const abuseConfig = getPublicLeadAbuseConfig();

  const transactionResult = await withPgTransaction(async (client) => {
    const loadRow = await getLoadById(client, loadId);

    if (!loadRow) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    if (loadRow.status !== LOAD_STATUS.OPEN) {
      throw buildLoadUnavailableError(loadRow);
    }

    assertVehicleTypeMatchesLoad(loadRow, normalizedPayload.vehicleType);

    await assertPublicLeadAttemptAllowed(client, {
      loadId,
      clientIp: requestContext.clientIp,
      eventTypes: [PUBLIC_LEAD_EVENT_TYPE.PRE_REGISTERED],
      maxAttempts: abuseConfig.preRegistrationMaxAttempts,
      windowSeconds: abuseConfig.preRegistrationWindowSeconds,
      scopeLabel: "public-lead-pre-registration",
      correlationId: resolvedCorrelationId,
    });

    let leadRow = await getPublicLeadByIdentity(client, {
      loadId,
      cpf: normalizedPayload.cpf,
      phone: normalizedPayload.phone,
      horsePlate: normalizedPayload.horsePlate,
      trailerPlate: normalizedPayload.trailerPlate,
      trailerPlate2: normalizedPayload.trailerPlate2,
    });
    let reused = Boolean(leadRow);

    if (!leadRow) {
      leadRow = await insertPreRegisteredLead(client, {
        loadId,
        normalizedPayload,
      });

      await insertPublicLeadEvent(client, {
        loadId,
        leadId: leadRow.id,
        eventType: PUBLIC_LEAD_EVENT_TYPE.PRE_REGISTERED,
        payload: {
          correlation_id: resolvedCorrelationId,
          vehicle_type: normalizedPayload.vehicleType,
        },
        actorType: "public-driver",
        actorId: normalizedPayload.cpf,
      });

      await insertPublicLeadEvent(client, {
        loadId,
        leadId: leadRow.id,
        eventType: PUBLIC_LEAD_EVENT_TYPE.QUEUED,
        payload: {
          correlation_id: resolvedCorrelationId,
          source: "PRE_REGISTRATION",
        },
        actorType: "public-driver",
        actorId: normalizedPayload.cpf,
      });
    } else if (leadRow.status === PUBLIC_LEAD_STATUS.APPROVED) {
      throw new ConflictError("Essa tentativa ja foi aprovada e a carga nao aceita um novo pre-cadastro ativo.", {
        code: "LEAD_ALREADY_APPROVED",
      });
    } else if (
      leadRow.vehicle_type !== normalizedPayload.vehicleType ||
      leadRow.trailer_plate !== normalizedPayload.trailerPlate ||
      (leadRow.trailer_plate_2 || "") !== normalizedPayload.trailerPlate2
    ) {
      let rows;

      try {
        const result = await runWithTransactionSavepoint(client, () =>
          client.query(
            `
              UPDATE public.load_public_leads
              SET vehicle_type = $2,
                  trailer_plate = $3,
                  trailer_plate_2 = $4,
                  updated_at = now()
              WHERE id = $1
              RETURNING *
            `,
            [leadRow.id, normalizedPayload.vehicleType, normalizedPayload.trailerPlate, normalizedPayload.trailerPlate2],
          ),
        );
        rows = result.rows;
      } catch (error) {
        if (!isMissingPublicLeadSecondTrailerColumnError(error)) {
          throw error;
        }

        if (normalizedPayload.trailerPlate2) {
          throw createPublicLeadSchemaUpdateError();
        }

        const fallbackResult = await client.query(
          `
            UPDATE public.load_public_leads
            SET vehicle_type = $2,
                trailer_plate = $3,
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `,
          [leadRow.id, normalizedPayload.vehicleType, normalizedPayload.trailerPlate],
        );
        rows = fallbackResult.rows;
      }
      leadRow = rows[0] ?? leadRow;
    }

    if (leadRow.status !== PUBLIC_LEAD_STATUS.QUEUED) {
      const { rows } = await client.query(
        `
          UPDATE public.load_public_leads
          SET status = $2,
              queued_at = COALESCE(queued_at, now()),
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [leadRow.id, PUBLIC_LEAD_STATUS.QUEUED],
      );

      leadRow = rows[0] ?? leadRow;

      await insertPublicLeadEvent(client, {
        loadId,
        leadId: leadRow.id,
        eventType: PUBLIC_LEAD_EVENT_TYPE.QUEUED,
        payload: {
          correlation_id: resolvedCorrelationId,
          source: "PRE_REGISTRATION_REUSE",
        },
        actorType: "public-driver",
        actorId: leadRow.cpf,
      });
    }

    await recordPublicLeadIpEvent(client, {
      loadId,
      leadId: leadRow.id,
      eventType: PUBLIC_LEAD_EVENT_TYPE.PRE_REGISTERED,
      clientIp: requestContext.clientIp,
      correlationId: resolvedCorrelationId,
    });

    // Validacao detachada: o motorista recebe a resposta imediatamente e a
    // checagem contra Angellira/ASPx roda em background, atualizando o snapshot
    // depois. Se o lead ja tem snapshot persistido de uma submissao anterior,
    // reaproveitamos enquanto a re-validacao corre.
    const existingValidationSummary = rehydrateStoredValidationSummary(leadRow.validation_summary_json, {
      status: leadRow.validation_status,
      checkedAt: leadRow.validation_checked_at,
    });

    const validationPending = !existingValidationSummary;

    const queuePosition =
      leadRow.status === PUBLIC_LEAD_STATUS.QUEUED ? await computeQueuedPosition(client, leadRow) : null;

    const response = {
      ok: true,
      lead: {
        ...serializePublicLead(leadRow, queuePosition),
        validation: existingValidationSummary,
      },
      load: serializeLoadSummary(loadRow),
      meta: {
        correlationId: resolvedCorrelationId,
        reused,
        validationPending,
      },
    };

    logLoadClaimEvent("info", "load-public-leads.pre-registration.saved", {
      correlation_id: resolvedCorrelationId,
      load_id: loadId,
      lead_id: leadRow.id,
      reused,
      lead_status: leadRow.status,
    });

    return {
      statusCode: reused ? 200 : 201,
      payload: response,
      leadId: leadRow.id,
      validationPending,
    };
  });

  // Fire-and-forget: so dispara depois do commit para nao prender a resposta
  // do motorista enquanto Angellira/ASPx sao consultados. Em Vercel Node, o
  // container aguarda o event loop drenar ate o limite de maxDuration.
  if (transactionResult.validationPending && transactionResult.leadId) {
    void runDeferredPublicLeadValidation({
      loadId,
      leadId: transactionResult.leadId,
      normalizedPayload,
      correlationId: resolvedCorrelationId,
    });
  }

  return {
    statusCode: transactionResult.statusCode,
    payload: transactionResult.payload,
  };
}

export async function queuePublicLoadLeadViaWhatsApp({ loadId, leadId, correlationId, requestContext = {} }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const abuseConfig = getPublicLeadAbuseConfig();
  assertPublicLeadWhatsAppRoutingConfigured({
    loadId,
    leadId,
    correlationId: resolvedCorrelationId,
    clientIp: requestContext.clientIp,
    scope: "whatsapp-queue",
  });

  return withPgTransaction(async (client) => {
    const loadRow = await getLoadById(client, loadId, { lock: true });

    if (!loadRow) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    if (loadRow.status !== LOAD_STATUS.OPEN) {
      throw buildLoadUnavailableError(loadRow);
    }

    let leadRow = await getPublicLeadById(client, leadId, { lock: true });

    if (!leadRow || leadRow.load_id !== loadId) {
      throw new NotFoundError("Lead publico nao encontrado para esta carga.");
    }

    await assertPublicLeadAttemptAllowed(client, {
      loadId,
      clientIp: requestContext.clientIp,
      eventTypes: [PUBLIC_LEAD_EVENT_TYPE.WHATSAPP_CLICKED],
      maxAttempts: abuseConfig.whatsappQueueMaxAttempts,
      windowSeconds: abuseConfig.whatsappQueueWindowSeconds,
      scopeLabel: "public-lead-whatsapp-queue",
      correlationId: resolvedCorrelationId,
    });

    if (leadRow.status === PUBLIC_LEAD_STATUS.CANCELLED) {
      throw new ConflictError("Esse lead publico foi cancelado e nao pode mais entrar na fila.", {
        code: "LEAD_CANCELLED",
      });
    }

    if (leadRow.status === PUBLIC_LEAD_STATUS.APPROVED) {
      throw new ConflictError("Esse lead publico ja foi aprovado pelo operador.", {
        code: "LEAD_ALREADY_APPROVED",
      });
    }

    const whatsappUrl = buildWhatsAppUrl(loadRow, leadRow);

    const shouldMarkQueued = leadRow.status !== PUBLIC_LEAD_STATUS.QUEUED;
    const shouldMarkWhatsappClicked = !leadRow.whatsapp_clicked_at;

    if (shouldMarkQueued || shouldMarkWhatsappClicked) {
      const { rows } = await client.query(
        `
          UPDATE public.load_public_leads
          SET status = $2,
              queued_at = COALESCE(queued_at, now()),
              whatsapp_clicked_at = COALESCE(whatsapp_clicked_at, now()),
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [leadId, PUBLIC_LEAD_STATUS.QUEUED],
      );
      leadRow = rows[0] ?? leadRow;
    }

    if (shouldMarkWhatsappClicked) {
      await insertPublicLeadEvent(client, {
        loadId,
        leadId,
        eventType: PUBLIC_LEAD_EVENT_TYPE.WHATSAPP_CLICKED,
        payload: {
          correlation_id: resolvedCorrelationId,
        },
        actorType: "public-driver",
        actorId: leadRow.cpf,
      });
    }

    if (shouldMarkQueued) {
      await insertPublicLeadEvent(client, {
        loadId,
        leadId,
        eventType: PUBLIC_LEAD_EVENT_TYPE.QUEUED,
        payload: {
          correlation_id: resolvedCorrelationId,
        },
        actorType: "public-driver",
        actorId: leadRow.cpf,
      });
    }

    await recordPublicLeadIpEvent(client, {
      loadId,
      leadId,
      eventType: PUBLIC_LEAD_EVENT_TYPE.WHATSAPP_CLICKED,
      clientIp: requestContext.clientIp,
      correlationId: resolvedCorrelationId,
    });

    const queuePosition = await computeQueuedPosition(client, leadRow);

    logLoadClaimEvent("info", "load-public-leads.whatsapp.queued", {
      correlation_id: resolvedCorrelationId,
      load_id: loadId,
      lead_id: leadId,
      queue_position: queuePosition,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lead: serializePublicLead(leadRow, queuePosition),
        load: serializeLoadSummary(loadRow),
        whatsappUrl,
        meta: {
          correlationId: resolvedCorrelationId,
        },
      },
    };
  });
}

function groupLeadsForOperator(rows) {
  const groupsMap = new Map();

  rows.forEach((row) => {
    const existingGroup = groupsMap.get(row.load_id) || {
      load: {
        id: row.load_id,
        status: row.load_status,
        origem: row.load_origem,
        destino: row.load_destino,
        perfil: row.load_perfil,
        data: row.load_data,
        horario: row.load_horario,
        reservedPublicLeadId: row.load_reserved_public_lead_id,
        sheetLh: row.load_sheet_lh || null,
        sheetDataCarregamento: row.load_sheet_data_carregamento || null,
        sheetDataDescarga: row.load_sheet_data_descarga || null,
        sheetMotorista: row.load_sheet_motorista || null,
        sheetCavalo: row.load_sheet_cavalo || null,
        sheetCarreta: row.load_sheet_carreta || null,
        sheetStatus: row.load_sheet_status || null,
      },
      queueCount: 0,
      totalLeads: 0,
      leads: [],
    };

    const queuePosition = row.status === PUBLIC_LEAD_STATUS.QUEUED ? existingGroup.queueCount + 1 : null;

    existingGroup.leads.push({
      id: row.id,
      status: row.status,
      cpf: row.cpf || "",
      phone: row.phone || "",
      horsePlate: row.horse_plate || "",
      trailerPlate: row.trailer_plate || "",
      trailerPlate2: row.trailer_plate_2 || "",
      vehicleType: row.vehicle_type,
      preRegisteredAt: row.pre_registered_at,
      queuedAt: row.queued_at,
      whatsappClickedAt: row.whatsapp_clicked_at,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      validation: rehydrateStoredValidationSummary(row.validation_summary_json, {
        status: row.validation_status,
        checkedAt: row.validation_checked_at,
      }),
      queuePosition,
      whatsappUrl: buildPhoneWhatsAppUrl(row.phone),
    });

    if (row.status === PUBLIC_LEAD_STATUS.QUEUED) {
      existingGroup.queueCount += 1;
    }

    existingGroup.totalLeads += 1;
    groupsMap.set(row.load_id, existingGroup);
  });

  return Array.from(groupsMap.values());
}

export async function listOperatorPublicLoadLeads({ correlationId }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();

  return withPgTransaction(async (client) => {
    let rows;

    try {
      const result = await runWithTransactionSavepoint(client, () =>
        client.query(
          `
            SELECT
              leads.*,
              cargas.id AS load_id,
              cargas.status AS load_status,
              cargas.origem AS load_origem,
              cargas.destino AS load_destino,
              cargas.perfil AS load_perfil,
              cargas.data AS load_data,
              cargas.horario AS load_horario,
              cargas.reserved_public_lead_id AS load_reserved_public_lead_id,
              cargas.sheet_lh AS load_sheet_lh,
              cargas.sheet_data_carregamento AS load_sheet_data_carregamento,
              cargas.sheet_data_descarga AS load_sheet_data_descarga,
              cargas.sheet_motorista AS load_sheet_motorista,
              cargas.sheet_cavalo AS load_sheet_cavalo,
              cargas.sheet_carreta AS load_sheet_carreta,
              cargas.sheet_status AS load_sheet_status
            FROM public.load_public_leads AS leads
            INNER JOIN public.cargas
              ON cargas.id = leads.load_id
            WHERE leads.status = ANY($1::text[])
              AND (leads.status = 'QUEUED' OR leads.pii_redacted_at IS NULL)
            ORDER BY COALESCE(leads.queued_at, leads.created_at) ASC, leads.created_at ASC, leads.id ASC
          `,
          [[PUBLIC_LEAD_STATUS.QUEUED, PUBLIC_LEAD_STATUS.APPROVED]],
        ),
      );
      rows = result.rows;
    } catch (error) {
      if (!isMissingPublicLeadRedactionColumnError(error)) {
        throw error;
      }

      const fallbackResult = await client.query(
        `
          SELECT
            leads.*,
            cargas.id AS load_id,
            cargas.status AS load_status,
            cargas.origem AS load_origem,
            cargas.destino AS load_destino,
            cargas.perfil AS load_perfil,
            cargas.data AS load_data,
            cargas.horario AS load_horario,
            cargas.reserved_public_lead_id AS load_reserved_public_lead_id,
            cargas.sheet_lh AS load_sheet_lh,
            cargas.sheet_data_carregamento AS load_sheet_data_carregamento,
            cargas.sheet_data_descarga AS load_sheet_data_descarga,
            cargas.sheet_motorista AS load_sheet_motorista,
            cargas.sheet_cavalo AS load_sheet_cavalo,
            cargas.sheet_carreta AS load_sheet_carreta
          FROM public.load_public_leads AS leads
          INNER JOIN public.cargas
            ON cargas.id = leads.load_id
          WHERE leads.status = ANY($1::text[])
          ORDER BY COALESCE(leads.queued_at, leads.created_at) ASC, leads.created_at ASC, leads.id ASC
        `,
        [[PUBLIC_LEAD_STATUS.QUEUED, PUBLIC_LEAD_STATUS.APPROVED]],
      );
      rows = fallbackResult.rows;
    }

    // Include OPEN/RESERVED cargas that have no active leads — they should remain
    // visible in the fila after their last lead is cancelled.
    const activeLoadIds = new Set(rows.map(r => r.load_id));
    const { rows: emptyLoadRows } = await client.query(
      `
        SELECT
          cargas.id AS load_id,
          cargas.status AS load_status,
          cargas.origem AS load_origem,
          cargas.destino AS load_destino,
          cargas.perfil AS load_perfil,
          cargas.data AS load_data,
          cargas.horario AS load_horario,
          cargas.reserved_public_lead_id AS load_reserved_public_lead_id,
          cargas.sheet_lh AS load_sheet_lh,
          cargas.sheet_data_carregamento AS load_sheet_data_carregamento,
          cargas.sheet_data_descarga AS load_sheet_data_descarga,
          cargas.sheet_motorista AS load_sheet_motorista,
          cargas.sheet_cavalo AS load_sheet_cavalo,
          cargas.sheet_carreta AS load_sheet_carreta,
          cargas.sheet_status AS load_sheet_status
        FROM public.cargas
        WHERE cargas.status = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM public.load_public_leads leads
            WHERE leads.load_id = cargas.id
              AND leads.status = ANY($2::text[])
          )
      `,
      [["OPEN", "RESERVED"], [PUBLIC_LEAD_STATUS.QUEUED, PUBLIC_LEAD_STATUS.APPROVED]],
    );

    const emptyGroups = emptyLoadRows
      .filter(r => !activeLoadIds.has(r.load_id))
      .map(r => ({
        load: {
          id: r.load_id,
          status: r.load_status,
          origem: r.load_origem,
          destino: r.load_destino,
          perfil: r.load_perfil,
          data: r.load_data,
          horario: r.load_horario,
          reservedPublicLeadId: r.load_reserved_public_lead_id,
          sheetLh: r.load_sheet_lh || null,
          sheetDataCarregamento: r.load_sheet_data_carregamento || null,
          sheetDataDescarga: r.load_sheet_data_descarga || null,
          sheetMotorista: r.load_sheet_motorista || null,
          sheetCavalo: r.load_sheet_cavalo || null,
          sheetCarreta: r.load_sheet_carreta || null,
          sheetStatus: r.load_sheet_status || null,
        },
        queueCount: 0,
        totalLeads: 0,
        leads: [],
      }));

    return {
      statusCode: 200,
      payload: {
        groups: [...groupLeadsForOperator(rows), ...emptyGroups],
        meta: {
          correlationId: resolvedCorrelationId,
        },
      },
    };
  });
}

export async function createDirectLeadAllocation({ loadId, payload, operatorId, correlationId }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();

  const cpf = normalizeCpf(payload.cpf);
  const phone = normalizePhone(payload.phone);
  const horsePlate = normalizePlate(payload.horsePlate);
  const vehicleType = normalizeVehicleType(payload.vehicleType);
  const trailerPlate = payload.trailerPlate ? normalizePlate(payload.trailerPlate) : null;
  const trailerPlate2 = payload.trailerPlate2 ? normalizePlate(payload.trailerPlate2) : null;

  if (!cpf || cpf.length !== 11) {
    throw new ValidationError("CPF invalido (deve ter 11 digitos).");
  }
  if (!phone || phone.length < 10 || phone.length > 13) {
    throw new ValidationError("Telefone invalido (10-13 digitos com DDD).");
  }
  if (!horsePlate || horsePlate.length !== 7) {
    throw new ValidationError("Placa do cavalo invalida (7 caracteres alfanumericos).");
  }
  if (!vehicleType || !CANONICAL_VEHICLE_PROFILES.includes(vehicleType)) {
    throw new ValidationError("Tipo de veiculo invalido.");
  }

  return withPgTransaction(async (client) => {
    const loadRow = await getLoadById(client, loadId, { lock: true });

    if (!loadRow) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    if (loadRow.status !== LOAD_STATUS.OPEN) {
      throw buildLoadUnavailableError(loadRow);
    }

    const { rows: existingApproved } = await client.query(
      `SELECT id FROM public.load_public_leads WHERE load_id = $1 AND status = $2 LIMIT 1`,
      [loadId, PUBLIC_LEAD_STATUS.APPROVED],
    );

    if (existingApproved.length > 0) {
      throw new ConflictError("Esta carga ja tem um motorista aprovado.", {
        code: "LEAD_ALREADY_APPROVED",
      });
    }

    const { rows: leadRows } = await client.query(
      `
        INSERT INTO public.load_public_leads
          (load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2, vehicle_type, status, source,
           pre_registered_at, queued_at, approved_at, approved_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPERATOR_DIRECT',
                now(), now(), now(), $9, now(), now())
        RETURNING *
      `,
      [loadId, cpf, phone, horsePlate, trailerPlate, trailerPlate2, vehicleType, PUBLIC_LEAD_STATUS.APPROVED, operatorId],
    );
    const leadRow = leadRows[0];

    const { rows: reservedLoadRows } = await client.query(
      `
        UPDATE public.cargas
        SET status = $2,
            reserved_at = now(),
            reserved_until = null,
            reserved_driver_id = null,
            reserved_claim_id = null,
            reserved_public_lead_id = $3,
            version = version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING
          id, status, origem, destino, perfil, data, horario,
          reserved_at, reserved_until, reserved_public_lead_id, version
      `,
      [loadId, LOAD_STATUS.RESERVED, leadRow.id],
    );
    const reservedLoad = reservedLoadRows[0] ?? null;

    await insertPublicLeadEvent(client, {
      loadId,
      leadId: leadRow.id,
      eventType: PUBLIC_LEAD_EVENT_TYPE.APPROVED,
      payload: {
        correlation_id: resolvedCorrelationId,
        source: "OPERATOR_DIRECT",
      },
      actorType: "operator",
      actorId: operatorId,
    });

    logLoadClaimEvent("info", "load-public-leads.direct-allocation.reserved", {
      correlation_id: resolvedCorrelationId,
      load_id: loadId,
      lead_id: leadRow.id,
      operator_id: operatorId,
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        lead: serializePublicLead(leadRow),
        load: serializeLoadSummary(reservedLoad),
        meta: {
          correlationId: resolvedCorrelationId,
        },
      },
    };
  });
}

export async function approvePublicLoadLead({ loadId, leadId, operatorId, correlationId }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();

  return withPgTransaction(async (client) => {
    const loadRow = await getLoadById(client, loadId, { lock: true });

    if (!loadRow) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    let leadRow = await getPublicLeadById(client, leadId, { lock: true });

    if (!leadRow || leadRow.load_id !== loadId) {
      throw new NotFoundError("Lead publico nao encontrado para esta carga.");
    }

    if (
      loadRow.status === LOAD_STATUS.RESERVED &&
      loadRow.reserved_public_lead_id === leadId &&
      leadRow.status === PUBLIC_LEAD_STATUS.APPROVED
    ) {
      return {
        statusCode: 200,
        payload: {
          ok: true,
          lead: serializePublicLead(leadRow),
          load: serializeLoadSummary(loadRow),
          meta: {
            correlationId: resolvedCorrelationId,
            idempotent: true,
          },
        },
      };
    }

    if (loadRow.status !== LOAD_STATUS.OPEN) {
      throw buildLoadUnavailableError(loadRow);
    }

    if (leadRow.status !== PUBLIC_LEAD_STATUS.QUEUED) {
      throw new ConflictError("Apenas leads que ja entraram na fila podem ser reservados.", {
        code: "LEAD_NOT_QUEUED",
        leadStatus: leadRow.status,
      });
    }

    const { rows: approvedLeadRows } = await client.query(
      `
        UPDATE public.load_public_leads
        SET status = $2,
            approved_at = COALESCE(approved_at, now()),
            approved_by = $3,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [leadId, PUBLIC_LEAD_STATUS.APPROVED, operatorId],
    );
    leadRow = approvedLeadRows[0] ?? leadRow;

    await insertPublicLeadEvent(client, {
      loadId,
      leadId,
      eventType: PUBLIC_LEAD_EVENT_TYPE.APPROVED,
      payload: {
        correlation_id: resolvedCorrelationId,
      },
      actorType: "operator",
      actorId: operatorId,
    });

    const { rows: reservedLoadRows } = await client.query(
      `
        UPDATE public.cargas
        SET status = $2,
            reserved_at = now(),
            reserved_until = null,
            reserved_driver_id = null,
            reserved_claim_id = null,
            reserved_public_lead_id = $3,
            version = version + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING
          id,
          status,
          origem,
          destino,
          perfil,
          data,
          horario,
          reserved_at,
          reserved_until,
          reserved_public_lead_id,
          version
      `,
      [loadId, LOAD_STATUS.RESERVED, leadId],
    );
    const reservedLoad = reservedLoadRows[0] ?? null;

    logLoadClaimEvent("info", "load-public-leads.approve.reserved", {
      correlation_id: resolvedCorrelationId,
      load_id: loadId,
      lead_id: leadId,
      operator_id: operatorId,
      previous_load_status: loadRow.status,
      next_load_status: reservedLoad?.status || null,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lead: serializePublicLead(leadRow),
        load: serializeLoadSummary(reservedLoad),
        meta: {
          correlationId: resolvedCorrelationId,
          idempotent: false,
        },
      },
    };
  });
}

export async function cancelPublicLoadLead({ loadId, leadId, operatorId, correlationId }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();

  return withPgTransaction(async (client) => {
    const loadRow = await getLoadById(client, loadId, { lock: true });

    if (!loadRow) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    let leadRow = await getPublicLeadById(client, leadId, { lock: true });

    if (!leadRow || leadRow.load_id !== loadId) {
      throw new NotFoundError("Lead publico nao encontrado para esta carga.");
    }

    if (leadRow.status === PUBLIC_LEAD_STATUS.CANCELLED) {
      return {
        statusCode: 200,
        payload: {
          ok: true,
          lead: serializePublicLead(leadRow),
          load: serializeLoadSummary(loadRow),
          meta: {
            correlationId: resolvedCorrelationId,
            idempotent: true,
          },
        },
      };
    }

    if (
      leadRow.status !== PUBLIC_LEAD_STATUS.QUEUED &&
      leadRow.status !== PUBLIC_LEAD_STATUS.APPROVED &&
      leadRow.status !== PUBLIC_LEAD_STATUS.PRE_REGISTERED
    ) {
      throw new ConflictError("Esta candidatura nao pode mais ser cancelada.", {
        code: "LEAD_NOT_CANCELLABLE",
        leadStatus: leadRow.status,
      });
    }

    const previousLeadStatus = leadRow.status;
    const wasReservedLead =
      previousLeadStatus === PUBLIC_LEAD_STATUS.APPROVED &&
      loadRow.status === LOAD_STATUS.RESERVED &&
      loadRow.reserved_public_lead_id === leadId;

    const { rows: cancelledLeadRows } = await client.query(
      `
        UPDATE public.load_public_leads
        SET status = $2,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [leadId, PUBLIC_LEAD_STATUS.CANCELLED],
    );
    leadRow = cancelledLeadRows[0] ?? leadRow;

    await insertPublicLeadEvent(client, {
      loadId,
      leadId,
      eventType: PUBLIC_LEAD_EVENT_TYPE.CANCELLED,
      payload: {
        correlation_id: resolvedCorrelationId,
        previous_status: previousLeadStatus,
      },
      actorType: "operator",
      actorId: operatorId,
    });

    let nextLoadRow = loadRow;

    if (wasReservedLead) {
      const { rows: reopenedLoadRows } = await client.query(
        `
          UPDATE public.cargas
          SET status = $2,
              reserved_at = null,
              reserved_until = null,
              reserved_driver_id = null,
              reserved_claim_id = null,
              reserved_public_lead_id = null,
              version = version + 1,
              updated_at = now()
          WHERE id = $1
          RETURNING
            id,
            status,
            origem,
            destino,
            perfil,
            data,
            horario,
            reserved_at,
            reserved_until,
            reserved_public_lead_id,
            version
        `,
        [loadId, LOAD_STATUS.OPEN],
      );
      nextLoadRow = reopenedLoadRows[0] ?? loadRow;
    }

    logLoadClaimEvent("info", "load-public-leads.cancel.executed", {
      correlation_id: resolvedCorrelationId,
      load_id: loadId,
      lead_id: leadId,
      operator_id: operatorId,
      previous_lead_status: previousLeadStatus,
      was_reserved_lead: wasReservedLead,
      next_load_status: nextLoadRow?.status || null,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lead: serializePublicLead(leadRow),
        load: serializeLoadSummary(nextLoadRow),
        meta: {
          correlationId: resolvedCorrelationId,
          idempotent: false,
        },
      },
    };
  });
}

export function assertOperatorId(operatorId) {
  if (!operatorId) {
    throw new ForbiddenError("Nao foi possivel identificar o operador autenticado.");
  }
}
