import {
  resolveAspxSyncStatusResponse,
  resolveAspxSyncTriggerResponse,
} from "../backend/server/http/aspx-admin/handlers.js";
import { resolveClientLogoResponse } from "../backend/server/http/client-logo.handler.js";
import {
  resolveApprovePublicLoadLeadResponse,
  resolveCancelLoadClaimResponse,
  resolveCancelPublicLoadLeadResponse,
  resolveClaimMaintenanceResponse,
  resolveConfirmLoadClaimResponse,
  resolveCreateLoadClaimResponse,
  resolveCreatePublicLoadLeadPreRegistrationResponse,
  resolveDriverProfileResponse,
  resolveGetLoadClaimStatusResponse,
  resolveOperatorPublicLoadLeadsResponse,
  resolveQueuePublicLoadLeadViaWhatsAppResponse,
  resolveRegisterDriverResponse,
  resolveRevalidateQueuedPublicLeadsResponse,
  resolveRevalidateQueuedPublicLeadsAspxResponse,
} from "../backend/server/http/load-claims/handlers.js";
import {
  resolveOperatorAuditLogsResponse,
  resolveCreateOperatorCargoResponse,
  resolveCreateOperatorClienteResponse,
  resolveCreateOperatorRouteResponse,
  resolveDeleteOperatorCargoResponse,
  resolveDeleteOperatorClienteResponse,
  resolveDuplicateOperatorCargoResponse,
  resolveOperatorCargoListReadModelResponse,
  resolveOperatorClientesListReadModelResponse,
  resolveOperatorDashboardReadModelResponse,
  resolveOperatorDriverFlowMetricsResponse,
  resolveOperatorDriversListReadModelResponse,
  resolveOperatorRoutesListReadModelResponse,
  resolveOperatorSheetSyncResponse,
  resolveOperatorVehiclesListReadModelResponse,
  resolveRevalidateAllVehiclesResponse,
  resolveToggleOperatorCargoStatusResponse,
  resolveUpdateOperatorCargoResponse,
  resolveUpdateOperatorClienteResponse,
  resolveUpdateOperatorDriverProfileResponse,
  resolveUpdateOperatorRouteResponse,
  resolveSheetMonitorResponse,
  resolveSheetMonitorRowDetailResponse,
  resolveSheetMonitorEnrichResponse,
  resolveRedactPublicLeadPiiResponse,
} from "../backend/server/http/operator-admin/handlers.js";
import { resolveDriverPortalVisitResponse, resolveHealthResponse, resolveDriverLoadFacetsResponse, resolveDriverLoadsReadModelResponse } from "../backend/server/http/public-loads/handlers.js";
import { resolveRouteInfoResponse } from "../backend/server/http/route-info.handler.js";
import { resolveSheetSyncResponse } from "../backend/server/http/sheet-sync.handler.js";

const DEFAULT_ALLOWED_HEADERS = "Authorization,Content-Type,Idempotency-Key,X-Correlation-Id";
const GENERIC_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

function resolveAllowedOrigin(requestOrigin) {
  const raw = process.env.ALLOWED_ORIGINS?.trim() || "";
  if (!raw) {
    // Fail closed: reject all cross-origin requests when ALLOWED_ORIGINS is not configured.
    // Set ALLOWED_ORIGINS=https://your-domain.vercel.app in Vercel environment variables.
    return null;
  }
  const allowed = raw.split(",").map((o) => o.trim()).filter(Boolean);
  return requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : null;
}

function setCorsHeaders(response, options = {}) {
  const requestOrigin = options.requestOrigin || null;
  const allowedOrigin = resolveAllowedOrigin(requestOrigin);

  if (allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    if (allowedOrigin !== "*") {
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  response.setHeader("Access-Control-Allow-Methods", options.methods || GENERIC_ALLOWED_METHODS);
  response.setHeader("Access-Control-Allow-Headers", options.headers || DEFAULT_ALLOWED_HEADERS);
}

function setRouteInfoCacheHeaders(response, statusCode) {
  if (statusCode === 200) {
    response.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
    return;
  }

  response.setHeader("Cache-Control", "no-store");
}

export function normalizeRouteQuerySegments(rawRoute) {
  if (Array.isArray(rawRoute)) {
    return rawRoute
      .flatMap((segment) => String(segment).split("/"))
      .map((segment) => decodeURIComponent(segment.trim()))
      .filter(Boolean);
  }

  if (typeof rawRoute === "string" && rawRoute.trim()) {
    return rawRoute
      .split("/")
      .map((segment) => decodeURIComponent(segment.trim()))
      .filter(Boolean);
  }

  return [];
}

export function buildRouteContext(request) {
  const url = new URL(request.url || "/api", "http://localhost");
  const pathnameSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  let segments = pathnameSegments[0] === "api" ? pathnameSegments.slice(1) : pathnameSegments;

  if (!segments.length || segments.some((segment) => /^\[\.\.\..+\]$/.test(segment))) {
    const dynamicSegments = normalizeRouteQuerySegments(request.query?.route);

    if (dynamicSegments.length) {
      segments = dynamicSegments;
    }
  }

  return { url, segments };
}

function syncRequestQuery(request, url, routeParams = {}) {
  const searchParams = Object.fromEntries(url.searchParams.entries());

  request.query = {
    ...(request.query || {}),
    ...searchParams,
    ...routeParams,
  };
}

function respondMethodNotAllowed(response, message) {
  response.status(405).json({
    error: "MethodNotAllowed",
    code: "METHOD_NOT_ALLOWED",
    message,
  });
}

function respondNotFound(response) {
  response.status(404).json({
    error: "NotFound",
    code: "NOT_FOUND",
    message: "Endpoint /api nao encontrado.",
  });
}

async function handleJsonRoute({
  request,
  response,
  methods,
  resolve,
  routeParams,
  url,
  notAllowedMessage,
}) {
  setCorsHeaders(response, { requestOrigin: request.headers?.origin });

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (!methods.includes(request.method)) {
    respondMethodNotAllowed(response, notAllowedMessage);
    return;
  }

  syncRequestQuery(request, url, routeParams);
  const { statusCode, payload } = await resolve(request);
  response.status(statusCode).json(payload);
}

export default async function handler(request, response) {
  const { url, segments } = buildRouteContext(request);

  if (!segments.length) {
    setCorsHeaders(response, { requestOrigin: request.headers?.origin });
    respondNotFound(response);
    return;
  }

  const [root, second, third, fourth, fifth] = segments;

  if (root === "health" && segments.length === 1) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/health",
      resolve: resolveHealthResponse,
    });
    return;
  }

  if (root === "sheet-sync" && segments.length === 1) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/sheet-sync",
      resolve: resolveSheetSyncResponse,
    });
    return;
  }

  if (root === "route-info" && segments.length === 1) {
    setCorsHeaders(response, {
      methods: "GET,OPTIONS",
      headers: "Content-Type",
    });

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    if (request.method !== "GET") {
      respondMethodNotAllowed(response, "Use GET /api/route-info");
      return;
    }

    syncRequestQuery(request, url);
    const origin = typeof request.query?.origin === "string" ? request.query.origin : "";
    const destination = typeof request.query?.destination === "string" ? request.query.destination : "";
    const { statusCode, payload } = await resolveRouteInfoResponse(origin, destination);
    setRouteInfoCacheHeaders(response, statusCode);
    response.status(statusCode).json(payload);
    return;
  }

  if (root === "client-logo" && segments.length === 1) {
    setCorsHeaders(response, {
      methods: "GET,OPTIONS",
      headers: "Content-Type",
    });

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    if (request.method !== "GET") {
      respondMethodNotAllowed(response, "Use GET /api/client-logo");
      return;
    }

    syncRequestQuery(request, url);
    const rawUrl = typeof request.query?.url === "string" ? request.query.url : "";
    const { statusCode, headers, body } = await resolveClientLogoResponse(rawUrl);

    Object.entries(headers).forEach(([headerName, headerValue]) => {
      response.setHeader(headerName, headerValue);
    });

    response.status(statusCode).send(body);
    return;
  }

  if (root === "driver" && second === "loads" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/driver/loads",
      resolve: resolveDriverLoadsReadModelResponse,
    });
    return;
  }

  if (root === "driver" && second === "loads" && third === "facets" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/driver/loads/facets",
      resolve: resolveDriverLoadFacetsResponse,
    });
    return;
  }

  if (root === "driver" && second === "portal-view" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/driver/portal-view",
      resolve: resolveDriverPortalVisitResponse,
    });
    return;
  }

  if (root === "drivers" && second === "register" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/drivers/register",
      resolve: resolveRegisterDriverResponse,
    });
    return;
  }

  if (root === "drivers" && second === "me" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET", "PUT"],
      notAllowedMessage: "Use GET or PUT /api/drivers/me",
      resolve: resolveDriverProfileResponse,
    });
    return;
  }

  // POST /api/operators/register is disabled — operator provisioning is done via the
  // supabase:create-operator admin script. The handler returns 501 if somehow reached.

  if (root === "load-claims" && second === "maintenance" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET", "POST"],
      notAllowedMessage: "Use GET or POST /api/load-claims/maintenance",
      resolve: resolveClaimMaintenanceResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "claim-status" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second },
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/loads/:loadId/claim-status",
      resolve: resolveGetLoadClaimStatusResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "pre-registration" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/pre-registration",
      resolve: resolveCreatePublicLoadLeadPreRegistrationResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "claims" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/claims",
      resolve: resolveCreateLoadClaimResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "claims" && fourth && fifth === "confirm" && segments.length === 5) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second, claimId: fourth },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/claims/:claimId/confirm",
      resolve: resolveConfirmLoadClaimResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "claims" && fourth && fifth === "cancel" && segments.length === 5) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second, claimId: fourth },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/claims/:claimId/cancel",
      resolve: resolveCancelLoadClaimResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "leads" && fourth && fifth === "approve" && segments.length === 5) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second, leadId: fourth },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/leads/:leadId/approve",
      resolve: resolveApprovePublicLoadLeadResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "leads" && fourth && fifth === "cancel" && segments.length === 5) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second, leadId: fourth },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/leads/:leadId/cancel",
      resolve: resolveCancelPublicLoadLeadResponse,
    });
    return;
  }

  if (root === "loads" && second && third === "leads" && fourth && fifth === "whatsapp" && segments.length === 5) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { loadId: second, leadId: fourth },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/loads/:loadId/leads/:leadId/whatsapp",
      resolve: resolveQueuePublicLoadLeadViaWhatsAppResponse,
    });
    return;
  }

  if (root === "operator" && second === "dashboard" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/dashboard",
      resolve: resolveOperatorDashboardReadModelResponse,
    });
    return;
  }

  if (root === "operator" && second === "cargas" && third === "sync-sheet" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/cargas/sync-sheet",
      resolve: resolveOperatorSheetSyncResponse,
    });
    return;
  }

  if (root === "operator" && second === "audit-logs" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/audit-logs",
      resolve: resolveOperatorAuditLogsResponse,
    });
    return;
  }

  if (root === "operator" && second === "driver-flow-metrics" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/driver-flow-metrics",
      resolve: resolveOperatorDriverFlowMetricsResponse,
    });
    return;
  }

  if (root === "operator" && second === "leads" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/leads",
      resolve: resolveOperatorPublicLoadLeadsResponse,
    });
    return;
  }

  if (root === "operator" && second === "leads" && third === "revalidate-queued" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/leads/revalidate-queued",
      resolve: resolveRevalidateQueuedPublicLeadsResponse,
    });
    return;
  }

  if (root === "operator" && second === "leads" && third === "revalidate-queued-aspx" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/leads/revalidate-queued-aspx",
      resolve: resolveRevalidateQueuedPublicLeadsAspxResponse,
    });
    return;
  }

  if (root === "operator" && second === "aspx" && third === "status" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/aspx/status",
      resolve: resolveAspxSyncStatusResponse,
    });
    return;
  }

  if (root === "operator" && second === "aspx" && third === "sync" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/aspx/sync",
      resolve: resolveAspxSyncTriggerResponse,
    });
    return;
  }

  if (root === "operator" && second === "motoristas" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/motoristas",
      resolve: resolveOperatorDriversListReadModelResponse,
    });
    return;
  }

  if (root === "operator" && second === "motoristas" && third && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { driverId: third },
      methods: ["PATCH"],
      notAllowedMessage: "Use PATCH /api/operator/motoristas/:driverId",
      resolve: resolveUpdateOperatorDriverProfileResponse,
    });
    return;
  }

  if (root === "operator" && second === "veiculos" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/veiculos",
      resolve: resolveOperatorVehiclesListReadModelResponse,
    });
    return;
  }

  if (root === "operator" && second === "veiculos" && third === "revalidate" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/veiculos/revalidate",
      resolve: resolveRevalidateAllVehiclesResponse,
    });
    return;
  }

  if (root === "operator" && second === "sheet-monitor" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/sheet-monitor",
      resolve: resolveSheetMonitorResponse,
    });
    return;
  }

  if (root === "operator" && second === "sheet-monitor" && third === "row" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET"],
      notAllowedMessage: "Use GET /api/operator/sheet-monitor/row?lh=...",
      resolve: resolveSheetMonitorRowDetailResponse,
    });
    return;
  }

  if (root === "operator" && second === "sheet-monitor" && third === "enrich" && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/sheet-monitor/enrich",
      resolve: resolveSheetMonitorEnrichResponse,
    });
    return;
  }

  if (root === "operator" && second === "pii-redaction" && segments.length === 2) {
    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/pii-redaction",
      resolve: resolveRedactPublicLeadPiiResponse,
    });
    return;
  }

  if (root === "operator" && second === "cargas" && segments.length === 2) {
    const isReadOperation = request.method === "GET";

    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET", "POST"],
      notAllowedMessage: "Use GET or POST /api/operator/cargas",
      resolve: isReadOperation ? resolveOperatorCargoListReadModelResponse : resolveCreateOperatorCargoResponse,
    });
    return;
  }

  if (root === "operator" && second === "cargas" && third && segments.length === 3) {
    if (request.method === "PATCH") {
      await handleJsonRoute({
        request,
        response,
        url,
        routeParams: { cargoId: third },
        methods: ["PATCH"],
        notAllowedMessage: "Use PATCH or DELETE /api/operator/cargas/:cargoId",
        resolve: resolveUpdateOperatorCargoResponse,
      });
      return;
    }

    if (request.method === "DELETE") {
      await handleJsonRoute({
        request,
        response,
        url,
        routeParams: { cargoId: third },
        methods: ["DELETE"],
        notAllowedMessage: "Use PATCH or DELETE /api/operator/cargas/:cargoId",
        resolve: resolveDeleteOperatorCargoResponse,
      });
      return;
    }

    setCorsHeaders(response, { requestOrigin: request.headers?.origin });
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    respondMethodNotAllowed(response, "Use PATCH or DELETE /api/operator/cargas/:cargoId");
    return;
  }

  if (root === "operator" && second === "cargas" && third && fourth === "duplicate" && segments.length === 4) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { cargoId: third },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/cargas/:cargoId/duplicate",
      resolve: resolveDuplicateOperatorCargoResponse,
    });
    return;
  }

  if (root === "operator" && second === "cargas" && third && fourth === "toggle-status" && segments.length === 4) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { cargoId: third },
      methods: ["POST"],
      notAllowedMessage: "Use POST /api/operator/cargas/:cargoId/toggle-status",
      resolve: resolveToggleOperatorCargoStatusResponse,
    });
    return;
  }

  if (root === "operator" && second === "clientes" && segments.length === 2) {
    const isReadOperation = request.method === "GET";

    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET", "POST"],
      notAllowedMessage: "Use GET or POST /api/operator/clientes",
      resolve: isReadOperation ? resolveOperatorClientesListReadModelResponse : resolveCreateOperatorClienteResponse,
    });
    return;
  }

  if (root === "operator" && second === "clientes" && third && segments.length === 3) {
    if (request.method === "PATCH") {
      await handleJsonRoute({
        request,
        response,
        url,
        routeParams: { clienteId: third },
        methods: ["PATCH"],
        notAllowedMessage: "Use PATCH or DELETE /api/operator/clientes/:clienteId",
        resolve: resolveUpdateOperatorClienteResponse,
      });
      return;
    }

    if (request.method === "DELETE") {
      await handleJsonRoute({
        request,
        response,
        url,
        routeParams: { clienteId: third },
        methods: ["DELETE"],
        notAllowedMessage: "Use PATCH or DELETE /api/operator/clientes/:clienteId",
        resolve: resolveDeleteOperatorClienteResponse,
      });
      return;
    }

    setCorsHeaders(response, { requestOrigin: request.headers?.origin });
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    respondMethodNotAllowed(response, "Use PATCH or DELETE /api/operator/clientes/:clienteId");
    return;
  }

  if (root === "operator" && second === "routes" && segments.length === 2) {
    const isReadOperation = request.method === "GET";

    await handleJsonRoute({
      request,
      response,
      url,
      methods: ["GET", "POST"],
      notAllowedMessage: "Use GET or POST /api/operator/routes",
      resolve: isReadOperation ? resolveOperatorRoutesListReadModelResponse : resolveCreateOperatorRouteResponse,
    });
    return;
  }

  if (root === "operator" && second === "routes" && third && segments.length === 3) {
    await handleJsonRoute({
      request,
      response,
      url,
      routeParams: { routeId: third },
      methods: ["PATCH"],
      notAllowedMessage: "Use PATCH /api/operator/routes/:routeId",
      resolve: resolveUpdateOperatorRouteResponse,
    });
    return;
  }

  setCorsHeaders(response, { requestOrigin: request.headers?.origin });

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  respondNotFound(response);
}
