import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import {
  normalizeClientName,
  isMissingRouteCatalogColumnsError,
  resolveRouteMetricsIfNeeded,
} from "./_shared.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";
import { normalizeVehicleProfile } from "../../../domain/vehicle-profiles.js";

/**
 * Salva um trecho (origem→destino) com N tarifas por veículo em uma única
 * operação. Uma tarifa = combinação (perfil, eixos) com valor/bônus próprios.
 *
 * Modelo: cada tarifa vira uma linha em route_metrics_cache — a mesma tabela
 * que as cargas, o portal do motorista e a cascata já leem. Tarifas removidas
 * da lista somem do catálogo (DELETE escopado ao trecho). Métricas
 * (distância/duração) são do trecho e valem para todas as tarifas.
 */
export async function saveRouteTrecho({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '5000'");

    if (!Array.isArray(payload.tarifas) || payload.tarifas.length === 0) {
      throw new ValidationError("Informe ao menos uma tarifa (perfil + valor) para a rota.");
    }

    const resolvedMetrics = await resolveRouteMetricsIfNeeded(payload.origem, payload.destino, payload);
    if (resolvedMetrics.distancia_km === null || resolvedMetrics.duracao_horas === null) {
      throw new ValidationError("Nao foi possivel salvar a rota sem distancia e duracao.");
    }

    const originKey = normalizeClientName(payload.origem).replace(/\s+/g, " ");
    const destinationKey = normalizeClientName(payload.destino).replace(/\s+/g, " ");
    const tempoEstimadoHoras = payload.tempo_estimado_horas ?? resolvedMetrics.duracao_horas;
    const warnings = [];

    // Normaliza as tarifas: perfil canônico (compõe a chave), eixos 0 = genérico.
    // Rejeita (perfil, eixos) duplicado no próprio payload — seria ambíguo.
    const seen = new Set();
    const tarifas = payload.tarifas.map((tarifa) => {
      const perfil = normalizeVehicleProfile(tarifa.perfil, "CARRETA");
      const eixos = tarifa.eixos ?? 0;
      const dedupeKey = `${perfil}|${eixos}`;
      if (seen.has(dedupeKey)) {
        throw new ValidationError(
          `Tarifa duplicada no mesmo trecho: ${perfil}${eixos ? ` (${eixos} eixos)` : ""}. Cada combinação de perfil e eixos só pode aparecer uma vez.`,
        );
      }
      seen.add(dedupeKey);
      return {
        perfil,
        eixos,
        valor: tarifa.valor ?? null,
        bonus: tarifa.bonus ?? null,
        bonus_exigencias: tarifa.bonus_exigencias ?? null,
      };
    });

    let catalogColumnsAvailable = true;

    // 1. Upsert de cada tarifa em route_metrics_cache.
    for (const tarifa of tarifas) {
      try {
        await client.query(
          `
            INSERT INTO public.route_metrics_cache (
              origin_key, destination_key, origem, destino,
              distancia_km, duracao_horas, tempo_estimado_horas,
              perfil_padrao, eixos, valor_padrao, bonus_padrao, bonus_exigencias, ativa, observacoes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (origin_key, destination_key, perfil_padrao, eixos) DO UPDATE SET
              origem = EXCLUDED.origem, destino = EXCLUDED.destino,
              distancia_km = EXCLUDED.distancia_km, duracao_horas = EXCLUDED.duracao_horas,
              tempo_estimado_horas = EXCLUDED.tempo_estimado_horas,
              valor_padrao = EXCLUDED.valor_padrao,
              bonus_padrao = EXCLUDED.bonus_padrao, bonus_exigencias = EXCLUDED.bonus_exigencias,
              ativa = EXCLUDED.ativa, observacoes = EXCLUDED.observacoes, updated_at = now()
          `,
          [
            originKey, destinationKey, payload.origem, payload.destino,
            resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, tempoEstimadoHoras,
            tarifa.perfil, tarifa.eixos, tarifa.valor, tarifa.bonus,
            tarifa.bonus_exigencias, payload.ativa, payload.observacoes,
          ],
        );
      } catch (error) {
        if (!isMissingRouteCatalogColumnsError(error)) throw error;
        catalogColumnsAvailable = false;
        break;
      }
    }

    if (!catalogColumnsAvailable) {
      // Schema legado sem colunas de catálogo — grava só o trecho básico (1 linha).
      await client.query(
        `
          INSERT INTO public.route_metrics_cache (
            origin_key, destination_key, origem, destino, distancia_km, duracao_horas
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (origin_key, destination_key) DO UPDATE SET
            origem = EXCLUDED.origem, destino = EXCLUDED.destino,
            distancia_km = EXCLUDED.distancia_km, duracao_horas = EXCLUDED.duracao_horas,
            updated_at = now()
        `,
        [originKey, destinationKey, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas],
      );
      warnings.push("Extended route catalog columns are not available in the current database schema.");
    }

    // 2. Remove tarifas do trecho que não estão mais na lista.
    // (SELECT + DELETE por id evita row-value NOT IN, que pg-mem não suporta.)
    let deletedCount = 0;
    if (catalogColumnsAvailable) {
      const { rows: existing } = await client.query(
        `SELECT id, perfil_padrao, eixos FROM public.route_metrics_cache
          WHERE origin_key = $1 AND destination_key = $2`,
        [originKey, destinationKey],
      );
      const keep = new Set(tarifas.map((t) => `${t.perfil}|${t.eixos}`));
      const staleIds = existing
        .filter((row) => !keep.has(`${normalizeVehicleProfile(row.perfil_padrao, "CARRETA")}|${row.eixos ?? 0}`))
        .map((row) => row.id);
      if (staleIds.length > 0) {
        const placeholders = staleIds.map((_, i) => `$${i + 1}`).join(", ");
        const del = await client.query(
          `DELETE FROM public.route_metrics_cache WHERE id IN (${placeholders})`,
          staleIds,
        );
        deletedCount = del.rowCount || 0;
      }
    }

    // 3. Sincroniza public.rotas (canônica — usada no vínculo com cliente).
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
        [payload.origem, payload.destino, resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas, payload.ativa, payload.observacoes],
      );
      rotaCanonicalId = rotaResult.rows[0]?.id ?? null;
    } catch (error) {
      const message = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
      if (!message.includes("public.rotas")) throw error;
      warnings.push("Tabela public.rotas indisponível — vínculo com cliente não foi sincronizado.");
    }

    // 4. Cascata: atualiza cargas OPEN/DRAFT do mesmo trecho + perfil + eixos
    // com o valor/bônus da tarifa correspondente. Mesma regra de match do
    // update-route (uma rota por veículo — não sobrescreve o preço de outro perfil).
    let cascadedCargaCount = 0;
    try {
      const { rows: openCargas } = await client.query(
        `SELECT id, origem, destino, perfil, eixos FROM public.cargas WHERE status IN ('OPEN', 'DRAFT') LIMIT 500`,
      );
      const routeKey = `${originKey}|${destinationKey}`;
      for (const tarifa of tarifas) {
        const matchingIds = openCargas
          .filter(
            (row) =>
              createRouteLookupKeys(row.origem, row.destino).includes(routeKey) &&
              normalizeVehicleProfile(row.perfil, "CARRETA") === tarifa.perfil &&
              (row.eixos ?? 0) === tarifa.eixos,
          )
          .map((row) => row.id);
        if (matchingIds.length === 0) continue;
        const idPlaceholders = matchingIds.map((_, i) => `$${i + 5}`).join(", ");
        const cascadeResult = await client.query(
          `
            UPDATE public.cargas
            SET valor = COALESCE($1, valor), bonus = COALESCE($2, bonus),
                distancia_km = COALESCE($3, distancia_km), duracao_horas = COALESCE($4, duracao_horas)
            WHERE id IN (${idPlaceholders})
          `,
          [tarifa.valor, tarifa.bonus, resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, ...matchingIds],
        );
        cascadedCargaCount += cascadeResult.rowCount || 0;
      }
    } catch {
      warnings.push("A rota foi salva, mas nao foi possivel atualizar as cargas abertas automaticamente.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.route.trecho_saved",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route",
      resourceId: `${originKey}|${destinationKey}`,
      action: "upsert",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        origem: payload.origem,
        destino: payload.destino,
        ativa: payload.ativa,
        tarifasCount: tarifas.length,
        deletedCount,
        cascadedCargaCount,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        rota_id: rotaCanonicalId,
        tarifasCount: tarifas.length,
        deletedCount,
        cascadedCargaCount,
        warnings,
        meta: { correlationId },
      },
    };
  });
}
