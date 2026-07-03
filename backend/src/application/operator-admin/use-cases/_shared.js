/**
 * Shared helpers and constants used across operator-admin use cases.
 * All exports are internal — do not import from outside this directory.
 */

import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { ForbiddenError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { getRouteInfo } from "../../../infrastructure/geoapify/index.js";
import {
  parseNullableNumber,
  createRouteLookupKeys,
  canonicalizeRouteLookupLocation,
  normalizeRouteLocation,
} from "../../../domain/operator-admin/route-utils.js";
import { baseRouteValues } from "../../../domain/operator-admin/base-route-values.js";
import { parseDriverLoadsQuery } from "../../../domain/operator-admin/schemas.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const MANUAL_CARGO_STATUSES = new Set(["DRAFT", "OPEN"]);
export const DEFAULT_SHEET_CLIENT_NAME = "Shopee";
export const TERMINAL_LOAD_STATUSES = ["BOOKED", "EXPIRED", "CANCELLED", "COMPLETED", "FAILED"];
export const DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
export const REVALIDATE_VEHICLES_BATCH_LIMIT = 50;
export const REVALIDATE_VEHICLES_CONCURRENCY = 5;

// ─── Helper functions ─────────────────────────────────────────────────────────

export function getDefaultSheetClientName() {
  return process.env.GOOGLE_SHEET_DEFAULT_CLIENT_NAME?.trim() || DEFAULT_SHEET_CLIENT_NAME;
}

export function normalizeClientName(value) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

export function isMissingRouteColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("distancia_km") ||
    combinedMessage.includes("duracao_horas") ||
    combinedMessage.includes("eixos")
  );
}

export function isMissingRouteCatalogTableError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("route_metrics_cache");
}

export function isMissingClienteLogoColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("logo_url");
}

export function isMissingRouteCatalogColumnsError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("tempo_estimado_horas") ||
    combinedMessage.includes("perfil_padrao") ||
    combinedMessage.includes("valor_padrao") ||
    combinedMessage.includes("bonus_padrao") ||
    combinedMessage.includes("ativa") ||
    combinedMessage.includes("observacoes")
  );
}

export function isMissingSheetScheduleColumnsError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("sheet_data_carregamento") || combinedMessage.includes("sheet_data_descarga");
}

export function isMissingBonusRequirementsColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("bonus_exigencias");
}

export function isMissingDriverVisibilityColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("driver_visibility");
}

export function isMissingEixosColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("eixos");
}

export function isMissingRecurrenceColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("is_recurring") || combinedMessage.includes("recurrence_interval_days");
}

// Phase 10 (cargas-casadas): se a tabela cargas_casadas / coluna viagem_id ainda nao
// foi aplicada na DB (rollout incremental), a query principal de driver-loads
// faz fallback para a versao sem JOIN de pacote — comportamento pre-Phase 10.
export function isMissingPacoteColumnsError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("cargas_casadas") ||
    combinedMessage.includes("viagem_id") ||
    combinedMessage.includes("ordem_viagem")
  );
}

export function isMissingOptionalCargoReadModelColumnsError(error) {
  return isMissingRouteColumnError(error) || isMissingSheetScheduleColumnsError(error);
}

export async function fetchRouteCatalogMetricsByLoadId(client, loadRows) {
  if (!Array.isArray(loadRows) || loadRows.length === 0) {
    return new Map();
  }

  const originKeys = new Set();
  const destinationKeys = new Set();

  loadRows.forEach((row) => {
    createRouteLookupKeys(row.origem, row.destino).forEach((routeKey) => {
      const [originKey, destinationKey] = routeKey.split("|");
      if (originKey) originKeys.add(originKey);
      if (destinationKey) destinationKeys.add(destinationKey);
    });
  });

  if (originKeys.size === 0 || destinationKeys.size === 0) {
    return new Map();
  }

  try {
    const { rows } = await client.query(
      `
        SELECT
          origin_key,
          destination_key,
          distancia_km,
          tempo_estimado_horas,
          duracao_horas,
          perfil_padrao,
          valor_padrao,
          bonus_padrao
        FROM public.route_metrics_cache
        WHERE origin_key = ANY($1::text[])
          AND destination_key = ANY($2::text[])
      `,
      [Array.from(originKeys), Array.from(destinationKeys)],
    );

    // Uma rota por veículo: várias linhas podem compartilhar o mesmo trecho
    // (origem|destino) divergindo só no perfil/eixos. Agrupamos por trecho e,
    // no match, preferimos a linha cujo perfil casa com o da carga (fallback:
    // primeira linha do trecho). Preserva o comportamento legado com 1 só linha.
    const routeMetricsByLocation = new Map();

    rows.forEach((row) => {
      const distanceKm = parseNullableNumber(row.distancia_km);
      const routeEstimatedHours =
        parseNullableNumber(row.tempo_estimado_horas) ?? parseNullableNumber(row.duracao_horas);
      const durationHours = parseNullableNumber(row.duracao_horas);
      const profile =
        typeof row.perfil_padrao === "string" && row.perfil_padrao.trim() !== ""
          ? row.perfil_padrao.trim()
          : null;
      const value = parseNullableNumber(row.valor_padrao);
      const bonus = parseNullableNumber(row.bonus_padrao);

      if (
        distanceKm === null &&
        routeEstimatedHours === null &&
        durationHours === null &&
        profile === null &&
        value === null &&
        bonus === null
      ) {
        return;
      }

      const locationKey = `${row.origin_key}|${row.destination_key}`;
      if (!routeMetricsByLocation.has(locationKey)) {
        routeMetricsByLocation.set(locationKey, []);
      }
      routeMetricsByLocation.get(locationKey).push({
        perfil_padrao: profile,
        metrics: {
          distancia_km: distanceKm,
          tempo_estimado_horas: routeEstimatedHours,
          duracao_horas: durationHours,
          perfil_padrao: profile,
          valor_padrao: value,
          bonus_padrao: bonus,
        },
      });
    });

    const pickRouteMetrics = (row) => {
      const locationKey = createRouteLookupKeys(row.origem, row.destino).find((routeKey) =>
        routeMetricsByLocation.has(routeKey),
      );
      if (!locationKey) return null;
      const candidates = routeMetricsByLocation.get(locationKey);
      const cargoProfile = String(row.perfil ?? "").trim().toUpperCase();
      const matched =
        (cargoProfile && candidates.find((c) => String(c.perfil_padrao ?? "").toUpperCase() === cargoProfile)) ||
        candidates[0];
      return matched ? matched.metrics : null;
    };

    return new Map(loadRows.map((row) => [row.id, pickRouteMetrics(row)]));
  } catch (error) {
    if (isMissingRouteCatalogTableError(error) || isMissingRouteCatalogColumnsError(error)) {
      return new Map();
    }
    throw error;
  }
}

function _approximateCity(normalizedValue, knownCities) {
  let best = null;
  for (const city of knownCities) {
    if (!city) continue;
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(normalizedValue)) {
      if (!best || city.length > best.length) best = city;
    }
  }
  return best;
}

export function buildRouteLabelMap(loadRows) {
  if (!Array.isArray(loadRows) || loadRows.length === 0) {
    return new Map();
  }

  // Exact lookup: "originVariant|destinationVariant" -> canonical route label
  const labelByKey = new Map();
  baseRouteValues.forEach((entry) => {
    createRouteLookupKeys(entry.origin, entry.destination).forEach((key) => {
      if (!labelByKey.has(key)) labelByKey.set(key, entry.route);
    });
  });

  // Approximate lookup: "canonicalOrigin|canonicalDest" -> route label
  const labelByCanonical = new Map();
  const knownCities = new Set();
  baseRouteValues.forEach((entry) => {
    const co = canonicalizeRouteLookupLocation(entry.origin);
    const cd = canonicalizeRouteLookupLocation(entry.destination);
    if (!labelByCanonical.has(`${co}|${cd}`)) labelByCanonical.set(`${co}|${cd}`, entry.route);
    if (co) knownCities.add(co);
    if (cd) knownCities.add(cd);
  });

  const unmatched = [];

  const result = new Map(
    loadRows.map((row) => {
      // 1. Exact match
      const exactKey = createRouteLookupKeys(row.origem, row.destino)
        .find((key) => labelByKey.has(key));
      if (exactKey) return [row.id, labelByKey.get(exactKey)];

      // 2. Approximate match — find longest known city name inside normalized string
      const normOrigin = normalizeRouteLocation(row.origem ?? "");
      const normDest = normalizeRouteLocation(row.destino ?? "");
      const approxOrigin = _approximateCity(normOrigin, knownCities);
      const approxDest = _approximateCity(normDest, knownCities);
      if (approxOrigin && approxDest) {
        const approxLabel = labelByCanonical.get(`${approxOrigin}|${approxDest}`);
        if (approxLabel) return [row.id, approxLabel];
      }

      // Fallback: construct a displayable label from the cargo's own origem/destino.
      // Use the raw string (not canonicalized — that strips accents for matching purposes).
      // Strip the "/UF" state suffix only (e.g. "São Bernardo do Campo/SP" → "SÃO BERNARDO DO CAMPO").
      const rawOrigin = String(row.origem ?? "").replace(/\s*\/\s*[A-Za-z]{2}$/i, "").trim();
      const rawDest = String(row.destino ?? "").replace(/\s*\/\s*[A-Za-z]{2}$/i, "").trim();
      const fallbackLabel = rawOrigin && rawDest ? `${rawOrigin.toUpperCase()} X ${rawDest.toUpperCase()}` : null;
      if (!fallbackLabel) unmatched.push({ id: row.id, origem: row.origem, destino: row.destino });
      return [row.id, fallbackLabel];
    }),
  );

  if (unmatched.length > 0) {
    console.warn(
      `[buildRouteLabelMap] ${unmatched.length} carga(s) sem rota correspondente:\n` +
        unmatched.map((u) => `  id=${u.id}  origem="${u.origem}"  destino="${u.destino}"`).join("\n"),
    );
  }

  return result;
}

/**
 * Constroi o objeto `pacote_meta` quando a carga pertence a um pacote.
 * Cargas avulsas (viagem_id IS NULL) retornam null — backward-compat: frontend
 * antigo que ignora o campo nao quebra.
 *
 * Implementado em JS em vez de SQL (jsonb_build_object) porque pg-mem nao suporta
 * jsonb_build_object e o codebase precisa rodar testes locais sem postgres real.
 *
 * Campos derivados (plan revisao 2026-05-23):
 *  - earliest_carga_date: data (YYYY-MM-DD) da carga com menor data dentro do pacote
 *  - earliest_carga_horario: horario (HH:MM:SS) da carga com menor data — usado
 *    pelo PacoteHeader badge "Coleta DD/MM as HH:MM" (iter #2)
 *  - total_km: soma das distancia_km das cargas do pacote (null quando todas null)
 *  - total_duration_horas: soma das duracao_horas (null quando todas null)
 *  - cliente_uniforme: { id, nome, logo_url } quando todas as cargas tem o mesmo
 *    cliente_id; null quando ha clientes distintos ou cargas sem cliente
 *  - perfil_uniforme: string do perfil quando todas as cargas tem o mesmo perfil;
 *    null caso contrario
 *
 * Os agregados vem da query principal via cc_aggregates subquery — campos
 * row.pacoteEarliestDate, row.pacoteEarliestHorario, row.pacoteTotalKm,
 * row.pacoteTotalDuracaoHoras, row.pacoteClienteUniformeId,
 * row.pacoteClienteUniformeNome, etc.
 */
export function buildPacoteMeta(row) {
  if (!row?.viagemId) return null;

  // Plan revisao 2026-05-23 — derivar uniformidade a partir dos primos
  // (MIN + COUNT(DISTINCT)) que vem do cc_aggregates subquery. Quando o
  // count distinto e 1, o MIN representa o valor uniforme. Quando > 1 ou
  // 0, retorna null (heterogeneo ou sem dados).
  const clienteDistinctCount = Number(row.pacoteClienteDistinctCount ?? 0);
  const clienteIdMin = row.pacoteClienteIdMin ?? null;
  const cliente_uniforme =
    clienteDistinctCount === 1 && clienteIdMin
      ? {
          id: clienteIdMin,
          nome: row.pacoteClienteUniformeNome ?? null,
          logo_url: row.pacoteClienteUniformeLogoUrl ?? null,
        }
      : null;

  const perfilDistinctCount = Number(row.pacotePerfilDistinctCount ?? 0);
  const perfilMin =
    typeof row.pacotePerfilMin === "string" && row.pacotePerfilMin.trim() !== ""
      ? row.pacotePerfilMin
      : null;
  const perfil_uniforme = perfilDistinctCount === 1 ? perfilMin : null;

  return {
    id: row.viagemId,
    status: row.pacoteStatus ?? null,
    valor_total: parseNullableNumber(row.pacoteValorTotal),
    version: row.pacoteVersion ?? null,
    published_at: row.pacotePublishedAt ?? null,
    total_cargas:
      typeof row.pacoteTotalCargas === "number"
        ? row.pacoteTotalCargas
        : Number.parseInt(row.pacoteTotalCargas ?? "0", 10) || 0,
    ordem_propria: row.ordemViagem ?? null,
    earliest_carga_date: row.pacoteEarliestDate ?? null,
    earliest_carga_horario: row.pacoteEarliestHorario ?? null,
    total_km: parseNullableNumber(row.pacoteTotalKm),
    total_duration_horas: parseNullableNumber(row.pacoteTotalDuracaoHoras),
    cliente_uniforme,
    perfil_uniforme,
  };
}

export function mapDriverLoadReadModelItem(row) {
  return {
    id: row.id,
    data: row.data,
    horario: row.horario,
    origem: row.origem,
    destino: row.destino,
    distancia_km: parseNullableNumber(row.distancia_km),
    duracao_horas: parseNullableNumber(row.duracao_horas),
    tempo_estimado_horas: parseNullableNumber(row.tempo_estimado_horas),
    perfil: row.perfil,
    eixos: parseNullableNumber(row.eixos),
    valor: parseNullableNumber(row.valor),
    bonus: parseNullableNumber(row.bonus),
    clienteId: row.clienteId ?? null,
    clienteNome: row.clienteNome ?? null,
    clienteDescricao: row.clienteDescricao ?? null,
    clienteLogoUrl: row.clienteLogoUrl ?? null,
    clienteLogoUrlCard: row.clienteLogoUrlCard ?? null,
    clienteLogoUrlProximas: row.clienteLogoUrlProximas ?? null,
    carregamentoLabel: row.carregamentoLabel ?? null,
    descargaLabel: row.descargaLabel ?? null,
    routeLabel: row.routeLabel ?? null,
    // Phase 10 (cargas-casadas): expoe metadata do pacote quando a carga e parte de viagem casada.
    viagem_id: row.viagemId ?? null,
    ordem_viagem: row.ordemViagem ?? null,
    pacote_meta: buildPacoteMeta(row),
  };
}

export function normalizeOptionalText(value) {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  return trimmedValue !== "" ? trimmedValue : null;
}

export function buildDriverLoadPublicationState(row, routeCatalogMetrics, routeLabel = null) {
  const perfil = normalizeOptionalText(row.perfil) ?? routeCatalogMetrics?.perfil_padrao ?? null;
  const valor = parseNullableNumber(row.valor) ?? routeCatalogMetrics?.valor_padrao ?? null;
  const bonus = parseNullableNumber(row.bonus) ?? routeCatalogMetrics?.bonus_padrao ?? null;
  const distanciaKm = parseNullableNumber(row.distancia_km) ?? routeCatalogMetrics?.distancia_km ?? null;
  const duracaoHoras = parseNullableNumber(row.duracao_horas) ?? routeCatalogMetrics?.duracao_horas ?? null;
  const tempoEstimadoHoras =
    parseNullableNumber(row.tempo_estimado_horas) ??
    routeCatalogMetrics?.tempo_estimado_horas ??
    duracaoHoras;
  const routeMetricsRequired = row.__routeColumnsAvailable !== false;
  const missingFields = [];

  if (perfil === null) missingFields.push("profile");
  if (valor === null) missingFields.push("payment");
  if (routeMetricsRequired && distanciaKm === null) missingFields.push("distance");
  if (routeMetricsRequired && tempoEstimadoHoras === null) missingFields.push("estimatedTime");
  if (routeLabel === null) missingFields.push("routeLabel");

  return {
    isReady: missingFields.length === 0,
    missingFields,
    row: {
      ...row,
      perfil: perfil ?? "",
      valor,
      bonus,
      distancia_km: distanciaKm,
      duracao_horas: duracaoHoras,
      tempo_estimado_horas: tempoEstimadoHoras,
      routeLabel,
    },
  };
}

/**
 * Query principal do driver portal — devolve cargas elegiveis para listing.
 *
 * Phase 10 (cargas-casadas): quando `withPacoteJoin=true`, augmenta a query com:
 *  - LEFT JOIN cargas_casadas (campos do pacote: status, valor_total, version, published_at)
 *  - LEFT JOIN subquery GROUP BY (total_cargas por pacote — anti-N+1, evita correlated subquery
 *    e LATERAL que pg-mem nao suporta; em postgres real, indice idx_cargas_viagem_id mantem custo baixo)
 *  - DISTINCT ON (COALESCE(viagem_id, id)) — pacote aparece UMA vez no listing (primeira carga),
 *    avulsa continua aparecendo normalmente
 *  - Filtro WHERE adicional: cargas de pacote so visiveis em status publicado/reservado/em_andamento
 *
 * Facets/operator-admin chamam com `withPacoteJoin=false` — preservam comportamento legado.
 *
 * Ordem global do listing (data ASC, horario ASC, id ASC) e preservada via subquery:
 * DISTINCT ON dedupe em inner SELECT; ORDER BY final aplica-se no outer SELECT.
 */
export async function queryDriverLoadCandidateRows(
  client,
  { whereSql, values, withPacoteJoin = false } = {},
) {
  const buildItemQuery = ({
    withRouteColumns = true,
    withSheetScheduleColumns = true,
    includePacoteJoin = withPacoteJoin,
  } = {}) => {
    const innerSelect = `
          SELECT
            ${includePacoteJoin ? "DISTINCT ON (COALESCE(cargas.viagem_id, cargas.id))" : ""}
            cargas.id,
            cargas.data,
            cargas.horario,
            cargas.origem,
            cargas.destino,
            ${withRouteColumns ? "TRUE" : "FALSE"}::boolean AS "__routeColumnsAvailable",
            ${withRouteColumns ? "cargas.distancia_km" : "NULL::numeric AS distancia_km"},
            ${withRouteColumns ? "cargas.duracao_horas" : "NULL::numeric AS duracao_horas"},
            cargas.perfil,
            ${withRouteColumns ? "cargas.eixos" : "NULL::smallint AS eixos"},
            cargas.valor,
            cargas.bonus,
            cargas.cliente_id AS "clienteId",
            clientes.nome AS "clienteNome",
            clientes.descricao AS "clienteDescricao",
            clientes.logo_url AS "clienteLogoUrl",
            clientes.logo_url_card AS "clienteLogoUrlCard",
            clientes.logo_url_proximas AS "clienteLogoUrlProximas",
            ${withSheetScheduleColumns ? 'cargas.sheet_data_carregamento AS "carregamentoLabel"' : 'NULL::text AS "carregamentoLabel"'},
            ${withSheetScheduleColumns ? 'cargas.sheet_data_descarga AS "descargaLabel"' : 'NULL::text AS "descargaLabel"'}
            ${includePacoteJoin ? `,
            cargas.viagem_id AS "viagemId",
            cargas.ordem_viagem AS "ordemViagem",
            cc.status AS "pacoteStatus",
            cc.valor_total AS "pacoteValorTotal",
            cc.version AS "pacoteVersion",
            cc.published_at AS "pacotePublishedAt",
            cc_counts.total_cargas AS "pacoteTotalCargas",
            cc_aggregates.earliest_date AS "pacoteEarliestDate",
            cc_aggregates.earliest_horario AS "pacoteEarliestHorario",
            cc_aggregates.total_km AS "pacoteTotalKm",
            cc_aggregates.total_duracao_horas AS "pacoteTotalDuracaoHoras",
            cc_aggregates.perfil_min AS "pacotePerfilMin",
            cc_aggregates.perfil_distinct_count AS "pacotePerfilDistinctCount",
            cc_aggregates.cliente_id_min AS "pacoteClienteIdMin",
            cc_aggregates.cliente_distinct_count AS "pacoteClienteDistinctCount",
            cc_cliente_uniforme.nome AS "pacoteClienteUniformeNome",
            cc_cliente_uniforme.logo_url AS "pacoteClienteUniformeLogoUrl"
            ` : ""}
          FROM public.cargas
          LEFT JOIN public.clientes
            ON clientes.id = cargas.cliente_id
          ${includePacoteJoin ? `
          LEFT JOIN public.cargas_casadas cc
            ON cc.id = cargas.viagem_id
          LEFT JOIN (
            SELECT viagem_id, COUNT(*)::int AS total_cargas
              FROM public.cargas
             WHERE viagem_id IS NOT NULL
             GROUP BY viagem_id
          ) cc_counts ON cc_counts.viagem_id = cargas.viagem_id
          LEFT JOIN (
            -- Agregados por pacote (plan revisao 2026-05-23): date, km, horas,
            -- e os elementos primos (MIN + COUNT DISTINCT) que o JS combina em
            -- perfil_uniforme/cliente_uniforme via buildPacoteMeta. Evita
            -- CASE WHEN COUNT(DISTINCT) IN subquery (pg-mem instavel).
            SELECT
              viagem_id,
              MIN(data) AS earliest_date,
              -- iter #2 (2026-05-23): MIN(horario) — usado pelo PacoteHeader
              -- badge "Coleta DD/MM as HH:MM". Nullable quando todas cargas
              -- nao tem horario (raro mas possivel em rascunho).
              MIN(horario) AS earliest_horario,
              SUM(distancia_km) AS total_km,
              SUM(duracao_horas) AS total_duracao_horas,
              MIN(perfil) AS perfil_min,
              COUNT(DISTINCT perfil)::int AS perfil_distinct_count,
              -- pg-mem nao implementa MIN(uuid); cast pra text e devolve string
              -- (UUID-shaped) — buildPacoteMeta nao re-parsea, so usa como identifier.
              MIN(cliente_id::text) AS cliente_id_min,
              COUNT(DISTINCT cliente_id)::int AS cliente_distinct_count
              FROM public.cargas
             WHERE viagem_id IS NOT NULL
             GROUP BY viagem_id
          ) cc_aggregates ON cc_aggregates.viagem_id = cargas.viagem_id
          LEFT JOIN public.clientes cc_cliente_uniforme
            ON cc_cliente_uniforme.id::text = cc_aggregates.cliente_id_min
          ` : ""}
          WHERE ${whereSql}
          ${includePacoteJoin
            ? "ORDER BY COALESCE(cargas.viagem_id, cargas.id), cargas.ordem_viagem ASC NULLS LAST, cargas.data ASC, cargas.horario ASC, cargas.id ASC"
            : "ORDER BY cargas.data ASC, cargas.horario ASC, cargas.id ASC"}
        `;

    // Pacote-aware: DISTINCT ON precisa do ORDER BY iniciando por COALESCE(viagem_id, id).
    // Para devolver o listing na ordem global esperada (data ASC, horario ASC, id ASC),
    // envelopamos a inner-query DISTINCT em uma outer-query que reordena.
    if (includePacoteJoin) {
      return `SELECT * FROM (${innerSelect}) deduped
              ORDER BY deduped.data ASC, deduped.horario ASC, deduped.id ASC`;
    }
    return innerSelect;
  };

  try {
    const queryResult = await client.query(buildItemQuery(), values);
    return queryResult.rows;
  } catch (error) {
    // Fallback Phase 10: cargas_casadas / viagem_id / ordem_viagem ainda nao migrados.
    // Re-tenta sem o JOIN de pacote, preservando o resto do comportamento.
    if (withPacoteJoin && isMissingPacoteColumnsError(error)) {
      try {
        const fallback = await client.query(
          buildItemQuery({ includePacoteJoin: false }),
          values,
        );
        return fallback.rows;
      } catch (fallbackError) {
        if (!isMissingOptionalCargoReadModelColumnsError(fallbackError)) throw fallbackError;
        const fallback2 = await client.query(
          buildItemQuery({
            includePacoteJoin: false,
            withRouteColumns: !isMissingRouteColumnError(fallbackError),
            withSheetScheduleColumns: !isMissingSheetScheduleColumnsError(fallbackError),
          }),
          values,
        );
        return fallback2.rows;
      }
    }

    if (!isMissingOptionalCargoReadModelColumnsError(error)) throw error;
    const fallbackQueryResult = await client.query(
      buildItemQuery({
        withRouteColumns: !isMissingRouteColumnError(error),
        withSheetScheduleColumns: !isMissingSheetScheduleColumnsError(error),
      }),
      values,
    );
    return fallbackQueryResult.rows;
  }
}

export async function resolveRouteMetricsIfNeeded(origem, destino, existingMetrics = {}) {
  const distanceKm = typeof existingMetrics.distancia_km === "number" ? existingMetrics.distancia_km : null;
  const durationHours = typeof existingMetrics.duracao_horas === "number" ? existingMetrics.duracao_horas : null;

  if (distanceKm !== null && durationHours !== null) {
    return { distancia_km: distanceKm, duracao_horas: durationHours, degraded: false };
  }

  try {
    const routeInfo = await getRouteInfo(origem, destino);
    return { distancia_km: routeInfo.distanceKm, duracao_horas: routeInfo.durationHours, degraded: false };
  } catch (error) {
    logStructuredEvent("warn", "operator-admin.route-metrics.unavailable", {
      origem,
      destino,
      message: error instanceof Error ? error.message : String(error),
    });
    return { distancia_km: distanceKm, duracao_horas: durationHours, degraded: true };
  }
}

export async function findSheetClientId(client) {
  const targetName = getDefaultSheetClientName();
  const { rows } = await client.query(
    "SELECT id FROM public.clientes WHERE LOWER(nome) = LOWER($1) LIMIT 1",
    [targetName],
  );
  return rows[0]?.id ?? null;
}

export async function findCargoById(client, cargoId, { lock = false } = {}) {
  const suffix = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `SELECT id, status, cliente_id, sheet_lh, created_by, valor, bonus, viagem_id
       FROM public.cargas WHERE id = $1 ${suffix}`,
    [cargoId],
  );
  return rows[0] || null;
}

export function assertCargoOwnership(cargo, operatorId, options = {}) {
  if (options.accessLevel === "advanced") return;
  if (cargo.created_by && cargo.created_by !== operatorId) {
    throw new ForbiddenError("Acesso negado: esta carga pertence a outro operador.");
  }
}

export async function writeCargo(
  client,
  { cargoId, operatorId, payload, requestIp, correlationId, skipRouteMetrics = false },
) {
  const existingCargo = cargoId ? await findCargoById(client, cargoId, { lock: true }) : null;

  if (cargoId && !existingCargo) {
    throw new NotFoundError("Carga nao encontrada.");
  }

  if (existingCargo && !MANUAL_CARGO_STATUSES.has(existingCargo.status) && payload.status !== existingCargo.status) {
    throw new ForbiddenError("Somente cargas em rascunho ou abertas podem ter o status alterado manualmente.");
  }

  // Em importações em lote evitamos chamadas externas (Geoapify) por linha
  // dentro da transação: usamos só as métricas informadas (ou null).
  const resolvedMetrics = skipRouteMetrics
    ? {
        distancia_km: typeof payload.distancia_km === "number" ? payload.distancia_km : null,
        duracao_horas: typeof payload.duracao_horas === "number" ? payload.duracao_horas : null,
        degraded: false,
      }
    : await resolveRouteMetricsIfNeeded(payload.origem, payload.destino, {
        distancia_km: payload.distancia_km,
        duracao_horas: payload.duracao_horas,
      });

  const shouldLockSheetClient = Boolean(existingCargo?.sheet_lh);
  const sheetClientId = shouldLockSheetClient ? await findSheetClientId(client) : null;
  const clienteId = shouldLockSheetClient
    ? sheetClientId || existingCargo?.cliente_id || null
    : payload.cliente_id;
  const nextStatus =
    existingCargo && !MANUAL_CARGO_STATUSES.has(existingCargo.status)
      ? existingCargo.status
      : payload.status;
  const nextDriverVisibility = payload.driver_visibility || "PUBLIC";
  const resolvedValor = payload.valor !== undefined ? payload.valor : (existingCargo?.valor ?? null);
  const resolvedBonus = payload.bonus !== undefined ? payload.bonus : (existingCargo?.bonus ?? null);
  const resolvedIsRecurring = payload.is_recurring === true;
  // Intervalo só faz sentido quando recorrente; NULL/inválido => diário (1).
  const resolvedRecurrenceInterval = resolvedIsRecurring
    ? (Number.isInteger(payload.recurrence_interval_days) && payload.recurrence_interval_days > 0
        ? payload.recurrence_interval_days
        : 1)
    : null;
  const warnings = [];
  let schemaFallbackUsed = false;
  let createdId = cargoId; // no INSERT vira o id recém-gerado (RETURNING id)

  if (cargoId) {
    try {
      await client.query(
        `
          UPDATE public.cargas
          SET
            data = $2, horario = $3, origem = $4, destino = $5,
            distancia_km = $6, duracao_horas = $7, perfil = $8,
            valor = $9, bonus = $10, bonus_exigencias = $11,
            driver_visibility = $12, cliente_id = $13, status = $14,
            is_template = $15, sheet_data_carregamento = $16, sheet_data_descarga = $17,
            eixos = $18, is_recurring = $19, recurrence_interval_days = $20
          WHERE id = $1
        `,
        [
          cargoId, payload.data, payload.horario, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, payload.perfil,
          resolvedValor, resolvedBonus, payload.bonus_exigencias, nextDriverVisibility,
          clienteId, nextStatus, payload.is_template,
          payload.sheet_data_carregamento ?? null, payload.sheet_data_descarga ?? null,
          payload.eixos ?? null, resolvedIsRecurring, resolvedRecurrenceInterval,
        ],
      );
    } catch (error) {
      if (
        !isMissingRouteColumnError(error) &&
        !isMissingBonusRequirementsColumnError(error) &&
        !isMissingDriverVisibilityColumnError(error) &&
        !isMissingSheetScheduleColumnsError(error) &&
        !isMissingEixosColumnError(error) &&
        !isMissingRecurrenceColumnError(error)
      ) {
        throw error;
      }
      await client.query(
        `
          UPDATE public.cargas
          SET data = $2, horario = $3, origem = $4, destino = $5,
              perfil = $6, valor = $7, bonus = $8, cliente_id = $9,
              status = $10, is_template = $11
          WHERE id = $1
        `,
        [
          cargoId, payload.data, payload.horario, payload.origem, payload.destino,
          payload.perfil, resolvedValor, resolvedBonus, clienteId, nextStatus, payload.is_template,
        ],
      );
      schemaFallbackUsed = true;
      warnings.push("Optional cargo fields are not available in the current database schema.");
    }
  } else {
    try {
      const ins = await client.query(
        `
          INSERT INTO public.cargas (
            data, horario, origem, destino, distancia_km, duracao_horas,
            perfil, valor, bonus, bonus_exigencias, driver_visibility,
            cliente_id, status, is_template, created_by,
            sheet_data_carregamento, sheet_data_descarga, eixos,
            is_recurring, recurrence_interval_days
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          RETURNING id
        `,
        [
          payload.data, payload.horario, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, payload.perfil,
          resolvedValor, resolvedBonus, payload.bonus_exigencias, nextDriverVisibility,
          clienteId, nextStatus, payload.is_template, operatorId,
          payload.sheet_data_carregamento ?? null, payload.sheet_data_descarga ?? null,
          payload.eixos ?? null, resolvedIsRecurring, resolvedRecurrenceInterval,
        ],
      );
      createdId = ins.rows[0]?.id ?? null;
    } catch (error) {
      if (
        !isMissingRouteColumnError(error) &&
        !isMissingBonusRequirementsColumnError(error) &&
        !isMissingDriverVisibilityColumnError(error) &&
        !isMissingSheetScheduleColumnsError(error) &&
        !isMissingEixosColumnError(error) &&
        !isMissingRecurrenceColumnError(error)
      ) {
        throw error;
      }
      const insFallback = await client.query(
        `
          INSERT INTO public.cargas (
            data, horario, origem, destino, perfil, valor, bonus,
            cliente_id, status, is_template, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id
        `,
        [
          payload.data, payload.horario, payload.origem, payload.destino,
          payload.perfil, resolvedValor, resolvedBonus, clienteId,
          nextStatus, payload.is_template, operatorId,
        ],
      );
      createdId = insFallback.rows[0]?.id ?? null;
      schemaFallbackUsed = true;
      warnings.push("Optional cargo fields are not available in the current database schema.");
    }
  }

  if (resolvedMetrics.degraded) {
    warnings.push("Route metrics could not be refreshed at this moment.");
  }

  await insertSecurityAuditEvent(client, {
    eventType: cargoId ? "operator.cargo.updated" : "operator.cargo.created",
    actorUserId: operatorId,
    actorRole: "operator",
    resourceType: "cargo",
    resourceId: createdId || null,
    action: cargoId ? "update" : "create",
    outcome: "success",
    requestIp,
    correlationId,
    metadata: {
      origem: payload.origem,
      destino: payload.destino,
      status: nextStatus,
      isTemplate: payload.is_template,
      isRecurring: resolvedIsRecurring,
      recurrenceIntervalDays: resolvedRecurrenceInterval,
      degradedRouteMetrics: resolvedMetrics.degraded,
      schemaFallbackUsed,
      sheetClientLocked: shouldLockSheetClient,
    },
  });

  return { warnings, cargoId: createdId };
}

export function buildDriverLoadFilters(query, {
  includeDriverVisibilityFilter = true,
  includePacoteVisibilityFilter = false,
} = {}) {
  const parsedQuery = parseDriverLoadsQuery(query);
  const clauses = [
    "cargas.status = 'OPEN'",
    "COALESCE(cargas.is_template, false) = false",
    // Defense-in-depth: a planilha (Google Sheets/Shopee) é a fonte de verdade
    // para alocação de motorista. Se o sync atrasar/falhar, cargas com motorista
    // já atribuído no sheet (sheet_motorista preenchido) continuariam visíveis
    // no painel por dependerem só de `cargas.status='OPEN'`. Bloquear por
    // sheet_motorista impede esse vazamento.
    //
    // NOTA: filtro de `sheet_status` foi removido (era over-broad). Statuses
    // como 'AGUARDANDO CARREGAMENTO' / 'AGUARDANDO CHEGAR NO CLIENTE' indicam
    // pipeline aberto na planilha, não alocação — bloquear escondia cargas
    // legítimas dos motoristas. Para estados terminais (DESCARREGADO, CTE
    // ENVIADO, CANCELADO, etc.), o `cargas.status` já transita para BOOKED
    // /EXPIRED via sync, então o filtro principal `cargas.status='OPEN'` cobre.
    // Alocação efetiva = override do operador (alloc_motorista, editado no Monitor)
    // tem precedência sobre o que veio da planilha (sheet_motorista).
    "COALESCE(cargas.alloc_motorista, cargas.sheet_motorista, '') = ''",
  ];
  const values = [];
  let index = 1;

  // Iter #8 (2026-05-25): cargas com (data + horário) anterior ao momento atual
  // NÃO devem aparecer para o motorista — viraram rascunho implicitamente até
  // o operator transitar status formalmente (script expire-past-cargas.mjs).
  // Mantemos cargas com data NULL como visíveis (operator pode estar
  // cadastrando ainda). Quando horario for NULL, comparamos só pela data.
  //
  // Parameterizado pq pg-mem nao suporta CURRENT_DATE/CURRENT_TIME nativos.
  //
  // O "agora" tem que ser o relógio de Sao Paulo: o container roda em UTC e
  // cargas.data/horario são horário local do Brasil. Misturar fusos (data UTC +
  // hora local) escondia cargas de hoje até ~3h cedo e o dia todo após 21h BRT.
  const { dateIso: todayIso, timeIso: nowTimeIso } = getSaoPauloWallClock();
  clauses.push(
    `(cargas.data IS NULL OR cargas.data > $${index} OR (cargas.data = $${index + 1} AND (cargas.horario IS NULL OR cargas.horario >= $${index + 2})))`,
  );
  values.push(todayIso, todayIso, nowTimeIso);
  index += 3;

  // Phase 10: regra de visibilidade combina driver_visibility (avulsa) com status do pacote
  // (premium em pacote publicado).
  //  - Carga avulsa (viagem_id IS NULL):  driver_visibility='PUBLIC' (comportamento legado)
  //  - Carga em pacote (viagem_id NOT NULL): cc.status IN ('publicado','reservado','em_andamento')
  //    Pacote inclui cargas PREMIUM por design (CONTEXT.md: todas as cargas de um pacote sao
  //    PREMIUM); driver_visibility e ignorado neste branch — quem gate-keeps e o status do pacote.
  // Quando o pacote-join nao esta ativo (facets/legacy), aplica so o filtro de driver_visibility.
  if (includePacoteVisibilityFilter) {
    if (includeDriverVisibilityFilter) {
      clauses.push(
        "(" +
          "(cargas.viagem_id IS NULL AND COALESCE(cargas.driver_visibility, 'PUBLIC') = 'PUBLIC')" +
          " OR " +
          "(cargas.viagem_id IS NOT NULL AND cc.status IN ('publicado','reservado','em_andamento'))" +
        ")",
      );
    } else {
      clauses.push(
        "(cargas.viagem_id IS NULL OR cc.status IN ('publicado','reservado','em_andamento'))",
      );
    }
  } else if (includeDriverVisibilityFilter) {
    clauses.push("COALESCE(cargas.driver_visibility, 'PUBLIC') = 'PUBLIC'");
  }

  const normalizeDriverLocationFilterValue = (value) =>
    String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\s*(\/|,|-)\s*([A-Za-z]{2})$/i, (_, _separator, uf) => `/${String(uf).toUpperCase()}`);

  const buildDriverLocationFilterPatterns = (value) => {
    const normalizedValue = normalizeDriverLocationFilterValue(value);
    if (!normalizedValue) return [];
    const matchedLocation = normalizedValue.match(/^(.*?)(?:\/([A-Za-z]{2}))$/);
    if (!matchedLocation) return [`%${normalizedValue}%`];
    const city = matchedLocation[1].trim();
    const uf = matchedLocation[2].toUpperCase();
    const patterns = new Set([
      normalizedValue,
      `${city} / ${uf}`,
      `${city}/${uf}`,
      `${city}, ${uf}`,
      `${city},${uf}`,
      `${city} - ${uf}`,
      `${city}-${uf}`,
    ]);
    return Array.from(patterns)
      .filter(Boolean)
      .map((pattern) => `%${pattern}%`);
  };

  const appendDriverLocationClause = (columnName, value) => {
    const patterns = buildDriverLocationFilterPatterns(value);
    if (patterns.length === 0) return;
    const locationClauses = patterns.map((pattern) => {
      values.push(pattern);
      const placeholder = `$${index}`;
      index += 1;
      return `${columnName} ILIKE ${placeholder}`;
    });
    clauses.push(`(${locationClauses.join(" OR ")})`);
  };

  if (parsedQuery.perfil) {
    clauses.push(`cargas.perfil = $${index}`);
    values.push(parsedQuery.perfil);
    index += 1;
  }
  if (parsedQuery.dateFrom) {
    clauses.push(`cargas.data >= $${index}`);
    values.push(parsedQuery.dateFrom);
    index += 1;
  }
  if (parsedQuery.dateTo) {
    clauses.push(`cargas.data <= $${index}`);
    values.push(parsedQuery.dateTo);
    index += 1;
  }

  return { parsedQuery, whereSql: clauses.join(" AND "), values, nextIndex: index };
}
