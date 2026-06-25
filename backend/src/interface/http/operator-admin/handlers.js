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
  fetchOperatorCargoListReadModel,
  fetchOperatorClientesListReadModel,
  fetchOperatorDriversListReadModel,
  fetchOperatorRoutesListReadModel,
  fetchOperatorVehiclesListReadModel,
} from "../../../application/operator-admin/read-models.js";
import { fetchOperatorAuditLogsReadModel } from "../../../application/operator-admin/use-cases/audit-logs-read-model.js";
import { fetchPendingDriverRegistrations } from "../../../application/operator-admin/use-cases/pending-driver-registrations-read-model.js";
import { listDraftRegistrations } from "../../../application/operator-admin/use-cases/list-draft-registrations.js";
import { submitDraftAsOperator } from "../../../application/operator-admin/use-cases/submit-draft-as-operator.js";
import { DOC_TIPOS, listAvailableMigratedDocs, readLocalProdDocAsDataUri } from "../../../application/operator-admin/use-cases/migrated-docs/prod-docs-share.js";
import { candidaturaSubmitSchema } from "../schemas/candidatura-schemas.js";
import { DRAFT_FILE_BUCKET } from "../../../application/candidatura/use-cases/upload-draft-file.js";
import { ensureDriverLoadsSheetFresh } from "../public-loads/handlers.js";
import { fetchDriverFlowMetrics } from "../../../domain/operator-admin/driver-flow-metrics.js";
import {
  ForbiddenError,
  LoadClaimServiceError,
  UnauthorizedError,
} from "../../../domain/load-claims/errors.js";
import { assertOperatorAccessLevel, assertOperatorPermission, hasOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { getAdminClient, requireOperatorSession } from "../../../application/load-claims/auth.js";
import { syncGoogleSheetLoads } from "../../../application/google-sheets/google-sheet-loads.js";
import { createSupabaseAdminClient } from "../../../infrastructure/supabase/admin-client.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";

const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const MAX_IDEMPOTENCY_CACHE_SIZE = 5_000;
const idempotencyCache = new Map();

function checkIdempotencyCache(key) {
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry.response;
}

function setIdempotencyCache(key, response) {
  if (idempotencyCache.size >= MAX_IDEMPOTENCY_CACHE_SIZE) {
    // Sweep completo de expirados antes de fallback FIFO — corrige bug em que
    // break prematuro mantinha o cache cheio e degradava em FIFO eviction logo
    // após o primeiro overflow.
    const now = Date.now();
    let evicted = 0;
    for (const [k, v] of idempotencyCache) {
      if (v.expiresAt <= now) {
        idempotencyCache.delete(k);
        evicted += 1;
      }
    }
    // Fallback FIFO apenas se sweep não liberou espaço suficiente — garante
    // bounded memory mesmo sob alta taxa de chaves não-expiradas.
    if (evicted === 0) {
      idempotencyCache.delete(idempotencyCache.keys().next().value);
    }
  }
  idempotencyCache.set(key, { response, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
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
      const cachedResponse = checkIdempotencyCache(cacheKey);
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
      setIdempotencyCache(cacheKey, response);
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

async function readSheetMonitorEnrichedByLh(supabaseClient, correlationId) {
  const enrichedByLh = {};
  try {
    // PostgREST caps responses at 1000 rows server-side (.limit is clamped), so
    // a single select would silently drop every enriched row past the first 1000
    // — leaving thousands of rows showing "Consulta Angellira/ASPX pendente" in
    // the Monitor even with good data. Paginate by range to fetch the full set.
    const PAGE_SIZE = 1000;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: enrichedRows, error } = await supabaseClient
        .from("sheet_monitor_enriched")
        .select("*")
        .order("lh", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!enrichedRows || enrichedRows.length === 0) break;
      for (const r of enrichedRows) enrichedByLh[r.lh] = r;
      if (enrichedRows.length < PAGE_SIZE) break;
    }
  } catch (enrichErr) {
    logStructuredEvent("warn", "sheet-monitor.enrich-read-failed", {
      correlationId,
      message: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
    });
  }
  return enrichedByLh;
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

          // Return the freshly-parsed rows immediately. Still attach the enriched
          // map from the DB — otherwise setQueryData() on the client would replace
          // the cached payload with one that has no enrichedByLh, blanking every
          // row to "Consulta Angellira/ASPX pendente" until the next read.
          const enrichedByLh = await readSheetMonitorEnrichedByLh(supabaseClient, correlationId);
          return {
            statusCode: 200,
            payload: {
              items: rows,
              summary,
              enrichedByLh,
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
      // Read enriched data — non-fatal if missing
      const enrichedByLh = await readSheetMonitorEnrichedByLh(supabaseClient, correlationId);

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
 * GET /api/operator/cadastros/rascunhos?page=1&pageSize=50
 * Lista rascunhos em andamento (status=draft) para o operador resgatar.
 */
export async function resolveOperatorListDraftRegistrationsResponse(request) {
  return withOperatorSession(request, "list-draft-registrations", async ({ correlationId }) => {
    const query = request.query || {};
    return listDraftRegistrations({
      page: query.page,
      pageSize: query.pageSize,
      correlationId,
    });
  });
}

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

    // Body opcional: { jobs: ['angellira'] } — disparo automático de cadastro
    // externo após criar conta. DC-111 / Sprint 1.
    let body = {};
    try {
      body = await parseJsonBody(request);
    } catch {
      // body opcional — segue sem disparo automatico
    }
    const requestedJobs = Array.isArray(body?.jobs)
      ? body.jobs.filter((j) => typeof j === "string").map((j) => j.toLowerCase().trim())
      : [];
    const shouldDispatchAngellira = requestedJobs.includes("angellira");
    const shouldDispatchSpx = requestedJobs.includes("spx");

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
        app_metadata: {
          role: "driver",
          source: "cadastro-operador",
        },
        user_metadata: {
          role: "driver",
          source: "cadastro-operador",
          full_name: nome,
          cpf: cpfClean,
        },
      });

      let driverId;
      if (authError) {
        // Motorista já tem conta (mesmo CPF aprovado anteriormente).
        // Re-aprovação: reutiliza o usuário existente em vez de bloquear.
        if (authError.status === 422 || /already registered/i.test(authError.message || "")) {
          // Usa query direta em auth.users (listUsers() pagina a 50 e perde usuários)
          const { rows: existingRows } = await client.query(
            `SELECT id FROM auth.users WHERE email = $1`,
            [email],
          );
          if (!existingRows.length) {
            return { statusCode: 409, payload: { error: "Conflict", message: `Email ${email} já registrado mas usuário não encontrado. Contate o suporte.`, meta: { correlationId } } };
          }
          driverId = existingRows[0].id;
        } else {
          throw authError;
        }
      } else {
        driverId = authData.user.id;
      }

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
        metadata: { driverId, cpf: cpfClean, nome, jobs: requestedJobs },
      });

      // 7. Opcional: dispara pipelines externos (DC-111 / Sprint 1)
      let angellira = null;
      if (shouldDispatchAngellira) {
        angellira = await dispatchAngelliraFromApprove({
          client, cadastroRegistro: registro, driverId, operatorId, correlationId,
        });
      }
      let spx = null;
      if (shouldDispatchSpx) {
        spx = await dispatchSpxFromApprove({
          client, cadastroRegistro: registro, driverId, operatorId, correlationId,
        });
      }

      return {
        statusCode: 200,
        payload: {
          ok: true,
          driverId,
          jobs: requestedJobs,
          angellira,
          spx,
          meta: { correlationId },
        },
      };
    });
  });
}

/**
 * Helper interno: dispara o pipeline Angellira logo após o aprovar.
 *
 * Executa síncrono com timeout suave — o tempo médio é ~30-60s (4 chamadas
 * HTTPS) e a UI granular precisa do snapshot final pra renderizar status.
 */
async function dispatchAngelliraFromApprove({ client, cadastroRegistro, driverId, operatorId, correlationId }) {
  // Import dinâmico evita ciclo de imports e mantém handler carregável mesmo
  // se o módulo angellira não estiver pronto em algum ambiente de teste.
  const { runAngelliraPipeline } = await import(
    "../../../application/operator-admin/use-cases/angellira/dispatch-pipeline.js"
  );
  try {
    const result = await runAngelliraPipeline({
      client,
      cadastro: cadastroRegistro,
      driverUserId: driverId,
      operatorId,
      correlationId,
    });
    return {
      ok: result.ok,
      results: result.results.map(({ step, status, external_id, error }) => ({
        step, status, external_id: external_id ?? null, error: error ?? null,
      })),
    };
  } catch (err) {
    logStructuredEvent("error", "operator.cadastro.angellira_dispatch_failed", {
      cadastroId: cadastroRegistro.id,
      driverId,
      correlationId,
      message: err?.message || String(err),
    });
    return {
      ok: false,
      error: {
        code: "PIPELINE_FATAL",
        message: err?.message || "Falha inesperada ao executar pipeline Angellira",
      },
      results: [],
    };
  }
}

/** Helper: dispara pipeline SPX após o aprovar quando 'spx' está em jobs[] */
async function dispatchSpxFromApprove({ client, cadastroRegistro, driverId, operatorId, correlationId }) {
  const { runSpxPipeline } = await import(
    "../../../application/operator-admin/use-cases/spx/dispatch-pipeline.js"
  );
  try {
    const result = await runSpxPipeline({
      client, cadastro: cadastroRegistro, driverUserId: driverId,
      operatorId, correlationId,
    });
    return {
      ok: result.ok,
      results: result.results.map(({ step, status, external_id, error }) => ({
        step, status, external_id: external_id ?? null, error: error ?? null,
      })),
    };
  } catch (err) {
    logStructuredEvent("error", "operator.cadastro.spx_dispatch_failed", {
      cadastroId: cadastroRegistro.id, driverId, correlationId,
      message: err?.message || String(err),
    });
    return {
      ok: false,
      error: {
        code: "SPX_PIPELINE_FATAL",
        message: err?.message || "Falha inesperada ao executar pipeline SPX",
      },
      results: [],
    };
  }
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

// ─────────────────────────────────────────────────────────────────────────
// Angellira — endpoints granulares para o painel do operador (DC-117).
//
// Servem ao painel <ExternalRegistrationPanel /> em /motoristas:
//   - precheck      → consulta vigência + check_owner
//   - check-owner   → wrapper passivo (sem cadastrar)
//   - cadastrar     → dispara pipeline completo
//   - cadastrar/:step → re-tentativa de uma etapa
//   - external-jobs → lista jobs do cadastro (audit log)
// ─────────────────────────────────────────────────────────────────────────

async function loadCadastroAprovado(client, cadastroId) {
  const { rows } = await client.query(
    `SELECT id, status, dados FROM public.pending_driver_registrations WHERE id = $1`,
    [cadastroId],
  );
  return rows[0] || null;
}

/**
 * POST /api/operator/cadastros/:id/angellira/precheck
 * Body opcional: { include_check_owner: true }
 * Retorna: { motorista: {...}, cavalo?: {...}, carreta?: {...}, check_owner?: {...} }
 */
export async function resolveOperatorAngelliraPrecheckResponse(request) {
  return withOperatorSession(request, "angellira-precheck", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(
      user, "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem consultar Angellira.",
    );
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }

    return withPgClient(async (client) => {
      const cadastro = await loadCadastroAprovado(client, id);
      if (!cadastro) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }

      const { performAngelliraPrecheck } = await import(
        "../../../application/operator-admin/use-cases/angellira/precheck.js"
      );
      const result = await performAngelliraPrecheck({ cadastro, correlationId });
      return { statusCode: 200, payload: { ok: true, ...result, meta: { correlationId } } };
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/angellira/check-owner
 * Body: { placa, expected_cpf?, expected_cnpj?, expected_tipo? }
 */
export async function resolveOperatorAngelliraCheckOwnerResponse(request) {
  return withOperatorSession(request, "angellira-check-owner", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }
    let body = {};
    try { body = await parseJsonBody(request); } catch {}
    const placa = String(body?.placa || "").trim().toUpperCase();
    if (!placa) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "Campo 'placa' é obrigatório.", meta: { correlationId } } };
    }

    const { checkOwner } = await import(
      "../../../infrastructure/cadastro-bots/angellira-bot-client.js"
    );
    try {
      const result = await checkOwner({
        placa,
        expectedCpf: body.expected_cpf || "",
        expectedCnpj: body.expected_cnpj || "",
        expectedTipo: body.expected_tipo || "",
        correlationId,
      });
      return { statusCode: 200, payload: { ok: true, result, meta: { correlationId } } };
    } catch (err) {
      const errJson = typeof err?.toJSON === "function" ? err.toJSON() : { message: err?.message };
      return { statusCode: 502, payload: { error: "BotError", ...errJson, meta: { correlationId } } };
    }
  });
}

/**
 * POST /api/operator/cadastros/:id/angellira/cadastrar
 * Dispara o pipeline completo (proprietario → cavalo → carreta → motorista).
 */
export async function resolveOperatorAngelliraCadastrarResponse(request) {
  return withOperatorSession(request, "angellira-cadastrar", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }

    return withPgClient(async (client) => {
      const cadastro = await loadCadastroAprovado(client, id);
      if (!cadastro) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      if (cadastro.status !== "aprovado") {
        return {
          statusCode: 409,
          payload: { error: "Conflict", message: "Cadastro precisa ter sido aprovado antes (driver_profile inexistente).", meta: { correlationId } },
        };
      }

      // Recupera driver_user_id a partir do CPF (foi criado no /aprovar)
      const cpfClean = String(cadastro.dados?.motorista?.cpf || "").replace(/\D/g, "");
      const { rows: dpRows } = await client.query(
        `SELECT user_id FROM public.driver_profiles WHERE document_number = $1 LIMIT 1`,
        [cpfClean],
      );
      const driverUserId = dpRows[0]?.user_id || null;

      const { runAngelliraPipeline } = await import(
        "../../../application/operator-admin/use-cases/angellira/dispatch-pipeline.js"
      );
      const result = await runAngelliraPipeline({
        client, cadastro, driverUserId, operatorId, correlationId,
      });

      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.angellira_dispatched",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: id,
        action: "angellira_dispatch", outcome: result.ok ? "success" : "partial",
        requestIp, correlationId,
        metadata: { steps: result.results.map((r) => ({ step: r.step, status: r.status })) },
      });

      return { statusCode: 200, payload: { ok: result.ok, results: result.results, meta: { correlationId } } };
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/angellira/cadastrar/:step
 * Re-tenta uma única etapa (proprietario_cavalo|cavalo|proprietario_carreta|carreta|motorista).
 */
export async function resolveOperatorAngelliraCadastrarStepResponse(request) {
  return withOperatorSession(request, "angellira-cadastrar-step", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    const step = getQueryParam(request, "step");
    const ALLOWED_STEPS = ["proprietario_cavalo", "cavalo", "proprietario_carreta", "carreta", "motorista"];
    if (!id || !step) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID e step são obrigatórios.", meta: { correlationId } } };
    }
    if (!ALLOWED_STEPS.includes(step)) {
      return { statusCode: 400, payload: { error: "BadRequest", message: `Step inválido. Use um de: ${ALLOWED_STEPS.join(", ")}.`, meta: { correlationId } } };
    }

    return withPgClient(async (client) => {
      const cadastro = await loadCadastroAprovado(client, id);
      if (!cadastro) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      const cpfClean = String(cadastro.dados?.motorista?.cpf || "").replace(/\D/g, "");
      const { rows: dpRows } = await client.query(
        `SELECT user_id FROM public.driver_profiles WHERE document_number = $1 LIMIT 1`,
        [cpfClean],
      );
      const driverUserId = dpRows[0]?.user_id || null;

      const { runAngelliraPipeline } = await import(
        "../../../application/operator-admin/use-cases/angellira/dispatch-pipeline.js"
      );
      const result = await runAngelliraPipeline({
        client, cadastro, driverUserId, operatorId, correlationId, onlySteps: [step],
      });

      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.angellira_retry_step",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: id,
        action: "angellira_retry_step", outcome: result.ok ? "success" : "failure",
        requestIp, correlationId,
        metadata: { step },
      });

      return { statusCode: 200, payload: { ok: result.ok, results: result.results, meta: { correlationId } } };
    });
  });
}

/**
 * GET /api/operator/cadastros/:id/external-jobs
 * Lista todos os jobs externos do cadastro (angellira/spx/unificada) — audit log.
 */
export async function resolveOperatorListExternalJobsResponse(request) {
  return withOperatorSession(request, "list-external-jobs", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { listJobsByCadastro } = await import(
        "../../../application/operator-admin/use-cases/angellira/jobs-repository.js"
      );
      const jobs = await listJobsByCadastro({ client, cadastroId: id });
      return { statusCode: 200, payload: { ok: true, jobs, meta: { correlationId } } };
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SPX (Shopee Express) — endpoints granulares (DC-111 / extensão SPX)
//
// Servem ao painel <ExternalRegistrationPanel /> em /motoristas:
//   - precheck       → consulta CPF no portal (read-only)
//   - cadastrar      → dispara pipeline SPX (lookup → cadastrar/importar)
//   - cadastrar/motorista → re-tentativa do step único (compat com Angellira)
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /api/operator/cadastros/:id/spx/precheck
 * Retorna { status: NOT_FOUND | IS_MATCHED_NOSSA | IS_MATCHED_OUTRA |
 *           REQUEST_PENDENTE | BLOQUEADO | UNAVAILABLE, ... }
 */
export async function resolveOperatorSpxPrecheckResponse(request) {
  return withOperatorSession(request, "spx-precheck", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const cadastro = await loadCadastroAprovado(client, id);
      if (!cadastro) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      const { performSpxPrecheck } = await import(
        "../../../application/operator-admin/use-cases/spx/precheck.js"
      );
      const result = await performSpxPrecheck({ cadastro, correlationId });
      return { statusCode: 200, payload: { ok: result.ok, ...result, meta: { correlationId } } };
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/spx/cadastrar
 * Dispara pipeline SPX (precheck → cadastrar/importar). Body opcional:
 *   { overrides: { linehaul_station_name, vehicle_type_name, ... } }
 */
export async function resolveOperatorSpxCadastrarResponse(request) {
  return withOperatorSession(request, "spx-cadastrar", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }
    let body = {};
    try { body = await parseJsonBody(request); } catch {}

    return withPgClient(async (client) => {
      const cadastro = await loadCadastroAprovado(client, id);
      if (!cadastro) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      if (cadastro.status !== "aprovado") {
        return {
          statusCode: 409,
          payload: { error: "Conflict", message: "Cadastro precisa ter sido aprovado antes.", meta: { correlationId } },
        };
      }
      const cpfClean = String(cadastro.dados?.motorista?.cpf || "").replace(/\D/g, "");
      const { rows: dpRows } = await client.query(
        `SELECT user_id FROM public.driver_profiles WHERE document_number = $1 LIMIT 1`,
        [cpfClean],
      );
      const driverUserId = dpRows[0]?.user_id || null;

      const { runSpxPipeline } = await import(
        "../../../application/operator-admin/use-cases/spx/dispatch-pipeline.js"
      );
      const result = await runSpxPipeline({
        client, cadastro, driverUserId, operatorId, correlationId,
        overrides: body?.overrides || {},
      });

      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.spx_dispatched",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: id,
        action: "spx_dispatch", outcome: result.ok ? "success" : "failure",
        requestIp, correlationId,
        metadata: { steps: result.results.map((r) => ({ step: r.step, status: r.status })) },
      });

      return { statusCode: 200, payload: { ok: result.ok, results: result.results, meta: { correlationId } } };
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/unificada/gerar-pdf
 * Gera (ou reusa, se < 24h) o dossiê de gerenciamento de risco unificado e
 * persiste no Supabase Storage. Body opcional: { force: true } p/ regenerar.
 */
export async function resolveOperatorUnificadaGerarPdfResponse(request) {
  return withOperatorSession(request, "unificada-gerar-pdf", async ({ correlationId, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso negado.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
    }
    let body = {};
    try { body = await parseJsonBody(request); } catch {}

    return withPgClient(async (client) => {
      const cadastro = await loadCadastroAprovado(client, id);
      if (!cadastro) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      const { generateDossie } = await import(
        "../../../application/operator-admin/use-cases/unificada/generate-dossie.js"
      );
      const result = await generateDossie({
        client, cadastro, operatorId, correlationId,
        force: body?.force === true,
      });
      if (!result.ok) {
        return {
          statusCode: 502,
          payload: {
            error: result.error?.code || "UnificadaError",
            message: result.error?.message || "Falha ao gerar o dossiê.",
            acao: result.error?.acao ?? null,
            meta: { correlationId },
          },
        };
      }
      return {
        statusCode: 200,
        payload: {
          ok: true,
          reused: result.reused,
          storage_path: result.storagePath,
          signed_url: result.signedUrl,
          components: result.components,
          warnings: result.warnings,
          meta: { correlationId },
        },
      };
    });
  });
}

/**
 * GET /api/operator/cadastros/:id
 * Retorna dados completos de um cadastro (para modal de edição).
 */
export async function resolveOperatorGetCadastroResponse(request) {
  return withOperatorSession(request, "get-cadastro", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID obrigatório.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, status, dados, observacoes, created_at, reviewed_at FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      return { statusCode: 200, payload: { cadastro: rows[0], meta: { correlationId } } };
    });
  });
}

/**
 * GET /api/operator/cadastros/:id/arquivo?path=<storage_path>
 * Gera uma signed URL (TTL 1h) para o operador visualizar um documento enviado
 * pelo motorista (CNH, CRLV, comprovante, etc.) no bucket privado cadastro-drafts.
 * Segurança: o path precisa estar referenciado no `dados` DESTE cadastro — evita
 * que o endpoint assine qualquer objeto do bucket.
 */
export async function resolveOperatorCadastroFileUrlResponse(request) {
  return withOperatorSession(request, "cadastro-arquivo-url", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário.");
    const id = getQueryParam(request, "id");
    const path = getQueryParam(request, "path");
    if (!id || !path) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "id e path são obrigatórios.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT dados FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      // Path precisa ser um valor-string presente no dados deste cadastro.
      const dadosStr = JSON.stringify(rows[0].dados ?? {});
      if (!dadosStr.includes(JSON.stringify(path))) {
        return { statusCode: 403, payload: { error: "Forbidden", message: "Arquivo não pertence a este cadastro.", meta: { correlationId } } };
      }
      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase.storage
        .from(DRAFT_FILE_BUCKET)
        .createSignedUrl(path, 3600);
      const signedUrl = data?.signedUrl ?? data?.signedURL ?? null;
      if (error || !signedUrl) {
        return { statusCode: 502, payload: { error: "StorageError", message: "Não foi possível gerar o link do arquivo.", meta: { correlationId } } };
      }
      return { statusCode: 200, payload: { signed_url: signedUrl, expires_in: 3600, meta: { correlationId } } };
    });
  });
}

/**
 * GET /api/operator/cadastros/:id/docs-migrados
 * Manifesto dos documentos de um cadastro MIGRADO (bot WhatsApp) que existem no
 * share local — para a galeria do painel. Só lista (tipo/label/filename); o
 * conteúdo é servido sob demanda por /doc-migrado. Não expõe o caminho do share.
 */
export async function resolveOperatorCadastroDocsMigradosResponse(request) {
  return withOperatorSession(request, "cadastro-docs-migrados", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "id é obrigatório.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT dados FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      const dados = rows[0].dados ?? {};
      // Só faz sentido para migrados (têm _origem.motorista_id e docs no share).
      if (!dados?._origem?.motorista_id) {
        return { statusCode: 200, payload: { docs: [], migrado: false, meta: { correlationId } } };
      }
      let docs = [];
      try {
        docs = listAvailableMigratedDocs(dados);
      } catch (err) {
        logStructuredEvent("warn", "operator.docs_migrados.resolve_failed", {
          cadastroId: id, correlationId, message: err?.message || String(err),
        });
      }
      return { statusCode: 200, payload: { docs, migrado: true, meta: { correlationId } } };
    });
  });
}

/**
 * GET /api/operator/cadastros/:id/doc-migrado?tipo=<tipo>
 * Serve UM documento de cadastro migrado como data-URI base64, lido do share
 * local (sem subir pro Supabase). O motorista_id vem do `dados._origem` do
 * cadastro (NUNCA do cliente) e o `tipo` é validado contra a allowlist DOC_TIPOS
 * — logo não há leitura de caminho arbitrário.
 */
export async function resolveOperatorCadastroDocMigradoResponse(request) {
  return withOperatorSession(request, "cadastro-doc-migrado", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário.");
    const id = getQueryParam(request, "id");
    const tipo = getQueryParam(request, "tipo");
    if (!id || !tipo) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "id e tipo são obrigatórios.", meta: { correlationId } } };
    }
    if (!Object.prototype.hasOwnProperty.call(DOC_TIPOS, tipo)) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "tipo de documento inválido.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT dados FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      const dados = rows[0].dados ?? {};
      if (!dados?._origem?.motorista_id) {
        return { statusCode: 400, payload: { error: "BadRequest", message: "Cadastro não é migrado (sem documentos no share).", meta: { correlationId } } };
      }
      let doc;
      try {
        doc = readLocalProdDocAsDataUri(dados, tipo);
      } catch (err) {
        if (err?.code === "DOC_TOO_LARGE") {
          return { statusCode: 413, payload: { error: "PayloadTooLarge", message: err.message, meta: { correlationId } } };
        }
        logStructuredEvent("warn", "operator.doc_migrado.read_failed", {
          cadastroId: id, tipo, correlationId, message: err?.message || String(err),
        });
        return { statusCode: 502, payload: { error: "ShareError", message: "Falha ao ler o documento do share.", meta: { correlationId } } };
      }
      if (!doc) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Documento não encontrado no share para este cadastro.", meta: { correlationId } } };
      }
      return { statusCode: 200, payload: { ...doc, tipo, meta: { correlationId } } };
    });
  });
}

/**
 * PATCH /api/operator/cadastros/:id/dados
 * Body: { dados: object } — atualiza o JSONB de dados do cadastro.
 */
export async function resolveOperatorPatchCadastroDadosResponse(request) {
  return withOperatorSession(request, "patch-cadastro-dados", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID obrigatório.", meta: { correlationId } } };
    }
    let body;
    try {
      body = await parseJsonBody(request);
    } catch {
      return { statusCode: 400, payload: { error: "BadRequest", message: "Body JSON inválido.", meta: { correlationId } } };
    }
    if (!body?.dados || typeof body.dados !== "object" || Array.isArray(body.dados)) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "Campo 'dados' deve ser um objeto JSON.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, status FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      // 'draft' incluído para o resgate de rascunho pelo operador (autosave do
      // wizard persiste o progresso na própria row de rascunho via PATCH).
      if (!["draft", "aprovado", "pendente", "em_revisao"].includes(rows[0].status)) {
        return { statusCode: 409, payload: { error: "Conflict", message: "Apenas rascunhos, pendentes ou aprovados podem ser editados.", meta: { correlationId } } };
      }
      await client.query(
        `UPDATE public.pending_driver_registrations SET dados = $1 WHERE id = $2`,
        [JSON.stringify(body.dados), id],
      );
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.dados_updated",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: id,
        action: "update_dados", outcome: "success",
        requestIp, correlationId,
      });
      return { statusCode: 200, payload: { ok: true, meta: { correlationId } } };
    });
  });
}

/**
 * POST /api/operator/cadastros/:id/submeter
 * Submete um rascunho (status='draft') em nome do motorista, a partir do wizard
 * de resgate no painel. Reusa o pipeline canônico do motorista (submit-final):
 * gera 'pendente' com protocolo/cascata ANTT/owner-reuse e consome o rascunho.
 *
 * Body: { dados } — estado final do wizard. cargaId vem da própria row de draft.
 */
export async function resolveOperatorSubmitDraftResponse(request) {
  return withOperatorSession(request, "submeter-rascunho", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário para submeter cadastros.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID do rascunho é obrigatório.", meta: { correlationId } } };
    }

    let body;
    try {
      body = await parseJsonBody(request);
    } catch {
      return { statusCode: 400, payload: { error: "BadRequest", message: "Body JSON inválido.", meta: { correlationId } } };
    }

    // Valida o payload com o MESMO schema do submit do motorista, garantindo
    // que o 'pendente' gerado seja consistente. cargaId é opcional no schema.
    let parsedInput;
    try {
      parsedInput = candidaturaSubmitSchema.parse({ dados: body?.dados });
    } catch (err) {
      if (err instanceof ZodError) {
        return zodErrorToHttpResponse(err, correlationId);
      }
      throw err;
    }

    const result = await submitDraftAsOperator({
      cadastroId: id,
      dados: parsedInput.dados,
      operatorId,
      requestIp,
      correlationId,
    });

    return result;
  });
}

/**
 * POST /api/operator/motoristas/cadastrar
 * Cadastro rápido de motorista pelo operador — sem wizard público.
 * Cria conta Supabase Auth + driver_profile + registro de auditoria.
 *
 * Body: { cpf, nome, telefone, placa_cavalo? }
 * Retorna: { ok, driverId, email }
 */
export async function resolveOperatorCadastrarMotoristaResponse(request) {
  return withOperatorSession(request, "cadastrar-motorista", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Apenas operadores com acesso intermediário ou avançado podem cadastrar motoristas.");

    let body = {};
    try {
      body = await parseJsonBody(request);
    } catch {
      return { statusCode: 400, payload: { error: "BadRequest", message: "Body JSON inválido.", meta: { correlationId } } };
    }

    const cpfClean = String(body.cpf || "").replace(/\D/g, "");
    const nome = String(body.nome || "").trim();
    const telefone = String(body.telefone || "").replace(/\D/g, "") || null;
    const placaCavalo = String(body.placa_cavalo || "").toUpperCase().trim() || null;

    if (!cpfClean || cpfClean.length !== 11) {
      return { statusCode: 422, payload: { error: "ValidationError", message: "CPF inválido ou ausente (deve ter 11 dígitos).", meta: { correlationId } } };
    }
    if (!nome) {
      return { statusCode: 422, payload: { error: "ValidationError", message: "Nome completo é obrigatório.", meta: { correlationId } } };
    }

    const adminClient = getAdminClient();
    const email = `${cpfClean}@motorista.lmc.internal`;

    return withPgClient(async (client) => {
      // 1. Cria (ou reutiliza) usuário Supabase Auth
      const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
        email,
        password: crypto.randomUUID(),
        email_confirm: true,
        app_metadata: { role: "driver", source: "cadastro-operador" },
        user_metadata: { role: "driver", source: "cadastro-operador", full_name: nome, cpf: cpfClean },
      });

      let driverId;
      if (authError) {
        if (authError.status === 422 || /already registered/i.test(authError.message || "")) {
          const { rows: existing } = await client.query(
            `SELECT id FROM auth.users WHERE email = $1`, [email],
          );
          if (!existing.length) {
            return { statusCode: 409, payload: { error: "Conflict", message: `CPF ${cpfClean} já tem conta, mas usuário não encontrado. Contate o suporte.`, meta: { correlationId } } };
          }
          driverId = existing[0].id;
        } else {
          throw authError;
        }
      } else {
        driverId = authData.user.id;
      }

      // 2. Upsert driver_profile
      await client.query(
        `
          INSERT INTO public.driver_profiles (
            user_id, full_name, phone, document_number,
            vehicle_profile, active, documents_valid
          )
          VALUES ($1, $2, $3, $4, $5, true, false)
          ON CONFLICT (user_id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            phone = COALESCE(EXCLUDED.phone, driver_profiles.phone),
            document_number = EXCLUDED.document_number,
            vehicle_profile = COALESCE(EXCLUDED.vehicle_profile, driver_profiles.vehicle_profile),
            updated_at = now()
        `,
        [driverId, nome, telefone, cpfClean, placaCavalo ? "cavalo" : "none"],
      );

      // 3. Audit log
      await insertSecurityAuditEvent(client, {
        eventType: "operator.motorista.cadastro_rapido",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "driver_profile",
        resourceId: driverId,
        action: "create",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { cpf: cpfClean, placa_cavalo: placaCavalo },
      });

      return {
        statusCode: 201,
        payload: {
          ok: true,
          driverId,
          email,
          nome,
          cpf: cpfClean,
          meta: { correlationId },
        },
      };
    });
  });
}

/**
 * DELETE /api/operator/cadastros/:id
 * Exclui um cadastro (qualquer status, incluindo aprovado e com jobs externos).
 * Jobs em external_registration_jobs são removidos via ON DELETE CASCADE.
 * Requer acesso avançado.
 */
export async function resolveOperatorDeleteCadastroResponse(request) {
  return withOperatorSession(request, "delete-cadastro", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "advanced", "Apenas operadores com acesso avançado podem excluir cadastros.");
    const id = getQueryParam(request, "id");
    if (!id) {
      return { statusCode: 400, payload: { error: "BadRequest", message: "ID obrigatório.", meta: { correlationId } } };
    }
    return withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, status FROM public.pending_driver_registrations WHERE id = $1`,
        [id],
      );
      if (!rows.length) {
        return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
      }
      // Permite exclusão mesmo com jobs OK — o operador assumiu a responsabilidade
      // no modal de confirmação. Dados no Angellira/SPX devem ser removidos manualmente
      // pelo operador nesses sistemas se necessário.
      await client.query(`DELETE FROM public.pending_driver_registrations WHERE id = $1`, [id]);
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.deleted",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: id,
        action: "delete", outcome: "success",
        requestIp, correlationId,
      });
      return { statusCode: 200, payload: { ok: true, meta: { correlationId } } };
    });
  });
}
