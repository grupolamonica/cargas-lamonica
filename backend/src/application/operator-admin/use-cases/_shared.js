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
  return combinedMessage.includes("distancia_km") || combinedMessage.includes("duracao_horas");
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

    const routeMetricsByKey = new Map();

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

      routeMetricsByKey.set(`${row.origin_key}|${row.destination_key}`, {
        distancia_km: distanceKm,
        tempo_estimado_horas: routeEstimatedHours,
        duracao_horas: durationHours,
        perfil_padrao: profile,
        valor_padrao: value,
        bonus_padrao: bonus,
      });
    });

    return new Map(
      loadRows.map((row) => {
        const matchedRouteKey = createRouteLookupKeys(row.origem, row.destino).find((routeKey) =>
          routeMetricsByKey.has(routeKey),
        );
        return [row.id, matchedRouteKey ? routeMetricsByKey.get(matchedRouteKey) : null];
      }),
    );
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

      unmatched.push({ id: row.id, origem: row.origem, destino: row.destino });
      return [row.id, null];
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
    valor: parseNullableNumber(row.valor),
    bonus: parseNullableNumber(row.bonus),
    clienteId: row.clienteId ?? null,
    clienteNome: row.clienteNome ?? null,
    clienteDescricao: row.clienteDescricao ?? null,
    carregamentoLabel: row.carregamentoLabel ?? null,
    descargaLabel: row.descargaLabel ?? null,
    routeLabel: row.routeLabel ?? null,
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

export async function queryDriverLoadCandidateRows(client, { whereSql, values }) {
  const buildItemQuery = ({ withRouteColumns = true, withSheetScheduleColumns = true } = {}) => `
        SELECT
          cargas.id,
          cargas.data,
          cargas.horario,
          cargas.origem,
          cargas.destino,
          ${withRouteColumns ? "TRUE" : "FALSE"}::boolean AS "__routeColumnsAvailable",
          ${withRouteColumns ? "cargas.distancia_km" : "NULL::numeric AS distancia_km"},
          ${withRouteColumns ? "cargas.duracao_horas" : "NULL::numeric AS duracao_horas"},
          cargas.perfil,
          cargas.valor,
          cargas.bonus,
          cargas.cliente_id AS "clienteId",
          clientes.nome AS "clienteNome",
          clientes.descricao AS "clienteDescricao",
          ${withSheetScheduleColumns ? 'cargas.sheet_data_carregamento AS "carregamentoLabel"' : 'NULL::text AS "carregamentoLabel"'},
          ${withSheetScheduleColumns ? 'cargas.sheet_data_descarga AS "descargaLabel"' : 'NULL::text AS "descargaLabel"'}
        FROM public.cargas
        LEFT JOIN public.clientes
          ON clientes.id = cargas.cliente_id
        WHERE ${whereSql}
        ORDER BY cargas.data ASC, cargas.horario ASC, cargas.id ASC
      `;

  try {
    const queryResult = await client.query(buildItemQuery(), values);
    return queryResult.rows;
  } catch (error) {
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
    `SELECT id, status, cliente_id, sheet_lh, created_by, valor, bonus FROM public.cargas WHERE id = $1 ${suffix}`,
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

export async function writeCargo(client, { cargoId, operatorId, payload, requestIp, correlationId }) {
  const existingCargo = cargoId ? await findCargoById(client, cargoId, { lock: true }) : null;

  if (cargoId && !existingCargo) {
    throw new NotFoundError("Carga nao encontrada.");
  }

  if (existingCargo && !MANUAL_CARGO_STATUSES.has(existingCargo.status) && payload.status !== existingCargo.status) {
    throw new ForbiddenError("Somente cargas em rascunho ou abertas podem ter o status alterado manualmente.");
  }

  const resolvedMetrics = await resolveRouteMetricsIfNeeded(payload.origem, payload.destino, {
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
  const warnings = [];
  let schemaFallbackUsed = false;

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
            is_template = $15, sheet_data_carregamento = $16, sheet_data_descarga = $17
          WHERE id = $1
        `,
        [
          cargoId, payload.data, payload.horario, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, payload.perfil,
          resolvedValor, resolvedBonus, payload.bonus_exigencias, nextDriverVisibility,
          clienteId, nextStatus, payload.is_template,
          payload.sheet_data_carregamento ?? null, payload.sheet_data_descarga ?? null,
        ],
      );
    } catch (error) {
      if (
        !isMissingRouteColumnError(error) &&
        !isMissingBonusRequirementsColumnError(error) &&
        !isMissingDriverVisibilityColumnError(error) &&
        !isMissingSheetScheduleColumnsError(error)
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
      await client.query(
        `
          INSERT INTO public.cargas (
            data, horario, origem, destino, distancia_km, duracao_horas,
            perfil, valor, bonus, bonus_exigencias, driver_visibility,
            cliente_id, status, is_template, created_by,
            sheet_data_carregamento, sheet_data_descarga
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `,
        [
          payload.data, payload.horario, payload.origem, payload.destino,
          resolvedMetrics.distancia_km, resolvedMetrics.duracao_horas, payload.perfil,
          resolvedValor, resolvedBonus, payload.bonus_exigencias, nextDriverVisibility,
          clienteId, nextStatus, payload.is_template, operatorId,
          payload.sheet_data_carregamento ?? null, payload.sheet_data_descarga ?? null,
        ],
      );
    } catch (error) {
      if (
        !isMissingRouteColumnError(error) &&
        !isMissingBonusRequirementsColumnError(error) &&
        !isMissingDriverVisibilityColumnError(error) &&
        !isMissingSheetScheduleColumnsError(error)
      ) {
        throw error;
      }
      await client.query(
        `
          INSERT INTO public.cargas (
            data, horario, origem, destino, perfil, valor, bonus,
            cliente_id, status, is_template, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          payload.data, payload.horario, payload.origem, payload.destino,
          payload.perfil, resolvedValor, resolvedBonus, clienteId,
          nextStatus, payload.is_template, operatorId,
        ],
      );
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
    resourceId: cargoId || null,
    action: cargoId ? "update" : "create",
    outcome: "success",
    requestIp,
    correlationId,
    metadata: {
      origem: payload.origem,
      destino: payload.destino,
      status: nextStatus,
      isTemplate: payload.is_template,
      degradedRouteMetrics: resolvedMetrics.degraded,
      schemaFallbackUsed,
      sheetClientLocked: shouldLockSheetClient,
    },
  });

  return { warnings };
}

export function buildDriverLoadFilters(query, { includeDriverVisibilityFilter = true } = {}) {
  const parsedQuery = parseDriverLoadsQuery(query);
  const clauses = ["cargas.status = 'OPEN'", "COALESCE(cargas.is_template, false) = false"];
  const values = [];
  let index = 1;

  if (includeDriverVisibilityFilter) {
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
