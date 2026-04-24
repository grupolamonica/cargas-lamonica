import "../../infrastructure/config/load-env.js";

import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { getPostgresTlsConfiguration, isEnabledEnv } from "../../infrastructure/pg/postgres-ssl.js";
import { getDriverValidationMetricsSnapshot } from "../../infrastructure/metrics.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../domain/load-claims/errors.js";
import { getRouteInfo } from "../../infrastructure/geoapify/index.js";
import { parseDriverLoadsQuery, parseOperatorDashboardQuery } from "../../domain/operator-admin/schemas.js";
import {
  buildPaginationMeta,
  parseNullableNumber,
  normalizeRouteLocation,
  stripRouteStateSuffix,
  stripOperationalLocationSuffix,
  canonicalizeRouteLookupLocation,
  createRouteLookupKeys,
} from "../../domain/operator-admin/route-utils.js";

const MANUAL_CARGO_STATUSES = new Set(["DRAFT", "OPEN"]);
const DEFAULT_SHEET_CLIENT_NAME = "Shopee";
const TERMINAL_LOAD_STATUSES = ["BOOKED", "EXPIRED", "CANCELLED", "COMPLETED", "FAILED"];

function getDefaultSheetClientName() {
  return process.env.GOOGLE_SHEET_DEFAULT_CLIENT_NAME?.trim() || DEFAULT_SHEET_CLIENT_NAME;
}

function normalizeClientName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isMissingRouteColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("distancia_km") || combinedMessage.includes("duracao_horas");
}

function isMissingRouteCatalogTableError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("route_metrics_cache");
}

function isMissingClienteLogoColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("logo_url");
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

function isMissingSheetScheduleColumnsError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("sheet_data_carregamento") || combinedMessage.includes("sheet_data_descarga");
}

function isMissingBonusRequirementsColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("bonus_exigencias");
}

function isMissingDriverVisibilityColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("driver_visibility");
}

function isMissingOptionalCargoReadModelColumnsError(error) {
  return isMissingRouteColumnError(error) || isMissingSheetScheduleColumnsError(error);
}

async function fetchRouteCatalogMetricsByLoadId(client, loadRows) {
  if (!Array.isArray(loadRows) || loadRows.length === 0) {
    return new Map();
  }

  const originKeys = new Set();
  const destinationKeys = new Set();

  loadRows.forEach((row) => {
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
      const profile = typeof row.perfil_padrao === "string" && row.perfil_padrao.trim() !== "" ? row.perfil_padrao.trim() : null;
      const value = parseNullableNumber(row.valor_padrao);
      const bonus = parseNullableNumber(row.bonus_padrao);

      if (distanceKm === null && routeEstimatedHours === null && durationHours === null && profile === null && value === null && bonus === null) {
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

function mapDriverLoadReadModelItem(row) {
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
  };
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue !== "" ? trimmedValue : null;
}

function buildDriverLoadPublicationState(row, routeCatalogMetrics) {
  const perfil = normalizeOptionalText(row.perfil) ?? routeCatalogMetrics?.perfil_padrao ?? null;
  const valor = parseNullableNumber(row.valor) ?? routeCatalogMetrics?.valor_padrao ?? null;
  const bonus = parseNullableNumber(row.bonus) ?? routeCatalogMetrics?.bonus_padrao ?? null;
  const distanciaKm = parseNullableNumber(row.distancia_km) ?? routeCatalogMetrics?.distancia_km ?? null;
  const duracaoHoras = parseNullableNumber(row.duracao_horas) ?? routeCatalogMetrics?.duracao_horas ?? null;
  const tempoEstimadoHoras =
    parseNullableNumber(row.tempo_estimado_horas) ?? routeCatalogMetrics?.tempo_estimado_horas ?? duracaoHoras;
  const routeMetricsRequired = row.__routeColumnsAvailable !== false;

  const missingFields = [];

  if (perfil === null) {
    missingFields.push("profile");
  }

  if (valor === null) {
    missingFields.push("payment");
  }

  if (routeMetricsRequired && distanciaKm === null) {
    missingFields.push("distance");
  }

  if (routeMetricsRequired && tempoEstimadoHoras === null) {
    missingFields.push("estimatedTime");
  }

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
    },
  };
}

async function queryDriverLoadCandidateRows(client, { whereSql, values }) {
  const buildItemQuery = ({
    withRouteColumns = true,
    withSheetScheduleColumns = true,
  } = {}) => `
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
    if (!isMissingOptionalCargoReadModelColumnsError(error)) {
      throw error;
    }

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

async function resolveRouteMetricsIfNeeded(origem, destino, existingMetrics = {}) {
  const distanceKm = typeof existingMetrics.distancia_km === "number" ? existingMetrics.distancia_km : null;
  const durationHours = typeof existingMetrics.duracao_horas === "number" ? existingMetrics.duracao_horas : null;

  if (distanceKm !== null && durationHours !== null) {
    return {
      distancia_km: distanceKm,
      duracao_horas: durationHours,
      degraded: false,
    };
  }

  try {
    const routeInfo = await getRouteInfo(origem, destino);
    return {
      distancia_km: routeInfo.distanceKm,
      duracao_horas: routeInfo.durationHours,
      degraded: false,
    };
  } catch (error) {
    logStructuredEvent("warn", "operator-admin.route-metrics.unavailable", {
      origem,
      destino,
      message: error instanceof Error ? error.message : String(error),
    });

    return {
      distancia_km: distanceKm,
      duracao_horas: durationHours,
      degraded: true,
    };
  }
}

async function findSheetClientId(client) {
  const targetName = getDefaultSheetClientName();
  const { rows } = await client.query(
    "SELECT id FROM public.clientes WHERE LOWER(nome) = LOWER($1) LIMIT 1",
    [targetName]
  );
  return rows[0]?.id ?? null;
}

async function findCargoById(client, cargoId, { lock = false } = {}) {
  const suffix = lock ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `
      SELECT id, status, cliente_id, sheet_lh, created_by, valor, bonus
      FROM public.cargas
      WHERE id = $1
      ${suffix}
    `,
    [cargoId],
  );

  return rows[0] || null;
}

function assertCargoOwnership(cargo, operatorId, options = {}) {
  // Cargas importadas via planilha (created_by = NULL) sao acessiveis por qualquer operador.
  // Operadores com acesso 'advanced' ignoram a trava de ownership — eles
  // administram toda a malha (inclusive cargas criadas por intermediarios).
  if (options.accessLevel === "advanced") {
    return;
  }
  if (cargo.created_by && cargo.created_by !== operatorId) {
    throw new ForbiddenError("Acesso negado: esta carga pertence a outro operador.");
  }
}

async function writeCargo(client, { cargoId, operatorId, payload, requestIp, correlationId }) {
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
  const clienteId = shouldLockSheetClient ? sheetClientId || existingCargo?.cliente_id || null : payload.cliente_id;
  const nextStatus = existingCargo && !MANUAL_CARGO_STATUSES.has(existingCargo.status) ? existingCargo.status : payload.status;
  const nextDriverVisibility = payload.driver_visibility || "PUBLIC";

  // When monetary fields are stripped (undefined) by the handler due to insufficient permissions,
  // preserve existing database values for updates, or default to null for creates.
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
            data = $2,
            horario = $3,
            origem = $4,
            destino = $5,
            distancia_km = $6,
            duracao_horas = $7,
            perfil = $8,
            valor = $9,
            bonus = $10,
            bonus_exigencias = $11,
            driver_visibility = $12,
            cliente_id = $13,
            status = $14,
            is_template = $15,
            sheet_data_carregamento = $16,
            sheet_data_descarga = $17
          WHERE id = $1
        `,
        [
          cargoId,
          payload.data,
          payload.horario,
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          payload.perfil,
          resolvedValor,
          resolvedBonus,
          payload.bonus_exigencias,
          nextDriverVisibility,
          clienteId,
          nextStatus,
          payload.is_template,
          payload.sheet_data_carregamento ?? null,
          payload.sheet_data_descarga ?? null,
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
          SET
            data = $2,
            horario = $3,
            origem = $4,
            destino = $5,
            perfil = $6,
            valor = $7,
            bonus = $8,
            cliente_id = $9,
            status = $10,
            is_template = $11
          WHERE id = $1
        `,
        [
          cargoId,
          payload.data,
          payload.horario,
          payload.origem,
          payload.destino,
          payload.perfil,
          resolvedValor,
          resolvedBonus,
          clienteId,
          nextStatus,
          payload.is_template,
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
            data,
            horario,
            origem,
            destino,
            distancia_km,
            duracao_horas,
            perfil,
            valor,
            bonus,
            bonus_exigencias,
            driver_visibility,
            cliente_id,
            status,
            is_template,
            created_by,
            sheet_data_carregamento,
            sheet_data_descarga
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `,
        [
          payload.data,
          payload.horario,
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          payload.perfil,
          resolvedValor,
          resolvedBonus,
          payload.bonus_exigencias,
          nextDriverVisibility,
          clienteId,
          nextStatus,
          payload.is_template,
          operatorId,
          payload.sheet_data_carregamento ?? null,
          payload.sheet_data_descarga ?? null,
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
            data,
            horario,
            origem,
            destino,
            perfil,
            valor,
            bonus,
            cliente_id,
            status,
            is_template,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          payload.data,
          payload.horario,
          payload.origem,
          payload.destino,
          payload.perfil,
          resolvedValor,
          resolvedBonus,
          clienteId,
          nextStatus,
          payload.is_template,
          operatorId,
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

  return {
    warnings,
  };
}

export async function createOperatorCargo({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const result = await writeCargo(client, {
      operatorId,
      payload,
      requestIp,
      correlationId,
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        warnings: result.warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function updateOperatorCargo({ cargoId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const result = await writeCargo(client, {
      cargoId,
      operatorId,
      payload,
      requestIp,
      correlationId,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        warnings: result.warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function duplicateOperatorCargo({ cargoId, operatorId, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    let existingCargo;

    try {
      const { rows } = await client.query(
        `
          SELECT
            id,
            data,
            horario,
            origem,
            destino,
            distancia_km,
            duracao_horas,
            perfil,
            valor,
            bonus,
            bonus_exigencias,
            driver_visibility,
            cliente_id,
            sheet_lh
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
            id,
            data,
            horario,
            origem,
            destino,
            distancia_km,
            duracao_horas,
            perfil,
            valor,
            bonus,
            NULL::text AS bonus_exigencias,
            'PUBLIC'::text AS driver_visibility,
            cliente_id,
            sheet_lh
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
            data,
            horario,
            origem,
            destino,
            distancia_km,
            duracao_horas,
            perfil,
            valor,
            bonus,
            bonus_exigencias,
            driver_visibility,
            cliente_id,
            status,
            is_template,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'DRAFT', false, $13)
        `,
        [
          existingCargo.data,
          existingCargo.horario,
          existingCargo.origem,
          existingCargo.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          existingCargo.perfil,
          existingCargo.valor,
          existingCargo.bonus,
          existingCargo.bonus_exigencias,
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
            data,
            horario,
            origem,
            destino,
            perfil,
            valor,
            bonus,
            cliente_id,
            status,
            is_template,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', false, $9)
        `,
        [
          existingCargo.data,
          existingCargo.horario,
          existingCargo.origem,
          existingCargo.destino,
          existingCargo.perfil,
          existingCargo.valor,
          existingCargo.bonus,
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
      payload: {
        ok: true,
        warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function toggleOperatorCargoStatus({ cargoId, operatorId, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const cargo = await findCargoById(client, cargoId, { lock: true });

    if (!cargo) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    assertCargoOwnership(cargo, operatorId);

    if (!MANUAL_CARGO_STATUSES.has(cargo.status)) {
      throw new ConflictError("Somente cargas abertas ou em rascunho podem ser alteradas manualmente.", {
        code: "CARGO_STATUS_MANAGED_BY_SYSTEM",
      });
    }

    const nextStatus = cargo.status === "OPEN" ? "DRAFT" : "OPEN";

    await client.query(`UPDATE public.cargas SET status = $2 WHERE id = $1`, [cargoId, nextStatus]);

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.status_toggled",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "toggle-status",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        previousStatus: cargo.status,
        nextStatus,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        status: nextStatus,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function deleteOperatorCargo({ cargoId, operatorId, operatorAccessLevel, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const cargo = await findCargoById(client, cargoId, { lock: true });

    if (!cargo) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    assertCargoOwnership(cargo, operatorId, { accessLevel: operatorAccessLevel });

    if (!MANUAL_CARGO_STATUSES.has(cargo.status)) {
      throw new ConflictError("Nao e seguro excluir cargas controladas pelo fluxo operacional.", {
        code: "CARGO_DELETE_BLOCKED",
      });
    }

    await client.query(`DELETE FROM public.cargas WHERE id = $1`, [cargoId]);

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.deleted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "delete",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        previousStatus: cargo.status,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function createOperatorCliente({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const values = [
      payload.nome,
      payload.descricao,
      payload.logo_url,
      payload.forma_pagamento,
      payload.prazo_pagamento,
      payload.exige_rastreamento,
      payload.exige_antt,
      payload.exige_seguro,
      payload.exige_carga_monitorada,
      payload.reputacao_pagamento_rapido,
      payload.reputacao_bom_pagador,
      payload.reputacao_liberacao_rapida,
      payload.reputacao_carga_organizada,
      payload.reputacao_boa_comunicacao,
      payload.exige_rastreamento ? "Obrigatorio" : null,
      payload.exige_antt ? "Obrigatorio" : null,
      payload.observacoes,
    ];
    const warnings = [];

    try {
      await client.query(
        `
          INSERT INTO public.clientes (
            nome,
            descricao,
            logo_url,
            forma_pagamento,
            prazo_pagamento,
            exige_rastreamento,
            exige_antt,
            exige_seguro,
            exige_carga_monitorada,
            reputacao_pagamento_rapido,
            reputacao_bom_pagador,
            reputacao_liberacao_rapida,
            reputacao_carga_organizada,
            reputacao_boa_comunicacao,
            rastreamento,
            antt,
            observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `,
        values,
      );
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) {
        throw error;
      }

      await client.query(
        `
          INSERT INTO public.clientes (
            nome,
            descricao,
            forma_pagamento,
            prazo_pagamento,
            exige_rastreamento,
            exige_antt,
            exige_seguro,
            exige_carga_monitorada,
            reputacao_pagamento_rapido,
            reputacao_bom_pagador,
            reputacao_liberacao_rapida,
            reputacao_carga_organizada,
            reputacao_boa_comunicacao,
            rastreamento,
            antt,
            observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `,
        values.filter((_, index) => index !== 2),
      );
      warnings.push("Client logo column is not available in the current database schema.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente.created",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente",
      action: "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        nome: payload.nome,
        hasLogoUrl: Boolean(payload.logo_url),
      },
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function updateOperatorCliente({ clienteId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id FROM public.clientes WHERE id = $1 FOR UPDATE`, [clienteId]);

    if (!rows[0]) {
      throw new NotFoundError("Embarcador nao encontrado.");
    }

    const values = [
      clienteId,
      payload.nome,
      payload.descricao,
      payload.logo_url,
      payload.forma_pagamento,
      payload.prazo_pagamento,
      payload.exige_rastreamento,
      payload.exige_antt,
      payload.exige_seguro,
      payload.exige_carga_monitorada,
      payload.reputacao_pagamento_rapido,
      payload.reputacao_bom_pagador,
      payload.reputacao_liberacao_rapida,
      payload.reputacao_carga_organizada,
      payload.reputacao_boa_comunicacao,
      payload.exige_rastreamento ? "Obrigatorio" : null,
      payload.exige_antt ? "Obrigatorio" : null,
      payload.observacoes,
    ];
    const warnings = [];

    try {
      await client.query(
        `
          UPDATE public.clientes
          SET
            nome = $2,
            descricao = $3,
            logo_url = $4,
            forma_pagamento = $5,
            prazo_pagamento = $6,
            exige_rastreamento = $7,
            exige_antt = $8,
            exige_seguro = $9,
            exige_carga_monitorada = $10,
            reputacao_pagamento_rapido = $11,
            reputacao_bom_pagador = $12,
            reputacao_liberacao_rapida = $13,
            reputacao_carga_organizada = $14,
            reputacao_boa_comunicacao = $15,
            rastreamento = $16,
            antt = $17,
            observacoes = $18
          WHERE id = $1
        `,
        values,
      );
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) {
        throw error;
      }

      await client.query(
        `
          UPDATE public.clientes
          SET
            nome = $2,
            descricao = $3,
            forma_pagamento = $4,
            prazo_pagamento = $5,
            exige_rastreamento = $6,
            exige_antt = $7,
            exige_seguro = $8,
            exige_carga_monitorada = $9,
            reputacao_pagamento_rapido = $10,
            reputacao_bom_pagador = $11,
            reputacao_liberacao_rapida = $12,
            reputacao_carga_organizada = $13,
            reputacao_boa_comunicacao = $14,
            rastreamento = $15,
            antt = $16,
            observacoes = $17
          WHERE id = $1
        `,
        values.filter((_, index) => index !== 3),
      );
      warnings.push("Client logo column is not available in the current database schema.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente.updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente",
      resourceId: clienteId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        nome: payload.nome,
        hasLogoUrl: Boolean(payload.logo_url),
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function deleteOperatorCliente({ clienteId, operatorId, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const dependencyCheck = await client.query(
      `
        SELECT COUNT(*)::int AS load_count
        FROM public.cargas
        WHERE cliente_id = $1
      `,
      [clienteId],
    );

    if ((dependencyCheck.rows[0]?.load_count || 0) > 0) {
      throw new ConflictError("Nao e seguro excluir um embarcador que ainda possui cargas vinculadas.", {
        code: "CLIENTE_HAS_CARGAS",
      });
    }

    const { rowCount } = await client.query(`DELETE FROM public.clientes WHERE id = $1`, [clienteId]);

    if (!rowCount) {
      throw new NotFoundError("Embarcador nao encontrado.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente.deleted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente",
      resourceId: clienteId,
      action: "delete",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {},
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function createOperatorRoute({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
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
            perfil_padrao = EXCLUDED.perfil_padrao,
            valor_padrao = EXCLUDED.valor_padrao,
            bonus_padrao = EXCLUDED.bonus_padrao,
            ativa = EXCLUDED.ativa,
            observacoes = EXCLUDED.observacoes,
            updated_at = now()
        `,
        [
          originKey,
          destinationKey,
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          payload.tempo_estimado_horas ?? resolvedMetrics.duracao_horas,
          payload.perfil_padrao,
          payload.valor_padrao,
          payload.bonus_padrao,
          payload.ativa,
          payload.observacoes,
        ],
      );
    } catch (error) {
      if (!isMissingRouteCatalogColumnsError(error)) {
        throw error;
      }

      await client.query(
        `
          INSERT INTO public.route_metrics_cache (
            origin_key,
            destination_key,
            origem,
            destino,
            distancia_km,
            duracao_horas
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (origin_key, destination_key)
          DO UPDATE SET
            origem = EXCLUDED.origem,
            destino = EXCLUDED.destino,
            distancia_km = EXCLUDED.distancia_km,
            duracao_horas = EXCLUDED.duracao_horas,
            updated_at = now()
        `,
        [
          originKey,
          destinationKey,
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
        ],
      );
      warnings.push("Extended route catalog columns are not available in the current database schema.");
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
      metadata: {
        origem: payload.origem,
        destino: payload.destino,
        ativa: payload.ativa,
      },
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function updateOperatorRoute({ routeId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id FROM public.route_metrics_cache WHERE id = $1 FOR UPDATE`, [routeId]);

    if (!rows[0]) {
      throw new NotFoundError("Rota nao encontrada.");
    }

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
            origin_key = $2,
            destination_key = $3,
            origem = $4,
            destino = $5,
            distancia_km = $6,
            duracao_horas = $7,
            tempo_estimado_horas = $8,
            perfil_padrao = $9,
            valor_padrao = $10,
            bonus_padrao = $11,
            ativa = $12,
            observacoes = $13,
            updated_at = now()
          WHERE id = $1
        `,
        [
          routeId,
          originKey,
          destinationKey,
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          payload.tempo_estimado_horas ?? resolvedMetrics.duracao_horas,
          payload.perfil_padrao,
          payload.valor_padrao,
          payload.bonus_padrao,
          payload.ativa,
          payload.observacoes,
        ],
      );
    } catch (error) {
      if (!isMissingRouteCatalogColumnsError(error)) {
        throw error;
      }

      await client.query(
        `
          UPDATE public.route_metrics_cache
          SET
            origin_key = $2,
            destination_key = $3,
            origem = $4,
            destino = $5,
            distancia_km = $6,
            duracao_horas = $7,
            updated_at = now()
          WHERE id = $1
        `,
        [
          routeId,
          originKey,
          destinationKey,
          payload.origem,
          payload.destino,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
        ],
      );
      warnings.push("Extended route catalog columns are not available in the current database schema.");
    }

    // Cascade route default values to all OPEN/DRAFT cargas matching this route.
    // Uses the same normalization as normalizeRouteLocation to match cargas by origem+destino.
    let cascadedCargaCount = 0;

    try {
      const cascadeResult = await client.query(
        `
          UPDATE public.cargas
          SET
            valor = COALESCE($1, valor),
            bonus = COALESCE($2, bonus),
            perfil = COALESCE($3, perfil),
            distancia_km = COALESCE($4, distancia_km),
            duracao_horas = COALESCE($5, duracao_horas)
          WHERE status IN ('OPEN', 'DRAFT')
            AND LOWER(TRIM(REGEXP_REPLACE(
                  REGEXP_REPLACE(origem, '[\u0300-\u036f]', '', 'g'),
                  '\\s+', ' ', 'g'
                ))) = $6
            AND LOWER(TRIM(REGEXP_REPLACE(
                  REGEXP_REPLACE(destino, '[\u0300-\u036f]', '', 'g'),
                  '\\s+', ' ', 'g'
                ))) = $7
        `,
        [
          payload.valor_padrao,
          payload.bonus_padrao,
          payload.perfil_padrao,
          resolvedMetrics.distancia_km,
          resolvedMetrics.duracao_horas,
          originKey,
          destinationKey,
        ],
      );
      cascadedCargaCount = cascadeResult.rowCount || 0;

      if (cascadedCargaCount > 0) {
        console.info(`[updateOperatorRoute] cascaded route defaults to ${cascadedCargaCount} open/draft cargas`, {
          routeId,
          origem: payload.origem,
          destino: payload.destino,
          correlationId,
        });
      }
    } catch (cascadeError) {
      // Non-fatal: route was already saved, log and continue
      console.warn("[updateOperatorRoute] failed to cascade route defaults to cargas", {
        routeId,
        error: cascadeError.message,
        correlationId,
      });
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
      metadata: {
        origem: payload.origem,
        destino: payload.destino,
        ativa: payload.ativa,
        cascadedCargaCount,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        cascadedCargaCount,
        warnings,
        meta: {
          correlationId,
        },
      },
    };
  });
}

export async function fetchOperatorDashboardReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, status, driverVisibility } = parseOperatorDashboardQuery(query);

  const buildDashboardFilterContext = ({ supportsOptionalColumns }) => {
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
          cargas.perfil ILIKE $${index} OR
          cargas.status ILIKE $${index} OR
          COALESCE(clientes.nome, '') ILIKE $${index} OR
          COALESCE(clientes.descricao, '') ILIKE $${index}
        )
      `);
      index += 1;
    }

    if (status && status !== "todos") {
      if (status === "templates") {
        clauses.push("COALESCE(cargas.is_template, false) = true");
      } else {
        values.push(status);
        clauses.push(`cargas.status = $${index}`);
        index += 1;
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

    return {
      values,
      whereSql: clauses.length ? clauses.join(" AND ") : "true",
      limitIndex: index,
      offsetIndex: index + 1,
    };
  };

  return withPgClient(async (client) => {
    let filterContext = buildDashboardFilterContext({
      supportsOptionalColumns: true,
    });
    let itemRows;

    try {
      const itemQueryResult = await client.query(
        `
          SELECT
            cargas.id,
            cargas.data,
            cargas.horario,
            cargas.origem,
            cargas.destino,
            cargas.distancia_km,
            cargas.duracao_horas,
            cargas.perfil,
            cargas.valor,
            cargas.bonus,
            COALESCE(cargas.driver_visibility, 'PUBLIC') AS driver_visibility,
            cargas.status,
            cargas.is_template,
            cargas.sheet_lh,
            cargas.sheet_data_carregamento,
            cargas.sheet_data_descarga,
            clientes.id AS cliente_id,
            clientes.nome AS cliente_nome,
            clientes.descricao AS cliente_descricao,
            clientes.forma_pagamento AS cliente_forma_pagamento,
            clientes.prazo_pagamento AS cliente_prazo_pagamento,
            clientes.observacoes AS cliente_observacoes,
            clientes.tipo_veiculo AS cliente_tipo_veiculo,
            clientes.peso AS cliente_peso,
            clientes.exige_antt AS cliente_exige_antt,
            clientes.exige_carga_monitorada AS cliente_exige_carga_monitorada,
            clientes.exige_rastreamento AS cliente_exige_rastreamento,
            clientes.exige_seguro AS cliente_exige_seguro,
            clientes.reputacao_boa_comunicacao AS cliente_reputacao_boa_comunicacao,
            clientes.reputacao_bom_pagador AS cliente_reputacao_bom_pagador,
            clientes.reputacao_carga_organizada AS cliente_reputacao_carga_organizada,
            clientes.reputacao_liberacao_rapida AS cliente_reputacao_liberacao_rapida,
            clientes.reputacao_pagamento_rapido AS cliente_reputacao_pagamento_rapido
          FROM public.cargas
          LEFT JOIN public.clientes
            ON clientes.id = cargas.cliente_id
          WHERE ${filterContext.whereSql}
          ORDER BY cargas.created_at DESC, cargas.id DESC
          LIMIT $${filterContext.limitIndex} OFFSET $${filterContext.offsetIndex}
        `,
        [...filterContext.values, pageSize, offset],
      );
      itemRows = itemQueryResult.rows;
    } catch (error) {
      if (!isMissingOptionalCargoReadModelColumnsError(error)) {
        throw error;
      }

      filterContext = buildDashboardFilterContext({
        supportsOptionalColumns: false,
      });

      const fallbackItemQueryResult = await client.query(
        `
          SELECT
            cargas.id,
            cargas.data,
            cargas.horario,
            cargas.origem,
            cargas.destino,
            NULL::numeric AS distancia_km,
            NULL::numeric AS duracao_horas,
            cargas.perfil,
            cargas.valor,
            cargas.bonus,
            'PUBLIC'::text AS driver_visibility,
            cargas.status,
            cargas.is_template,
            cargas.sheet_lh,
            NULL::text AS sheet_data_carregamento,
            NULL::text AS sheet_data_descarga,
            clientes.id AS cliente_id,
            clientes.nome AS cliente_nome,
            clientes.descricao AS cliente_descricao,
            clientes.forma_pagamento AS cliente_forma_pagamento,
            clientes.prazo_pagamento AS cliente_prazo_pagamento,
            clientes.observacoes AS cliente_observacoes,
            clientes.tipo_veiculo AS cliente_tipo_veiculo,
            clientes.peso AS cliente_peso,
            clientes.exige_antt AS cliente_exige_antt,
            clientes.exige_carga_monitorada AS cliente_exige_carga_monitorada,
            clientes.exige_rastreamento AS cliente_exige_rastreamento,
            clientes.exige_seguro AS cliente_exige_seguro,
            clientes.reputacao_boa_comunicacao AS cliente_reputacao_boa_comunicacao,
            clientes.reputacao_bom_pagador AS cliente_reputacao_bom_pagador,
            clientes.reputacao_carga_organizada AS cliente_reputacao_carga_organizada,
            clientes.reputacao_liberacao_rapida AS cliente_reputacao_liberacao_rapida,
            clientes.reputacao_pagamento_rapido AS cliente_reputacao_pagamento_rapido
          FROM public.cargas
          LEFT JOIN public.clientes
            ON clientes.id = cargas.cliente_id
          WHERE ${filterContext.whereSql}
          ORDER BY cargas.created_at DESC, cargas.id DESC
          LIMIT $${filterContext.limitIndex} OFFSET $${filterContext.offsetIndex}
        `,
        [...filterContext.values, pageSize, offset],
      );
      itemRows = fallbackItemQueryResult.rows;
    }

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
    const { rows: summaryRows } = await client.query(
      `
        SELECT
          COALESCE(SUM(CASE WHEN status = 'OPEN' AND NOT COALESCE(is_template, false) THEN 1 ELSE 0 END), 0)::int AS active_count,
          COALESCE(SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END), 0)::int AS draft_count,
          COALESCE(SUM(CASE WHEN COALESCE(is_template, false) THEN 1 ELSE 0 END), 0)::int AS template_count
        FROM public.cargas
      `,
    );

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
          driver_visibility: row.driver_visibility,
          status: row.status,
          is_template: row.is_template,
          sheet_lh: row.sheet_lh ?? null,
          sheet_data_carregamento: row.sheet_data_carregamento,
          sheet_data_descarga: row.sheet_data_descarga,
          cliente: row.cliente_id
            ? {
                id: row.cliente_id,
                nome: row.cliente_nome,
                descricao: row.cliente_descricao,
                forma_pagamento: row.cliente_forma_pagamento,
                prazo_pagamento: row.cliente_prazo_pagamento,
                observacoes: row.cliente_observacoes,
                tipo_veiculo: row.cliente_tipo_veiculo,
                peso: row.cliente_peso,
                exige_antt: row.cliente_exige_antt,
                exige_carga_monitorada: row.cliente_exige_carga_monitorada,
                exige_rastreamento: row.cliente_exige_rastreamento,
                exige_seguro: row.cliente_exige_seguro,
                reputacao_boa_comunicacao: row.cliente_reputacao_boa_comunicacao,
                reputacao_bom_pagador: row.cliente_reputacao_bom_pagador,
                reputacao_carga_organizada: row.cliente_reputacao_carga_organizada,
                reputacao_liberacao_rapida: row.cliente_reputacao_liberacao_rapida,
                reputacao_pagamento_rapido: row.cliente_reputacao_pagamento_rapido,
              }
            : null,
        })),
        summary: {
          activeCount: summaryRows[0]?.active_count || 0,
          draftCount: summaryRows[0]?.draft_count || 0,
          templateCount: summaryRows[0]?.template_count || 0,
        },
        meta: buildPaginationMeta(page, pageSize, countRows[0]?.total_count || 0, maxPageSize, correlationId),
      },
    };
  });
}

function buildDriverLoadFilters(query, { includeDriverVisibilityFilter = true } = {}) {
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

    if (!normalizedValue) {
      return [];
    }

    const matchedLocation = normalizedValue.match(/^(.*?)(?:\/([A-Za-z]{2}))$/);

    if (!matchedLocation) {
      return [`%${normalizedValue}%`];
    }

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

    if (patterns.length === 0) {
      return;
    }

    const locationClauses = patterns.map((pattern) => {
      values.push(pattern);
      const placeholder = `$${index}`;
      index += 1;
      return `${columnName} ILIKE ${placeholder}`;
    });

    clauses.push(`(${locationClauses.join(" OR ")})`);
  };

  appendDriverLocationClause("cargas.origem", parsedQuery.origem);
  appendDriverLocationClause("cargas.destino", parsedQuery.destino);

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

  return {
    parsedQuery,
    whereSql: clauses.join(" AND "),
    values,
    nextIndex: index,
  };
}

export async function fetchDriverLoadsReadModel({ query, correlationId }) {
  return withPgClient(async (client) => {
    let filterContext = buildDriverLoadFilters(query);
    let parsedQuery = filterContext.parsedQuery;
    let whereSql = filterContext.whereSql;
    let values = filterContext.values;
    let itemRows;

    try {
      itemRows = await queryDriverLoadCandidateRows(client, {
        whereSql,
        values,
      });
    } catch (error) {
      if (isMissingDriverVisibilityColumnError(error)) {
        filterContext = buildDriverLoadFilters(query, { includeDriverVisibilityFilter: false });
        parsedQuery = filterContext.parsedQuery;
        whereSql = filterContext.whereSql;
        values = filterContext.values;
        itemRows = await queryDriverLoadCandidateRows(client, {
          whereSql,
          values,
        });
      } else {
        throw error;
      }
    }

    const routeCatalogMetricsByLoadId = await fetchRouteCatalogMetricsByLoadId(client, itemRows);
    const publishableRows = itemRows
      .map((row) => buildDriverLoadPublicationState(row, routeCatalogMetricsByLoadId.get(row.id)))
      .filter((entry) => entry.isReady)
      .map((entry) => entry.row);
    const paginatedRows = publishableRows.slice(parsedQuery.offset, parsedQuery.offset + parsedQuery.pageSize);

    const stateSet = new Set();
    const profileSet = new Set();

    publishableRows.forEach((row) => {
      const originMatch = String(row.origem || "").trim().match(/([A-Za-z]{2})\s*$/);
      const destinationMatch = String(row.destino || "").trim().match(/([A-Za-z]{2})\s*$/);

      if (originMatch?.[1]) {
        stateSet.add(originMatch[1].toUpperCase());
      }

      if (destinationMatch?.[1]) {
        stateSet.add(destinationMatch[1].toUpperCase());
      }

      if (row.perfil) {
        profileSet.add(row.perfil);
      }
    });

    return {
      statusCode: 200,
      payload: {
        items: paginatedRows.map(mapDriverLoadReadModelItem),
        summary: {
          totalCount: publishableRows.length,
          uniqueStateCount: stateSet.size,
          uniqueProfileCount: profileSet.size,
        },
        meta: buildPaginationMeta(
          parsedQuery.page,
          parsedQuery.pageSize,
          publishableRows.length,
          parsedQuery.maxPageSize,
          correlationId,
        ),
      },
    };
  });
}

export async function fetchDriverLoadFacets({ correlationId }) {
  return withPgClient(async (client) => {
    const buildFacetWhereSql = (includeDriverVisibilityFilter) =>
      includeDriverVisibilityFilter
        ? "status = 'OPEN' AND COALESCE(is_template, false) = false AND COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC'"
        : "status = 'OPEN' AND COALESCE(is_template, false) = false";

    const queryFacetRows = async (includeDriverVisibilityFilter) => {
      const whereSql = buildFacetWhereSql(includeDriverVisibilityFilter);
      const rows = await queryDriverLoadCandidateRows(client, {
        whereSql,
        values: [],
      });
      const routeCatalogMetricsByLoadId = await fetchRouteCatalogMetricsByLoadId(client, rows);

      return rows
        .map((row) => buildDriverLoadPublicationState(row, routeCatalogMetricsByLoadId.get(row.id)))
        .filter((entry) => entry.isReady)
        .map((entry) => entry.row);
    };

    let publishableRows;

    try {
      publishableRows = await queryFacetRows(true);
    } catch (error) {
      if (!isMissingDriverVisibilityColumnError(error)) {
        throw error;
      }

      publishableRows = await queryFacetRows(false);
    }

    const origemSet = new Set();
    const destinoSet = new Set();
    const perfilSet = new Set();

    publishableRows.forEach((row) => {
      if (row.origem) {
        origemSet.add(row.origem);
      }

      if (row.destino) {
        destinoSet.add(row.destino);
      }

      if (normalizeOptionalText(row.perfil)) {
        perfilSet.add(row.perfil);
      }
    });

    return {
      statusCode: 200,
      payload: {
        origemOptions: Array.from(origemSet).sort((left, right) => left.localeCompare(right, "pt-BR")),
        destinoOptions: Array.from(destinoSet).sort((left, right) => left.localeCompare(right, "pt-BR")),
        perfilOptions: Array.from(perfilSet).sort((left, right) => left.localeCompare(right, "pt-BR")),
        meta: {
          correlationId,
        },
      },
    };
  });
}

async function probeAngelliraConnectivity() {
  const configured = Boolean(
    process.env.ANGELLIRA_USER?.trim() &&
    process.env.ANGELLIRA_PASSWORD?.trim() &&
    process.env.ANGELLIRA_EMPRESA_ID?.trim(),
  );
  if (!configured) return "not_configured";

  try {
    const { lookupAngelliraDriverByCpf } = await import("../driver-validation/angellira-client.js");
    const result = await lookupAngelliraDriverByCpf("00000000000");
    return result.availability === "UNAVAILABLE" ? `error:${result.errorCode || "UNAVAILABLE"}` : "ok";
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function probeGeoapifyConnectivity() {
  try {
    const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
    if (!apiKey) return "not_configured";
    const { getGeoapifyJson } = await import("../geoapify/geoapify-client.js");
    await getGeoapifyJson("/v1/geocode/search", { text: "Sao Paulo", format: "json", limit: 1 }, { timeoutMs: 4_000 });
    return "ok";
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function probeGoogleSheetsConnectivity() {
  try {
    const { getSheetExportUrl, fetchGoogleSheetCsv } = await import("../google-sheet-loads.js");
    const sheetUrl = getSheetExportUrl();
    if (!sheetUrl) return "not_configured";
    await fetchGoogleSheetCsv(globalThis.fetch, sheetUrl);
    return "ok";
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getHealthSnapshot({ correlationId, deep = false }) {
  const tlsConfiguration = getPostgresTlsConfiguration();
  const trustedProxyHeaders = isEnabledEnv("TRUST_PROXY_HEADERS", true);
  const driverValidationMetrics = getDriverValidationMetricsSnapshot();

  return withPgClient(async (client) => {
    await client.query("SELECT 1");

    const deepChecks = deep
      ? await Promise.allSettled([
          probeAngelliraConnectivity(),
          probeGeoapifyConnectivity(),
          probeGoogleSheetsConnectivity(),
        ]).then(([angellira, geoapify, sheets]) => ({
          angellira: angellira.status === "fulfilled" ? angellira.value : `error:${angellira.reason}`,
          geoapify: geoapify.status === "fulfilled" ? geoapify.value : `error:${geoapify.reason}`,
          googleSheets: sheets.status === "fulfilled" ? sheets.value : `error:${sheets.reason}`,
        }))
      : null;

    return {
      statusCode: 200,
      payload: {
        ok: true,
        service: "lamonica-cargas-platform",
        checks: {
          database: "ok",
          publicLeadWhatsappConfigured: Boolean(process.env.PUBLIC_LOAD_WHATSAPP_NUMBER?.trim()),
          claimCronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
          strictDatabaseTls: tlsConfiguration.rejectUnauthorized,
          databaseTlsCaConfigured: tlsConfiguration.caConfigured,
          databaseTlsCaSource: tlsConfiguration.caSource,
          trustedProxyHeaders,
          canonicalClientIpHeaderConfigured: Boolean(process.env.TRUSTED_CLIENT_IP_HEADER?.trim()),
          ...(deepChecks ? { integrations: deepChecks } : {}),
        },
        features: {
          driverValidation: driverValidationMetrics,
        },
        meta: {
          correlationId,
          timestamp: new Date().toISOString(),
          deepCheck: deep,
        },
      },
    };
  });
}

export async function redactExpiredPublicLeadPii({ batchSize = 50, retentionDays = 30, correlationId }) {
  const effectiveBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 50;
  const effectiveRetentionDays = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const cutoffTimestamp = new Date(Date.now() - effectiveRetentionDays * 24 * 60 * 60 * 1000).toISOString();

  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `
        SELECT leads.id
        FROM public.load_public_leads AS leads
        INNER JOIN public.cargas
          ON cargas.id = leads.load_id
        WHERE leads.pii_redacted_at IS NULL
          AND leads.status IN ('APPROVED', 'CANCELLED')
          AND (
            leads.status = 'CANCELLED'
            OR cargas.status = ANY($1::text[])
          )
          AND COALESCE(leads.approved_at, leads.updated_at, leads.created_at) < $2::timestamptz
        ORDER BY COALESCE(leads.approved_at, leads.updated_at, leads.created_at) ASC
        LIMIT $3
        FOR UPDATE
      `,
      [TERMINAL_LOAD_STATUSES, cutoffTimestamp, effectiveBatchSize],
    );

    if (!rows.length) {
      return {
        redactedCount: 0,
        correlationId,
      };
    }

    const leadIds = rows.map((row) => row.id);

    const placeholderSql = leadIds.map((_, index) => `$${index + 1}`).join(", ");

    await client.query(
      `
        UPDATE public.load_public_leads
        SET
          cpf = CONCAT('redacted-cpf-', id::text),
          phone = CONCAT('redacted-phone-', id::text),
          horse_plate = CONCAT('redacted-horse-', id::text),
          trailer_plate = CONCAT('redacted-trailer-', id::text),
          trailer_plate_2 = CASE
            WHEN COALESCE(trailer_plate_2, '') = '' THEN ''
            ELSE CONCAT('redacted-trailer-2-', id::text)
          END,
          pii_redacted_at = now()
        WHERE id IN (${placeholderSql})
      `,
      leadIds,
    );

    await insertSecurityAuditEvent(client, {
      eventType: "public-leads.pii.redacted",
      actorRole: "system",
      resourceType: "public-load-lead",
      action: "redact-pii",
      outcome: "success",
      correlationId,
      metadata: {
        redactedCount: leadIds.length,
        retentionDays: effectiveRetentionDays,
      },
    });

    return {
      redactedCount: leadIds.length,
      correlationId,
    };
  });
}

export async function updateOperatorDriverProfile({ driverId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT user_id, full_name, document_number, phone FROM public.driver_profiles WHERE user_id = $1 FOR UPDATE`,
      [driverId],
    );

    if (!rows[0]) {
      throw new NotFoundError("Motorista nao encontrado.");
    }

    const oldCpf = String(rows[0].document_number || "").replace(/\D/g, "");
    const oldPhone = String(rows[0].phone || "").replace(/\D/g, "");

    // Build dynamic SET clause from payload keys
    const updates = [];
    const values = [driverId]; // $1 = user_id
    let paramIndex = 2;

    const fieldMap = {
      full_name: "full_name",
      phone: "phone",
      document_number: "document_number",
      vehicle_profile: "vehicle_profile",
      documents_valid: "documents_valid",
      antt_valid: "antt_valid",
      tracking_enabled: "tracking_enabled",
      insurance_valid: "insurance_valid",
      monitoring_capable: "monitoring_capable",
      operational_blocked: "operational_blocked",
      allowed_regions: "allowed_regions",
    };

    for (const [payloadKey, column] of Object.entries(fieldMap)) {
      if (payload[payloadKey] !== undefined) {
        const isArrayColumn = column === "allowed_regions";
        const rawValue = payload[payloadKey];
        const normalizedValue = column === "phone"
          ? String(rawValue || "").replace(/\D/g, "")
          : rawValue;
        updates.push(`${column} = $${paramIndex}${isArrayColumn ? "::text[]" : ""}`);
        values.push(normalizedValue);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      throw new ValidationError("Nenhum campo informado para atualizar.");
    }

    updates.push("updated_at = now()");

    await client.query(
      `UPDATE public.driver_profiles SET ${updates.join(", ")} WHERE user_id = $1`,
      values,
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.driver.profile.updated",
      severity: "info",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "driver_profile",
      resourceId: driverId,
      action: "update-driver-profile",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        updatedFields: Object.keys(payload),
        previousName: rows[0].full_name,
      },
    });

    logStructuredEvent("info", "operator.driver.profile.updated", {
      driverId,
      operatorId,
      correlationId,
      updatedFields: Object.keys(payload),
    });

    // Cascade CPF/phone changes to public leads so deduplication keeps matching
    const newCpf = payload.document_number !== undefined
      ? String(payload.document_number || "").replace(/\D/g, "")
      : oldCpf;
    const newPhone = payload.phone !== undefined
      ? String(payload.phone || "").replace(/\D/g, "")
      : oldPhone;

    if (oldCpf && oldCpf !== newCpf) {
      await client.query(
        `UPDATE public.load_public_leads SET cpf = $1 WHERE REGEXP_REPLACE(cpf, '\\D', '', 'g') = $2 AND status IN ('QUEUED', 'APPROVED')`,
        [newCpf, oldCpf],
      );
    }
    if (oldPhone && oldPhone !== newPhone) {
      await client.query(
        `UPDATE public.load_public_leads SET phone = $1 WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') = $2 AND status IN ('QUEUED', 'APPROVED')`,
        [newPhone, oldPhone],
      );
    }

    const { rows: updatedRows } = await client.query(
      `SELECT * FROM public.driver_profiles WHERE user_id = $1`,
      [driverId],
    );

    return {
      statusCode: 200,
      payload: {
        ok: true,
        profile: updatedRows[0],
        meta: { correlationId },
      },
    };
  });
}

/**
 * Busca dados Angellira ja persistidos no perfil de um motorista cadastrado.
 * Retorna o cache local quando:
 *   1. O CPF corresponde a um motorista registrado
 *   2. Os dados foram checados ha menos de `maxAgeMs` (padrao: 24 horas)
 *
 * Usado pelo fluxo de validacao para evitar chamadas externas desnecessarias.
 */
const DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export async function lookupCachedAngelliraValidation({ documentNumber, maxAgeMs, correlationId }) {
  if (!documentNumber) {
    return { found: false, reason: "MISSING_INPUT" };
  }

  const normalizedCpf = String(documentNumber).replace(/\D/g, "");

  if (!normalizedCpf) {
    return { found: false, reason: "EMPTY_DOCUMENT" };
  }

  const effectiveMaxAge = maxAgeMs ?? DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS;

  return withPgClient(async (client) => {
    try {
      const { rows } = await client.query(
        `SELECT
          user_id,
          full_name,
          document_number,
          angellira_status,
          angellira_valid_until,
          angellira_status_text,
          angellira_checked_at
        FROM public.driver_profiles
        WHERE angellira_checked_at IS NOT NULL
          AND (replace(document_number, '.', '') LIKE '%' || $1 || '%'
            OR replace(replace(document_number, '.', ''), '-', '') = $1)
        LIMIT 1`,
        [normalizedCpf],
      );

      if (!rows.length) {
        return { found: false, reason: "NO_MATCH" };
      }

      const row = rows[0];
      const checkedAt = new Date(row.angellira_checked_at).getTime();
      const ageMs = Date.now() - checkedAt;

      if (ageMs > effectiveMaxAge) {
        logStructuredEvent("info", "operator-admin.angellira-cache.stale", {
          correlationId: correlationId || null,
          documentNumber: `***${normalizedCpf.slice(-4)}`,
          ageHours: Math.round(ageMs / (1000 * 60 * 60) * 10) / 10,
          maxAgeHours: Math.round(effectiveMaxAge / (1000 * 60 * 60) * 10) / 10,
        });
        return { found: false, reason: "STALE", ageMs };
      }

      logStructuredEvent("info", "operator-admin.angellira-cache.hit", {
        correlationId: correlationId || null,
        documentNumber: `***${normalizedCpf.slice(-4)}`,
        angelliraStatus: row.angellira_status,
        ageMs,
      });

      return {
        found: true,
        cached: true,
        driverName: row.full_name,
        angelliraResult: {
          queryFor: "cpf",
          queryValue: normalizedCpf,
          availability: "OK",
          status: row.angellira_status || "NOT_FOUND",
          found: row.angellira_status === "FOUND",
          displayName: row.full_name,
          validUntil: row.angellira_valid_until
            ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
            : null,
          lastSeenAt: row.angellira_checked_at,
          statusText: row.angellira_status_text || null,
        },
      };
    } catch (error) {
      // Se as colunas Angellira nao existem, retorna cache miss silenciosamente
      const msg = (error?.message || "").toLowerCase();
      if (msg.includes("angellira_status") || msg.includes("angellira_checked_at")) {
        return { found: false, reason: "COLUMNS_MISSING" };
      }
      throw error;
    }
  });
}

/**
 * Revalida em lote as placas registradas na tabela vehicles consultando o Angellira
 * e gravando as respostas via syncVehicleAngelliraLookup.
 *
 * - Processa em chunks de CONCURRENCY para respeitar rate-limit do Angellira
 *   e caber no maxDuration (30s no Vercel).
 * - Ordena por angellira_checked_at ASC NULLS FIRST: atualiza primeiro os
 *   mais desatualizados.
 */
const REVALIDATE_VEHICLES_BATCH_LIMIT = 50;
const REVALIDATE_VEHICLES_CONCURRENCY = 5;

export async function revalidateAllVehiclesAngellira({ correlationId } = {}) {
  const { lookupAngelliraPlate } = await import("../driver-validation/angellira-client.js");

  const vehicleRows = await withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT
          plate,
          plate_role,
          vehicle_type,
          linked_driver_cpf
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
        if (lookup.availability !== "OK") {
          return { skipped: true };
        }
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

/**
 * Busca dados Angellira de placa ja persistidos na tabela de veiculos.
 * Retorna cache local quando existe um registro com angellira_checked_at dentro do `maxAgeMs`
 * (padrao: 24 horas). Formato compatível com `lookupAngelliraPlate` para ser drop-in.
 */
export async function lookupCachedAngelliraPlate({ plate, maxAgeMs, correlationId }) {
  if (!plate) {
    return { found: false, reason: "MISSING_INPUT" };
  }

  const normalizedPlate = String(plate).toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (!normalizedPlate) {
    return { found: false, reason: "EMPTY_PLATE" };
  }

  const effectiveMaxAge = maxAgeMs ?? DEFAULT_ANGELLIRA_CACHE_MAX_AGE_MS;

  try {
    return await withPgClient(async (client) => {
      try {
        const { rows } = await client.query(
          `SELECT
            plate,
            angellira_status,
            angellira_valid_until,
            angellira_status_text,
            angellira_display_name,
            angellira_last_seen_at,
            angellira_checked_at
          FROM public.vehicles
          WHERE plate = $1
            AND angellira_checked_at IS NOT NULL
          LIMIT 1`,
          [normalizedPlate],
        );

        if (!rows.length) {
          return { found: false, reason: "NO_MATCH" };
        }

        const row = rows[0];
        const checkedAt = new Date(row.angellira_checked_at).getTime();
        const ageMs = Date.now() - checkedAt;

        if (ageMs > effectiveMaxAge) {
          logStructuredEvent("info", "operator-admin.angellira-plate-cache.stale", {
            correlationId: correlationId || null,
            plate: `${normalizedPlate.slice(0, 3)}***`,
            ageHours: Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10,
          });
          return { found: false, reason: "STALE", ageMs };
        }

        logStructuredEvent("info", "operator-admin.angellira-plate-cache.hit", {
          correlationId: correlationId || null,
          plate: `${normalizedPlate.slice(0, 3)}***`,
          angelliraStatus: row.angellira_status,
          ageMs,
        });

        return {
          found: true,
          cached: true,
          angelliraResult: {
            queryFor: "plate",
            queryValue: normalizedPlate,
            availability: "OK",
            status: row.angellira_status || "NOT_FOUND",
            found: row.angellira_status === "FOUND",
            displayName: row.angellira_display_name || null,
            validUntil: row.angellira_valid_until
              ? new Date(row.angellira_valid_until).toISOString().slice(0, 10)
              : null,
            lastSeenAt: row.angellira_last_seen_at
              ? new Date(row.angellira_last_seen_at).toISOString()
              : row.angellira_checked_at,
            statusText: row.angellira_status_text || null,
          },
        };
      } catch (error) {
        const msg = (error?.message || "").toLowerCase();
        if (msg.includes("angellira_") || msg.includes("vehicles")) {
          return { found: false, reason: "COLUMNS_MISSING" };
        }
        throw error;
      }
    });
  } catch {
    return { found: false, reason: "CACHE_UNAVAILABLE" };
  }
}

/**
 * Persiste o resultado da validacao Angellira no perfil de um motorista cadastrado.
 * Chamado automaticamente apos a validacao de leads publicos quando o CPF corresponde
 * a um motorista registrado. Operacao idempotente — sempre sobrescreve com o dado mais recente.
 */
export async function syncDriverAngelliraValidation({ documentNumber, angelliraResult, correlationId }) {
  if (!documentNumber || !angelliraResult) {
    return { updated: false, reason: "MISSING_INPUT" };
  }

  const normalizedCpf = String(documentNumber).replace(/\D/g, "");

  if (!normalizedCpf) {
    return { updated: false, reason: "EMPTY_DOCUMENT" };
  }

  // Apenas persiste resultados concretos (FOUND ou NOT_FOUND).
  // UNAVAILABLE indica falha transitória e não deve sobrescrever dados válidos.
  if (angelliraResult.availability !== "OK") {
    return { updated: false, reason: "UNAVAILABLE_RESULT" };
  }

  return withPgClient(async (client) => {
    const detailsJson = angelliraResult.driverDetails
      ? JSON.stringify(angelliraResult.driverDetails)
      : null;
    const angelliraName = (angelliraResult.displayName || "").trim() || null;

    const { rows } = await client.query(
      `UPDATE public.driver_profiles
       SET
         full_name = COALESCE($6, full_name),
         angellira_status = $2,
         angellira_valid_until = $3,
         angellira_status_text = $4,
         angellira_details = COALESCE($5::jsonb, angellira_details),
         angellira_checked_at = now(),
         updated_at = now()
       WHERE replace(document_number, '.', '') LIKE '%' || $1 || '%'
         OR replace(replace(document_number, '.', ''), '-', '') = $1
       RETURNING user_id`,
      [
        normalizedCpf,
        angelliraResult.status || null,
        angelliraResult.validUntil || null,
        angelliraResult.statusText || null,
        detailsJson,
        angelliraName,
      ],
    );

    const updatedCount = rows.length;

    if (updatedCount > 0) {
      logStructuredEvent("info", "operator-admin.angellira-sync.updated", {
        correlationId: correlationId || null,
        documentNumber: `***${normalizedCpf.slice(-4)}`,
        angelliraStatus: angelliraResult.status,
        validUntil: angelliraResult.validUntil || null,
        matchedDrivers: updatedCount,
      });
    }

    return { updated: updatedCount > 0, matchedDrivers: updatedCount };
  });
}

/**
 * Persiste o resultado de uma consulta Angellira de placa na tabela de veiculos.
 * Chamado automaticamente apos a validacao de leads publicos quando a placa retorna resultado valido.
 * Operacao idempotente — sempre sobrescreve com o dado mais recente via UPSERT.
 */
export async function syncVehicleAngelliraLookup({ plate, plateRole, vehicleType, angelliraResult, linkedDriverCpf, correlationId }) {
  const normalizedPlate = String(plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (!normalizedPlate || !angelliraResult || angelliraResult.availability !== "OK") {
    return { upserted: false, reason: "SKIP" };
  }

  try {
    return await withPgClient(async (client) => {
      const detailsJson = angelliraResult.vehicleDetails
        ? JSON.stringify(angelliraResult.vehicleDetails)
        : null;

      const { rows } = await client.query(
        `INSERT INTO public.vehicles (
          plate, vehicle_type, plate_role,
          angellira_status, angellira_valid_until, angellira_status_text,
          angellira_display_name, angellira_last_seen_at, angellira_checked_at,
          angellira_details,
          linked_driver_cpf, source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9::jsonb, $10, 'PUBLIC_LEAD')
        ON CONFLICT (plate) DO UPDATE SET
          angellira_status = EXCLUDED.angellira_status,
          angellira_valid_until = EXCLUDED.angellira_valid_until,
          angellira_status_text = EXCLUDED.angellira_status_text,
          angellira_display_name = COALESCE(EXCLUDED.angellira_display_name, vehicles.angellira_display_name),
          angellira_last_seen_at = EXCLUDED.angellira_last_seen_at,
          angellira_checked_at = EXCLUDED.angellira_checked_at,
          angellira_details = COALESCE(EXCLUDED.angellira_details, vehicles.angellira_details),
          linked_driver_cpf = COALESCE(EXCLUDED.linked_driver_cpf, vehicles.linked_driver_cpf),
          vehicle_type = COALESCE(EXCLUDED.vehicle_type, vehicles.vehicle_type),
          updated_at = now()
        RETURNING id`,
        [
          normalizedPlate,
          vehicleType || null,
          plateRole || null,
          angelliraResult.status || null,
          angelliraResult.validUntil || null,
          angelliraResult.statusText || null,
          angelliraResult.displayName || null,
          angelliraResult.lastSeenAt || null,
          detailsJson,
          linkedDriverCpf ? String(linkedDriverCpf).replace(/\D/g, "") : null,
        ],
      );

      logStructuredEvent("info", "operator-admin.vehicle-sync.upserted", {
        correlationId: correlationId || null,
        plate: `${normalizedPlate.slice(0, 3)}***`,
        plateRole: plateRole || null,
        angelliraStatus: angelliraResult.status || null,
        vehicleId: rows[0]?.id || null,
      });

      return { upserted: true, vehicleId: rows[0]?.id };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.toLowerCase().includes("vehicles")) {
      return { upserted: false, reason: "TABLE_MISSING" };
    }

    throw error;
  }
}
