import "../../../infrastructure/config/load-env.js";

import crypto from "node:crypto";

import { ZodError } from "zod";

import { insertSecurityAuditEvent, recordSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import {
  getAuthorizationHeader,
  getCorrelationId,
  getHeaderValue,
  getQueryParam,
  getRequestIp,
  parseJsonBody,
} from "../http-utils.js";
import {
  cargoCreateMutationSchema,
  cargoUpdateMutationSchema,
  clienteMutationSchema,
  driverProfileUpdateMutationSchema,
  routeMutationSchema,
} from "../../../domain/operator-admin/schemas.js";
import {
  buildInternalErrorResponse,
  buildServiceErrorResponse,
} from "../error-mapping.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";
import { cargoIdParamsSchema } from "../schemas/cargo-schemas.js";
import {
  attachClienteRotaBodySchema,
  clienteIdParamsSchema,
  clienteRotaParamsSchema,
} from "../schemas/cliente-schemas.js";
import { routeIdParamsSchema } from "../schemas/route-schemas.js";
import { driverIdParamsSchema } from "../schemas/driver-schemas.js";
import { dashboardQuerySchema } from "../schemas/operator-schemas.js";
import {
  attachClienteRota,
  createOperatorCargo,
  createOperatorCliente,
  createOperatorRoute,
  deleteOperatorCargo,
  deleteOperatorCliente,
  detachClienteRota,
  fetchOperatorDashboardReadModel,
  listClienteRotas,
  redactExpiredPublicLeadPii,
  revalidateAllVehiclesAngellira,
  updateOperatorCargo,
  updateOperatorCliente,
  updateOperatorRoute,
  duplicateOperatorCargo,
  toggleOperatorCargoStatus,
  updateOperatorDriverProfile,
} from "../../../application/operator-admin/service.js";
import {
  fetchOperatorAuditLogsReadModel,
  fetchOperatorCargoListReadModel,
  fetchOperatorClientesListReadModel,
  fetchOperatorDriversListReadModel,
  fetchOperatorRoutesListReadModel,
  fetchOperatorVehiclesListReadModel,
  fetchPendingDriverRegistrations,
} from "../../../application/operator-admin/read-models.js";
import { ensureDriverLoadsSheetFresh } from "../public-loads/handlers.js";
import { fetchDriverFlowMetrics } from "../../../domain/operator-admin/driver-flow-metrics.js";
import {
  ForbiddenError,
  LoadClaimServiceError,
  UnauthorizedError,
} from "../../../domain/load-claims/errors.js";
import { assertOperatorAccessLevel, assertOperatorPermission, hasOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { getAdminClient, requireOperatorSession } from "../../../application/load-claims/auth.js";
import { createSupabaseAdminClient, syncGoogleSheetLoads } from "../../../application/google-sheets/google-sheet-loads.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";

import {
  getIdempotencyResult,
  setIdempotencyResult,
} from "../../../infrastructure/idempotency-redis.js";

// Idempotency cache backed by Redis — shared across replicas.
// Falls back to null (cache miss) on Redis failure, causing re-execution.

async function checkIdempotencyCache(key) {
  return getIdempotencyResult(key);
}

async function setIdempotencyCache(key, response) {
  await setIdempotencyResult(key, response);
}

function toErrorResponse(error, correlationId) {
  if (error instanceof ZodError) {
    return zodErrorToHttpResponse(error, correlationId);
  }
  if (error instanceof LoadClaimServiceError) {
    return buildServiceErrorResponse(error, correlationId, { includeDetails: true });
  }
  return buildInternalErrorResponse(
    correlationId,
    "Unexpected error while processing the operator request.",
  );
}

async function withOperatorSession(request, action, optionsOrExecute, maybeExecute) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);
  const options = typeof optionsOrExecute === "function" ? {} : optionsOrExecute;
  const execute = typeof optionsOrExecute === "function" ? optionsOrExecute : maybeExecute;
  let user = null;
  let accessLevel = null;
  const rawIdempotencyKey = getHeaderValue(request, "Idempotency-Key");

  try {
    const session = await requireOperatorSession(getAuthorizationHeader(request));
    user = session.user;
    accessLevel = session.accessLevel;

    if (options.requiredPermission) {
      assertOperatorPermission(user, options.requiredPermission, options.forbiddenMessage);
    }

    if (rawIdempotencyKey) {
      const cacheKey = `${user.id}:${action}:${rawIdempotencyKey}`;
      const cachedResponse = await checkIdempotencyCache(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }

      const response = await execute({
        correlationId,
        requestIp,
        operatorId: user.id,
        operatorAccessLevel: accessLevel,
        user,
      });
      await setIdempotencyCache(cacheKey, response);
      return response;
    }

    return await execute({
      correlationId,
      requestIp,
      operatorId: user.id,
      operatorAccessLevel: accessLevel,
      user,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      await recordSecurityAuditEvent({
        eventType: "operator.request.denied",
        severity: "warn",
        actorUserId: user?.id ?? null,
        actorRole: user ? `operator:${accessLevel || "unknown"}` : "unknown",
        resourceType: "operator-api",
        action,
        outcome: "denied",
        requestIp,
        correlationId,
        metadata: {
          path: request.url || null,
          method: request.method || "GET",
          reason: error.code,
          requiredPermission: options.requiredPermission || null,
          operatorAccessLevel: accessLevel,
        },
      });
    } else {
      logStructuredEvent("error", "operator.request.failed", {
        action,
        correlationId,
        requestIp,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return toErrorResponse(error, correlationId);
  }
}

export async function resolveCreateOperatorCargoResponse(request) {
  return withOperatorSession(
    request,
    "create-cargo",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem alterar cargas.",
    },
    async ({ correlationId, requestIp, operatorId, user }) => {
    const payload = cargoCreateMutationSchema.parse(await parseJsonBody(request));

    // Strip monetary fields when operator lacks cargos:write_values permission
    if (!hasOperatorPermission(user, "cargos:write_values")) {
      delete payload.valor;
      delete payload.bonus;
    }

    return createOperatorCargo({
      operatorId,
      payload,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveUpdateOperatorCargoResponse(request) {
  return withOperatorSession(
    request,
    "update-cargo",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem alterar cargas.",
    },
    async ({ correlationId, requestIp, operatorId, user }) => {
    const { cargoId } = cargoIdParamsSchema.parse({ cargoId: getQueryParam(request, "cargoId") });

    const payload = cargoUpdateMutationSchema.parse(await parseJsonBody(request));

    // Strip monetary fields when operator lacks cargos:write_values permission
    if (!hasOperatorPermission(user, "cargos:write_values")) {
      delete payload.valor;
      delete payload.bonus;
    }

    return updateOperatorCargo({
      cargoId,
      operatorId,
      payload,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveDuplicateOperatorCargoResponse(request) {
  return withOperatorSession(
    request,
    "duplicate-cargo",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem alterar cargas.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
    const { cargoId } = cargoIdParamsSchema.parse({ cargoId: getQueryParam(request, "cargoId") });

    return duplicateOperatorCargo({
      cargoId,
      operatorId,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveToggleOperatorCargoStatusResponse(request) {
  return withOperatorSession(
    request,
    "toggle-cargo-status",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem alterar cargas.",
    },
    async ({ correlationId, requestIp, operatorId, operatorAccessLevel }) => {
    const { cargoId } = cargoIdParamsSchema.parse({ cargoId: getQueryParam(request, "cargoId") });

    return toggleOperatorCargoStatus({
      cargoId,
      operatorId,
      operatorAccessLevel,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveDeleteOperatorCargoResponse(request) {
  return withOperatorSession(
    request,
    "delete-cargo",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem alterar cargas.",
    },
    async ({ correlationId, requestIp, operatorId, operatorAccessLevel }) => {
    const { cargoId } = cargoIdParamsSchema.parse({ cargoId: getQueryParam(request, "cargoId") });

    return deleteOperatorCargo({
      cargoId,
      operatorId,
      operatorAccessLevel,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveCreateOperatorClienteResponse(request) {
  return withOperatorSession(
    request,
    "create-cliente",
    {
      requiredPermission: "clientes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem alterar embarcadores.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
    const payload = clienteMutationSchema.parse(await parseJsonBody(request));
    return createOperatorCliente({
      operatorId,
      payload,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveUpdateOperatorClienteResponse(request) {
  return withOperatorSession(
    request,
    "update-cliente",
    {
      requiredPermission: "clientes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem alterar embarcadores.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
    const { clienteId } = clienteIdParamsSchema.parse({ clienteId: getQueryParam(request, "clienteId") });

    const payload = clienteMutationSchema.parse(await parseJsonBody(request));
    return updateOperatorCliente({
      clienteId,
      operatorId,
      payload,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveDeleteOperatorClienteResponse(request) {
  return withOperatorSession(
    request,
    "delete-cliente",
    {
      requiredPermission: "clientes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem alterar embarcadores.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
    const { clienteId } = clienteIdParamsSchema.parse({ clienteId: getQueryParam(request, "clienteId") });

    return deleteOperatorCliente({
      clienteId,
      operatorId,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveListClienteRotasResponse(request) {
  return withOperatorSession(
    request,
    "list-cliente-rotas",
    {
      requiredPermission: "operator:read",
      forbiddenMessage: "Sem permissao para visualizar embarcadores.",
    },
    async ({ correlationId }) => {
      const { clienteId } = clienteIdParamsSchema.parse({
        clienteId: getQueryParam(request, "clienteId"),
      });
      return listClienteRotas({ clienteId, correlationId });
    },
  );
}

export async function resolveAttachClienteRotaResponse(request) {
  return withOperatorSession(
    request,
    "attach-cliente-rota",
    {
      requiredPermission: "clientes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem atrelar rotas a embarcadores.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
      const { clienteId } = clienteIdParamsSchema.parse({
        clienteId: getQueryParam(request, "clienteId"),
      });
      const body = attachClienteRotaBodySchema.parse(await parseJsonBody(request));
      return attachClienteRota({
        clienteId,
        rotaId: body.rotaId,
        operatorId,
        requestIp,
        correlationId,
      });
    },
  );
}

export async function resolveDetachClienteRotaResponse(request) {
  return withOperatorSession(
    request,
    "detach-cliente-rota",
    {
      requiredPermission: "clientes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem desatrelar rotas de embarcadores.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
      const { clienteId, rotaId } = clienteRotaParamsSchema.parse({
        clienteId: getQueryParam(request, "clienteId"),
        rotaId: getQueryParam(request, "rotaId"),
      });
      return detachClienteRota({
        clienteId,
        rotaId,
        operatorId,
        requestIp,
        correlationId,
      });
    },
  );
}

export async function resolveCreateOperatorRouteResponse(request) {
  return withOperatorSession(
    request,
    "create-route",
    {
      requiredPermission: "routes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem alterar rotas padrao.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
    const payload = routeMutationSchema.parse(await parseJsonBody(request));
    return createOperatorRoute({
      operatorId,
      payload,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveUpdateOperatorRouteResponse(request) {
  return withOperatorSession(
    request,
    "update-route",
    {
      requiredPermission: "routes:write",
      forbiddenMessage: "Somente operadores com acesso avancado podem alterar rotas padrao.",
    },
    async ({ correlationId, requestIp, operatorId }) => {
    const { routeId } = routeIdParamsSchema.parse({ routeId: getQueryParam(request, "routeId") });

    const payload = routeMutationSchema.parse(await parseJsonBody(request));
    return updateOperatorRoute({
      routeId,
      operatorId,
      payload,
      requestIp,
      correlationId,
    });
    },
  );
}

export async function resolveOperatorDashboardReadModelResponse(request) {
  return withOperatorSession(request, "read-operator-dashboard", async ({ correlationId }) => {
    // Opportunistic refresh — sync da planilha roda em background se snapshot
    // estiver stale (>7min). Stale-while-revalidate: serve dados atuais agora,
    // próxima request reflete o sync. Sem isso, operador vê cargas marcadas no
    // sheet como ainda OPEN por minutos/horas até o próximo tick periódico.
    await ensureDriverLoadsSheetFresh();
    const query = dashboardQuerySchema.parse(request.query || {});
    return fetchOperatorDashboardReadModel({
      query,
      correlationId,
    });
  });
}

export async function resolveOperatorCargoListReadModelResponse(request) {
  return withOperatorSession(request, "read-operator-cargas", async ({ correlationId }) => {
    await ensureDriverLoadsSheetFresh();
    return fetchOperatorCargoListReadModel({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveOperatorClientesListReadModelResponse(request) {
  return withOperatorSession(request, "read-operator-clientes", async ({ correlationId }) => {
    return fetchOperatorClientesListReadModel({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveOperatorRoutesListReadModelResponse(request) {
  return withOperatorSession(request, "read-operator-routes", async ({ correlationId }) => {
    return fetchOperatorRoutesListReadModel({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveUpdateOperatorDriverProfileResponse(request) {
  return withOperatorSession(
    request,
    "update-driver-profile",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem alterar perfis de motoristas.",
    },
    async ({ correlationId, requestIp, operatorId, user }) => {
      const { driverId } = driverIdParamsSchema.parse({ driverId: getQueryParam(request, "driverId") });

      const payload = driverProfileUpdateMutationSchema.parse(await parseJsonBody(request));

      // operational_blocked is a sensitive field — setting it requires advanced access level.
      if (payload.operational_blocked !== undefined) {
        assertOperatorAccessLevel(
          user,
          "advanced",
          "Somente operadores avancados podem bloquear motoristas operacionalmente.",
        );
      }

      return updateOperatorDriverProfile({
        driverId,
        operatorId,
        payload,
        requestIp,
        correlationId,
      });
    },
  );
}

export async function resolveOperatorDriversListReadModelResponse(request) {
  return withOperatorSession(request, "read-operator-drivers", async ({ correlationId }) => {
    return fetchOperatorDriversListReadModel({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveOperatorVehiclesListReadModelResponse(request) {
  return withOperatorSession(request, "read-operator-vehicles", async ({ correlationId }) => {
    return fetchOperatorVehiclesListReadModel({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveRevalidateAllVehiclesResponse(request) {
  return withOperatorSession(
    request,
    "revalidate-vehicles-angellira",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem revalidar veiculos.",
    },
    async ({ correlationId }) => {
      return revalidateAllVehiclesAngellira({ correlationId });
    },
  );
}

export async function resolveOperatorSheetSyncResponse(request) {
  return withOperatorSession(
    request,
    "sync-google-sheet-loads",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem atualizar cargas.",
    },
    async ({ correlationId }) => {
      const supabaseClient = createSupabaseAdminClient();
      const result = await syncGoogleSheetLoads({ supabaseClient });
      logStructuredEvent("info", "operator-admin.sheet-sync.requested", {
        correlationId,
        inserted: result?.inserted ?? null,
        updated: result?.updated ?? null,
      });
      return {
        statusCode: 200,
        payload: {
          ok: true,
          ...result,
          meta: { correlationId },
        },
      };
    },
  );
}

export async function resolveOperatorAuditLogsResponse(request) {
  return withOperatorSession(request, "read-operator-audit-logs", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(
      user,
      "advanced",
      "Apenas operadores com acesso avancado podem consultar os logs de auditoria.",
    );
    return fetchOperatorAuditLogsReadModel({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveOperatorDriverFlowMetricsResponse(request) {
  return withOperatorSession(request, "read-driver-flow-metrics", async ({ correlationId }) => {
    return fetchDriverFlowMetrics({
      query: request.query || {},
      correlationId,
    });
  });
}

export async function resolveSheetMonitorResponse(request) {
  return withOperatorSession(request, "sheet-monitor", async ({ correlationId }) => {
    const supabaseClient = createSupabaseAdminClient();
    const refresh = getQueryParam(request, "refresh") === "true";
    const emptySummary = { total: 0, available: 0, assigned: 0, withStatus: 0, statuses: {}, tipos: {} };

    // ----------------------------------------------------------------
    // REFRESH path: operator explicitly asked for a fresh sync.
    // Fetch CSV → parse all rows → save to DB → return parsed rows IMMEDIATELY
    // (no second round-trip to the DB — data is available right now).
    // ----------------------------------------------------------------
    if (refresh) {
      const { getSheetExportUrl, fetchGoogleSheetCsv, updateSheetMonitorSnapshot } =
        await import("../../../application/google-sheets/google-sheet-loads.js");

      const sheetUrl = getSheetExportUrl();

      if (!sheetUrl) {
        logStructuredEvent("warn", "sheet-monitor.refresh-skipped", {
          correlationId,
          reason: "GOOGLE_SHEET_ID_NOT_CONFIGURED",
        });
      } else {
        try {
          const csvText = await fetchGoogleSheetCsv(globalThis.fetch, sheetUrl);
          const { rows, summary, syncedAt, persisted, persistError } =
            await updateSheetMonitorSnapshot({ csvText, supabaseClient });

          if (persisted) {
            logStructuredEvent("info", "sheet-monitor.snapshot-refreshed", {
              correlationId,
              rowCount: rows.length,
            });
          } else {
            logStructuredEvent("error", "sheet-monitor.snapshot-save-failed", {
              correlationId,
              rowCount: rows.length,
              code: persistError?.code ?? null,
              message: persistError?.message ?? null,
              hint: persistError?.hint ?? null,
            });
          }

          // Return the freshly-parsed rows immediately — no extra DB read needed.
          return {
            statusCode: 200,
            payload: {
              items: rows,
              summary,
              meta: {
                correlationId,
                sheetConfigured: true,
                cachedAt: syncedAt,
                snapshotSaved: persisted,
                ...(persistError
                  ? { snapshotSaveError: persistError.message }
                  : {}),
              },
            },
          };
        } catch (refreshError) {
          logStructuredEvent("error", "sheet-monitor.refresh-failed", {
            correlationId,
            message: refreshError instanceof Error ? refreshError.message : String(refreshError),
          });
          // Refresh failed — fall through to serve whatever is cached in the DB.
        }
      }
    }

    // ----------------------------------------------------------------
    // READ path: always from the DB snapshot — never hits Google Sheets.
    // ----------------------------------------------------------------
    let snapshot = null;
    try {
      const { data, error } = await supabaseClient
        .from("sheet_monitor_snapshot")
        .select("rows_json, summary_json, synced_at")
        .eq("id", 1)
        .maybeSingle();

      if (error) {
        logStructuredEvent("error", "sheet-monitor.snapshot-read-failed", {
          correlationId,
          code: error.code,
          message: error.message,
        });
      } else {
        snapshot = data;
      }
    } catch (dbError) {
      logStructuredEvent("error", "sheet-monitor.db-error", {
        correlationId,
        message: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }

    if (snapshot) {
      // Read enriched data in parallel — non-fatal if missing
      let enrichedByLh = {};
      try {
        const { data: enrichedRows } = await supabaseClient
          .from("sheet_monitor_enriched")
          .select("*")
          .limit(50000);
        if (enrichedRows) {
          for (const r of enrichedRows) enrichedByLh[r.lh] = r;
        }
      } catch (enrichErr) {
        logStructuredEvent("warn", "sheet-monitor.enrich-read-failed", {
          correlationId,
          message: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
        });
      }

      return {
        statusCode: 200,
        payload: {
          items: snapshot.rows_json ?? [],
          summary: snapshot.summary_json ?? emptySummary,
          enrichedByLh,
          meta: {
            correlationId,
            sheetConfigured: true,
            cachedAt: snapshot.synced_at,
          },
        },
      };
    }

    // No snapshot yet (first use or migration pending).
    // Return empty state — not an error. Frontend shows "Clique em Atualizar planilha".
    const { getSheetExportUrl: getUrl } = await import("../../../application/google-sheets/google-sheet-loads.js");
    return {
      statusCode: 200,
      payload: {
        items: [],
        summary: emptySummary,
        meta: {
          correlationId,
          sheetConfigured: Boolean(getUrl()),
          noSnapshot: true,
        },
      },
    };
  });
}

export async function resolveSheetMonitorRowDetailResponse(request) {
  return withOperatorSession(request, "sheet-monitor-row-detail", async ({ correlationId }) => {
    const lh = getQueryParam(request, "lh")?.trim();

    if (!lh) {
      return { statusCode: 400, payload: { error: "MISSING_LH", message: "Query param 'lh' is required." } };
    }

    const supabaseClient = createSupabaseAdminClient();

    // 1. Find row in snapshot
    let row = null;
    try {
      const { data: snapshot, error } = await supabaseClient
        .from("sheet_monitor_snapshot")
        .select("rows_json")
        .eq("id", 1)
        .maybeSingle();
      if (error) {
        logStructuredEvent("warn", "sheet-monitor-row-detail.snapshot-error", { correlationId, message: error.message });
      } else if (snapshot?.rows_json) {
        row = snapshot.rows_json.find((r) => r.lh === lh) ?? null;
      }
    } catch (e) {
      logStructuredEvent("warn", "sheet-monitor-row-detail.snapshot-fetch-error", { correlationId, message: e instanceof Error ? e.message : String(e) });
    }

    if (!row) {
      return { statusCode: 404, payload: { error: "ROW_NOT_FOUND", message: `LH '${lh}' nao encontrado no snapshot.` } };
    }

    // 2. Lookup driver by name in driver_profiles
    const driverName = (row.motoristas || "").trim();
    let driverProfiles = [];

    if (driverName) {
      try {
        const { data: profiles, error } = await supabaseClient
          .from("driver_profiles")
          .select("user_id, full_name, document_number, vehicle_profile, documents_valid, antt_valid, insurance_valid, tracking_enabled, angellira_status, angellira_valid_until, angellira_status_text, angellira_details")
          .ilike("full_name", `%${driverName}%`)
          .limit(5);
        if (!error && profiles) driverProfiles = profiles;
      } catch (e) {
        logStructuredEvent("warn", "sheet-monitor-row-detail.driver-lookup-error", { correlationId, message: e instanceof Error ? e.message : String(e) });
      }
    }

    // 3. Lookup vehicles by plate in DB
    const normPl = (p) => (p || "").replace(/[\s\-.]/g, "").toUpperCase();
    const cavaloPl = normPl(row.cavalo);
    const carretaPl = normPl(row.carreta);
    const platesToLookup = [...new Set([cavaloPl, carretaPl].filter(Boolean))];

    const vehiclesByPlate = {};
    if (platesToLookup.length > 0) {
      try {
        const { data: vehicles, error } = await supabaseClient
          .from("vehicles")
          .select("plate, vehicle_type, plate_role, angellira_status, angellira_valid_until, angellira_status_text, angellira_display_name, angellira_details, linked_driver_cpf, updated_at")
          .in("plate", platesToLookup);
        if (!error && vehicles) {
          for (const v of vehicles) vehiclesByPlate[v.plate] = { ...v, source: "db" };
        }
      } catch (e) {
        logStructuredEvent("warn", "sheet-monitor-row-detail.vehicle-db-error", { correlationId, message: e instanceof Error ? e.message : String(e) });
      }
    }

    // 4. Angellira fallback for plates not in DB
    const missingPlates = platesToLookup.filter((p) => !vehiclesByPlate[p]);
    for (const plate of missingPlates) {
      try {
        const { lookupAngelliraPlate } = await import("../../../infrastructure/angellira/angellira-client.js");
        const result = await lookupAngelliraPlate(plate);
        vehiclesByPlate[plate] = { plate, source: "angellira", ...result };
      } catch (e) {
        logStructuredEvent("warn", "sheet-monitor-row-detail.angellira-error", { correlationId, plate, message: e instanceof Error ? e.message : String(e) });
        vehiclesByPlate[plate] = { plate, source: "not_found" };
      }
    }

    return {
      statusCode: 200,
      payload: {
        row,
        driver: {
          queried: Boolean(driverName),
          searchName: driverName || null,
          profiles: driverProfiles,
        },
        vehicles: {
          cavalo: cavaloPl ? (vehiclesByPlate[cavaloPl] ?? { plate: cavaloPl, source: "not_found" }) : null,
          carreta: carretaPl ? (vehiclesByPlate[carretaPl] ?? { plate: carretaPl, source: "not_found" }) : null,
        },
        meta: { correlationId },
      },
    };
  });
}

export async function resolveSheetMonitorEnrichResponse(request) {
  return withOperatorSession(request, "sheet-monitor-enrich", async ({ correlationId }) => {
    const force = getQueryParam(request, "force") === "true";
    const forceSessionStart = getQueryParam(request, "forceSessionStart") || null;
    const supabaseClient = createSupabaseAdminClient();
    const { enrichSheetMonitorRows } = await import("../../../application/operator-admin/sheet-monitor-enrichment.js");
    const result = await enrichSheetMonitorRows(supabaseClient, correlationId, { force, forceSessionStart });
    return { statusCode: 200, payload: result };
  });
}

export async function resolveRedactPublicLeadPiiResponse(request) {
  return withOperatorSession(
    request,
    "redact-public-lead-pii",
    {
      requiredPermission: "cargos:write",
      forbiddenMessage: "Somente operadores com acesso intermediario ou avancado podem executar a redacao de PII.",
    },
    async ({ correlationId }) => {
      const retentionDays =
        Number.parseInt(getQueryParam(request, "retentionDays") || "", 10) ||
        Number.parseInt(process.env.PUBLIC_LEAD_PII_RETENTION_DAYS || "", 10) ||
        30;
      const batchSize =
        Number.parseInt(getQueryParam(request, "batchSize") || "", 10) ||
        Number.parseInt(process.env.PUBLIC_LEAD_PII_REDACTION_BATCH_SIZE || "", 10) ||
        50;

      const result = await redactExpiredPublicLeadPii({
        batchSize,
        retentionDays,
        correlationId,
      });

      return {
        statusCode: 200,
        payload: {
          ok: true,
          ...result,
        },
      };
    },
  );
}


export async function resolveDriverSponsorClicksResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    await requireOperatorSession(getAuthorizationHeader(request));

    const rows = await withPgClient(async (client) => {
      const result = await client.query(`
        SELECT data->>'brand' AS brand, COUNT(*)::int AS clicks
        FROM public.analytics_events
        WHERE event_type = 'SPONSOR_CLICK'
          AND created_at >= now() - interval '30 days'
        GROUP BY data->>'brand'
        ORDER BY clicks DESC
        LIMIT 20
      `);
      return result.rows;
    });

    return {
      statusCode: 200,
      payload: {
        items: rows,
        meta: { correlationId },
      },
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { statusCode: 401, payload: { error: "UNAUTHORIZED", meta: { correlationId } } };
    }
    return { statusCode: 500, payload: { error: "INTERNAL_ERROR", meta: { correlationId } } };
  }
}

// Cheap "did anything change?" probe for the operator Overview dashboard.
// Returns a digest derived from MAX(updated_at) + counts across cargas, leads, claims.
// Frontend polls this every 5 min — when digest changes, invalidate the
// expensive 3x select(500) overview query. Realtime is the primary trigger;
// this digest is the safety net for missed events (network drops, etc.).
export async function resolveOperatorOverviewDigestResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    await requireOperatorSession(getAuthorizationHeader(request));

    const digest = await withPgClient(async (client) => {
      const { rows } = await client.query(`
        SELECT
          (SELECT COALESCE(EXTRACT(EPOCH FROM MAX(updated_at))::bigint, 0) FROM public.cargas)            AS cargas_ts,
          (SELECT COUNT(*)::bigint FROM public.cargas)                                                    AS cargas_count,
          (SELECT COALESCE(EXTRACT(EPOCH FROM MAX(created_at))::bigint, 0) FROM public.load_public_leads) AS leads_ts,
          (SELECT COUNT(*)::bigint FROM public.load_public_leads)                                         AS leads_count,
          (SELECT COALESCE(EXTRACT(EPOCH FROM MAX(created_at))::bigint, 0) FROM public.load_claims)       AS claims_ts,
          (SELECT COUNT(*)::bigint FROM public.load_claims)                                               AS claims_count
      `);
      const r = rows[0] || {};
      return `${r.cargas_ts}:${r.cargas_count}:${r.leads_ts}:${r.leads_count}:${r.claims_ts}:${r.claims_count}`;
    });

    return {
      statusCode: 200,
      payload: { digest, meta: { correlationId } },
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { statusCode: 401, payload: { error: "UNAUTHORIZED", meta: { correlationId } } };
    }
    return { statusCode: 500, payload: { error: "INTERNAL_ERROR", meta: { correlationId } } };
  }
}

// ─── Cadastros pendentes de motoristas ───────────────────────────────────────

/**
 * GET /api/operator/cadastros-pendentes?status=pendente&page=1&pageSize=20
 */
export async function resolveOperatorCadastrosPendentesResponse(request) {
  return withOperatorSession(request, "read-cadastros-pendentes", async ({ correlationId }) => {
    const query = request.query || {};
    return fetchPendingDriverRegistrations({
      status: typeof query.status === "string" ? query.status.trim() : null,
      page: query.page,
      pageSize: query.pageSize,
      correlationId,
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/aprovar
 * Cria usuário Supabase Auth (driver) + insere em driver_profiles + atualiza status.
 */
export async function resolveOperatorAprovarCadastroResponse(request) {
  return withOperatorSession(request, "aprovar-cadastro", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(
      user,
      "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem aprovar cadastros.",
    );

    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }

    return withPgClient(async (client) => {
      // 1. Busca o registro pendente
      const { rows } = await client.query(
        `SELECT id, id_cadastro, status, dados FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      const registro = rows[0];
      if (registro.status === "aprovado") {
        return { statusCode: 409, payload: { error: "Conflict", message: "Cadastro já foi aprovado.", meta: { correlationId } } };
      }

      // 2. Extrai dados do motorista
      const motorista = registro.dados?.motorista || {};
      const nome = String(motorista.nome || "").trim();
      const cpfClean = String(motorista.cpf || "").replace(/\D/g, "");
      const telefone = String(motorista.telefones?.[0] || motorista.telefone || "").replace(/\D/g, "") || null;

      if (!cpfClean) {
        return { statusCode: 422, payload: { error: "ValidationError", message: "CPF do motorista ausente nos dados do cadastro.", meta: { correlationId } } };
      }

      // 3. Cria usuário Supabase Auth (driver auth client)
      const adminClient = getAdminClient();
      const email = `${cpfClean}@motorista.lmc.internal`;
      const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
        email,
        password: crypto.randomUUID(),
        email_confirm: true,
        user_metadata: {
          role: "driver",
          source: "cadastro-operador",
          full_name: nome,
          cpf: cpfClean,
        },
      });

      if (authError) {
        // Já existe: retorna 409 para que o operador saiba
        if (authError.status === 422 || /already registered/i.test(authError.message || "")) {
          return { statusCode: 409, payload: { error: "Conflict", message: `Email ${email} já registrado. Motorista pode já ter conta.`, meta: { correlationId } } };
        }
        throw authError;
      }

      const driverId = authData.user.id;

      // 4. Insere driver_profile
      const cavaloPlaca = String(registro.dados?.cavalo?.placa || "").trim() || null;
      const vehicleProfile = cavaloPlaca ? "cavalo" : null;

      await client.query(
        `
          INSERT INTO public.driver_profiles (
            user_id, full_name, phone, document_number,
            vehicle_profile, active, documents_valid
          )
          VALUES ($1, $2, $3, $4, $5, true, true)
          ON CONFLICT (user_id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            phone = EXCLUDED.phone,
            document_number = EXCLUDED.document_number,
            vehicle_profile = EXCLUDED.vehicle_profile,
            documents_valid = EXCLUDED.documents_valid,
            updated_at = now()
        `,
        [driverId, nome || null, telefone, cpfClean, vehicleProfile],
      );

      // 5. Atualiza registro para aprovado
      await client.query(
        `UPDATE public.pending_driver_registrations
         SET status = 'aprovado', reviewed_at = now(), reviewed_by_id = $1
         WHERE id = $2`,
        [operatorId, id],
      );

      // 6. Audit log
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.approved",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "pending_driver_registration",
        resourceId: id,
        action: "approve",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { driverId, cpf: cpfClean, nome },
      });

      return {
        statusCode: 200,
        payload: { ok: true, driverId, meta: { correlationId } },
      };
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/rejeitar
 * Body: { observacoes?: string }
 */
export async function resolveOperatorRejeitarCadastroResponse(request) {
  return withOperatorSession(request, "rejeitar-cadastro", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(
      user,
      "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem rejeitar cadastros.",
    );

    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }

    let body = {};
    try {
      body = await parseJsonBody(request);
    } catch {
      // body is optional
    }
    const observacoes = typeof body?.observacoes === "string" ? body.observacoes.trim().slice(0, 1000) : null;

    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, status FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      if (rows[0].status === "rejeitado") {
        return { statusCode: 409, payload: { error: "Conflict", message: "Cadastro já foi rejeitado.", meta: { correlationId } } };
      }

      await client.query(
        `UPDATE public.pending_driver_registrations
         SET status = 'rejeitado', observacoes = $1, reviewed_at = now(), reviewed_by_id = $2
         WHERE id = $3`,
        [observacoes, operatorId, id],
      );

      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.rejected",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "pending_driver_registration",
        resourceId: id,
        action: "reject",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { observacoes },
      });

      return {
        statusCode: 200,
        payload: { ok: true, meta: { correlationId } },
      };
    });
  });
}
