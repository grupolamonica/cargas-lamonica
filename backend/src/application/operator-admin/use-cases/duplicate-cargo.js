import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import {
  findSheetClientId,
  isMissingBonusRequirementsColumnError,
  isMissingDriverVisibilityColumnError,
  isMissingRouteColumnError,
  resolveRouteMetricsIfNeeded,
} from "./_shared.js";

export async function duplicateOperatorCargo({ cargoId, operatorId, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    let existingCargo;

    try {
      const { rows } = await client.query(
        `
          SELECT
            id, data, horario, origem, destino,
            distancia_km, duracao_horas, perfil, valor, bonus,
            bonus_exigencias, driver_visibility, cliente_id, sheet_lh
          FROM public.cargas
          WHERE id = $1
          FOR UPDATE
        `,
        [cargoId],
      );
      existingCargo = rows[0];
    } catch (error) {
      if (!isMissingBonusRequirementsColumnError(error) && !isMissingDriverVisibilityColumnError(error)) {
        throw error;
      }
      const { rows } = await client.query(
        `
          SELECT
            id, data, horario, origem, destino,
            distancia_km, duracao_horas, perfil, valor, bonus,
            NULL::text AS bonus_exigencias,
            'PUBLIC'::text AS driver_visibility,
            cliente_id, sheet_lh
          FROM public.cargas
          WHERE id = $1
          FOR UPDATE
        `,
        [cargoId],
      );
      existingCargo = rows[0];
    }

    if (!existingCargo) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    const sheetClientId = existingCargo.sheet_lh ? await findSheetClientId(client) : null;
    const resolvedMetrics = await resolveRouteMetricsIfNeeded(existingCargo.origem, existingCargo.destino, {
      distancia_km: existingCargo.distancia_km,
      duracao_horas: existingCargo.duracao_horas,
    });
    const warnings = [];

    try {
      await client.query(
        `
          INSERT INTO public.cargas (
            data, horario, origem, destino, distancia_km, duracao_horas,
            perfil, valor, bonus, bonus_exigencias, driver_visibility,
            cliente_id, status, is_template, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'DRAFT', false, $13)
        `,
        [
          existingCargo.data, existingCargo.horario, existingCargo.origem, existingCargo.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, existingCargo.perfil,
          existingCargo.valor, existingCargo.bonus, existingCargo.bonus_exigencias,
          existingCargo.driver_visibility || "PUBLIC",
          sheetClientId || existingCargo.cliente_id,
          operatorId,
        ],
      );
    } catch (error) {
      if (
        !isMissingRouteColumnError(error) &&
        !isMissingBonusRequirementsColumnError(error) &&
        !isMissingDriverVisibilityColumnError(error)
      ) {
        throw error;
      }
      await client.query(
        `
          INSERT INTO public.cargas (
            data, horario, origem, destino, perfil, valor, bonus,
            cliente_id, status, is_template, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', false, $9)
        `,
        [
          existingCargo.data, existingCargo.horario, existingCargo.origem, existingCargo.destino,
          existingCargo.perfil, existingCargo.valor, existingCargo.bonus,
          sheetClientId || existingCargo.cliente_id,
          operatorId,
        ],
      );
      warnings.push("Optional cargo fields are not available in the current database schema.");
    }

    if (resolvedMetrics.degraded) {
      warnings.push("Route metrics could not be refreshed at this moment.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.duplicated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "duplicate",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        origem: existingCargo.origem,
        destino: existingCargo.destino,
        forcedSheetClient: Boolean(existingCargo.sheet_lh),
      },
    });

    return {
      statusCode: 201,
      payload: { ok: true, warnings, meta: { correlationId } },
    };
  });
}
