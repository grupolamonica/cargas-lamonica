import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import {
  normalizeClientName,
  isMissingRouteCatalogColumnsError,
  resolveRouteMetricsIfNeeded,
} from "./_shared.js";

export async function createOperatorRoute({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const resolvedMetrics = await resolveRouteMetricsIfNeeded(payload.origem, payload.destino, payload);

    if (resolvedMetrics.distancia_km === null || resolvedMetrics.duracao_horas === null) {
      throw new ValidationError("Nao foi possivel salvar a rota sem distancia e duracao.");
    }

    const originKey = normalizeClientName(payload.origem).replace(/\s+/g, " ");
    const destinationKey = normalizeClientName(payload.destino).replace(/\s+/g, " ");
    const warnings = [];
    let routeId = null;

    try {
      const insertResult = await client.query(
        `
          INSERT INTO public.route_metrics_cache (
            origin_key, destination_key, origem, destino,
            distancia_km, duracao_horas, tempo_estimado_horas,
            perfil_padrao, valor_padrao, bonus_padrao, bonus_exigencias, ativa, observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (origin_key, destination_key) DO UPDATE SET
            origem = EXCLUDED.origem, destino = EXCLUDED.destino,
            distancia_km = EXCLUDED.distancia_km, duracao_horas = EXCLUDED.duracao_horas,
            tempo_estimado_horas = EXCLUDED.tempo_estimado_horas,
            perfil_padrao = EXCLUDED.perfil_padrao, valor_padrao = EXCLUDED.valor_padrao,
            bonus_padrao = EXCLUDED.bonus_padrao, bonus_exigencias = EXCLUDED.bonus_exigencias,
            ativa = EXCLUDED.ativa, observacoes = EXCLUDED.observacoes, updated_at = now()
          RETURNING id
        `,
        [
          originKey, destinationKey, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas,
          payload.tempo_estimado_horas ?? resolvedMetrics.duracao_horas,
          payload.perfil_padrao, payload.valor_padrao, payload.bonus_padrao,
          payload.bonus_exigencias, payload.ativa, payload.observacoes,
        ],
      );
      routeId = insertResult.rows[0]?.id ?? null;
    } catch (error) {
      if (!isMissingRouteCatalogColumnsError(error)) throw error;

      const fallbackResult = await client.query(
        `
          INSERT INTO public.route_metrics_cache (
            origin_key, destination_key, origem, destino, distancia_km, duracao_horas
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (origin_key, destination_key) DO UPDATE SET
            origem = EXCLUDED.origem, destino = EXCLUDED.destino,
            distancia_km = EXCLUDED.distancia_km, duracao_horas = EXCLUDED.duracao_horas,
            updated_at = now()
          RETURNING id
        `,
        [originKey, destinationKey, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas],
      );
      routeId = fallbackResult.rows[0]?.id ?? null;
      warnings.push("Extended route catalog columns are not available in the current database schema.");
    }

    // Sincroniza com public.rotas (tabela canônica usada para vínculo com cliente).
    // Best-effort — se a tabela não existir (schema legado), apenas pula.
    let rotaCanonicalId = null;
    try {
      const rotaResult = await client.query(
        `
          INSERT INTO public.rotas (origem, destino, distancia_km, duracao_horas, ativa, observacoes)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (origem, destino) DO UPDATE SET
            distancia_km  = EXCLUDED.distancia_km,
            duracao_horas = EXCLUDED.duracao_horas,
            ativa         = EXCLUDED.ativa,
            observacoes   = EXCLUDED.observacoes,
            updated_at    = now()
          RETURNING id
        `,
        [
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          payload.ativa,
          payload.observacoes,
        ],
      );
      rotaCanonicalId = rotaResult.rows[0]?.id ?? null;
    } catch (error) {
      const message = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
      if (!message.includes('relation "public.rotas"') && !message.includes("public.rotas")) {
        throw error;
      }
      warnings.push("Tabela public.rotas indisponível — vínculo com cliente não foi sincronizado.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.route.saved",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route",
      resourceId: `${originKey}|${destinationKey}`,
      action: "upsert",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { origem: payload.origem, destino: payload.destino, ativa: payload.ativa },
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        id: routeId,
        rota_id: rotaCanonicalId,
        warnings,
        meta: { correlationId },
      },
    };
  });
}
