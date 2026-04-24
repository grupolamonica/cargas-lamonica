import crypto from "node:crypto";

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { rehydrateStoredValidationSummary } from "../load-claims/public-lead-validation.js";
import { createSupabaseAdminClient } from "../google-sheets/google-sheet-loads.js";
import {
  buildPaginationMeta,
  parseNullableNumber,
  normalizeRouteLocation,
  canonicalizeRouteLookupLocation,
  createRouteLookupKeys,
} from "../../domain/operator-admin/route-utils.js";

// Cache in-memory de user_id \u2192 { email, displayName } para evitar listUsers
// em toda chamada ao audit-logs. TTL curto (60s) \u00e9 suficiente.
const OPERATOR_DIRECTORY_TTL_MS = 60_000;
let operatorDirectoryCache = { at: 0, map: new Map() };

async function resolveOperatorDirectory() {
  const now = Date.now();
  if (now - operatorDirectoryCache.at < OPERATOR_DIRECTORY_TTL_MS) {
    return operatorDirectoryCache.map;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const map = new Map();
    for (const user of data?.users || []) {
      const email = user.email || null;
      const localPart = email ? email.split("@")[0] : "";
      const prettyName = localPart
        ? localPart.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : null;
      const role = user?.app_metadata?.role || user?.user_metadata?.role || null;
      const accessLevelRaw =
        user?.app_metadata?.access_level || user?.user_metadata?.access_level || null;
      const accessLevel =
        accessLevelRaw === "advanced" || accessLevelRaw === "intermediate"
          ? accessLevelRaw
          : role === "operator"
            ? "advanced"
            : null;
      map.set(user.id, { email, displayName: prettyName, role, accessLevel });
    }
    operatorDirectoryCache = { at: now, map };
    return map;
  } catch (error) {
    console.error("[operator-directory] Failed to refresh — returning stale cache:", {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
    });
    return operatorDirectoryCache.map;
  }
}
import {
  parseOperatorCargoListQuery,
  parseOperatorClientesListQuery,
  parseOperatorDriversListQuery,
  parseOperatorRoutesListQuery,
  parseOperatorVehiclesListQuery,
} from "../../domain/operator-admin/schemas.js";
import { baseRouteValues } from "../../domain/operator-admin/base-route-values.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue !== "" ? trimmedValue : null;
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function maskDriverDocument(value) {
  const digits = normalizeDigits(value);

  if (!digits) {
    return null;
  }

  if (digits.length === 11) {
    return `***.***.***-${digits.slice(-2)}`;
  }

  if (digits.length <= 4) {
    return "*".repeat(digits.length);
  }

  return `${"*".repeat(Math.max(digits.length - 4, 4))}${digits.slice(-4)}`;
}

function maskDriverPhone(value) {
  const digits = normalizeDigits(value);

  if (!digits) {
    return null;
  }

  const localNumber = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  const areaCode = localNumber.slice(0, 2);
  const suffix = localNumber.slice(-4);

  if (areaCode.length === 2) {
    return `(${areaCode}) *****-${suffix}`;
  }

  return `*******${suffix}`;
}

function maskDriverPlate(value) {
  const normalizedPlate = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (normalizedPlate.length !== 7) {
    return null;
  }

  return `${normalizedPlate.slice(0, 3)}***${normalizedPlate.slice(-1)}`;
}

function createOpaqueDriverIdentifier(sourceType, rawValue) {
  const hash = crypto.createHash("sha256").update(`${sourceType}:${rawValue}`).digest("hex").slice(0, 16);
  return `${sourceType.toLowerCase()}:${hash}`;
}

function createDriverEntityId(row) {
  if (row.source_type === "REGISTERED") {
    return `driver:${row.user_id}`;
  }

  return createOpaqueDriverIdentifier("PUBLIC_LEAD", `${row.raw_document || ""}|${row.raw_phone || ""}`);
}

function buildDriverRegistrationStatus(sourceType) {
  return sourceType === "REGISTERED" ? "REGISTERED" : "PUBLIC_ONLY";
}

function mapDriverApplicationStatusBuckets(sourceType, status) {
  if (sourceType === "REGISTERED") {
    return {
      queued: status === "PENDING" || status === "WAITLISTED",
      reserved: status === "WON_RESERVATION" || status === "PROMOTED",
      confirmed: status === "CONFIRMED",
    };
  }

  return {
    queued: status === "QUEUED",
    reserved: status === "APPROVED",
    confirmed: false,
  };
}

function buildValidationSnapshot(row) {
  return rehydrateStoredValidationSummary(row.validation_summary_json, {
    status: row.validation_status,
    checkedAt: row.validation_checked_at,
  });
}

function buildDriverExternalValidation(applications) {
  const latestPublicApplication = applications.find(
    (application) => application.source === "PUBLIC_LEAD" && application.validation,
  );
  const validation = latestPublicApplication?.validation ?? null;

  if (!validation) {
    return null;
  }

  return {
    overallStatus: validation.overallStatus,
    warnings: Array.isArray(validation.warnings) ? validation.warnings : [],
    hasAngelira: Boolean(validation.driver?.angelira?.found),
    hasAspx: Boolean(validation.driver?.aspx?.found),
    checkedAt: validation.checkedAt,
  };
}

function isMissingPublicLeadValidationColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("validation_status") ||
    combinedMessage.includes("validation_summary_json") ||
    combinedMessage.includes("validation_checked_at")
  );
}

function isMissingPublicLeadRedactionColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("pii_redacted_at");
}

function isMissingRouteColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("distancia_km") ||
    combinedMessage.includes("duracao_horas") ||
    combinedMessage.includes("bonus_exigencias") ||
    combinedMessage.includes("driver_visibility") ||
    combinedMessage.includes("sheet_data_carregamento") ||
    combinedMessage.includes("sheet_data_descarga")
  );
}

function isMissingClienteLogoColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("logo_url");
}

function isMissingRouteCatalogTableError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("route_metrics_cache");
}

function isMissingRouteCatalogColumnsError(error) {
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

function mergeBaseRoutesWithCatalog(routes) {
  const persistedRouteMap = new Map(
    routes.map((route) => [`${normalizeRouteLocation(route.origem)}|${normalizeRouteLocation(route.destino)}`, route]),
  );

  const mergedBaseRoutes = baseRouteValues.map((baseRoute) => {
    const routeKey = `${normalizeRouteLocation(baseRoute.origin)}|${normalizeRouteLocation(baseRoute.destination)}`;
    const persistedRoute = persistedRouteMap.get(routeKey);

    if (persistedRoute) {
      persistedRouteMap.delete(routeKey);

      return {
        ...persistedRoute,
        route_key: `${persistedRoute.origin_key || normalizeRouteLocation(persistedRoute.origem)}|${
          persistedRoute.destination_key || normalizeRouteLocation(persistedRoute.destino)
        }`,
        base_route_label: baseRoute.route,
        distancia_km: parseNullableNumber(persistedRoute.distancia_km) ?? baseRoute.distanceKm ?? null,
        duracao_horas: parseNullableNumber(persistedRoute.duracao_horas),
        tempo_estimado_horas:
          parseNullableNumber(persistedRoute.tempo_estimado_horas) ?? parseNullableNumber(persistedRoute.duracao_horas),
        valor_padrao: parseNullableNumber(persistedRoute.valor_padrao) ?? baseRoute.value,
        bonus_padrao: parseNullableNumber(persistedRoute.bonus_padrao),
        persisted: true,
        source: "base+db",
      };
    }

    return {
      id: `base:${routeKey}`,
      route_key: routeKey,
      origin_key: normalizeRouteLocation(baseRoute.origin),
      destination_key: normalizeRouteLocation(baseRoute.destination),
      origem: baseRoute.origin,
      destino: baseRoute.destination,
      distancia_km: baseRoute.distanceKm ?? null,
      duracao_horas: null,
      tempo_estimado_horas: null,
      perfil_padrao: null,
      valor_padrao: baseRoute.value,
      bonus_padrao: null,
      ativa: true,
      observacoes: null,
      created_at: null,
      updated_at: null,
      base_route_label: baseRoute.route,
      persisted: false,
      source: "base",
    };
  });

  const extraPersistedRoutes = Array.from(persistedRouteMap.values()).map((route) => ({
    ...route,
    route_key: `${route.origin_key || normalizeRouteLocation(route.origem)}|${
      route.destination_key || normalizeRouteLocation(route.destino)
    }`,
    distancia_km: parseNullableNumber(route.distancia_km),
    duracao_horas: parseNullableNumber(route.duracao_horas),
    tempo_estimado_horas: parseNullableNumber(route.tempo_estimado_horas) ?? parseNullableNumber(route.duracao_horas),
    valor_padrao: parseNullableNumber(route.valor_padrao),
    bonus_padrao: parseNullableNumber(route.bonus_padrao),
    base_route_label: null,
    persisted: true,
    source: "db",
  }));

  return [...mergedBaseRoutes, ...extraPersistedRoutes];
}

async function fetchPersistedRoutes(client) {
  try {
    const { rows } = await client.query(`
      SELECT
        id,
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
        observacoes,
        created_at,
        updated_at
      FROM public.route_metrics_cache
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      LIMIT 2000
    `);

    return {
      rows,
      supportsCatalogFields: true,
    };
  } catch (error) {
    if (isMissingRouteCatalogTableError(error)) {
      return {
        rows: [],
        supportsCatalogFields: false,
      };
    }

    if (!isMissingRouteCatalogColumnsError(error)) {
      throw error;
    }

    const { rows } = await client.query(`
      SELECT
        id,
        origin_key,
        destination_key,
        origem,
        destino,
        distancia_km,
        duracao_horas,
        duracao_horas AS tempo_estimado_horas,
        NULL::text AS perfil_padrao,
        NULL::numeric AS valor_padrao,
        NULL::numeric AS bonus_padrao,
        true AS ativa,
        NULL::text AS observacoes,
        created_at,
        updated_at
      FROM public.route_metrics_cache
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      LIMIT 2000
    `);

    return {
      rows,
      supportsCatalogFields: false,
    };
  }
}

async function fetchRouteCatalogMetricsByCargoId(client, cargoRows) {
  if (!Array.isArray(cargoRows) || cargoRows.length === 0) {
    return new Map();
  }

  const originKeys = new Set();
  const destinationKeys = new Set();

  cargoRows.forEach((row) => {
    createRouteLookupKeys(row.origem, row.destino).forEach((routeKey) => {
      const [originKey, destinationKey] = routeKey.split("|");

      if (originKey) {
        originKeys.add(originKey);
      }

      if (destinationKey) {
        destinationKeys.add(destinationKey);
      }
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
          duracao_horas,
          tempo_estimado_horas,
          perfil_padrao,
          valor_padrao
        FROM public.route_metrics_cache
        WHERE origin_key = ANY($1::text[])
          AND destination_key = ANY($2::text[])
      `,
      [Array.from(originKeys), Array.from(destinationKeys)],
    );

    const routeMetricsByKey = new Map();

    rows.forEach((row) => {
      const distanceKm = parseNullableNumber(row.distancia_km);
      const durationHours = parseNullableNumber(row.duracao_horas);
      const estimatedHours = parseNullableNumber(row.tempo_estimado_horas) ?? durationHours;
      const profile = normalizeOptionalText(row.perfil_padrao);
      const value = parseNullableNumber(row.valor_padrao);

      if (distanceKm === null && durationHours === null && estimatedHours === null && profile === null && value === null) {
        return;
      }

      routeMetricsByKey.set(`${row.origin_key}|${row.destination_key}`, {
        distancia_km: distanceKm,
        duracao_horas: durationHours,
        tempo_estimado_horas: estimatedHours,
        perfil_padrao: profile,
        valor_padrao: value,
      });
    });

    return new Map(
      cargoRows.map((row) => {
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

function isCargoAwaitingPublicationData(row, routeCatalogMetrics) {
  const profile = normalizeOptionalText(row.perfil) ?? routeCatalogMetrics?.perfil_padrao ?? null;
  const value = parseNullableNumber(row.valor) ?? routeCatalogMetrics?.valor_padrao ?? null;
  const distanceKm = parseNullableNumber(row.distancia_km) ?? routeCatalogMetrics?.distancia_km ?? null;
  const durationHours = parseNullableNumber(row.duracao_horas) ?? routeCatalogMetrics?.duracao_horas ?? null;
  const estimatedHours = routeCatalogMetrics?.tempo_estimado_horas ?? durationHours;
  const routeMetricsRequired = row.__routeColumnsAvailable !== false;

  if (profile === null || value === null) {
    return true;
  }

  if (!routeMetricsRequired) {
    return false;
  }

  return distanceKm === null || estimatedHours === null;
}

export async function fetchOperatorCargoListReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, status, driverVisibility, source, dateFrom, dateTo } = parseOperatorCargoListQuery(query);
  const usePendingDataFilter = status === "aguardando_dados";

  const buildCargoFilterContext = ({ supportsOptionalColumns }) => {
    const values = [];
    const clauses = [];
    let index = 1;

    if (search) {
      values.push(`%${search}%`);
      clauses.push(`
        (
          cargas.id::text ILIKE $${index} OR
          cargas.origem ILIKE $${index} OR
          cargas.destino ILIKE $${index} OR
          COALESCE(cargas.sheet_lh, '') ILIKE $${index} OR
          COALESCE(clientes.nome, '') ILIKE $${index}
        )
      `);
      index += 1;
    }

    if (!usePendingDataFilter) {
      if (status && status !== "todos") {
        if (status === "templates") {
          clauses.push("COALESCE(cargas.is_template, false) = true");
        } else if (status === "ativas") {
          // `ativas` = rascunhos + abertas. Default da tela de Cargas do
          // operador: s\u00f3 mostra cargas no ciclo operacional (sem reservadas,
          // fechadas, expiradas, etc) para n\u00e3o inflar o contador.
          clauses.push("cargas.status IN ('DRAFT', 'OPEN')");
        } else {
          values.push(status);
          clauses.push(`cargas.status = $${index}`);
          index += 1;
        }
      } else {
        // Visao padrao "Todos": oculta cargas EXPIRED (que saem automaticamente
        // da planilha quando o LH some do Google Sheets). Para ver essas cargas,
        // o operador pode selecionar explicitamente o filtro "Expiradas".
        clauses.push("COALESCE(cargas.status, '') <> 'EXPIRED'");
      }
    }

    if (driverVisibility && driverVisibility !== "todos") {
      if (supportsOptionalColumns) {
        values.push(driverVisibility);
        clauses.push(`COALESCE(cargas.driver_visibility, 'PUBLIC') = $${index}`);
        index += 1;
      } else if (driverVisibility === "PREMIUM") {
        clauses.push("1 = 0");
      }
    }

    if (source && source !== "todos") {
      if (source === "planilha") {
        clauses.push("COALESCE(cargas.sheet_lh, '') <> ''");
      }

      if (source === "manual") {
        clauses.push("COALESCE(cargas.sheet_lh, '') = ''");
      }
    }

    // Data de carregamento (ISO YYYY-MM-DD). `cargas.data` \u00e9 o campo
    // can\u00f4nico; `sheet_data_carregamento` contempla o texto bruto da planilha
    // e fica como fallback caso `data` seja null.
    if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      values.push(dateFrom);
      clauses.push(`cargas.data >= $${index}::date`);
      index += 1;
    }
    if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      values.push(dateTo);
      clauses.push(`cargas.data <= $${index}::date`);
      index += 1;
    }

    return {
      values,
      whereSql: clauses.length ? clauses.join(" AND ") : "true",
      limitIndex: index,
      offsetIndex: index + 1,
    };
  };

  return withPgClient(async (client) => {
    let filterContext = buildCargoFilterContext({
      supportsOptionalColumns: true,
    });
    let itemRows;
    let totalCount = 0;
    let supportsOptionalColumns = true;

    const buildCargoSelectQuery = ({ supportsOptionalColumns: nextSupportsOptionalColumns, includePagination }) => `
          SELECT
            cargas.id,
            cargas.data,
            cargas.horario,
            cargas.origem,
            cargas.destino,
            ${nextSupportsOptionalColumns ? "TRUE" : "FALSE"}::boolean AS "__routeColumnsAvailable",
            ${nextSupportsOptionalColumns ? "cargas.distancia_km" : "NULL::numeric AS distancia_km"},
            ${nextSupportsOptionalColumns ? "cargas.duracao_horas" : "NULL::numeric AS duracao_horas"},
            cargas.perfil,
            cargas.valor,
            cargas.bonus,
            ${nextSupportsOptionalColumns ? "cargas.bonus_exigencias" : "NULL::text AS bonus_exigencias"},
            ${nextSupportsOptionalColumns ? "COALESCE(cargas.driver_visibility, 'PUBLIC') AS driver_visibility" : "'PUBLIC'::text AS driver_visibility"},
            cargas.status,
            cargas.is_template,
            cargas.cliente_id,
            cargas.sheet_lh,
            ${nextSupportsOptionalColumns ? 'cargas.sheet_data_carregamento' : "NULL::text AS sheet_data_carregamento"},
            ${nextSupportsOptionalColumns ? 'cargas.sheet_data_descarga' : "NULL::text AS sheet_data_descarga"},
            clientes.nome AS cliente_nome
          FROM public.cargas
          LEFT JOIN public.clientes
            ON clientes.id = cargas.cliente_id
          WHERE ${filterContext.whereSql}
          ORDER BY
            ${nextSupportsOptionalColumns ? "cargas.sheet_data_carregamento DESC NULLS LAST," : ""}
            cargas.data DESC NULLS LAST,
            cargas.horario DESC NULLS LAST,
            cargas.created_at DESC,
            cargas.id DESC
          ${includePagination ? `LIMIT $${filterContext.limitIndex} OFFSET $${filterContext.offsetIndex}` : ""}
        `;

    try {
      const result = await client.query(
        buildCargoSelectQuery({
          supportsOptionalColumns,
          includePagination: !usePendingDataFilter,
        }),
        usePendingDataFilter ? filterContext.values : [...filterContext.values, pageSize, offset],
      );

      itemRows = result.rows;
    } catch (error) {
      if (!isMissingRouteColumnError(error)) {
        throw error;
      }

      supportsOptionalColumns = false;
      filterContext = buildCargoFilterContext({
        supportsOptionalColumns,
      });

      const fallbackResult = await client.query(
        buildCargoSelectQuery({
          supportsOptionalColumns,
          includePagination: !usePendingDataFilter,
        }),
        usePendingDataFilter ? filterContext.values : [...filterContext.values, pageSize, offset],
      );

      itemRows = fallbackResult.rows;
    }

    if (usePendingDataFilter) {
      const routeCatalogMetricsByCargoId = await fetchRouteCatalogMetricsByCargoId(client, itemRows);
      const pendingRows = itemRows.filter((row) => isCargoAwaitingPublicationData(row, routeCatalogMetricsByCargoId.get(row.id)));

      totalCount = pendingRows.length;
      itemRows = pendingRows.slice(offset, offset + pageSize);
    } else {
      const { rows: countRows } = await client.query(
        `
          SELECT COUNT(*)::int AS total_count
          FROM public.cargas
          LEFT JOIN public.clientes
            ON clientes.id = cargas.cliente_id
          WHERE ${filterContext.whereSql}
        `,
        filterContext.values,
      );

      totalCount = countRows[0]?.total_count || 0;
    }

    return {
      statusCode: 200,
      payload: {
        items: itemRows.map((row) => ({
          id: row.id,
          data: row.data,
          horario: row.horario,
          origem: row.origem,
          destino: row.destino,
          distancia_km: parseNullableNumber(row.distancia_km),
          duracao_horas: parseNullableNumber(row.duracao_horas),
          perfil: row.perfil,
          valor: parseNullableNumber(row.valor),
          bonus: parseNullableNumber(row.bonus),
          bonus_exigencias: row.bonus_exigencias,
          driver_visibility: row.driver_visibility,
          status: row.status,
          is_template: row.is_template,
          cliente_id: row.cliente_id,
          sheet_lh: row.sheet_lh,
          sheet_data_carregamento: row.sheet_data_carregamento ?? null,
          sheet_data_descarga: row.sheet_data_descarga ?? null,
          clientes: row.cliente_nome
            ? {
                nome: row.cliente_nome,
              }
            : null,
        })),
        meta: buildPaginationMeta(page, pageSize, totalCount, maxPageSize, correlationId),
      },
    };
  });
}

export async function fetchOperatorClientesListReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search } = parseOperatorClientesListQuery(query);
  const searchPattern = search ? `%${search}%` : null;

  return withPgClient(async (client) => {
    let itemRows;

    try {
      const result = await client.query(
        `
          SELECT
            id,
            created_at,
            nome,
            descricao,
            logo_url,
            forma_pagamento,
            prazo_pagamento,
            peso,
            tipo_veiculo,
            valor_frete,
            exige_rastreamento,
            exige_antt,
            exige_seguro,
            exige_carga_monitorada,
            reputacao_pagamento_rapido,
            reputacao_bom_pagador,
            reputacao_liberacao_rapida,
            reputacao_carga_organizada,
            reputacao_boa_comunicacao,
            observacoes,
            rastreamento,
            antt
          FROM public.clientes
          WHERE (
            $1::text IS NULL OR
            nome ILIKE $1 OR
            COALESCE(descricao, '') ILIKE $1 OR
            COALESCE(forma_pagamento, '') ILIKE $1 OR
            COALESCE(prazo_pagamento, '') ILIKE $1 OR
            COALESCE(observacoes, '') ILIKE $1
          )
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
        `,
        [searchPattern, pageSize, offset],
      );

      itemRows = result.rows;
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) {
        throw error;
      }

      const fallbackResult = await client.query(
        `
          SELECT
            id,
            created_at,
            nome,
            descricao,
            NULL::text AS logo_url,
            forma_pagamento,
            prazo_pagamento,
            NULL::text AS peso,
            NULL::text AS tipo_veiculo,
            NULL::text AS valor_frete,
            exige_rastreamento,
            exige_antt,
            exige_seguro,
            exige_carga_monitorada,
            reputacao_pagamento_rapido,
            reputacao_bom_pagador,
            reputacao_liberacao_rapida,
            reputacao_carga_organizada,
            reputacao_boa_comunicacao,
            observacoes,
            rastreamento,
            antt
          FROM public.clientes
          WHERE (
            $1::text IS NULL OR
            nome ILIKE $1 OR
            COALESCE(descricao, '') ILIKE $1 OR
            COALESCE(forma_pagamento, '') ILIKE $1 OR
            COALESCE(prazo_pagamento, '') ILIKE $1 OR
            COALESCE(observacoes, '') ILIKE $1
          )
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
        `,
        [searchPattern, pageSize, offset],
      );

      itemRows = fallbackResult.rows;
    }

    const { rows: countRows } = await client.query(
      `
        SELECT COUNT(*)::int AS total_count
        FROM public.clientes
        WHERE (
          $1::text IS NULL OR
          nome ILIKE $1 OR
          COALESCE(descricao, '') ILIKE $1 OR
          COALESCE(forma_pagamento, '') ILIKE $1 OR
          COALESCE(prazo_pagamento, '') ILIKE $1 OR
          COALESCE(observacoes, '') ILIKE $1
        )
      `,
      [searchPattern],
    );

    return {
      statusCode: 200,
      payload: {
        items: itemRows,
        meta: buildPaginationMeta(page, pageSize, countRows[0]?.total_count || 0, maxPageSize, correlationId),
      },
    };
  });
}

export async function fetchOperatorRoutesListReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, status } = parseOperatorRoutesListQuery(query);

  return withPgClient(async (client) => {
    const { rows, supportsCatalogFields } = await fetchPersistedRoutes(client);
    const mergedRoutes = mergeBaseRoutesWithCatalog(rows);
    const filteredRoutes = mergedRoutes.filter((route) => {
      const matchesSearch =
        !search ||
        [route.origem, route.destino, route.perfil_padrao || "", route.observacoes || "", route.base_route_label || ""]
          .join(" ")
          .toLowerCase()
          .includes(search);
      const matchesStatus = status === "todas" || (status === "ativas" ? route.ativa : !route.ativa);
      return matchesSearch && matchesStatus;
    });

    const paginatedItems = filteredRoutes.slice(offset, offset + pageSize);

    return {
      statusCode: 200,
      payload: {
        items: paginatedItems,
        supportsCatalogFields,
        summary: (() => {
          const routeSummary = mergedRoutes.reduce(
            (acc, route) => {
              if (route.ativa) acc.activeRoutes++;
              if (route.source === "base" || route.source === "base+db") acc.baseRoutes++;
              return acc;
            },
            { activeRoutes: 0, baseRoutes: 0 },
          );
          return {
            totalRoutes: mergedRoutes.length,
            activeRoutes: routeSummary.activeRoutes,
            baseRoutes: routeSummary.baseRoutes,
          };
        })(),
        meta: buildPaginationMeta(page, pageSize, filteredRoutes.length, maxPageSize, correlationId),
      },
    };
  });
}

const DRIVER_APPLICATION_STATUS_FILTERS = {
  todos: {
    applyClaimFilter: false,
    applyLeadFilter: false,
    claimStatuses: [],
    leadStatuses: [],
  },
  fila: {
    applyClaimFilter: true,
    applyLeadFilter: true,
    claimStatuses: ["PENDING", "WAITLISTED"],
    leadStatuses: ["QUEUED"],
  },
  reservado: {
    applyClaimFilter: true,
    applyLeadFilter: true,
    claimStatuses: ["WON_RESERVATION", "PROMOTED"],
    leadStatuses: ["APPROVED"],
  },
  confirmado: {
    applyClaimFilter: true,
    applyLeadFilter: true,
    claimStatuses: ["CONFIRMED"],
    leadStatuses: [],
  },
};

function resolveDriverApplicationFilter(applicationStatus) {
  return DRIVER_APPLICATION_STATUS_FILTERS[applicationStatus] || DRIVER_APPLICATION_STATUS_FILTERS.todos;
}

function isMissingAngelliraColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("angellira_status") || combinedMessage.includes("angellira_valid_until");
}

function buildRegisteredDriverSummaryQuery(includeAngelliraFields = true) {
  const angelliraSelect = includeAngelliraFields
    ? `dp.angellira_status,
      dp.angellira_valid_until,
      dp.angellira_status_text,
      dp.angellira_checked_at,
      dp.angellira_details,`
    : `NULL::text AS angellira_status,
      NULL::date AS angellira_valid_until,
      NULL::text AS angellira_status_text,
      NULL::timestamptz AS angellira_checked_at,
      NULL::jsonb AS angellira_details,`;

  const angelliraGroupBy = includeAngelliraFields
    ? `,
      dp.angellira_status,
      dp.angellira_valid_until,
      dp.angellira_status_text,
      dp.angellira_checked_at,
      dp.angellira_details`
    : "";

  return `
    SELECT
      'REGISTERED'::text AS source_type,
      dp.user_id::text AS user_id,
      dp.full_name AS display_name,
      dp.phone AS raw_phone,
      dp.document_number AS raw_document,
      dp.vehicle_profile,
      dp.active,
      dp.documents_valid,
      dp.antt_valid,
      dp.tracking_enabled,
      dp.insurance_valid,
      dp.monitoring_capable,
      dp.operational_blocked,
      ${angelliraSelect}
      COUNT(lc.id)::int AS total_applications,
      COUNT(*) FILTER (WHERE lc.status IN ('PENDING', 'WAITLISTED'))::int AS queued_applications,
      COUNT(*) FILTER (WHERE lc.status IN ('WON_RESERVATION', 'PROMOTED'))::int AS reserved_applications,
      COUNT(*) FILTER (WHERE lc.status = 'CONFIRMED')::int AS confirmed_applications,
      MAX(COALESCE(lc.claimed_at, lc.created_at)) AS latest_application_at
    FROM public.driver_profiles AS dp
    LEFT JOIN public.load_claims AS lc
      ON lc.driver_id = dp.user_id
    GROUP BY
      dp.user_id,
      dp.full_name,
      dp.phone,
      dp.document_number,
      dp.vehicle_profile,
      dp.active,
      dp.documents_valid,
      dp.antt_valid,
      dp.tracking_enabled,
      dp.insurance_valid,
      dp.monitoring_capable,
      dp.operational_blocked${angelliraGroupBy}
  `;
}

async function fetchOperatorRegisteredDriverSummaries(client) {
  try {
    const { rows } = await client.query(buildRegisteredDriverSummaryQuery(true));
    return rows;
  } catch (error) {
    if (!isMissingAngelliraColumnError(error)) {
      throw error;
    }

    // Fallback: colunas Angellira ainda nao existem (migracao nao aplicada)
    const { rows } = await client.query(buildRegisteredDriverSummaryQuery(false));
    return rows;
  }
}

async function fetchOperatorPublicDriverSummaries(client) {
  const buildQuery = (includeRedactionField = true) => `
    SELECT
      'PUBLIC_LEAD'::text AS source_type,
      NULL::text AS user_id,
      'Motorista sem cadastro no app'::text AS display_name,
      leads.phone AS raw_phone,
      leads.cpf AS raw_document,
      MAX(leads.vehicle_type) AS vehicle_profile,
      NULL::boolean AS active,
      NULL::boolean AS documents_valid,
      NULL::boolean AS antt_valid,
      NULL::boolean AS tracking_enabled,
      NULL::boolean AS insurance_valid,
      NULL::boolean AS monitoring_capable,
      NULL::boolean AS operational_blocked,
      COUNT(leads.id)::int AS total_applications,
      COUNT(*) FILTER (WHERE leads.status = 'QUEUED')::int AS queued_applications,
      COUNT(*) FILTER (WHERE leads.status = 'APPROVED')::int AS reserved_applications,
      0::int AS confirmed_applications,
      MAX(COALESCE(leads.queued_at, leads.pre_registered_at, leads.created_at)) AS latest_application_at
    FROM public.load_public_leads AS leads
    WHERE leads.status = ANY(ARRAY['QUEUED', 'APPROVED']::text[])
      AND ${includeRedactionField ? "(leads.status = 'QUEUED' OR leads.pii_redacted_at IS NULL)" : "true"}
    GROUP BY leads.cpf, leads.phone
  `;

  try {
    const { rows } = await client.query(buildQuery(true));
    return rows;
  } catch (error) {
    if (!isMissingPublicLeadRedactionColumnError(error)) {
      throw error;
    }

    const { rows } = await client.query(buildQuery(false));
    return rows;
  }
}

async function fetchOperatorHistoricoDriverSummaries(client) {
  const { rows } = await client.query(`
    SELECT
      'HISTORICO'::text AS source_type,
      NULL::text AS user_id,
      mh.nome AS display_name,
      mh.telefone AS raw_phone,
      mh.cpf AS raw_document,
      NULL::text AS vehicle_profile,
      NULL::boolean AS active,
      NULL::boolean AS documents_valid,
      NULL::boolean AS antt_valid,
      NULL::boolean AS tracking_enabled,
      NULL::boolean AS insurance_valid,
      NULL::boolean AS monitoring_capable,
      NULL::boolean AS operational_blocked,
      'FOUND'::text AS angellira_status,
      mh.angellira_limit_date::date AS angellira_valid_until,
      'Conforme'::text AS angellira_status_text,
      mh.angellira_sent_date AS angellira_checked_at,
      jsonb_build_object(
        'name',           mh.nome,
        'cpf',            mh.cpf,
        'birthDate',      mh.nascimento::text,
        'rg',             mh.rg,
        'uf',             mh.estado,
        'fatherName',     mh.raw_json->'history'->>'driverFather',
        'motherName',     mh.raw_json->'history'->>'driverMother',
        'cnhNumber',      mh.cnh,
        'cnhCategory',    mh.cnh_categoria,
        'cnhSecurityCode',mh.cnh_security,
        'cnhValidity',    mh.cnh_validade::text,
        'phone',          mh.telefone,
        'city',           mh.cidade,
        'naturalness',    mh.raw_json->'history'->>'driverNaturalness'
      ) AS angellira_details,
      0::int AS total_applications,
      0::int AS queued_applications,
      0::int AS reserved_applications,
      0::int AS confirmed_applications,
      NULL::timestamptz AS latest_application_at
    FROM public.motoristas_historico AS mh
  `);

  return rows;
}

async function fetchOperatorRegisteredDriverApplications(client, userIds) {
  if (!userIds.length) {
    return [];
  }

  const { rows } = await client.query(
    `
      SELECT
        load_claims.driver_id,
        load_claims.id AS application_id,
        load_claims.status AS application_status,
        COALESCE(load_claims.claimed_at, load_claims.created_at) AS submitted_at,
        load_claims.queue_position,
        cargas.id AS load_id,
        cargas.status AS load_status,
        cargas.origem,
        cargas.destino,
        cargas.data,
        cargas.horario,
        cargas.perfil
      FROM public.load_claims
      INNER JOIN public.cargas
        ON cargas.id = load_claims.load_id
      WHERE load_claims.driver_id::text = ANY($1::text[])
      ORDER BY COALESCE(load_claims.claimed_at, load_claims.created_at) DESC, load_claims.id DESC
    `,
    [userIds],
  );

  return rows;
}

async function fetchOperatorPublicDriverApplications(client, publicDrivers) {
  if (!publicDrivers.length) {
    return [];
  }

  const values = [];
  const identityClauses = publicDrivers.map((driver, index) => {
    values.push(driver.raw_document, driver.raw_phone);
    const documentIndex = index * 2 + 1;
    const phoneIndex = documentIndex + 1;

    return `(leads.cpf = $${documentIndex} AND leads.phone = $${phoneIndex})`;
  });

  const buildQuery = ({ includeValidationFields = true, includeRedactionField = true }) => `
    SELECT
      leads.cpf AS raw_document,
      leads.phone AS raw_phone,
      leads.id AS application_id,
      leads.status AS application_status,
      COALESCE(leads.queued_at, leads.pre_registered_at, leads.created_at) AS submitted_at,
      leads.horse_plate,
      leads.trailer_plate,
      COALESCE(leads.trailer_plate_2, '') AS trailer_plate_2,
      leads.vehicle_type,
      ${
        includeValidationFields
          ? "leads.validation_status, leads.validation_checked_at, leads.validation_summary_json"
          : "'PENDING'::text AS validation_status, NULL::timestamptz AS validation_checked_at, '{}'::jsonb AS validation_summary_json"
      },
      cargas.id AS load_id,
      cargas.status AS load_status,
      cargas.origem,
      cargas.destino,
      cargas.data,
      cargas.horario,
      cargas.perfil
    FROM public.load_public_leads AS leads
    INNER JOIN public.cargas
      ON cargas.id = leads.load_id
    WHERE (${identityClauses.join(" OR ")})
      AND leads.status = ANY(ARRAY['QUEUED', 'APPROVED']::text[])
      AND ${includeRedactionField ? "(leads.status = 'QUEUED' OR leads.pii_redacted_at IS NULL)" : "true"}
    ORDER BY COALESCE(leads.queued_at, leads.pre_registered_at, leads.created_at) DESC, leads.id DESC
  `;

  try {
    const { rows } = await client.query(buildQuery({ includeValidationFields: true, includeRedactionField: true }), values);
    return rows;
  } catch (error) {
    if (!isMissingPublicLeadValidationColumnError(error) && !isMissingPublicLeadRedactionColumnError(error)) {
      throw error;
    }

    const { rows } = await client.query(
      buildQuery({
        includeValidationFields: !isMissingPublicLeadValidationColumnError(error),
        includeRedactionField: !isMissingPublicLeadRedactionColumnError(error),
      }),
      values,
    );

    return rows;
  }
}

function mapOperatorRegisteredApplicationRow(row) {
  return {
    id: row.application_id,
    source: "CLAIM",
    status: row.application_status,
    submittedAt: row.submitted_at,
    queuePosition: row.queue_position ?? null,
    vehicleType: row.perfil ?? null,
    plates: null,
    validation: null,
    load: {
      id: row.load_id,
      status: row.load_status,
      origem: row.origem,
      destino: row.destino,
      data: row.data,
      horario: row.horario,
      perfil: row.perfil,
    },
  };
}

function mapOperatorPublicApplicationRow(row) {
  return {
    id: row.application_id,
    source: "PUBLIC_LEAD",
    status: row.application_status,
    submittedAt: row.submitted_at,
    queuePosition: null,
    vehicleType: row.vehicle_type ?? null,
    plates: {
      horsePlate: row.horse_plate || null,
      trailerPlate: row.trailer_plate || null,
      trailerPlate2: row.trailer_plate_2 || null,
    },
    validation: buildValidationSnapshot(row),
    load: {
      id: row.load_id,
      status: row.load_status,
      origem: row.origem,
      destino: row.destino,
      data: row.data,
      horario: row.horario,
      perfil: row.perfil,
    },
  };
}

function buildAngelliraVigency(row) {
  if (!row.angellira_status && !row.angellira_valid_until) {
    return null;
  }

  const validUntil = row.angellira_valid_until
    ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
    : null;

  let daysUntilExpiry = null;
  let alertLevel = null;

  if (validUntil) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiryDate = new Date(validUntil + "T00:00:00Z");
    daysUntilExpiry = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) {
      alertLevel = "EXPIRED";
    } else if (daysUntilExpiry <= 30) {
      alertLevel = "EXPIRING_SOON";
    } else {
      alertLevel = "OK";
    }
  }

  return {
    status: row.angellira_status || null,
    statusText: row.angellira_status_text || null,
    validUntil,
    daysUntilExpiry,
    alertLevel,
    checkedAt: row.angellira_checked_at || null,
  };
}

/**
 * For PUBLIC_LEAD drivers, the Angellira data lives inside the validation_summary_json
 * of their applications (not in driver_profiles). This function extracts whatever is
 * available so the operator can see it on the driver card.
 */
function extractAngelliraDataFromApplications(applications) {
  for (const app of applications) {
    if (app.source === "PUBLIC_LEAD" && app.validation) {
      const angelira = app.validation.driver?.angelira;
      const aspx = app.validation.driver?.aspx;
      const vigency = app.validation.vigency;

      const displayName = (angelira?.displayName || aspx?.displayName || "").trim() || null;
      const angelliraFound = angelira?.found === true;

      // The validation summary now stores the full driverDetails object from
      // the Angellira response. When present, surface every field so the
      // operator can pre-fill the driver registration (CPF, RG, UF, parents,
      // CNH, security code, CNH validity, phone, city, naturalness).
      const storedDetails = angelira?.details || null;
      const details = angelliraFound
        ? {
            name: storedDetails?.name || displayName,
            cpf: storedDetails?.cpf || null,
            birthDate: storedDetails?.birthDate || null,
            rg: storedDetails?.rg || null,
            uf: storedDetails?.uf || null,
            fatherName: storedDetails?.fatherName || null,
            motherName: storedDetails?.motherName || null,
            cnhNumber: storedDetails?.cnhNumber || null,
            cnhCategory: storedDetails?.cnhCategory || null,
            cnhSecurityCode: storedDetails?.cnhSecurityCode || null,
            cnhValidity: storedDetails?.cnhValidity || null,
            phone: storedDetails?.phone || null,
            city: storedDetails?.city || null,
            naturalness: storedDetails?.naturalness || null,
          }
        : null;

      // Build vigency from the validation's vigency block
      let vigencyResult = null;
      if (vigency && angelliraFound) {
        const validUntil = vigency.validUntil || angelira?.validUntil || null;
        let daysUntilExpiry = vigency.daysUntilExpiry ?? null;
        let alertLevel = null;

        if (validUntil) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const expiryDate = new Date(validUntil + "T00:00:00Z");
          daysUntilExpiry = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

          if (daysUntilExpiry < 0) alertLevel = "EXPIRED";
          else if (daysUntilExpiry <= 30) alertLevel = "EXPIRING_SOON";
          else alertLevel = "OK";
        }

        vigencyResult = {
          status: angelira?.status || "FOUND",
          statusText: vigency.status === "VALID" ? "Vigente" : vigency.status === "EXPIRING" ? "Vencendo" : vigency.status === "INVALID" ? "Vencido" : null,
          validUntil,
          daysUntilExpiry,
          alertLevel,
          checkedAt: app.validation.checkedAt || null,
          lastSeenAt: angelira?.lastSeenAt || null,
        };
      } else if (angelira) {
        vigencyResult = {
          status: angelira.status || null,
          statusText: angelira.found ? "Encontrado" : "Nao encontrado",
          validUntil: null,
          daysUntilExpiry: null,
          alertLevel: null,
          checkedAt: app.validation.checkedAt || null,
          lastSeenAt: angelira.lastSeenAt || null,
        };
      }

      return { displayName, details, vigency: vigencyResult };
    }
  }
  return null;
}

function mapDriverSummaryRowToItem(row, applications) {
  const driverId = createDriverEntityId(row);
  const limitedApplications = applications.slice(0, 5);
  const externalValidation = buildDriverExternalValidation(limitedApplications);

  const rawDetails = row.angellira_details || null;
  let angelliraDetails = rawDetails
    ? {
        name: rawDetails.name || null,
        cpf: rawDetails.cpf || null,
        birthDate: rawDetails.birthDate || null,
        rg: rawDetails.rg || null,
        uf: rawDetails.uf || null,
        fatherName: rawDetails.fatherName || null,
        motherName: rawDetails.motherName || null,
        cnhNumber: rawDetails.cnhNumber || null,
        cnhCategory: rawDetails.cnhCategory || null,
        cnhSecurityCode: rawDetails.cnhSecurityCode || null,
        cnhValidity: rawDetails.cnhValidity || null,
        phone: rawDetails.phone || null,
        city: rawDetails.city || null,
        naturalness: rawDetails.naturalness || null,
      }
    : null;

  let displayName = row.display_name;
  let angelliraVigency = buildAngelliraVigency(row);

  // For PUBLIC_LEAD drivers, extract Angellira data from validation summaries
  // since they have no driver_profiles row with angellira_* columns.
  if (row.source_type === "PUBLIC_LEAD") {
    const extracted = extractAngelliraDataFromApplications(limitedApplications);
    if (extracted) {
      if (extracted.displayName) {
        displayName = extracted.displayName;
      }
      if (!angelliraDetails && extracted.details) {
        angelliraDetails = extracted.details;
      }
      if (!angelliraVigency && extracted.vigency) {
        angelliraVigency = extracted.vigency;
      }
    }
  }

  return {
    id: driverId,
    sourceType: row.source_type,
    registrationStatus: buildDriverRegistrationStatus(row.source_type),
    displayName,
    contact: {
      phone: row.raw_phone || null,
      document: row.raw_document || null,
    },
    profile: {
      vehicleProfile: row.vehicle_profile ?? null,
      active: row.active ?? null,
      documentsValid: row.documents_valid ?? null,
      anttValid: row.antt_valid ?? null,
      trackingEnabled: row.tracking_enabled ?? null,
      insuranceValid: row.insurance_valid ?? null,
      monitoringCapable: row.monitoring_capable ?? null,
      operationalBlocked: row.operational_blocked ?? null,
    },
    externalValidation,
    angelliraVigency,
    angelliraDetails,
    stats: {
      totalApplications: row.total_applications ?? 0,
      queuedApplications: row.queued_applications ?? 0,
      reservedApplications: row.reserved_applications ?? 0,
      confirmedApplications: row.confirmed_applications ?? 0,
      latestApplicationAt: row.latest_application_at ?? null,
    },
    applications: limitedApplications,
  };
}

export async function fetchOperatorDriversListReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, source, applicationStatus } = parseOperatorDriversListQuery(query);

  return withPgClient(async (client) => {
    const [registeredSummaryRows, publicSummaryRows, historicoSummaryRows] = await Promise.all([
      fetchOperatorRegisteredDriverSummaries(client),
      fetchOperatorPublicDriverSummaries(client),
      fetchOperatorHistoricoDriverSummaries(client),
    ]);
    // Cross-reference public leads against registered drivers by CPF or phone.
    // Normalizes CPF to digits-only before comparing so "123.456.789-09" matches "12345678909".
    // Falls back to phone when document_number is absent in driver_profiles.
    // This prevents the same person from appearing as both REGISTERED and PUBLIC_LEAD.
    const normalizeDocumentForDedup = (value) => String(value || "").replace(/\D/g, "");
    const normalizePhoneForDedup = (value) => String(value || "").replace(/\D/g, "");

    const registeredCpfSet = new Set();
    const registeredPhoneSet = new Set();
    const registeredCpfToRow = new Map();
    const registeredPhoneToRow = new Map();
    for (const row of registeredSummaryRows) {
      const normalizedCpf = normalizeDocumentForDedup(row.raw_document);
      const normalizedPhone = normalizePhoneForDedup(row.raw_phone);
      if (normalizedCpf) {
        registeredCpfSet.add(normalizedCpf);
        registeredCpfToRow.set(normalizedCpf, row);
      }
      if (normalizedPhone) {
        registeredPhoneSet.add(normalizedPhone);
        registeredPhoneToRow.set(normalizedPhone, row);
      }
    }

    const overlappingPublicLeads = [];
    const deduplicatedPublicRows = [];
    for (const row of publicSummaryRows) {
      const normalizedCpf = normalizeDocumentForDedup(row.raw_document);
      const normalizedPhone = normalizePhoneForDedup(row.raw_phone);
      const matchesByCpf = normalizedCpf && registeredCpfSet.has(normalizedCpf);
      const matchesByPhone = normalizedPhone && registeredPhoneSet.has(normalizedPhone);
      if (matchesByCpf || matchesByPhone) {
        overlappingPublicLeads.push(row);
      } else {
        deduplicatedPublicRows.push(row);
      }
    }

    // Build CPF set covering all already-present sources to dedup historico.
    const knownCpfSet = new Set(registeredCpfSet);
    for (const row of deduplicatedPublicRows) {
      const normalizedCpf = normalizeDocumentForDedup(row.raw_document);
      if (normalizedCpf) knownCpfSet.add(normalizedCpf);
    }
    const deduplicatedHistoricoRows = historicoSummaryRows.filter((row) => {
      const normalizedCpf = normalizeDocumentForDedup(row.raw_document);
      return normalizedCpf && !knownCpfSet.has(normalizedCpf);
    });

    const requestedSummaryRows = [...registeredSummaryRows, ...deduplicatedPublicRows, ...deduplicatedHistoricoRows].filter((row) => {
      if (source === "cadastrados") {
        return row.source_type === "REGISTERED";
      }

      if (source === "publicos") {
        return row.source_type === "PUBLIC_LEAD";
      }

      if (source === "historico") {
        return row.source_type === "HISTORICO";
      }

      return true;
    });

    const registeredDriverRows = requestedSummaryRows.filter((row) => row.source_type === "REGISTERED");
    const publicDriverRows = requestedSummaryRows.filter((row) => row.source_type === "PUBLIC_LEAD");

    const [registeredApplicationRows, publicApplicationRows, overlappingPublicApplicationRows] = await Promise.all([
      fetchOperatorRegisteredDriverApplications(
        client,
        registeredDriverRows.map((row) => row.user_id),
      ),
      fetchOperatorPublicDriverApplications(
        client,
        publicDriverRows.map((row) => ({
          raw_document: row.raw_document,
          raw_phone: row.raw_phone,
        })),
      ),
      // Fetch public applications for leads that overlap with registered drivers
      // in the same round-trip to avoid a sequential third DB call.
      overlappingPublicLeads.length > 0
        ? fetchOperatorPublicDriverApplications(
            client,
            overlappingPublicLeads.map((row) => ({
              raw_document: row.raw_document,
              raw_phone: row.raw_phone,
            })),
          )
        : Promise.resolve([]),
    ]);

    const applicationsByDriverId = new Map();

    registeredApplicationRows.forEach((row) => {
      const driverId = `driver:${row.driver_id}`;
      const currentApplications = applicationsByDriverId.get(driverId) || [];
      currentApplications.push(mapOperatorRegisteredApplicationRow(row));
      applicationsByDriverId.set(driverId, currentApplications);
    });

    publicApplicationRows.forEach((row) => {
      const driverId = createOpaqueDriverIdentifier("PUBLIC_LEAD", `${row.raw_document || ""}|${row.raw_phone || ""}`);
      const currentApplications = applicationsByDriverId.get(driverId) || [];
      currentApplications.push(mapOperatorPublicApplicationRow(row));
      applicationsByDriverId.set(driverId, currentApplications);
    });

    // Attach overlapping public lead applications to their corresponding registered driver entries.
    overlappingPublicApplicationRows.forEach((row) => {
      const normalizedCpf = normalizeDocumentForDedup(row.raw_document);
      const normalizedPhone = normalizePhoneForDedup(row.raw_phone);
      const registeredRow =
        (normalizedCpf && registeredCpfToRow.get(normalizedCpf)) ||
        (normalizedPhone && registeredPhoneToRow.get(normalizedPhone)) ||
        null;
      if (registeredRow) {
        const driverId = `driver:${registeredRow.user_id}`;
        const currentApplications = applicationsByDriverId.get(driverId) || [];
        currentApplications.push(mapOperatorPublicApplicationRow(row));
        applicationsByDriverId.set(driverId, currentApplications);
      }
    });

    const normalizedSearch = search.trim().toLowerCase();
    const requestedFilter = resolveDriverApplicationFilter(applicationStatus);
    const candidateItems = requestedSummaryRows.map((row) => {
      const applications = applicationsByDriverId.get(createDriverEntityId(row)) || [];
      const item = mapDriverSummaryRowToItem(row, applications);
      const vigencySearchTerms = item.angelliraVigency
        ? [
            item.angelliraVigency.statusText,
            item.angelliraVigency.alertLevel === "EXPIRING_SOON" ? "vigencia vencendo alerta" : null,
            item.angelliraVigency.alertLevel === "EXPIRED" ? "vigencia vencida expirada" : null,
            item.angelliraVigency.alertLevel === "OK" ? "vigencia vigente" : null,
            item.angelliraVigency.validUntil,
          ]
        : [];
      const searchableText = [
        row.display_name,
        row.raw_phone,
        row.raw_document,
        row.vehicle_profile,
        ...vigencySearchTerms,
        ...applications.flatMap((application) => [
          application.load.id,
          application.load.origem,
          application.load.destino,
          application.load.perfil,
          application.status,
          application.vehicleType,
          application.plates?.horsePlate,
          application.plates?.trailerPlate,
          application.plates?.trailerPlate2,
          application.validation?.overallStatus,
          ...(application.validation?.warnings || []),
        ]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return {
        item,
        searchableText,
      };
    });

    const filteredItems = candidateItems
      .filter(({ item, searchableText }) => {
        const matchesSearch = !normalizedSearch || searchableText.includes(normalizedSearch);

        const matchesStatus =
          (!requestedFilter.applyClaimFilter && !requestedFilter.applyLeadFilter) ||
          item.applications.some((application) => {
            const buckets = mapDriverApplicationStatusBuckets(item.sourceType, application.status);

            if (applicationStatus === "fila") {
              return buckets.queued;
            }

            if (applicationStatus === "reservado") {
              return buckets.reserved;
            }

            if (applicationStatus === "confirmado") {
              return buckets.confirmed;
            }

            return true;
          });

        return matchesSearch && matchesStatus;
      })
      .map(({ item }) => item)
      .sort((left, right) => {
        const leftDate = left.stats.latestApplicationAt ? new Date(left.stats.latestApplicationAt).getTime() : 0;
        const rightDate = right.stats.latestApplicationAt ? new Date(right.stats.latestApplicationAt).getTime() : 0;

        if (leftDate !== rightDate) {
          return rightDate - leftDate;
        }

        return left.displayName.localeCompare(right.displayName, "pt-BR");
      });

    const paginatedItems = filteredItems.slice(offset, offset + pageSize);
    const filteredSummary = filteredItems.reduce(
      (accumulator, item) => {
        accumulator.totalApplications += item.stats.totalApplications;

        if (item.registrationStatus === "REGISTERED") {
          accumulator.registeredCount += 1;
        } else {
          accumulator.publicOnlyCount += 1;
        }

        return accumulator;
      },
      {
        totalApplications: 0,
        registeredCount: 0,
        publicOnlyCount: 0,
      },
    );

    return {
      statusCode: 200,
      payload: {
        items: paginatedItems,
        summary: {
          totalDrivers: filteredItems.length,
          registeredCount: filteredSummary.registeredCount,
          publicOnlyCount: filteredSummary.publicOnlyCount,
          totalApplications: filteredSummary.totalApplications,
        },
        meta: buildPaginationMeta(page, pageSize, filteredItems.length, maxPageSize, correlationId),
      },
    };
  });
}

function buildVehicleAngelliraVigency(row) {
  if (!row.angellira_status && !row.angellira_valid_until) {
    return null;
  }

  const validUntil = row.angellira_valid_until
    ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
    : null;

  let daysUntilExpiry = null;
  let alertLevel = null;

  if (validUntil) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiryDate = new Date(validUntil + "T00:00:00Z");
    daysUntilExpiry = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) {
      alertLevel = "EXPIRED";
    } else if (daysUntilExpiry <= 30) {
      alertLevel = "EXPIRING_SOON";
    } else {
      alertLevel = "OK";
    }
  }

  return {
    status: row.angellira_status || null,
    statusText: row.angellira_status_text || null,
    validUntil,
    daysUntilExpiry,
    alertLevel,
    checkedAt: row.angellira_checked_at || null,
  };
}

function mapVehicleRowToItem(row) {
  const rawDetails = row.angellira_details || null;
  // Normalize the JSONB details into a clean object for the frontend
  const angelliraDetails = rawDetails
    ? {
        type: rawDetails.type || null,
        plate: rawDetails.plate || null,
        brand: rawDetails.brand || null,
        model: rawDetails.model || null,
        fabricationYear: rawDetails.fabricationYear ?? null,
        modelYear: rawDetails.modelYear ?? null,
        color: rawDetails.color || null,
        renavam: rawDetails.renavam || null,
        chassis: rawDetails.chassis || null,
        antt: rawDetails.antt || null,
        uf: rawDetails.uf || null,
        lastLicensing: rawDetails.lastLicensing || null,
      }
    : null;

  return {
    id: row.id,
    plate: row.plate,
    vehicleType: row.vehicle_type || null,
    plateRole: row.plate_role || null,
    angelliraStatus: row.angellira_status || null,
    angelliraValidUntil: row.angellira_valid_until
      ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
      : null,
    angelliraStatusText: row.angellira_status_text || null,
    angelliraDisplayName: row.angellira_display_name || null,
    angelliraLastSeenAt: row.angellira_last_seen_at || null,
    angelliraCheckedAt: row.angellira_checked_at || null,
    linkedDriverId: row.linked_driver_id || null,
    linkedDriverCpf: row.linked_driver_cpf || null,
    linkedDriverName: row.linked_driver_name || null,
    source: row.source || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    angelliraVigency: buildVehicleAngelliraVigency(row),
    angelliraDetails,
  };
}

function isMissingVehiclesTableError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("vehicles");
}

export async function fetchOperatorVehiclesListReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, status, plateRole } = parseOperatorVehiclesListQuery(query);

  try {
    return await withPgClient(async (client) => {
      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (search) {
        const searchPattern = `%${search.toLowerCase()}%`;
        conditions.push(
          `(LOWER(v.plate) LIKE $${paramIndex}
            OR LOWER(v.angellira_display_name) LIKE $${paramIndex}
            OR LOWER(dp.full_name) LIKE $${paramIndex})`,
        );
        params.push(searchPattern);
        paramIndex++;
      }

      if (status && status !== "todos") {
        conditions.push(`v.angellira_status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }

      if (plateRole && plateRole !== "todos") {
        conditions.push(`v.plate_role = $${paramIndex}`);
        params.push(plateRole);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countQuery = `
        SELECT COUNT(*) AS total_count
        FROM public.vehicles v
        LEFT JOIN public.driver_profiles dp
          ON REPLACE(REPLACE(dp.document_number, '.', ''), '-', '') = v.linked_driver_cpf
        ${whereClause}
      `;

      const dataQuery = `
        SELECT
          v.id,
          v.plate,
          v.vehicle_type,
          v.plate_role,
          v.angellira_status,
          v.angellira_valid_until,
          v.angellira_status_text,
          v.angellira_display_name,
          v.angellira_last_seen_at,
          v.angellira_checked_at,
          v.angellira_details,
          v.linked_driver_cpf,
          v.source,
          v.created_at,
          v.updated_at,
          dp.user_id AS linked_driver_id,
          dp.full_name AS linked_driver_name
        FROM public.vehicles v
        LEFT JOIN public.driver_profiles dp
          ON REPLACE(REPLACE(dp.document_number, '.', ''), '-', '') = v.linked_driver_cpf
        ${whereClause}
        ORDER BY v.updated_at DESC NULLS LAST, v.created_at DESC NULLS LAST
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      const [countResult, dataResult] = await Promise.all([
        client.query(countQuery, params),
        client.query(dataQuery, [...params, pageSize, offset]),
      ]);

      const totalCount = Number.parseInt(countResult.rows[0]?.total_count || "0", 10);
      const items = dataResult.rows.map(mapVehicleRowToItem);

      // Build summary counts from full dataset (unfiltered by pagination).
      const summaryQuery = `
        SELECT
          COUNT(*) AS total_vehicles,
          COUNT(*) FILTER (WHERE angellira_status = 'FOUND') AS found_count,
          COUNT(*) FILTER (WHERE angellira_status = 'NOT_FOUND') AS not_found_count,
          COUNT(*) FILTER (
            WHERE angellira_valid_until IS NOT NULL
            AND angellira_valid_until <= (CURRENT_DATE + INTERVAL '30 days')
            AND angellira_valid_until >= CURRENT_DATE
          ) AS expiring_soon_count
        FROM public.vehicles
      `;

      const summaryResult = await client.query(summaryQuery);
      const summaryRow = summaryResult.rows[0] || {};

      return {
        statusCode: 200,
        payload: {
          items,
          summary: {
            totalVehicles: Number.parseInt(summaryRow.total_vehicles || "0", 10),
            foundCount: Number.parseInt(summaryRow.found_count || "0", 10),
            notFoundCount: Number.parseInt(summaryRow.not_found_count || "0", 10),
            expiringSoonCount: Number.parseInt(summaryRow.expiring_soon_count || "0", 10),
          },
          meta: buildPaginationMeta(page, pageSize, totalCount, maxPageSize, correlationId),
        },
      };
    });
  } catch (error) {
    if (isMissingVehiclesTableError(error)) {
      return {
        statusCode: 200,
        payload: {
          items: [],
          summary: {
            totalVehicles: 0,
            foundCount: 0,
            notFoundCount: 0,
            expiringSoonCount: 0,
          },
          meta: buildPaginationMeta(page, pageSize, 0, maxPageSize, correlationId),
        },
      };
    }

    throw error;
  }
}

/**
 * Lista de logs de atividades do painel (security_audit_logs).
 * Filtros: dateFrom (ISO date), dateTo (ISO date inclusive), operatorId (uuid).
 * Paginacao: page (1-based), pageSize (max 200).
 */
const AUDIT_LOGS_DEFAULT_PAGE_SIZE = 50;
const AUDIT_LOGS_MAX_PAGE_SIZE = 200;

function parseAuditLogsQuery(query) {
  const rawPage = Number.parseInt(query?.page || "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawPageSize = Number.parseInt(query?.pageSize || "", 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0
    ? Math.min(rawPageSize, AUDIT_LOGS_MAX_PAGE_SIZE)
    : AUDIT_LOGS_DEFAULT_PAGE_SIZE;

  const dateFrom = typeof query?.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom.trim())
    ? new Date(`${query.dateFrom.trim()}T00:00:00.000Z`)
    : null;
  const dateToRaw = typeof query?.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.dateTo.trim())
    ? new Date(`${query.dateTo.trim()}T00:00:00.000Z`)
    : null;
  const dateToExclusive = dateToRaw ? new Date(dateToRaw.getTime() + 86_400_000) : null;

  const operatorId = typeof query?.operatorId === "string" && query.operatorId.trim() !== ""
    ? query.operatorId.trim()
    : null;

  return { page, pageSize, offset: (page - 1) * pageSize, dateFrom, dateToExclusive, operatorId };
}

export async function fetchOperatorAuditLogsReadModel({ query, correlationId }) {
  const { page, pageSize, offset, dateFrom, dateToExclusive, operatorId } = parseAuditLogsQuery(query);

  return withPgClient(async (client) => {
    const whereClauses = [];
    const values = [];
    let index = 1;

    if (dateFrom) {
      values.push(dateFrom);
      whereClauses.push(`created_at >= $${index}`);
      index += 1;
    }
    if (dateToExclusive) {
      values.push(dateToExclusive);
      whereClauses.push(`created_at < $${index}`);
      index += 1;
    }
    if (operatorId) {
      values.push(operatorId);
      whereClauses.push(`actor_user_id = $${index}`);
      index += 1;
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const [itemsResult, countResult] = await Promise.all([
      client.query(
        `
        SELECT
          id,
          event_type,
          severity,
          actor_user_id,
          actor_role,
          resource_type,
          resource_id,
          action,
          outcome,
          request_ip,
          correlation_id,
          metadata,
          created_at
        FROM public.security_audit_logs
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${index} OFFSET $${index + 1}
      `,
        [...values, pageSize, offset],
      ),
      client.query(
        `SELECT COUNT(*)::int AS total FROM public.security_audit_logs ${whereSql}`,
        values,
      ),
    ]);
    const totalCount = Number(countResult.rows[0]?.total) || 0;

    const directory = await resolveOperatorDirectory();

    return {
      statusCode: 200,
      payload: {
        items: itemsResult.rows.map((row) => {
          const resolved = row.actor_user_id ? directory.get(row.actor_user_id) : null;
          return {
            id: row.id,
            eventType: row.event_type,
            severity: row.severity,
            actorUserId: row.actor_user_id,
            actorEmail: resolved?.email || null,
            actorDisplayName: resolved?.displayName || null,
            actorRole: row.actor_role,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            action: row.action,
            outcome: row.outcome,
            requestIp: row.request_ip,
            correlationId: row.correlation_id,
            metadata: row.metadata || null,
            createdAt: row.created_at,
          };
        }),
        meta: buildPaginationMeta(page, pageSize, totalCount, AUDIT_LOGS_MAX_PAGE_SIZE, correlationId),
        // Lista completa de operadores do diretório (auth), independente de
        // terem gerado logs no período. Antes vinha de DISTINCT actor_user_id
        // dos próprios audit logs e escondia operadores sem atividade.
        operators: Array.from(directory.entries())
          .filter(([, info]) => info?.role === "operator")
          .map(([id, info]) => ({
            id,
            email: info.email || null,
            displayName: info.displayName || null,
            accessLevel: info.accessLevel || null,
          }))
          .sort((a, b) => {
            const aLabel = (a.displayName || a.email || a.id).toLowerCase();
            const bLabel = (b.displayName || b.email || b.id).toLowerCase();
            return aLabel.localeCompare(bLabel);
          }),
      },
    };
  });
}
