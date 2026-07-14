// backend/src/application/operator-admin/use-cases/gr-alerts-read-model.js
//
// Read-model do feed de ALERTAS de Gerenciamento de Risco (GR) — card DC-234.
// Varre TODOS os motoristas cadastrados (driver_profiles, que carregam as colunas
// de vigência Angellira/BRK/SPX) e TODOS os veículos (public.vehicles), aplica a
// camada de domínio pura (domain/gr/risk-status) e devolve a lista de alertas
// ordenada por urgência + um summary para os KPIs.
//
// Sem paginação de propósito: a varredura precisa cobrir toda a base (senão um
// motorista vencido poderia ficar de fora do alerta). O volume é da ordem de
// centenas; se um dia crescer, paginar/filtrar aqui — nunca cortar em silêncio.
//
// Contrato: retorna { statusCode, payload } (consumido por wrap()).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import {
  classifyExpiry,
  consolidateVerdict,
  deriveDriverAlerts,
  deriveVehicleAlerts,
  sortByUrgency,
  SEVERITY,
} from "../../../domain/gr/risk-status.js";

const DRIVER_RISK_QUERY = `
  SELECT
    dp.user_id,
    dp.full_name,
    dp.document_number,
    dp.angellira_status,
    dp.angellira_valid_until,
    dp.angellira_status_text,
    dp.angellira_checked_at,
    dp.brk_status,
    dp.brk_conjunto_apto,
    dp.brk_valid_until,
    dp.brk_status_text,
    dp.brk_checked_at,
    dp.brk_details,
    dp.spx_vigency_status,
    dp.spx_vigency_status_text,
    dp.spx_vigency_encontrado,
    dp.spx_vigency_checked_at
  FROM public.driver_profiles dp
`;

const VEHICLE_RISK_QUERY = `
  SELECT
    v.id,
    v.plate,
    v.plate_role,
    v.angellira_status,
    v.angellira_valid_until,
    v.angellira_status_text,
    v.angellira_checked_at,
    v.linked_driver_cpf,
    dp.full_name AS linked_driver_name
  FROM public.vehicles v
  LEFT JOIN public.driver_profiles dp
    ON REPLACE(REPLACE(dp.document_number, '.', ''), '-', '') = v.linked_driver_cpf
`;

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Linha de driver_profiles → entrada normalizada para o domínio de GR. */
function normalizeDriverRow(row, nowMs) {
  const angelliraValidUntil = toIsoDate(row.angellira_valid_until);
  const angellira =
    row.angellira_status || angelliraValidUntil
      ? {
          status: row.angellira_status || null,
          statusText: row.angellira_status_text || null,
          validUntil: angelliraValidUntil,
          ...classifyExpiry(angelliraValidUntil, { nowMs }),
          checkedAt: row.angellira_checked_at || null,
        }
      : null;

  const brkValidUntil = toIsoDate(row.brk_valid_until);
  const brk =
    row.brk_status || brkValidUntil || row.brk_conjunto_apto != null
      ? {
          status: row.brk_status || null,
          statusText: row.brk_status_text || null,
          conjuntoApto: typeof row.brk_conjunto_apto === "boolean" ? row.brk_conjunto_apto : null,
          validUntil: brkValidUntil,
          ...classifyExpiry(brkValidUntil, { nowMs }),
          checkedAt: row.brk_checked_at || null,
          componentes: row.brk_details || null,
        }
      : null;

  const spx =
    row.spx_vigency_status || row.spx_vigency_encontrado != null
      ? {
          status: row.spx_vigency_status || null,
          statusText: row.spx_vigency_status_text || null,
          encontrado: typeof row.spx_vigency_encontrado === "boolean" ? row.spx_vigency_encontrado : null,
          checkedAt: row.spx_vigency_checked_at || null,
        }
      : null;

  return {
    entityId: `driver:${row.user_id}`,
    displayName: row.full_name || null,
    document: row.document_number || null,
    angellira,
    brk,
    spx,
  };
}

/** Linha de vehicles → entrada normalizada para o domínio de GR. */
function normalizeVehicleRow(row, nowMs) {
  const validUntil = toIsoDate(row.angellira_valid_until);
  const angellira =
    row.angellira_status || validUntil
      ? {
          status: row.angellira_status || null,
          statusText: row.angellira_status_text || null,
          validUntil,
          ...classifyExpiry(validUntil, { nowMs }),
          checkedAt: row.angellira_checked_at || null,
        }
      : null;

  const linkedDriver =
    row.linked_driver_name || row.linked_driver_cpf
      ? { name: row.linked_driver_name || null, cpf: row.linked_driver_cpf || null }
      : null;

  return {
    entityId: `vehicle:${row.id}`,
    plate: row.plate || null,
    plateRole: row.plate_role || null,
    linkedDriver,
    angellira,
  };
}

function emptySummary() {
  return {
    drivers: { total: 0, ok: 0, atencao: 0, critico: 0, semDado: 0 },
    vehicles: { total: 0, expiringSoon: 0, expired: 0 },
    alertas: { total: 0, criticos: 0, atencao: 0 },
  };
}

/**
 * Transformação PURA: linhas do banco → payload de alertas + summary.
 * Exportada para teste sem banco.
 */
export function buildGrAlertsPayload({ driverRows = [], vehicleRows = [], nowMs = Date.now(), correlationId = null } = {}) {
  const drivers = driverRows.map((row) => normalizeDriverRow(row, nowMs));
  const vehicles = vehicleRows.map((row) => normalizeVehicleRow(row, nowMs));

  const verdictCounts = { OK: 0, ATENCAO: 0, CRITICO: 0, SEM_DADO: 0 };
  const alerts = [];

  for (const driver of drivers) {
    const verdict = consolidateVerdict(driver);
    verdictCounts[verdict.status] = (verdictCounts[verdict.status] ?? 0) + 1;
    alerts.push(...deriveDriverAlerts(driver));
  }

  let vehExpiringSoon = 0;
  let vehExpired = 0;
  for (const vehicle of vehicles) {
    const vehicleAlerts = deriveVehicleAlerts(vehicle);
    for (const alert of vehicleAlerts) {
      if (alert.severity === SEVERITY.CRIT) vehExpired += 1;
      else vehExpiringSoon += 1;
    }
    alerts.push(...vehicleAlerts);
  }

  const items = sortByUrgency(alerts);
  const criticos = items.filter((alert) => alert.severity === SEVERITY.CRIT).length;

  return {
    statusCode: 200,
    payload: {
      items,
      summary: {
        drivers: {
          total: drivers.length,
          ok: verdictCounts.OK,
          atencao: verdictCounts.ATENCAO,
          critico: verdictCounts.CRITICO,
          semDado: verdictCounts.SEM_DADO,
        },
        vehicles: {
          total: vehicles.length,
          expiringSoon: vehExpiringSoon,
          expired: vehExpired,
        },
        alertas: {
          total: items.length,
          criticos,
          atencao: items.length - criticos,
        },
      },
      meta: { count: items.length, correlationId: correlationId ?? null },
    },
  };
}

// Migração de vigência/veículos ainda não aplicada em algum ambiente → degrada limpo
// (mesma resiliência dos read-models de motorista/veículo).
function isMissingRiskSchemaError(error) {
  const message = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    message.includes("angellira_status") ||
    message.includes("angellira_valid_until") ||
    message.includes("brk_status") ||
    message.includes("brk_conjunto_apto") ||
    message.includes("spx_vigency_status") ||
    message.includes("spx_vigency_encontrado") ||
    message.includes("vehicles") ||
    message.includes("driver_profiles")
  );
}

/**
 * GET /api/operator/gr/alertas — feed de alertas de GR + summary (KPIs).
 * @returns {Promise<{statusCode:number, payload:object}>}
 */
export async function fetchGrAlertsReadModel({ correlationId } = {}) {
  try {
    return await withPgClient(async (client) => {
      const [driverResult, vehicleResult] = await Promise.all([
        client.query(DRIVER_RISK_QUERY),
        client.query(VEHICLE_RISK_QUERY),
      ]);
      return buildGrAlertsPayload({
        driverRows: driverResult.rows,
        vehicleRows: vehicleResult.rows,
        nowMs: Date.now(),
        correlationId: correlationId ?? null,
      });
    });
  } catch (error) {
    if (isMissingRiskSchemaError(error)) {
      return {
        statusCode: 200,
        payload: { items: [], summary: emptySummary(), meta: { count: 0, correlationId: correlationId ?? null } },
      };
    }
    throw error;
  }
}
