import crypto from "node:crypto";

import { Pool } from "pg";

import "../config/load-env.js";
import { calculateOperationalEtaHours } from "../lib/operational-eta.js";
import { buildPostgresSslConfig } from "../lib/postgres-ssl.js";
import { insertSecurityAuditEvent } from "../lib/security-audit.js";
import { logStructuredEvent } from "../lib/security-log.js";
import { baseRouteValues } from "../services/operator-admin/base-route-values.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const DEFAULT_DURATION_RATIO = 1 / 80;
const SOURCE_LABEL = "Planilha2 - Tabela 2026 OFICIAL - EXPEDIÇÃO-20-03_FINAL.xlsx";

function normalizeLocationKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripRouteStateSuffix(value) {
  return value.replace(/\s*\/\s*[a-z]{2}$/i, "").trim();
}

function stripOperationalLocationSuffix(value) {
  return value
    .replace(/[-_/]\s*\d+\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeRouteLocation(value) {
  const normalizedValue = stripOperationalLocationSuffix(stripRouteStateSuffix(normalizeLocationKey(value)));

  if (!normalizedValue) {
    return "";
  }

  if (/\bsj rio preto\b/.test(normalizedValue) || /\bsao jose do rio preto\b/.test(normalizedValue)) {
    return "sao jose do rio preto";
  }

  if (/\bpedreira\b/.test(normalizedValue) || /\bsao paulo\b/.test(normalizedValue)) {
    return "sao paulo";
  }

  if (/\bsalvador\b/.test(normalizedValue)) {
    return "salvador";
  }

  if (/\bsimoes filho\b/.test(normalizedValue)) {
    return "simoes filho";
  }

  if (/\bjaboatao dos guararapes\b/.test(normalizedValue)) {
    return "jaboatao dos guararapes";
  }

  if (/\bfeira de santana\b/.test(normalizedValue)) {
    return "feira de santana";
  }

  if (/\bcampo grande\b/.test(normalizedValue)) {
    return "campo grande";
  }

  if (/\bcamacari\b/.test(normalizedValue)) {
    return "camacari";
  }

  return normalizedValue;
}

function createRouteLookupKeys(origin, destination) {
  const originKey = normalizeLocationKey(origin);
  const destinationKey = normalizeLocationKey(destination);
  const originWithoutState = stripRouteStateSuffix(originKey);
  const destinationWithoutState = stripRouteStateSuffix(destinationKey);
  const canonicalOrigin = canonicalizeRouteLocation(origin);
  const canonicalDestination = canonicalizeRouteLocation(destination);

  const originVariants = Array.from(
    new Set([originKey, originWithoutState, canonicalOrigin].filter((value) => value !== "")),
  );
  const destinationVariants = Array.from(
    new Set([destinationKey, destinationWithoutState, canonicalDestination].filter((value) => value !== "")),
  );

  return Array.from(
    new Set(
      originVariants.flatMap((originVariant) =>
        destinationVariants.map((destinationVariant) => `${originVariant}|${destinationVariant}`),
      ),
    ),
  );
}

function buildRouteStorageKey(origin, destination) {
  return `${normalizeLocationKey(origin)}|${normalizeLocationKey(destination)}`;
}

function roundToTwoDecimals(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 0) {
    return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
  }

  return sortedValues[middleIndex];
}

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim() || process.env.CLAIMS_DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL or CLAIMS_DATABASE_URL must be configured.");
  }

  return new Pool({
    connectionString,
    max: 1,
    ssl: buildPostgresSslConfig(),
  });
}

function buildImportCandidates() {
  return baseRouteValues.map((route) => ({
    route: route.route,
    origem: route.origin,
    destino: route.destination,
    origin_key: normalizeLocationKey(route.origin),
    destination_key: normalizeLocationKey(route.destination),
    valor_padrao: route.value,
    distancia_km: route.distanceKm,
  }));
}

async function fetchExistingRouteMap(client) {
  const { rows } = await client.query(`
    SELECT
      id,
      origin_key,
      destination_key,
      origem,
      destino,
      duracao_horas,
      tempo_estimado_horas,
      perfil_padrao,
      valor_padrao,
      bonus_padrao,
      ativa,
      observacoes
    FROM public.route_metrics_cache
  `);

  return new Map(rows.map((row) => [`${row.origin_key}|${row.destination_key}`, row]));
}

async function fetchHistoricalRouteWindows(client) {
  const { rows } = await client.query(`
    SELECT
      origem,
      destino,
      sheet_data_carregamento,
      sheet_data_descarga
    FROM public.cargas
    WHERE sheet_data_carregamento IS NOT NULL
      AND sheet_data_descarga IS NOT NULL
  `);

  return rows;
}

function buildHistoricalRouteDurations(rows) {
  const durationByRouteKey = new Map();
  const allRatios = [];

  rows.forEach((row) => {
    const etaHours = calculateOperationalEtaHours(row.sheet_data_carregamento, row.sheet_data_descarga);

    if (etaHours === null || etaHours <= 0) {
      return;
    }

    const routeKeys = createRouteLookupKeys(row.origem, row.destino);

    routeKeys.forEach((routeKey) => {
      const values = durationByRouteKey.get(routeKey) || [];
      values.push(etaHours);
      durationByRouteKey.set(routeKey, values);
    });
  });

  return {
    durationByRouteKey,
    allRatios,
  };
}

function resolveImportDurations(candidates, existingRouteMap, historicalRouteDurations) {
  const resolvedRows = [];
  const routeDurationRatios = [];

  candidates.forEach((candidate) => {
    const routeKeys = createRouteLookupKeys(candidate.origem, candidate.destino);
    const matchedDurationHours = routeKeys
      .flatMap((routeKey) => historicalRouteDurations.get(routeKey) || [])
      .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);

    const medianHistoricalDuration = median(matchedDurationHours);

    if (medianHistoricalDuration !== null && candidate.distancia_km > 0) {
      routeDurationRatios.push(medianHistoricalDuration / candidate.distancia_km);
    }

    resolvedRows.push({
      ...candidate,
      historicalDurationHours: medianHistoricalDuration,
    });
  });

  const ratioFallback = median(routeDurationRatios) ?? DEFAULT_DURATION_RATIO;

  return {
    rows: resolvedRows.map((candidate) => {
      const storageKey = buildRouteStorageKey(candidate.origem, candidate.destino);
      const existingRoute = existingRouteMap.get(storageKey) || null;
      const historicalDurationHours = candidate.historicalDurationHours;
      const fallbackDurationHours = roundToTwoDecimals(candidate.distancia_km * ratioFallback);
      const persistedDurationHours =
        existingRoute?.duracao_horas !== null && existingRoute?.duracao_horas !== undefined
          ? Number(existingRoute.duracao_horas)
          : null;
      const effectiveDurationHours =
        historicalDurationHours !== null
          ? roundToTwoDecimals(historicalDurationHours)
          : persistedDurationHours ?? fallbackDurationHours;

      return {
        ...candidate,
        duracao_horas: effectiveDurationHours,
        tempo_estimado_horas: historicalDurationHours !== null ? roundToTwoDecimals(historicalDurationHours) : null,
        durationSource: historicalDurationHours !== null ? "sheet-window-plus-2h" : "no-sheet-window",
      };
    }),
    medianDurationRatio: ratioFallback,
  };
}

async function upsertRouteCatalog(client, routes, existingRouteMap) {
  let insertedCount = 0;
  let updatedCount = 0;

  for (const route of routes) {
    const routeKey = `${route.origin_key}|${route.destination_key}`;
    const existingRoute = existingRouteMap.get(routeKey);

    await client.query(
      `
        INSERT INTO public.route_metrics_cache (
          origin_key,
          destination_key,
          origem,
          destino,
          distancia_km,
          duracao_horas,
          tempo_estimado_horas,
          perfil_padrao,
          valor_padrao,
          bonus_padrao,
          ativa,
          observacoes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (origin_key, destination_key)
        DO UPDATE SET
          origem = EXCLUDED.origem,
          destino = EXCLUDED.destino,
          distancia_km = EXCLUDED.distancia_km,
          duracao_horas = EXCLUDED.duracao_horas,
          tempo_estimado_horas = EXCLUDED.tempo_estimado_horas,
          valor_padrao = EXCLUDED.valor_padrao,
          perfil_padrao = COALESCE(public.route_metrics_cache.perfil_padrao, EXCLUDED.perfil_padrao),
          bonus_padrao = COALESCE(public.route_metrics_cache.bonus_padrao, EXCLUDED.bonus_padrao),
          ativa = public.route_metrics_cache.ativa,
          observacoes = EXCLUDED.observacoes,
          updated_at = now()
      `,
      [
        route.origin_key,
        route.destination_key,
        route.origem,
        route.destino,
        route.distancia_km,
        route.duracao_horas,
        route.tempo_estimado_horas,
        existingRoute?.perfil_padrao ?? null,
        route.valor_padrao,
        existingRoute?.bonus_padrao ?? null,
        existingRoute?.ativa ?? true,
        `Atualizado via ${SOURCE_LABEL}; distancia/valor de planilha; ETA ${route.durationSource}.`,
      ],
    );

    if (existingRoute) {
      updatedCount += 1;
    } else {
      insertedCount += 1;
    }
  }

  return {
    insertedCount,
    updatedCount,
  };
}

function buildSummary(routes) {
  const durationSourceBreakdown = routes.reduce((accumulator, route) => {
    accumulator[route.durationSource] = (accumulator[route.durationSource] || 0) + 1;
    return accumulator;
  }, {});

  return {
    totalRoutes: routes.length,
    durationSourceBreakdown,
    routes,
  };
}

async function main() {
  const shouldApply = process.argv.includes("--apply");
  const correlationId = crypto.randomUUID();
  const pool = createPool();
  const client = await pool.connect();

  try {
    const candidates = buildImportCandidates();
    const existingRouteMap = await fetchExistingRouteMap(client);
    const historicalRows = await fetchHistoricalRouteWindows(client);
    const { durationByRouteKey } = buildHistoricalRouteDurations(historicalRows);
    const resolvedImport = resolveImportDurations(candidates, existingRouteMap, durationByRouteKey);
    const summary = buildSummary(resolvedImport.rows);

    if (!shouldApply) {
      console.log(
        JSON.stringify(
          {
            mode: "dry-run",
            source: SOURCE_LABEL,
            correlationId,
            historicalWindowsCount: historicalRows.length,
            medianDurationRatio: resolvedImport.medianDurationRatio,
            summary,
          },
          null,
          2,
        ),
      );
      return;
    }

    await client.query("BEGIN");
    const upsertResult = await upsertRouteCatalog(client, resolvedImport.rows, existingRouteMap);

    await insertSecurityAuditEvent(client, {
      eventType: "system.route_catalog.imported",
      actorRole: "system",
      resourceType: "route_catalog",
      resourceId: "route_metrics_cache",
      action: "bulk_import",
      outcome: "success",
      correlationId,
      metadata: {
        source: SOURCE_LABEL,
        insertedCount: upsertResult.insertedCount,
        updatedCount: upsertResult.updatedCount,
        historicalWindowsCount: historicalRows.length,
        durationSourceBreakdown: summary.durationSourceBreakdown,
        routes: resolvedImport.rows.map((route) => ({
          route: route.route,
          origem: route.origem,
          destino: route.destino,
          distancia_km: route.distancia_km,
          duracao_horas: route.duracao_horas,
          tempo_estimado_horas: route.tempo_estimado_horas,
          valor_padrao: route.valor_padrao,
          durationSource: route.durationSource,
        })),
      },
    });

    await client.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          mode: "apply",
          source: SOURCE_LABEL,
          correlationId,
          historicalWindowsCount: historicalRows.length,
          medianDurationRatio: resolvedImport.medianDurationRatio,
          upsertResult,
          summary,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    logStructuredEvent("error", "route-catalog.import.failed", {
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: {
          name: error?.name || "Error",
          message: error?.message || String(error),
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
