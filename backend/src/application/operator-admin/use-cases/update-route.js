import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { buildAuditChanges } from "../../../domain/operator-admin/audit-diff.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import {
  normalizeClientName,
  isMissingRouteCatalogColumnsError,
  resolveRouteMetricsIfNeeded,
} from "./_shared.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";
import { normalizeVehicleProfile } from "../../../domain/vehicle-profiles.js";

// Editar a rota para um trecho (origem→destino) + perfil + nº de eixos que já
// existe em OUTRA rota viola route_metrics_cache_origin_dest_perfil_eixos_unique
// (Postgres 23505). Devolve 409 com causa clara em vez de 500 opaco.
const DUPLICATE_ROUTE_MESSAGE =
  "Já existe uma rota com esse trecho (origem → destino), perfil e nº de eixos. Edite a rota existente em vez de criar uma duplicada.";

export async function updateOperatorRoute({ routeId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    // AL-04: statement_timeout evita que FOR UPDATE bloqueie o pool inteiro
    // se outra transaction segurar o lock indefinidamente.
    await client.query("SET LOCAL statement_timeout = '5000'");
    // SELECT * (não só id) p/ capturar o estado ANTERIOR (DC-184). `*` é seguro
    // mesmo em schema sem as colunas estendidas do catálogo — devolve o que existe.
    const { rows } = await client.query(
      `SELECT * FROM public.route_metrics_cache WHERE id = $1 FOR UPDATE`,
      [routeId],
    );

    if (!rows[0]) throw new NotFoundError("Rota nao encontrada.");
    const before = rows[0];

    const resolvedMetrics = await resolveRouteMetricsIfNeeded(payload.origem, payload.destino, payload);

    if (resolvedMetrics.distancia_km === null || resolvedMetrics.duracao_horas === null) {
      throw new ValidationError("Nao foi possivel salvar a rota sem distancia e duracao.");
    }

    const originKey = normalizeClientName(payload.origem).replace(/\s+/g, " ");
    const destinationKey = normalizeClientName(payload.destino).replace(/\s+/g, " ");
    // perfil nunca nulo (compõe a chave única); eixos 0 = genérico.
    const perfilPadrao = payload.perfil_padrao || "CARRETA";
    const eixos = payload.eixos ?? 0;
    const warnings = [];

    try {
      await client.query(
        `
          UPDATE public.route_metrics_cache
          SET
            origin_key = $2, destination_key = $3, origem = $4, destino = $5,
            distancia_km = $6, duracao_horas = $7, tempo_estimado_horas = $8,
            perfil_padrao = $9, valor_padrao = $10, bonus_padrao = $11,
            bonus_exigencias = $12, ativa = $13, observacoes = $14, eixos = $15, updated_at = now()
          WHERE id = $1
        `,
        [
          routeId, originKey, destinationKey, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas,
          payload.tempo_estimado_horas ?? resolvedMetrics.duracao_horas,
          perfilPadrao, payload.valor_padrao, payload.bonus_padrao,
          payload.bonus_exigencias, payload.ativa, payload.observacoes, eixos,
        ],
      );
    } catch (error) {
      // Colisão com outra rota do mesmo trecho+perfil+eixos → 409 claro (não 500).
      if (error?.code === "23505") throw new ConflictError(DUPLICATE_ROUTE_MESSAGE);
      if (!isMissingRouteCatalogColumnsError(error)) throw error;

      try {
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
      } catch (fallbackError) {
        if (fallbackError?.code === "23505") throw new ConflictError(DUPLICATE_ROUTE_MESSAGE);
        throw fallbackError;
      }
      warnings.push("Extended route catalog columns are not available in the current database schema.");
    }

    let cascadedCargaCount = 0;

    try {
      // Fetch all OPEN/DRAFT cargas and match via JS canonicalization.
      // SQL-level normalization cannot resolve Shopee abbreviations like
      // "SJ Rio Preto-03 / SP" → "sao jose do rio preto", so we use
      // createRouteLookupKeys (which calls canonicalizeRouteLookupLocation)
      // to identify matching cargas by ID, then update by UUID array.
      // AL-05: LIMIT defensivo — sem ele, todas as cargas abertas carregam em memória
      // dentro de uma transaction com FOR UPDATE, ampliando o tempo de lock.
      const { rows: openCargas } = await client.query(
        `SELECT id, origem, destino, perfil, eixos FROM public.cargas WHERE status IN ('OPEN', 'DRAFT') LIMIT 500`,
      );

      const routeKey = `${originKey}|${destinationKey}`;
      // Uma rota por veículo: a cascata só atinge cargas do MESMO trecho E
      // perfil E nº de eixos. Senão, editar a rota "Carreta 4 eixos"
      // sobrescreveria a carga "Bitrem" do mesmo trecho.
      const matchingIds = openCargas
        .filter(
          (row) =>
            createRouteLookupKeys(row.origem, row.destino).includes(routeKey) &&
            normalizeVehicleProfile(row.perfil, "CARRETA") === perfilPadrao &&
            (row.eixos ?? 0) === eixos,
        )
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
            payload.valor_padrao, payload.bonus_padrao, perfilPadrao,
            resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas,
            matchingIds,
          ],
        );
        cascadedCargaCount = cascadeResult.rowCount || 0;
      }
    } catch (cascadeError) {
      warnings.push("A rota foi salva, mas nao foi possivel atualizar as cargas abertas automaticamente.");
    }

    // Sincroniza com public.rotas (canônica para vínculo cliente).
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
      eventType: "operator.route.updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route",
      resourceId: routeId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        origem: payload.origem,
        destino: payload.destino,
        ativa: payload.ativa,
        cascadedCargaCount,
        changes: buildAuditChanges(
          {
            origem: before.origem,
            destino: before.destino,
            perfil: before.perfil_padrao,
            valor: before.valor_padrao,
            bonus: before.bonus_padrao,
            eixos: before.eixos,
            ativa: before.ativa,
            observacoes: before.observacoes,
          },
          {
            origem: payload.origem,
            destino: payload.destino,
            perfil: perfilPadrao,
            valor: payload.valor_padrao,
            bonus: payload.bonus_padrao,
            eixos,
            ativa: payload.ativa,
            observacoes: payload.observacoes,
          },
          [
            { key: "origem", label: "Origem" },
            { key: "destino", label: "Destino" },
            { key: "perfil", label: "Perfil" },
            { key: "valor", label: "Valor" },
            { key: "bonus", label: "Bônus" },
            { key: "eixos", label: "Eixos" },
            { key: "ativa", label: "Ativa" },
            { key: "observacoes", label: "Observações" },
          ],
        ),
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        id: routeId,
        rota_id: rotaCanonicalId,
        cascadedCargaCount,
        warnings,
        meta: { correlationId },
      },
    };
  });
}
