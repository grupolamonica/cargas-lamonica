import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";

import { rehydrateStoredValidationSummary } from "./public-lead-validation.js";
import { getLoadClaimConfig } from "../../domain/load-claims/config.js";
import { hasPublicLeadWhatsAppRouting } from "./public-leads.js";
import {
  ACTIVE_CLAIM_STATUSES,
  CLAIM_EVENT_TYPE,
  CLAIM_STATUS,
  IDEMPOTENCY_SCOPE,
  LOAD_STATUS,
  RESERVATION_CLAIM_STATUSES,
  WAITLIST_CLAIM_STATUSES,
} from "../../domain/load-claims/constants.js";
import { evaluateDriverEligibility } from "../../domain/load-claims/eligibility.js";
import { transition } from "../../domain/load-claims/state-machine.js";
import { ConflictError, FeatureDisabledError, ForbiddenError, NotFoundError, ValidationError } from "../../domain/load-claims/errors.js";
import {
  buildClaimResponse,
  getReservationTtlSeconds,
  createCorrelationId,
  createRequestFingerprint,
} from "./helpers.js";
import { logLoadClaimEvent } from "./logging.js";

function ensureClaimSystemEnabled() {
  const config = getLoadClaimConfig();

  if (!config.claim_v2_enabled) {
    throw new FeatureDisabledError();
  }

  return config;
}

function requireIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey?.trim()) {
    throw new ValidationError("Idempotency-Key header is required.");
  }

  return idempotencyKey.trim();
}

function getIdempotencyExpirationDate(config) {
  return new Date(Date.now() + config.idempotency_ttl_seconds * 1_000).toISOString();
}

async function findLockedIdempotencyRecord(client, { scope, driverId, loadId, idempotencyKey }) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.idempotency_records
      WHERE scope = $1
        AND driver_id = $2
        AND load_id = $3
        AND idempotency_key = $4
      FOR UPDATE
    `,
    [scope, driverId, loadId, idempotencyKey],
  );

  return rows[0] ?? null;
}

async function insertIdempotencyRecord(client, { scope, driverId, loadId, idempotencyKey, requestHash, correlationId, expiresAt }) {
  const { rows } = await client.query(
    `
      INSERT INTO public.idempotency_records (
        scope,
        driver_id,
        load_id,
        idempotency_key,
        request_hash,
        correlation_id,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (scope, driver_id, load_id, idempotency_key)
      DO NOTHING
      RETURNING *
    `,
    [scope, driverId, loadId, idempotencyKey, requestHash, correlationId, expiresAt],
  );

  return rows[0] ?? null;
}

async function storeIdempotencyResponse(client, { scope, driverId, loadId, idempotencyKey, responseStatus, responseBody }) {
  await client.query(
    `
      UPDATE public.idempotency_records
      SET response_status = $5,
          response_body_json = $6
      WHERE scope = $1
        AND driver_id = $2
        AND load_id = $3
        AND idempotency_key = $4
    `,
    [scope, driverId, loadId, idempotencyKey, responseStatus, responseBody],
  );
}

async function lockLoadRow(client, loadId) {
  const { rows } = await client.query(
    `
      SELECT
        cargas.*
      FROM public.cargas
      WHERE cargas.id = $1
      FOR UPDATE
    `,
    [loadId],
  );

  const load = rows[0] ?? null;

  if (!load) {
    return null;
  }

  if (!load.cliente_id) {
    return {
      ...load,
      cliente_tipo_veiculo: null,
      cliente_exige_antt: null,
      cliente_exige_rastreamento: null,
      cliente_exige_seguro: null,
      cliente_exige_carga_monitorada: null,
      cliente_nome: null,
      cliente_descricao: null,
    };
  }

  const clientResult = await client.query(
    `
      SELECT
        tipo_veiculo AS cliente_tipo_veiculo,
        exige_antt AS cliente_exige_antt,
        exige_rastreamento AS cliente_exige_rastreamento,
        exige_seguro AS cliente_exige_seguro,
        exige_carga_monitorada AS cliente_exige_carga_monitorada,
        nome AS cliente_nome,
        descricao AS cliente_descricao
      FROM public.clientes
      WHERE id = $1
    `,
    [load.cliente_id],
  );

  return {
    ...load,
    ...(clientResult.rows[0] ?? {
      cliente_tipo_veiculo: null,
      cliente_exige_antt: null,
      cliente_exige_rastreamento: null,
      cliente_exige_seguro: null,
      cliente_exige_carga_monitorada: null,
      cliente_nome: null,
      cliente_descricao: null,
    }),
  };
}

async function getDriverProfile(client, driverId, { lock = false } = {}) {
  const lockingClause = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.driver_profiles
      WHERE user_id = $1
      ${lockingClause}
    `,
    [driverId],
  );

  return rows[0] ?? null;
}

async function findLatestClaimForDriver(client, { loadId, driverId, statuses = ACTIVE_CLAIM_STATUSES, lock = false }) {
  const lockingClause = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.load_claims
      WHERE load_id = $1
        AND driver_id = $2
        AND status = ANY($3::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      ${lockingClause}
    `,
    [loadId, driverId, statuses],
  );

  return rows[0] ?? null;
}

async function getClaimById(client, claimId, { lock = false } = {}) {
  const lockingClause = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.load_claims
      WHERE id = $1
      ${lockingClause}
    `,
    [claimId],
  );

  return rows[0] ?? null;
}

async function insertAuditEvent(client, event) {
  await client.query(
    `
      INSERT INTO public.load_claim_events (
        load_id,
        claim_id,
        driver_id,
        event_type,
        event_payload_json,
        actor_type,
        actor_id,
        correlation_id
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
    `,
    [
      event.loadId,
      event.claimId ?? null,
      event.driverId ?? null,
      event.eventType,
      JSON.stringify(event.payload ?? {}),
      event.actorType,
      event.actorId ?? null,
      event.correlationId ?? null,
    ],
  );
}

async function createClaimRow(client, { loadId, driverId, idempotencyKey, requestHash, correlationId, requestPayload }) {
  const { rows } = await client.query(
    `
      INSERT INTO public.load_claims (
        load_id,
        driver_id,
        status,
        idempotency_key,
        request_fingerprint,
        request_payload_json,
        correlation_id
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      RETURNING *
    `,
    [
      loadId,
      driverId,
      CLAIM_STATUS.PENDING,
      idempotencyKey,
      requestHash,
      JSON.stringify(requestPayload ?? {}),
      correlationId,
    ],
  );

  return rows[0];
}

const ALLOWED_CLAIM_UPDATE_COLUMNS = new Set([
  "status",
  "queue_position",
  "rejected_reason",
  "promoted_at",
  "confirmed_at",
  "expired_at",
  "cancelled_at",
  "reservation_expires_at",
  "reserved_until",
  "booked_at",
  "metadata",
]);

async function updateClaimRow(client, claimId, updates) {
  const fields = [];
  const values = [];

  Object.entries(updates).forEach(([key, value], index) => {
    if (!ALLOWED_CLAIM_UPDATE_COLUMNS.has(key)) {
      throw new Error(`[updateClaimRow] Illegal column name: "${key}". Add to ALLOWED_CLAIM_UPDATE_COLUMNS if intentional.`);
    }
    fields.push(`${key} = $${index + 2}`);
    values.push(value);
  });

  const { rows } = await client.query(
    `
      UPDATE public.load_claims
      SET ${fields.join(", ")}
      WHERE id = $1
      RETURNING *
    `,
    [claimId, ...values],
  );

  return rows[0] ?? null;
}

async function updateLoadReservation(client, { loadId, driverId, claimId, nextStatus, ttlSeconds }) {
  const ttl = getReservationTtlSeconds(ttlSeconds);
  const { rows } = await client.query(
    `
      UPDATE public.cargas
      SET status = $2,
          reserved_driver_id = $3,
          reserved_claim_id = $4,
          reserved_at = now(),
          reserved_until = now() + ($5 || ' seconds')::interval,
          booked_driver_id = NULL,
          booked_at = NULL,
          version = version + 1,
          published_at = COALESCE(published_at, now())
      WHERE id = $1
      RETURNING *
    `,
    [loadId, nextStatus, driverId, claimId, ttl],
  );

  return rows[0] ?? null;
}

async function clearLoadReservation(client, loadId, nextStatus = LOAD_STATUS.OPEN) {
  const { rows } = await client.query(
    `
      UPDATE public.cargas
      SET status = $2,
          reserved_driver_id = NULL,
          reserved_claim_id = NULL,
          reserved_at = NULL,
          reserved_until = NULL,
          version = version + 1,
          published_at = COALESCE(published_at, now())
      WHERE id = $1
      RETURNING *
    `,
    [loadId, nextStatus],
  );

  return rows[0] ?? null;
}

async function bookLoadForClaim(client, { loadId, driverId }) {
  const { rows } = await client.query(
    `
      UPDATE public.cargas
      SET status = $2,
          reserved_driver_id = NULL,
          reserved_claim_id = NULL,
          reserved_at = NULL,
          reserved_until = NULL,
          booked_driver_id = $3,
          booked_at = now(),
          version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [loadId, LOAD_STATUS.BOOKED, driverId],
  );

  return rows[0] ?? null;
}

async function getWaitlistClaims(client, loadId) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.load_claims
      WHERE load_id = $1
        AND status = ANY($2::text[])
      ORDER BY server_sequence ASC, claimed_at ASC, id ASC
      FOR UPDATE
    `,
    [loadId, WAITLIST_CLAIM_STATUSES],
  );

  return rows;
}

async function resequenceWaitlist(client, loadId) {
  const waitlistClaims = await getWaitlistClaims(client, loadId);

  if (waitlistClaims.length === 0) {
    return 0;
  }

  const claimIdsToUpdate = [];
  const expectedPositions = [];

  waitlistClaims.forEach((claim, index) => {
    const expectedPosition = index + 1;
    if (claim.queue_position !== expectedPosition) {
      claimIdsToUpdate.push(claim.id);
      expectedPositions.push(expectedPosition);
    }
  });

  if (claimIdsToUpdate.length > 0) {
    for (let i = 0; i < claimIdsToUpdate.length; i++) {
      await client.query(
        `
          UPDATE public.load_claims
          SET queue_position = $2
          WHERE id = $1
        `,
        [claimIdsToUpdate[i], expectedPositions[i]],
      );
    }
  }

  return waitlistClaims.length;
}

async function rejectRemainingWaitlistClaims(client, { loadId, correlationId, actorType, actorId }) {
  const waitlistClaims = await getWaitlistClaims(client, loadId);

  if (waitlistClaims.length === 0) {
    return;
  }

  // FSM pre-validation: all waitlist claims must be in a state that allows 'reject'
  for (const c of waitlistClaims) {
    transition(c.status, "reject");
  }

  const claimIds = waitlistClaims.map((c) => c.id);
  const idPlaceholders = claimIds.map((_, i) => `$${i + 3}`).join(", ");

  const { rows: rejectedClaims } = await client.query(
    `
      UPDATE public.load_claims
      SET status = $1, queue_position = NULL, rejected_reason = $2
      WHERE id IN (${idPlaceholders})
      RETURNING *
    `,
    [CLAIM_STATUS.REJECTED, "LOAD_BOOKED_BY_ANOTHER_DRIVER", ...claimIds],
  );

  if (rejectedClaims.length > 0) {
    for (const rejectedClaim of rejectedClaims) {
      await client.query(
        `
          INSERT INTO public.load_claim_events (
            load_id, claim_id, driver_id, event_type, event_payload_json,
            actor_type, actor_id, correlation_id
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
        `,
        [
          loadId,
          rejectedClaim.id,
          rejectedClaim.driver_id,
          CLAIM_EVENT_TYPE.CLAIM_REJECTED,
          JSON.stringify({ reason: "LOAD_BOOKED_BY_ANOTHER_DRIVER" }),
          actorType,
          actorId ?? null,
          correlationId ?? null,
        ],
      );
    }
  }
}

async function batchGetDriverProfiles(client, driverIds) {
  if (driverIds.length === 0) {
    return new Map();
  }

  const placeholders = driverIds.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.driver_profiles
      WHERE user_id IN (${placeholders})
      FOR UPDATE
    `,
    driverIds,
  );

  return new Map(rows.map((row) => [row.user_id, row]));
}

async function promoteNextEligibleClaim(client, { loadRow, correlationId, actorType, actorId, config }) {
  const waitlistClaims = await getWaitlistClaims(client, loadRow.id);

  // Batch-fetch all driver profiles in one query instead of one SELECT per claim
  const driverIds = [...new Set(waitlistClaims.map((c) => c.driver_id))];
  const profilesByDriverId = await batchGetDriverProfiles(client, driverIds);

  for (const claim of waitlistClaims) {
    const driverProfile = profilesByDriverId.get(claim.driver_id) ?? null;
    const eligibility = evaluateDriverEligibility({
      driverProfile,
      loadRow,
    });

    if (!eligibility.eligible) {
      const rejectedClaim = await updateClaimRow(client, claim.id, {
        status: transition(claim.status, "reject"),
        queue_position: null,
        rejected_reason: eligibility.rejectedReason,
      });

      await insertAuditEvent(client, {
        loadId: loadRow.id,
        claimId: rejectedClaim.id,
        driverId: rejectedClaim.driver_id,
        eventType: CLAIM_EVENT_TYPE.WAITLIST_SKIPPED_INELIGIBLE,
        actorType,
        actorId,
        correlationId,
        payload: {
          rejectedReason: eligibility.rejectedReason,
          reasons: eligibility.reasons,
        },
      });
      continue;
    }

    const promotedClaim = await updateClaimRow(client, claim.id, {
      status: transition(claim.status, "promote"),
      queue_position: null,
      promoted_at: new Date().toISOString(),
      rejected_reason: null,
    });

    const reservedLoad = await updateLoadReservation(client, {
      loadId: loadRow.id,
      driverId: promotedClaim.driver_id,
      claimId: promotedClaim.id,
      nextStatus: LOAD_STATUS.RESERVED,
      ttlSeconds: config.reservation_ttl_seconds,
    });

    await insertAuditEvent(client, {
      loadId: reservedLoad.id,
      claimId: promotedClaim.id,
      driverId: promotedClaim.driver_id,
      eventType: CLAIM_EVENT_TYPE.CLAIM_PROMOTED,
      actorType,
      actorId,
      correlationId,
      payload: {
        reservedUntil: reservedLoad.reserved_until,
      },
    });

    await insertAuditEvent(client, {
      loadId: reservedLoad.id,
      claimId: promotedClaim.id,
      driverId: promotedClaim.driver_id,
      eventType: CLAIM_EVENT_TYPE.LOAD_RESERVED,
      actorType,
      actorId,
      correlationId,
      payload: {
        source: "WAITLIST_PROMOTION",
        reservedUntil: reservedLoad.reserved_until,
      },
    });

    await resequenceWaitlist(client, loadRow.id);
    return {
      loadRow: reservedLoad,
      claimRow: promotedClaim,
    };
  }

  const reopenedLoad = await clearLoadReservation(client, loadRow.id, LOAD_STATUS.OPEN);

  await insertAuditEvent(client, {
    loadId: reopenedLoad.id,
    claimId: null,
    driverId: null,
    eventType: CLAIM_EVENT_TYPE.LOAD_REOPENED,
    actorType,
    actorId,
    correlationId,
    payload: {
      reason: "WAITLIST_EMPTY",
    },
  });

  return {
    loadRow: reopenedLoad,
    claimRow: null,
  };
}

async function expireCurrentReservationIfNeeded(client, { loadRow, correlationId, actorType, actorId, config }) {
  if (loadRow.status !== LOAD_STATUS.RESERVED || !loadRow.reserved_claim_id) {
    return loadRow;
  }

  if (!loadRow.reserved_until || new Date(loadRow.reserved_until).getTime() > Date.now()) {
    return loadRow;
  }

  const currentReservedClaim = await getClaimById(client, loadRow.reserved_claim_id, { lock: true });

  if (currentReservedClaim && RESERVATION_CLAIM_STATUSES.includes(currentReservedClaim.status)) {
    await updateClaimRow(client, currentReservedClaim.id, {
      status: transition(currentReservedClaim.status, "expire"),
      expired_at: new Date().toISOString(),
      queue_position: null,
    });

    await insertAuditEvent(client, {
      loadId: loadRow.id,
      claimId: currentReservedClaim.id,
      driverId: currentReservedClaim.driver_id,
      eventType: CLAIM_EVENT_TYPE.CLAIM_EXPIRED,
      actorType,
      actorId,
      correlationId,
      payload: {
        reservedUntil: loadRow.reserved_until,
      },
    });
  }

  await clearLoadReservation(client, loadRow.id, LOAD_STATUS.OPEN);
  const promotionResult = await promoteNextEligibleClaim(client, {
    loadRow: { ...loadRow, status: LOAD_STATUS.OPEN },
    correlationId,
    actorType,
    actorId,
    config,
  });

  return promotionResult.loadRow;
}

async function prepareIdempotencyRecord(client, { scope, driverId, loadId, idempotencyKey, requestHash, correlationId, config }) {
  const insertedRecord = await insertIdempotencyRecord(client, {
    scope,
    driverId,
    loadId,
    idempotencyKey,
    requestHash,
    correlationId,
    expiresAt: getIdempotencyExpirationDate(config),
  });

  const idempotencyRecord =
    insertedRecord ||
    (await findLockedIdempotencyRecord(client, {
      scope,
      driverId,
      loadId,
      idempotencyKey,
    }));

  if (idempotencyRecord) {
    if (idempotencyRecord.request_hash !== requestHash) {
      throw new ConflictError("The same Idempotency-Key cannot be reused with a different payload.", {
        code: "IDEMPOTENCY_CONFLICT",
      });
    }

    if (idempotencyRecord.response_body_json) {
      return {
        replay: true,
        record: idempotencyRecord,
      };
    }

    // O registro existe mas ainda nao tem resposta — outra request concorrente pode estar
    // processando o mesmo idempotency key. O FOR UPDATE garante que aguardamos o commit
    // da primeira request antes de chegar aqui; se ainda assim response_body_json for null,
    // a primeira falhou (rollback). Prosseguimos como nova tentativa.
    if (!insertedRecord) {
      console.warn("[load-claims] idempotency record found without response — concurrent processing or prior failure", {
        scope,
        loadId,
        correlationId,
        idempotencyKey,
      });
    }

    return {
      replay: false,
      record: idempotencyRecord,
    };
  }

  return {
    replay: false,
    record: null,
  };
}

function buildReplayedPayload(record) {
  return {
    ...record.response_body_json,
    meta: {
      ...record.response_body_json.meta,
      idempotencyReused: true,
    },
  };
}

async function recordIdempotencyReplay(client, { record, actorType, actorId, correlationId }) {
  const responseBody = record.response_body_json ?? {};

  await insertAuditEvent(client, {
    loadId: record.load_id,
    claimId: responseBody.claim?.id ?? null,
    driverId: record.driver_id,
    eventType: CLAIM_EVENT_TYPE.IDEMPOTENCY_REPLAY,
    actorType,
    actorId,
    correlationId,
    payload: {
      scope: record.scope,
      idempotencyKey: record.idempotency_key,
      requestHash: record.request_hash,
      responseStatus: record.response_status,
    },
  });

  logLoadClaimEvent("info", "load-claim.idempotency.replay", {
    correlation_id: correlationId,
    load_id: record.load_id,
    claim_id: responseBody.claim?.id ?? null,
    driver_id: record.driver_id,
    idempotency_key: record.idempotency_key,
    request_hash: record.request_hash,
    result: responseBody.outcome ?? "REPLAY",
  });
}

function isSkipLockedUnsupportedError(error) {
  const message = `${error?.message || ""}`.toLowerCase();
  return message.includes("skip locked") || message.includes("not supported");
}

async function selectNextExpiredLoadCandidate(client) {
  try {
    const { rows } = await client.query(
      `
        SELECT cargas.id
        FROM public.cargas
        WHERE cargas.status = $1
          AND cargas.reserved_until IS NOT NULL
          AND cargas.reserved_until <= now()
        ORDER BY cargas.reserved_until ASC, cargas.id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `,
      [LOAD_STATUS.RESERVED],
    );

    return rows[0] ?? null;
  } catch (error) {
    if (!isSkipLockedUnsupportedError(error)) {
      throw error;
    }

    const { rows } = await client.query(
      `
        SELECT cargas.id
        FROM public.cargas
        WHERE cargas.status = $1
          AND cargas.reserved_until IS NOT NULL
          AND cargas.reserved_until <= now()
        ORDER BY cargas.reserved_until ASC, cargas.id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [LOAD_STATUS.RESERVED],
    );

    return rows[0] ?? null;
  }
}

async function persistResponseAndLog(client, { scope, driverId, loadId, idempotencyKey, response, responseStatus, logPayload }) {
  await storeIdempotencyResponse(client, {
    scope,
    driverId,
    loadId,
    idempotencyKey,
    responseStatus,
    responseBody: response,
  });

  logLoadClaimEvent("info", logPayload.message, logPayload.payload);

  return {
    statusCode: responseStatus,
    payload: response,
  };
}

export async function createLoadClaim({ loadId, driverId, idempotencyKey, correlationId, requestPayload = {} }) {
  const config = ensureClaimSystemEnabled();
  const normalizedIdempotencyKey = requireIdempotencyKey(idempotencyKey);
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const requestHash = createRequestFingerprint({
    loadId,
    driverId,
    requestPayload,
  });

  return withPgTransaction(async (client) => {
    const idempotencyState = await prepareIdempotencyRecord(client, {
      scope: IDEMPOTENCY_SCOPE.CREATE_CLAIM,
      driverId,
      loadId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
      correlationId: resolvedCorrelationId,
      config,
    });

    if (idempotencyState.replay) {
      await recordIdempotencyReplay(client, {
        record: idempotencyState.record,
        actorType: "driver",
        actorId: driverId,
        correlationId: resolvedCorrelationId,
      });

      return {
        statusCode: idempotencyState.record.response_status,
        payload: buildReplayedPayload(idempotencyState.record),
      };
    }

    let loadRow = await lockLoadRow(client, loadId);

    if (!loadRow) {
      throw new NotFoundError("Load not found.");
    }

    loadRow = await expireCurrentReservationIfNeeded(client, {
      loadRow,
      correlationId: resolvedCorrelationId,
      actorType: "system",
      actorId: "create-claim",
      config,
    });

    const driverProfile = await getDriverProfile(client, driverId, { lock: true });
    const existingClaim = await findLatestClaimForDriver(client, {
      loadId,
      driverId,
      lock: true,
    });

    if (existingClaim) {
      const existingResponse = buildClaimResponse({
        claimRow: existingClaim,
        loadRow,
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      });

      return persistResponseAndLog(client, {
        scope: IDEMPOTENCY_SCOPE.CREATE_CLAIM,
        driverId,
        loadId,
        idempotencyKey: normalizedIdempotencyKey,
        response: existingResponse,
        responseStatus: 200,
        logPayload: {
          message: "load-claim.create.reused-existing-claim",
          payload: {
            correlation_id: resolvedCorrelationId,
            load_id: loadId,
            claim_id: existingClaim.id,
            driver_id: driverId,
            idempotency_key: normalizedIdempotencyKey,
            request_hash: requestHash,
            previous_status: existingClaim.status,
            next_status: existingClaim.status,
            result: existingResponse.outcome,
          },
        },
      });
    }

    const claimRow = await createClaimRow(client, {
      loadId,
      driverId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
      correlationId: resolvedCorrelationId,
      requestPayload,
    });

    await insertAuditEvent(client, {
      loadId,
      claimId: claimRow.id,
      driverId,
      eventType: CLAIM_EVENT_TYPE.CLAIM_CREATED,
      actorType: "driver",
      actorId: driverId,
      correlationId: resolvedCorrelationId,
      payload: {
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      },
    });

    const eligibility = evaluateDriverEligibility({
      driverProfile,
      loadRow,
    });

    if (!eligibility.eligible) {
      const rejectedClaim = await updateClaimRow(client, claimRow.id, {
        status: transition(claimRow.status, "reject"),
        rejected_reason: eligibility.rejectedReason,
      });

      await insertAuditEvent(client, {
        loadId,
        claimId: rejectedClaim.id,
        driverId,
        eventType: CLAIM_EVENT_TYPE.CLAIM_REJECTED,
        actorType: "driver",
        actorId: driverId,
        correlationId: resolvedCorrelationId,
        payload: {
          reasons: eligibility.reasons,
        },
      });

      const response = buildClaimResponse({
        claimRow: rejectedClaim,
        loadRow,
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      });

      return persistResponseAndLog(client, {
        scope: IDEMPOTENCY_SCOPE.CREATE_CLAIM,
        driverId,
        loadId,
        idempotencyKey: normalizedIdempotencyKey,
        response,
        responseStatus: 200,
        logPayload: {
          message: "load-claim.create.rejected",
          payload: {
            correlation_id: resolvedCorrelationId,
            load_id: loadId,
            claim_id: rejectedClaim.id,
            driver_id: driverId,
            idempotency_key: normalizedIdempotencyKey,
            request_hash: requestHash,
            previous_status: CLAIM_STATUS.PENDING,
            next_status: rejectedClaim.status,
            result: response.outcome,
          },
        },
      });
    }

    if (loadRow.status === LOAD_STATUS.OPEN) {
      const reservedClaim = await updateClaimRow(client, claimRow.id, {
        status: transition(claimRow.status, "win_reservation"),
      });
      const reservedLoad = await updateLoadReservation(client, {
        loadId,
        driverId,
        claimId: reservedClaim.id,
        nextStatus: LOAD_STATUS.RESERVED,
        ttlSeconds: config.reservation_ttl_seconds,
      });

      await insertAuditEvent(client, {
        loadId,
        claimId: reservedClaim.id,
        driverId,
        eventType: CLAIM_EVENT_TYPE.LOAD_RESERVED,
        actorType: "driver",
        actorId: driverId,
        correlationId: resolvedCorrelationId,
        payload: {
          source: "CLAIM_WINNER",
          reservedUntil: reservedLoad.reserved_until,
        },
      });

      const response = buildClaimResponse({
        claimRow: reservedClaim,
        loadRow: reservedLoad,
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      });

      return persistResponseAndLog(client, {
        scope: IDEMPOTENCY_SCOPE.CREATE_CLAIM,
        driverId,
        loadId,
        idempotencyKey: normalizedIdempotencyKey,
        response,
        responseStatus: 201,
        logPayload: {
          message: "load-claim.create.reserved",
          payload: {
            correlation_id: resolvedCorrelationId,
            load_id: loadId,
            claim_id: reservedClaim.id,
            driver_id: driverId,
            idempotency_key: normalizedIdempotencyKey,
            request_hash: requestHash,
            previous_status: CLAIM_STATUS.PENDING,
            next_status: reservedClaim.status,
            result: response.outcome,
          },
        },
      });
    }

    if (loadRow.status === LOAD_STATUS.RESERVED && config.waitlist_enabled) {
      const waitlistSize = await resequenceWaitlist(client, loadId);
      const waitlistedClaim = await updateClaimRow(client, claimRow.id, {
        status: transition(claimRow.status, "waitlist"),
        queue_position: waitlistSize + 1,
      });

      await insertAuditEvent(client, {
        loadId,
        claimId: waitlistedClaim.id,
        driverId,
        eventType: CLAIM_EVENT_TYPE.CLAIM_WAITLISTED,
        actorType: "driver",
        actorId: driverId,
        correlationId: resolvedCorrelationId,
        payload: {
          queuePosition: waitlistedClaim.queue_position,
          currentReservedUntil: loadRow.reserved_until,
        },
      });

      const response = buildClaimResponse({
        claimRow: waitlistedClaim,
        loadRow,
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      });

      return persistResponseAndLog(client, {
        scope: IDEMPOTENCY_SCOPE.CREATE_CLAIM,
        driverId,
        loadId,
        idempotencyKey: normalizedIdempotencyKey,
        response,
        responseStatus: 202,
        logPayload: {
          message: "load-claim.create.waitlisted",
          payload: {
            correlation_id: resolvedCorrelationId,
            load_id: loadId,
            claim_id: waitlistedClaim.id,
            driver_id: driverId,
            idempotency_key: normalizedIdempotencyKey,
            request_hash: requestHash,
            previous_status: CLAIM_STATUS.PENDING,
            next_status: waitlistedClaim.status,
            result: response.outcome,
          },
        },
      });
    }

    const unavailableClaim = await updateClaimRow(client, claimRow.id, {
      status: transition(claimRow.status, "reject"),
      rejected_reason: "LOAD_UNAVAILABLE",
    });

    await insertAuditEvent(client, {
      loadId,
      claimId: unavailableClaim.id,
      driverId,
      eventType: CLAIM_EVENT_TYPE.LOAD_UNAVAILABLE,
      actorType: "driver",
      actorId: driverId,
      correlationId: resolvedCorrelationId,
      payload: {
        loadStatus: loadRow.status,
      },
    });

    const response = buildClaimResponse({
      claimRow: unavailableClaim,
      loadRow,
      correlationId: resolvedCorrelationId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
    });

    return persistResponseAndLog(client, {
      scope: IDEMPOTENCY_SCOPE.CREATE_CLAIM,
      driverId,
      loadId,
      idempotencyKey: normalizedIdempotencyKey,
      response,
      responseStatus: 200,
      logPayload: {
        message: "load-claim.create.unavailable",
        payload: {
          correlation_id: resolvedCorrelationId,
          load_id: loadId,
          claim_id: unavailableClaim.id,
          driver_id: driverId,
          idempotency_key: normalizedIdempotencyKey,
          request_hash: requestHash,
          previous_status: CLAIM_STATUS.PENDING,
          next_status: unavailableClaim.status,
          result: response.outcome,
        },
      },
    });
  });
}

export async function confirmLoadClaim({ loadId, claimId, driverId, idempotencyKey, correlationId }) {
  const config = ensureClaimSystemEnabled();
  const normalizedIdempotencyKey = requireIdempotencyKey(idempotencyKey);
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const requestHash = createRequestFingerprint({
    loadId,
    claimId,
    driverId,
    action: "confirm",
  });

  return withPgTransaction(async (client) => {
    const idempotencyState = await prepareIdempotencyRecord(client, {
      scope: IDEMPOTENCY_SCOPE.CONFIRM_CLAIM,
      driverId,
      loadId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
      correlationId: resolvedCorrelationId,
      config,
    });

    if (idempotencyState.replay) {
      await recordIdempotencyReplay(client, {
        record: idempotencyState.record,
        actorType: "driver",
        actorId: driverId,
        correlationId: resolvedCorrelationId,
      });

      return {
        statusCode: idempotencyState.record.response_status,
        payload: buildReplayedPayload(idempotencyState.record),
      };
    }

    let loadRow = await lockLoadRow(client, loadId);

    if (!loadRow) {
      throw new NotFoundError("Load not found.");
    }

    loadRow = await expireCurrentReservationIfNeeded(client, {
      loadRow,
      correlationId: resolvedCorrelationId,
      actorType: "system",
      actorId: "confirm-claim",
      config,
    });

    const claimRow = await getClaimById(client, claimId, { lock: true });

    if (!claimRow || claimRow.load_id !== loadId) {
      throw new NotFoundError("Claim not found.");
    }

    if (claimRow.driver_id !== driverId) {
      throw new ForbiddenError("Only the reserving driver can confirm this claim.");
    }

    if (claimRow.status === CLAIM_STATUS.CONFIRMED && loadRow.status === LOAD_STATUS.BOOKED) {
      const existingResponse = buildClaimResponse({
        claimRow,
        loadRow,
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      });

      return persistResponseAndLog(client, {
        scope: IDEMPOTENCY_SCOPE.CONFIRM_CLAIM,
        driverId,
        loadId,
        idempotencyKey: normalizedIdempotencyKey,
        response: existingResponse,
        responseStatus: 200,
        logPayload: {
          message: "load-claim.confirm.replayed",
          payload: {
            correlation_id: resolvedCorrelationId,
            load_id: loadId,
            claim_id: claimId,
            driver_id: driverId,
            idempotency_key: normalizedIdempotencyKey,
            request_hash: requestHash,
            previous_status: CLAIM_STATUS.CONFIRMED,
            next_status: CLAIM_STATUS.CONFIRMED,
            result: existingResponse.outcome,
          },
        },
      });
    }

    if (
      loadRow.status !== LOAD_STATUS.RESERVED ||
      loadRow.reserved_claim_id !== claimId ||
      loadRow.reserved_driver_id !== driverId ||
      !loadRow.reserved_until ||
      new Date(loadRow.reserved_until).getTime() <= Date.now()
    ) {
      throw new ConflictError("The reservation is no longer active for this claim.", {
        code: "RESERVATION_NOT_ACTIVE",
      });
    }

    const confirmedClaim = await updateClaimRow(client, claimId, {
      status: transition(claimRow.status, "confirm"),
      confirmed_at: new Date().toISOString(),
      queue_position: null,
    });
    const bookedLoad = await bookLoadForClaim(client, {
      loadId,
      driverId,
    });

    await rejectRemainingWaitlistClaims(client, {
      loadId,
      correlationId: resolvedCorrelationId,
      actorType: "driver",
      actorId: driverId,
    });

    await insertAuditEvent(client, {
      loadId,
      claimId,
      driverId,
      eventType: CLAIM_EVENT_TYPE.CLAIM_CONFIRMED,
      actorType: "driver",
      actorId: driverId,
      correlationId: resolvedCorrelationId,
      payload: {
        bookedAt: bookedLoad.booked_at,
      },
    });

    const response = buildClaimResponse({
      claimRow: confirmedClaim,
      loadRow: bookedLoad,
      correlationId: resolvedCorrelationId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
    });

    return persistResponseAndLog(client, {
      scope: IDEMPOTENCY_SCOPE.CONFIRM_CLAIM,
      driverId,
      loadId,
      idempotencyKey: normalizedIdempotencyKey,
      response,
      responseStatus: 200,
      logPayload: {
        message: "load-claim.confirm.confirmed",
        payload: {
          correlation_id: resolvedCorrelationId,
          load_id: loadId,
          claim_id: claimId,
          driver_id: driverId,
          idempotency_key: normalizedIdempotencyKey,
          request_hash: requestHash,
          previous_status: claimRow.status,
          next_status: confirmedClaim.status,
          result: response.outcome,
        },
      },
    });
  });
}

export async function cancelLoadClaim({ loadId, claimId, driverId, idempotencyKey, correlationId }) {
  const config = ensureClaimSystemEnabled();
  const normalizedIdempotencyKey = requireIdempotencyKey(idempotencyKey);
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const requestHash = createRequestFingerprint({
    loadId,
    claimId,
    driverId,
    action: "cancel",
  });

  return withPgTransaction(async (client) => {
    const idempotencyState = await prepareIdempotencyRecord(client, {
      scope: IDEMPOTENCY_SCOPE.CANCEL_CLAIM,
      driverId,
      loadId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
      correlationId: resolvedCorrelationId,
      config,
    });

    if (idempotencyState.replay) {
      await recordIdempotencyReplay(client, {
        record: idempotencyState.record,
        actorType: "driver",
        actorId: driverId,
        correlationId: resolvedCorrelationId,
      });

      return {
        statusCode: idempotencyState.record.response_status,
        payload: buildReplayedPayload(idempotencyState.record),
      };
    }

    const loadRow = await lockLoadRow(client, loadId);

    if (!loadRow) {
      throw new NotFoundError("Load not found.");
    }

    const claimRow = await getClaimById(client, claimId, { lock: true });

    if (!claimRow || claimRow.load_id !== loadId) {
      throw new NotFoundError("Claim not found.");
    }

    if (claimRow.driver_id !== driverId) {
      throw new ForbiddenError("Only the claim owner can cancel this claim.");
    }

    if ([CLAIM_STATUS.CANCELLED, CLAIM_STATUS.EXPIRED, CLAIM_STATUS.REJECTED].includes(claimRow.status)) {
      const existingResponse = buildClaimResponse({
        claimRow,
        loadRow,
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
      });

      return persistResponseAndLog(client, {
        scope: IDEMPOTENCY_SCOPE.CANCEL_CLAIM,
        driverId,
        loadId,
        idempotencyKey: normalizedIdempotencyKey,
        response: existingResponse,
        responseStatus: 200,
        logPayload: {
          message: "load-claim.cancel.replayed",
          payload: {
            correlation_id: resolvedCorrelationId,
            load_id: loadId,
            claim_id: claimId,
            driver_id: driverId,
            idempotency_key: normalizedIdempotencyKey,
            request_hash: requestHash,
            previous_status: claimRow.status,
            next_status: claimRow.status,
            result: existingResponse.outcome,
          },
        },
      });
    }

    const cancelledClaim = await updateClaimRow(client, claimId, {
      status: transition(claimRow.status, "cancel"),
      queue_position: null,
    });

    let nextLoadRow = loadRow;

    await insertAuditEvent(client, {
      loadId,
      claimId,
      driverId,
      eventType: CLAIM_EVENT_TYPE.CLAIM_CANCELLED,
      actorType: "driver",
      actorId: driverId,
      correlationId: resolvedCorrelationId,
      payload: {
        previousStatus: claimRow.status,
      },
    });

    if (loadRow.reserved_claim_id === claimId && RESERVATION_CLAIM_STATUSES.includes(claimRow.status)) {
      await clearLoadReservation(client, loadId, LOAD_STATUS.OPEN);

      const promotionResult = await promoteNextEligibleClaim(client, {
        loadRow: { ...loadRow, status: LOAD_STATUS.OPEN },
        correlationId: resolvedCorrelationId,
        actorType: "driver",
        actorId: driverId,
        config,
      });

      nextLoadRow = promotionResult.loadRow;
    } else {
      await resequenceWaitlist(client, loadId);
    }

    const response = buildClaimResponse({
      claimRow: cancelledClaim,
      loadRow: nextLoadRow,
      correlationId: resolvedCorrelationId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
    });

    return persistResponseAndLog(client, {
      scope: IDEMPOTENCY_SCOPE.CANCEL_CLAIM,
      driverId,
      loadId,
      idempotencyKey: normalizedIdempotencyKey,
      response,
      responseStatus: 200,
      logPayload: {
        message: "load-claim.cancel.cancelled",
        payload: {
          correlation_id: resolvedCorrelationId,
          load_id: loadId,
          claim_id: claimId,
          driver_id: driverId,
          idempotency_key: normalizedIdempotencyKey,
          request_hash: requestHash,
          previous_status: claimRow.status,
          next_status: cancelledClaim.status,
          result: response.outcome,
        },
      },
    });
  });
}

export async function getLoadClaimStatus({ loadId, driverId = null, publicLeadId = null, correlationId }) {
  ensureClaimSystemEnabled();
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const config = getLoadClaimConfig();

  return withPgClient(async (client) => {
    const loadResult = await client.query(
      `
        SELECT
          cargas.id,
          cargas.status,
          cargas.version,
          cargas.reserved_until,
          cargas.reserved_at,
          cargas.booked_at,
          cargas.data,
          cargas.horario,
          cargas.origem,
          cargas.destino,
          cargas.perfil,
          cargas.valor,
          cargas.bonus,
          cargas.cliente_id,
          cargas.sheet_data_carregamento,
          cargas.sheet_data_descarga,
          clientes.nome AS cliente_nome,
          clientes.descricao AS cliente_descricao
        FROM public.cargas
        LEFT JOIN public.clientes
          ON clientes.id = cargas.cliente_id
        WHERE cargas.id = $1
      `,
      [loadId],
    );

    const loadRow = loadResult.rows[0] ?? null;

    if (!loadRow) {
      throw new NotFoundError("Load not found.");
    }

    let claimRow = null;
    let driverProfile = null;
    let publicLeadRow = null;

    if (driverId) {
      driverProfile = await getDriverProfile(client, driverId);
      const { rows } = await client.query(
        `
          SELECT *
          FROM public.load_claims
          WHERE load_id = $1
            AND driver_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [loadId, driverId],
      );
      claimRow = rows[0] ?? null;
    }

    if (publicLeadId) {
      const { rows } = await client.query(
        `
          SELECT *
          FROM public.load_public_leads
          WHERE id = $1
            AND load_id = $2
          LIMIT 1
        `,
        [publicLeadId, loadId],
      );
      publicLeadRow = rows[0] ?? null;
    }

    return {
      statusCode: 200,
      payload: {
        load: {
          id: loadRow.id,
          status: loadRow.status,
          version: loadRow.version,
          reservedUntil: loadRow.reserved_until,
          reservedAt: loadRow.reserved_at,
          bookedAt: loadRow.booked_at,
          data: loadRow.data,
          horario: loadRow.horario,
          origem: loadRow.origem,
          destino: loadRow.destino,
          perfil: loadRow.perfil,
          // Only expose monetary values to authenticated drivers
          ...(driverId ? { valor: loadRow.valor, bonus: loadRow.bonus } : {}),
          clienteId: loadRow.cliente_id,
          clienteNome: loadRow.cliente_nome,
          clienteDescricao: loadRow.cliente_descricao,
          carregamentoLabel: loadRow.sheet_data_carregamento,
          descargaLabel: loadRow.sheet_data_descarga,
        },
        publicLead: publicLeadRow
          ? {
              id: publicLeadRow.id,
              status: publicLeadRow.status,
              queuedAt: publicLeadRow.queued_at,
              whatsappClickedAt: publicLeadRow.whatsapp_clicked_at,
              approvedAt: publicLeadRow.approved_at,
              approvedBy: publicLeadRow.approved_by,
              validation: rehydrateStoredValidationSummary(publicLeadRow.validation_summary_json, {
                status: publicLeadRow.validation_status,
                checkedAt: publicLeadRow.validation_checked_at,
              }),
            }
          : null,
        claim: claimRow
          ? {
              id: claimRow.id,
              status: claimRow.status,
              queuePosition: claimRow.queue_position,
              serverSequence: claimRow.server_sequence,
              claimedAt: claimRow.claimed_at,
              promotedAt: claimRow.promoted_at,
              confirmedAt: claimRow.confirmed_at,
              expiredAt: claimRow.expired_at,
              rejectedReason: claimRow.rejected_reason,
            }
          : null,
        driverProfile: driverProfile
          ? {
              fullName: driverProfile.full_name,
              vehicleProfile: driverProfile.vehicle_profile,
              active: driverProfile.active,
              documentsValid: driverProfile.documents_valid,
              allowedRegions: driverProfile.allowed_regions,
            }
          : null,
        meta: {
          correlationId: resolvedCorrelationId,
          claim_v2_enabled: config.claim_v2_enabled,
          waitlist_enabled: config.waitlist_enabled,
          reservation_ttl_seconds: config.reservation_ttl_seconds,
          realtime_claim_updates_enabled: config.realtime_claim_updates_enabled,
          publicLeadWhatsappConfigured: hasPublicLeadWhatsAppRouting(),
        },
      },
    };
  });
}

export async function processExpiredLoadClaims({ batchSize, correlationId }) {
  const config = ensureClaimSystemEnabled();
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const effectiveBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : config.maintenance_batch_size;
  let processedCount = 0;
  let promotedCount = 0;
  let reopenedCount = 0;

  while (processedCount < effectiveBatchSize) {
    const result = await withPgTransaction(async (client) => {
      const candidate = await selectNextExpiredLoadCandidate(client);

      if (!candidate?.id) {
        return null;
      }

      const lockedLoad = await lockLoadRow(client, candidate.id);

      if (!lockedLoad) {
        return null;
      }

      const refreshedLoad = await expireCurrentReservationIfNeeded(client, {
        loadRow: lockedLoad,
        correlationId: resolvedCorrelationId,
        actorType: "system",
        actorId: "claim-maintenance",
        config,
      });

      return refreshedLoad;
    });

    if (!result) {
      break;
    }

    processedCount += 1;

    if (result.status === LOAD_STATUS.RESERVED) {
      promotedCount += 1;
    } else if (result.status === LOAD_STATUS.OPEN) {
      reopenedCount += 1;
    }
  }

  logLoadClaimEvent("info", "load-claim.maintenance.completed", {
    correlation_id: resolvedCorrelationId,
    processed_count: processedCount,
    promoted_count: promotedCount,
    reopened_count: reopenedCount,
  });

  return {
    processedCount,
    promotedCount,
    reopenedCount,
    correlationId: resolvedCorrelationId,
  };
}
