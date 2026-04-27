import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { REVALIDATE_VEHICLES_BATCH_LIMIT, REVALIDATE_VEHICLES_CONCURRENCY } from "./_shared.js";
import { syncVehicleAngelliraLookup } from "./angellira-cache.js";

export async function revalidateAllVehiclesAngellira({ correlationId } = {}) {
  const { lookupAngelliraPlate } = await import("../../driver-validation/angellira-client.js");

  const vehicleRows = await withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT plate, plate_role, vehicle_type, linked_driver_cpf
        FROM public.vehicles
        ORDER BY angellira_checked_at ASC NULLS FIRST, updated_at ASC NULLS FIRST
        LIMIT $1
      `,
      [REVALIDATE_VEHICLES_BATCH_LIMIT],
    );
    return rows;
  });

  let revalidated = 0;
  let failed = 0;

  for (let i = 0; i < vehicleRows.length; i += REVALIDATE_VEHICLES_CONCURRENCY) {
    const chunk = vehicleRows.slice(i, i + REVALIDATE_VEHICLES_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        const lookup = await lookupAngelliraPlate(row.plate, { correlationId });
        if (lookup.availability !== "OK") return { skipped: true };
        await syncVehicleAngelliraLookup({
          plate: row.plate,
          plateRole: row.plate_role,
          vehicleType: row.vehicle_type,
          angelliraResult: lookup,
          linkedDriverCpf: row.linked_driver_cpf,
          correlationId,
        });
        return { updated: true };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value?.updated) {
        revalidated += 1;
      } else if (result.status === "rejected") {
        failed += 1;
        logStructuredEvent("warn", "operator-admin.vehicles-revalidate.failed", {
          correlationId: correlationId || null,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  logStructuredEvent("info", "operator-admin.vehicles-revalidate.completed", {
    correlationId: correlationId || null,
    total: vehicleRows.length,
    revalidated,
    failed,
    limit: REVALIDATE_VEHICLES_BATCH_LIMIT,
  });

  return {
    statusCode: 200,
    payload: {
      ok: true,
      total: vehicleRows.length,
      revalidated,
      failed,
      limit: REVALIDATE_VEHICLES_BATCH_LIMIT,
      truncated: vehicleRows.length === REVALIDATE_VEHICLES_BATCH_LIMIT,
      meta: { correlationId: correlationId || null },
    },
  };
}
