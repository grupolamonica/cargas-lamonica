/**
 * atomic-claim — Claim atomico de pacote (D-04, D-05, CARGAS-CASADAS-07).
 *
 * Substitui o fluxo de createLoadClaim quando carga pertence a pacote
 * (cargas.viagem_id IS NOT NULL). Reserva pacote + TODAS as cargas em
 * uma unica transacao Postgres. Se qualquer carga estiver indisponivel,
 * ROLLBACK total — nenhuma carga fica reservada parcialmente.
 *
 * Lock order (CRITICO — previne deadlock — T-10-15):
 *   1. cargas_casadas (FOR UPDATE) — pacote-raiz
 *   2. cargas WHERE viagem_id=pacoteId ORDER BY ordem_viagem ASC (FOR UPDATE)
 *   3. driver_profiles (FOR UPDATE)
 *
 * Decisao F-2 (plan-check NOWAIT vs lock wait): adotamos lock wait padrao
 * (sem NOWAIT). Justificativa:
 *   - Em pacotes (3 cargas max), contencao e curta (~ms).
 *   - Lock wait + transaction serialization fornecem fail-fast natural via
 *     status check apos acquire: o perdedor da corrida sempre encontra
 *     status != 'publicado' apos seu turno do lock, e levanta
 *     ConflictError('pacote_indisponivel').
 *   - NOWAIT exigiria captura/remap de erro 55P03 do Postgres + estrategia
 *     de retry no front. Pode ser revisitado se observabilidade em prod
 *     mostrar lock contention.
 */

import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { getLoadClaimConfig } from "../../../domain/load-claims/config.js";
import { evaluateDriverEligibility } from "../../../domain/load-claims/eligibility.js";
import {
  ConflictError,
  FeatureDisabledError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../domain/load-claims/errors.js";
import { createCorrelationId, createRequestFingerprint } from "../../load-claims/helpers.js";

const PACOTE_CLAIM_SCOPE = "pacote-claim:create";

function ensureClaimSystemEnabled() {
  const config = getLoadClaimConfig();
  if (!config.claim_v2_enabled) {
    throw new FeatureDisabledError();
  }
  return config;
}

function requireIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey || !String(idempotencyKey).trim()) {
    throw new ValidationError("Idempotency-Key header is required.");
  }
  return String(idempotencyKey).trim();
}

function buildExpiresAt(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

/**
 * Idempotency: opera por (scope, driver_id, load_id=pacoteId, key).
 * Escopo distinto do load-claim regular evita colisao.
 */
async function findLockedIdempotencyRecord(client, { scope, driverId, pacoteId, idempotencyKey }) {
  const { rows } = await client.query(
    `SELECT *
       FROM public.idempotency_records
      WHERE scope = $1 AND driver_id = $2 AND load_id = $3 AND idempotency_key = $4
      FOR UPDATE`,
    [scope, driverId, pacoteId, idempotencyKey],
  );
  return rows[0] ?? null;
}

async function insertIdempotencyRecord(client, { scope, driverId, pacoteId, idempotencyKey, requestHash, correlationId, expiresAt }) {
  const { rows } = await client.query(
    `INSERT INTO public.idempotency_records (
       scope, driver_id, load_id, idempotency_key, request_hash, correlation_id, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope, driver_id, load_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [scope, driverId, pacoteId, idempotencyKey, requestHash, correlationId, expiresAt],
  );
  return rows[0] ?? null;
}

async function storeIdempotencyResponse(client, { scope, driverId, pacoteId, idempotencyKey, responseStatus, responseBody }) {
  await client.query(
    `UPDATE public.idempotency_records
        SET response_status = $5, response_body_json = $6::jsonb
      WHERE scope = $1 AND driver_id = $2 AND load_id = $3 AND idempotency_key = $4`,
    [scope, driverId, pacoteId, idempotencyKey, responseStatus, JSON.stringify(responseBody)],
  );
}

/**
 * createPacoteClaim — entrypoint do D-04.
 *
 * @param {object} params
 * @param {string} params.pacoteId - UUID do pacote alvo
 * @param {string} params.driverId - UUID do motorista candidato
 * @param {string} params.idempotencyKey - Idempotency-Key header value
 * @param {object} [params.requestPayload={}] - body original (para fingerprint)
 * @param {string} [params.correlationId] - correlation id
 *
 * @returns {Promise<{statusCode: number, payload: object}>}
 *  - 201 + payload: pacoteId, claimIds[], cargaIds[], status='reservado', reservedUntil
 *  - 200 + payload: idempotency replay (sem mudar estado)
 */
export async function createPacoteClaim({
  pacoteId,
  driverId,
  idempotencyKey,
  requestPayload = {},
  correlationId,
}) {
  const config = ensureClaimSystemEnabled();
  const normalizedIdempotencyKey = requireIdempotencyKey(idempotencyKey);
  const resolvedCorrelationId = correlationId || createCorrelationId();
  const requestHash = createRequestFingerprint({ pacoteId, driverId, requestPayload });
  const ttlSeconds = config.reservation_ttl_seconds;
  const idempotencyExpiresAt = new Date(Date.now() + config.idempotency_ttl_seconds * 1000).toISOString();

  return withPgTransaction(async (client) => {
    // ── 0. Idempotency check primeiro (cheap reject de retries) ──────────────
    const insertedIdemp = await insertIdempotencyRecord(client, {
      scope: PACOTE_CLAIM_SCOPE,
      driverId,
      pacoteId,
      idempotencyKey: normalizedIdempotencyKey,
      requestHash,
      correlationId: resolvedCorrelationId,
      expiresAt: idempotencyExpiresAt,
    });

    const idempotencyRecord =
      insertedIdemp ||
      (await findLockedIdempotencyRecord(client, {
        scope: PACOTE_CLAIM_SCOPE,
        driverId,
        pacoteId,
        idempotencyKey: normalizedIdempotencyKey,
      }));

    if (idempotencyRecord && idempotencyRecord.request_hash !== requestHash) {
      throw new ConflictError(
        "Idempotency-Key reusado com payload diferente.",
        { code: "IDEMPOTENCY_CONFLICT" },
      );
    }

    if (idempotencyRecord && idempotencyRecord.response_body_json) {
      // Replay — retorna resposta cached sem mutar estado.
      const body = idempotencyRecord.response_body_json;
      return {
        statusCode: idempotencyRecord.response_status || 200,
        payload: {
          ...body,
          meta: {
            ...(body.meta || {}),
            idempotencyReused: true,
            correlationId: resolvedCorrelationId,
          },
        },
      };
    }

    // ── 1. Lock pacote (lock order step 1) ────────────────────────────────────
    const { rows: pacoteRows } = await client.query(
      `SELECT id, status, valor_total, version, reserved_driver_id, reserved_claim_id
         FROM public.cargas_casadas
        WHERE id = $1
        FOR UPDATE`,
      [pacoteId],
    );
    const pacote = pacoteRows[0];
    if (!pacote) {
      throw new NotFoundError("Pacote nao encontrado.");
    }
    if (pacote.status !== "publicado") {
      throw new ConflictError(
        `Pacote em status '${pacote.status}' nao esta disponivel para reserva.`,
        { code: "pacote_indisponivel", pacoteId, status: pacote.status },
      );
    }

    // ── 2. Lock cargas (lock order step 2 — sempre ASC por ordem_viagem) ─────
    const { rows: cargas } = await client.query(
      `SELECT id, status, driver_visibility, viagem_id, ordem_viagem,
              reserved_driver_id, reserved_claim_id, origem, destino, perfil, cliente_id
         FROM public.cargas
        WHERE viagem_id = $1
        ORDER BY ordem_viagem ASC NULLS LAST, id ASC
        FOR UPDATE`,
      [pacoteId],
    );
    if (cargas.length === 0) {
      throw new ValidationError(
        "Pacote sem cargas — estado inconsistente.",
        { code: "pacote_vazio", pacoteId },
      );
    }
    for (const c of cargas) {
      if (c.status !== "OPEN") {
        throw new ConflictError(
          `Carga ${c.id} do pacote em status '${c.status}' (esperado 'OPEN').`,
          { code: "pacote_inconsistente", pacoteId, cargaId: c.id, status: c.status },
        );
      }
      if (c.reserved_driver_id) {
        throw new ConflictError(
          `Carga ${c.id} ja reservada por outro motorista.`,
          { code: "pacote_inconsistente", pacoteId, cargaId: c.id },
        );
      }
    }

    // ── 3. Lock driver_profile (lock order step 3) ───────────────────────────
    const { rows: profileRows } = await client.query(
      `SELECT * FROM public.driver_profiles WHERE user_id = $1 FOR UPDATE`,
      [driverId],
    );
    const driverProfile = profileRows[0];
    if (!driverProfile) {
      throw new ForbiddenError("Motorista nao cadastrado.");
    }

    // ── 4. Eligibility — avalia contra primeira carga (referencia do pacote) ─
    const referenceCarga = cargas[0];
    const eligibility = evaluateDriverEligibility({
      driverProfile,
      loadRow: referenceCarga,
    });
    if (!eligibility.eligible) {
      throw new ForbiddenError(
        `Motorista ineligivel para o pacote: ${eligibility.rejectedReason || "INELIGIBLE"}`,
      );
    }

    // ── 5. INSERT 1 claim por carga + UPDATE cada carga (atomic loop) ────────
    const claims = [];
    for (const carga of cargas) {
      const { rows: [claim] } = await client.query(
        `INSERT INTO public.load_claims (
           load_id, driver_id, status, idempotency_key, request_fingerprint,
           request_payload_json, correlation_id, queue_position
         )
         VALUES ($1, $2, 'WON_RESERVATION', $3, $4, $5::jsonb, $6, NULL)
         RETURNING id`,
        [
          carga.id,
          driverId,
          normalizedIdempotencyKey,
          requestHash,
          JSON.stringify(requestPayload || {}),
          resolvedCorrelationId,
        ],
      );

      await client.query(
        `UPDATE public.cargas
            SET status = 'RESERVED',
                reserved_driver_id = $2,
                reserved_claim_id = $3,
                reserved_at = now(),
                reserved_until = $4,
                version = version + 1,
                updated_at = now()
          WHERE id = $1`,
        [carga.id, driverId, claim.id, buildExpiresAt(ttlSeconds)],
      );

      await client.query(
        `INSERT INTO public.load_claim_events (
           load_id, claim_id, driver_id, event_type, event_payload_json,
           actor_type, actor_id, correlation_id
         )
         VALUES ($1, $2, $3, 'LOAD_RESERVED', $4::jsonb, 'driver', $3, $5)`,
        [
          carga.id,
          claim.id,
          driverId,
          JSON.stringify({ source: "PACOTE_CLAIM_WINNER", pacoteId, ordemViagem: carga.ordem_viagem }),
          resolvedCorrelationId,
        ],
      );
      claims.push({ id: claim.id, cargaId: carga.id });
    }

    // ── 6. UPDATE pacote ──────────────────────────────────────────────────────
    await client.query(
      `UPDATE public.cargas_casadas
          SET status = 'reservado',
              reserved_driver_id = $2,
              reserved_claim_id = $3,
              version = version + 1,
              updated_at = now()
        WHERE id = $1`,
      [pacoteId, driverId, claims[0].id],
    );

    // Evento "PACOTE_RESERVED" no claim sentinela (primeiro) com payload contendo todos cargaIds.
    await client.query(
      `INSERT INTO public.load_claim_events (
         load_id, claim_id, driver_id, event_type, event_payload_json,
         actor_type, actor_id, correlation_id
       )
       VALUES ($1, $2, $3, 'PACOTE_RESERVED', $4::jsonb, 'driver', $3, $5)`,
      [
        cargas[0].id,
        claims[0].id,
        driverId,
        JSON.stringify({
          pacoteId,
          cargaIds: cargas.map((c) => c.id),
          claimIds: claims.map((c) => c.id),
        }),
        resolvedCorrelationId,
      ],
    );

    const reservedUntil = buildExpiresAt(ttlSeconds);
    const responseBody = {
      outcome: "RESERVED",
      pacoteId,
      claimIds: claims.map((c) => c.id),
      cargaIds: cargas.map((c) => c.id),
      status: "reservado",
      reservedUntil,
      meta: {
        correlationId: resolvedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
        idempotencyReused: false,
      },
    };

    await storeIdempotencyResponse(client, {
      scope: PACOTE_CLAIM_SCOPE,
      driverId,
      pacoteId,
      idempotencyKey: normalizedIdempotencyKey,
      responseStatus: 201,
      responseBody,
    });

    return { statusCode: 201, payload: responseBody };
  });
}
