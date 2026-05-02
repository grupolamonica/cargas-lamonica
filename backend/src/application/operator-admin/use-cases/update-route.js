import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import {
  normalizeClientName,
  isMissingRouteCatalogColumnsError,
  resolveRouteMetricsIfNeeded,
} from "./_shared.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";

export async function updateOperatorRoute({ routeId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM public.route_metrics_cache WHERE id = $1 FOR UPDATE`,
      [routeId],
    );

    if (!rows[0]) throw new NotFoundError("Rota nao encontrada.");

    const resolvedMetrics = await resolveRouteMetricsIfNeeded(payload.origem, payload.destino, payload);

    if (resolvedMetrics.distancia_km === null || resolvedMetrics.duracao_horas === null) {
      throw new ValidationError("Nao foi possivel salvar a rota sem distancia e duracao.");
    }

    const originKey = normalizeClientName(payload.origem).replace(/\s+/g, " ");
    const destinationKey = normalizeClientName(payload.destino).replace(/\s+/g, " ");
    const warnings = [];

    try {
      await client.query(
        `
          UPDATE public.route_metrics_cache
          SET
            origin_key = $2, destination_key = $3, origem = $4, destino = $5,
            distancia_km = $6, duracao_horas = $7, tempo_estimado_horas = $8,
            perfil_padrao = $9, valor_padrao = $10, bonus_padrao = $11,
            ativa = $12, observacoes = $13, updated_at = now()
          WHERE id = $1
        `,
        [
          routeId, originKey, destinationKey, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas,
          payload.tempo_estimado_horas ?? resolvedMetrics.duracao_horas,
          payload.perfil_padrao, payload.valor_padrao, payload.bonus_padrao,
          payload.ativa, payload.observacoes,
        ],
      );
    } catch (error) {
      if (!isMissingRouteCatalogColumnsError(error)) throw error;

      await client.query(
        `
          UPDATE public.route_metrics_cache
          SET
            origin_key = $2, destination_key = $3, origem = $4, destino = $5,
            distancia_km = $6, duracao_horas = $7, updated_at = now()
          WHERE id = $1
        `,
        [routeId, originKey, destinationKey, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas],
      );
      warnings.push("Extended route catalog columns are not available in the current database schema.");
    }

    let cascadedCargaCount = 0;

    try {
      // Fetch all OPEN/DRAFT cargas and match via JS canonicalization.
      // SQL-level normalization cannot resolve Shopee abbreviations like
      // "SJ Rio Preto-03 / SP" → "sao jose do rio preto", so we use
      // createRouteLookupKeys (which calls canonicalizeRouteLookupLocation)
      // to identify matching cargas by ID, then update by UUID array.
      const { rows: openCargas } = await client.query(
        `SELECT id, origem, destino FROM public.cargas WHERE status IN ('OPEN', 'DRAFT')`,
      );

      const routeKey = `${originKey}|${destinationKey}`;
      const matchingIds = openCargas
        .filter((row) => createRouteLookupKeys(row.origem, row.destino).includes(routeKey))
        .map((row) => row.id);

      if (matchingIds.length > 0) {
        const cascadeResult = await client.query(
          `
            UPDATE public.cargas
            SET
              valor = COALESCE($1, valor), bonus = COALESCE($2, bonus),
              perfil = COALESCE($3, perfil), distancia_km = COALESCE($4, distancia_km),
              duracao_horas = COALESCE($5, duracao_horas)
            WHERE id = ANY($6::uuid[])
          `,
          [
            payload.valor_padrao, payload.bonus_padrao, payload.perfil_padrao,
            resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas,
            matchingIds,
          ],
        );
        cascadedCargaCount = cascadeResult.rowCount || 0;
      }
    } catch (cascadeError) {
      warnings.push("A rota foi salva, mas nao foi possivel atualizar as cargas abertas automaticamente.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.route.updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route",
      resourceId: routeId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { origem: payload.origem, destino: payload.destino, ativa: payload.ativa, cascadedCargaCount },
    });

    return {
      statusCode: 200,
      payload: { ok: true, cascadedCargaCount, warnings, meta: { correlationId } },
    };
  });
}
