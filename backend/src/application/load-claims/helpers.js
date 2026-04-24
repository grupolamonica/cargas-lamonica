import crypto from "node:crypto";

import { CLAIM_STATUS, LOAD_STATUS, RESERVATION_CLAIM_STATUSES } from "../../domain/load-claims/constants.js";

export function createCorrelationId() {
  return crypto.randomUUID();
}

export function normalizeText(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function sortForFingerprint(value) {
  if (Array.isArray(value)) {
    return value.map(sortForFingerprint);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortForFingerprint(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function createRequestFingerprint(payload) {
  const serializedPayload = JSON.stringify(sortForFingerprint(payload));
  return crypto.createHash("sha256").update(serializedPayload).digest("hex");
}

export function parseLocationUf(value) {
  const matchedLocation = (value || "").trim().match(/([A-Za-z]{2})\s*$/);
  return matchedLocation ? matchedLocation[1].toUpperCase() : null;
}

export function getReservationTtlSeconds(ttlSeconds) {
  return Number(ttlSeconds);
}

export function getClaimOutcomeFromRow(claimRow, loadRow) {
  if (!claimRow) {
    return {
      outcome: loadRow?.status === LOAD_STATUS.BOOKED ? "BOOKED" : "UNAVAILABLE",
      claimStatus: null,
    };
  }

  if (RESERVATION_CLAIM_STATUSES.includes(claimRow.status)) {
    return {
      outcome: "RESERVED",
      claimStatus: claimRow.status,
    };
  }

  if (claimRow.status === CLAIM_STATUS.WAITLISTED) {
    return {
      outcome: "WAITLISTED",
      claimStatus: claimRow.status,
    };
  }

  if (claimRow.status === CLAIM_STATUS.CONFIRMED || loadRow?.status === LOAD_STATUS.BOOKED) {
    return {
      outcome: "BOOKED",
      claimStatus: claimRow.status,
    };
  }

  if (claimRow.status === CLAIM_STATUS.REJECTED) {
    return {
      outcome: "REJECTED",
      claimStatus: claimRow.status,
    };
  }

  if (claimRow.status === CLAIM_STATUS.CANCELLED) {
    return {
      outcome: "CANCELLED",
      claimStatus: claimRow.status,
    };
  }

  if (claimRow.status === CLAIM_STATUS.EXPIRED) {
    return {
      outcome: "EXPIRED",
      claimStatus: claimRow.status,
    };
  }

  return {
    outcome: "UNAVAILABLE",
    claimStatus: claimRow.status,
  };
}

export function buildClaimResponse({
  claimRow,
  loadRow,
  correlationId,
  idempotencyKey,
  requestHash,
  idempotencyReused = false,
  rejectedReason = null,
}) {
  const { outcome, claimStatus } = getClaimOutcomeFromRow(claimRow, loadRow);

  return {
    outcome,
    claim: claimRow
      ? {
          id: claimRow.id,
          status: claimStatus,
          queuePosition: claimRow.queue_position,
          serverSequence: claimRow.server_sequence,
          claimedAt: claimRow.claimed_at,
          promotedAt: claimRow.promoted_at,
          confirmedAt: claimRow.confirmed_at,
          expiredAt: claimRow.expired_at,
          rejectedReason: rejectedReason ?? claimRow.rejected_reason ?? null,
        }
      : null,
    load: loadRow
      ? {
          id: loadRow.id,
          status: loadRow.status,
          version: loadRow.version,
          reservedUntil: loadRow.reserved_until,
          reservedAt: loadRow.reserved_at,
          bookedAt: loadRow.booked_at,
        }
      : null,
    meta: {
      correlationId,
      idempotencyKey,
      requestHash,
      idempotencyReused,
    },
  };
}
