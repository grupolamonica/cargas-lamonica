import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS } from "./_shared.js";

export async function lookupCachedAngelliraValidation({ documentNumber, maxAgeMs, correlationId }) {
  if (!documentNumber) return { found: false, reason: "MISSING_INPUT" };

  const normalizedCpf = String(documentNumber).replace(/\D/g, "");
  if (!normalizedCpf) return { found: false, reason: "EMPTY_DOCUMENT" };

  const effectiveMaxAge = maxAgeMs ?? DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS;

  return withPgClient(async (client) => {
    try {
      const { rows } = await client.query(
        `SELECT
          user_id, full_name, document_number,
          angellira_status, angellira_valid_until, angellira_status_text, angellira_checked_at
        FROM public.driver_profiles
        WHERE angellira_checked_at IS NOT NULL
          AND (replace(document_number, '.', '') LIKE '%' || $1 || '%'
            OR replace(replace(document_number, '.', ''), '-', '') = $1)
        LIMIT 1`,
        [normalizedCpf],
      );

      if (!rows.length) return { found: false, reason: "NO_MATCH" };

      const row = rows[0];
      const ageMs = Date.now() - new Date(row.angellira_checked_at).getTime();

      if (ageMs > effectiveMaxAge) {
        logStructuredEvent("info", "operator-admin.angellira-cache.stale", {
          correlationId: correlationId || null,
          documentNumber: `***${normalizedCpf.slice(-4)}`,
          ageHours: Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10,
          maxAgeHours: Math.round((effectiveMaxAge / (1000 * 60 * 60)) * 10) / 10,
        });
        return { found: false, reason: "STALE", ageMs };
      }

      logStructuredEvent("info", "operator-admin.angellira-cache.hit", {
        correlationId: correlationId || null,
        documentNumber: `***${normalizedCpf.slice(-4)}`,
        angelliraStatus: row.angellira_status,
        ageMs,
      });

      return {
        found: true,
        cached: true,
        driverName: row.full_name,
        angelliraResult: {
          queryFor: "cpf",
          queryValue: normalizedCpf,
          availability: "OK",
          status: row.angellira_status || "NOT_FOUND",
          found: row.angellira_status === "FOUND",
          displayName: row.full_name,
          validUntil: row.angellira_valid_until
            ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
            : null,
          lastSeenAt: row.angellira_checked_at,
          statusText: row.angellira_status_text || null,
        },
      };
    } catch (error) {
      const msg = (error?.message || "").toLowerCase();
      if (msg.includes("angellira_status") || msg.includes("angellira_checked_at")) {
        return { found: false, reason: "COLUMNS_MISSING" };
      }
      throw error;
    }
  });
}

export async function lookupCachedAngelliraPlate({ plate, maxAgeMs, correlationId }) {
  if (!plate) return { found: false, reason: "MISSING_INPUT" };

  const normalizedPlate = String(plate).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalizedPlate) return { found: false, reason: "EMPTY_PLATE" };

  const effectiveMaxAge = maxAgeMs ?? DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS;

  try {
    return await withPgClient(async (client) => {
      try {
        const { rows } = await client.query(
          `SELECT
            plate, angellira_status, angellira_valid_until, angellira_status_text,
            angellira_display_name, angellira_last_seen_at, angellira_checked_at
          FROM public.vehicles
          WHERE plate = $1 AND angellira_checked_at IS NOT NULL
          LIMIT 1`,
          [normalizedPlate],
        );

        if (!rows.length) return { found: false, reason: "NO_MATCH" };

        const row = rows[0];
        const ageMs = Date.now() - new Date(row.angellira_checked_at).getTime();

        if (ageMs > effectiveMaxAge) {
          logStructuredEvent("info", "operator-admin.angellira-plate-cache.stale", {
            correlationId: correlationId || null,
            plate: `${normalizedPlate.slice(0, 3)}***`,
            ageHours: Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10,
          });
          return { found: false, reason: "STALE", ageMs };
        }

        logStructuredEvent("info", "operator-admin.angellira-plate-cache.hit", {
          correlationId: correlationId || null,
          plate: `${normalizedPlate.slice(0, 3)}***`,
          angelliraStatus: row.angellira_status,
          ageMs,
        });

        return {
          found: true,
          cached: true,
          angelliraResult: {
            queryFor: "plate",
            queryValue: normalizedPlate,
            availability: "OK",
            status: row.angellira_status || "NOT_FOUND",
            found: row.angellira_status === "FOUND",
            displayName: row.angellira_display_name || null,
            validUntil: row.angellira_valid_until
              ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
              : null,
            lastSeenAt: row.angellira_last_seen_at
              ? new Date(row.angellira_last_seen_at).toISOString()
              : row.angellira_checked_at,
            statusText: row.angellira_status_text || null,
          },
        };
      } catch (error) {
        const msg = (error?.message || "").toLowerCase();
        if (msg.includes("angellira_") || msg.includes("vehicles")) {
          return { found: false, reason: "COLUMNS_MISSING" };
        }
        throw error;
      }
    });
  } catch {
    return { found: false, reason: "CACHE_UNAVAILABLE" };
  }
}

export async function syncDriverAngelliraValidation({ documentNumber, angelliraResult, correlationId }) {
  if (!documentNumber || !angelliraResult) return { updated: false, reason: "MISSING_INPUT" };

  const normalizedCpf = String(documentNumber).replace(/\D/g, "");
  if (!normalizedCpf) return { updated: false, reason: "EMPTY_DOCUMENT" };

  if (angelliraResult.availability !== "OK") return { updated: false, reason: "UNAVAILABLE_RESULT" };

  return withPgClient(async (client) => {
    const detailsJson = angelliraResult.driverDetails ? JSON.stringify(angelliraResult.driverDetails) : null;
    const angelliraName = (angelliraResult.displayName || "").trim() || null;

    const { rows } = await client.query(
      `UPDATE public.driver_profiles
       SET
         full_name = COALESCE($6, full_name),
         angellira_status = $2,
         angellira_valid_until = $3,
         angellira_status_text = $4,
         angellira_details = COALESCE($5::jsonb, angellira_details),
         angellira_checked_at = now(),
         updated_at = now()
       WHERE replace(document_number, '.', '') LIKE '%' || $1 || '%'
         OR replace(replace(document_number, '.', ''), '-', '') = $1
       RETURNING user_id`,
      [normalizedCpf, angelliraResult.status || null, angelliraResult.validUntil || null,
        angelliraResult.statusText || null, detailsJson, angelliraName],
    );

    const updatedCount = rows.length;
    if (updatedCount > 0) {
      logStructuredEvent("info", "operator-admin.angellira-sync.updated", {
        correlationId: correlationId || null,
        documentNumber: `***${normalizedCpf.slice(-4)}`,
        angelliraStatus: angelliraResult.status,
        validUntil: angelliraResult.validUntil || null,
        matchedDrivers: updatedCount,
      });
    }

    return { updated: updatedCount > 0, matchedDrivers: updatedCount };
  });
}

export async function syncVehicleAngelliraLookup({ plate, plateRole, vehicleType, angelliraResult, linkedDriverCpf, correlationId }) {
  const normalizedPlate = String(plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (!normalizedPlate || !angelliraResult || angelliraResult.availability !== "OK") {
    return { upserted: false, reason: "SKIP" };
  }

  try {
    return await withPgClient(async (client) => {
      const detailsJson = angelliraResult.vehicleDetails ? JSON.stringify(angelliraResult.vehicleDetails) : null;

      const { rows } = await client.query(
        `INSERT INTO public.vehicles (
          plate, vehicle_type, plate_role,
          angellira_status, angellira_valid_until, angellira_status_text,
          angellira_display_name, angellira_last_seen_at, angellira_checked_at,
          angellira_details, linked_driver_cpf, source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9::jsonb, $10, 'PUBLIC_LEAD')
        ON CONFLICT (plate) DO UPDATE SET
          angellira_status = EXCLUDED.angellira_status,
          angellira_valid_until = EXCLUDED.angellira_valid_until,
          angellira_status_text = EXCLUDED.angellira_status_text,
          angellira_display_name = COALESCE(EXCLUDED.angellira_display_name, vehicles.angellira_display_name),
          angellira_last_seen_at = EXCLUDED.angellira_last_seen_at,
          angellira_checked_at = EXCLUDED.angellira_checked_at,
          angellira_details = COALESCE(EXCLUDED.angellira_details, vehicles.angellira_details),
          linked_driver_cpf = COALESCE(EXCLUDED.linked_driver_cpf, vehicles.linked_driver_cpf),
          vehicle_type = COALESCE(EXCLUDED.vehicle_type, vehicles.vehicle_type),
          updated_at = now()
        RETURNING id`,
        [
          normalizedPlate, vehicleType || null, plateRole || null,
          angelliraResult.status || null, angelliraResult.validUntil || null,
          angelliraResult.statusText || null, angelliraResult.displayName || null,
          angelliraResult.lastSeenAt || null, detailsJson,
          linkedDriverCpf ? String(linkedDriverCpf).replace(/\D/g, "") : null,
        ],
      );

      logStructuredEvent("info", "operator-admin.vehicle-sync.upserted", {
        correlationId: correlationId || null,
        plate: `${normalizedPlate.slice(0, 3)}***`,
        plateRole: plateRole || null,
        angelliraStatus: angelliraResult.status || null,
        vehicleId: rows[0]?.id || null,
      });

      return { upserted: true, vehicleId: rows[0]?.id };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.toLowerCase().includes("vehicles")) return { upserted: false, reason: "TABLE_MISSING" };
    throw error;
  }
}
