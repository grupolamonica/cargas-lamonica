import "../config/load-env.js";

import { getRouteInfo } from "../services/geoapify/index.js";
import {
  ConfigurationError,
  RouteResolutionError,
  TimeoutError,
  UpstreamApiError,
  ValidationError,
} from "../services/geoapify/errors.js";

function getStatusCode(error) {
  if (error instanceof ValidationError) return 400;
  if (error instanceof RouteResolutionError) return 422;
  if (error instanceof TimeoutError) return 504;
  if (error instanceof ConfigurationError) return 500;
  if (error instanceof UpstreamApiError) return 502;
  return 500;
}

function toErrorPayload(error) {
  if (error instanceof ValidationError) {
    return {
      error: error.name,
      code: error.code || "VALIDATION_ERROR",
      message: error.message,
    };
  }

  if (error instanceof RouteResolutionError) {
    return {
      error: error.name,
      code: error.code || "ROUTE_RESOLUTION_ERROR",
      message: "Nao foi possivel resolver a rota informada com os dados enviados.",
    };
  }

  if (error instanceof TimeoutError) {
    return {
      error: error.name,
      code: error.code || "UPSTREAM_TIMEOUT",
      message: "O servico de rotas demorou mais do que o permitido para responder.",
    };
  }

  if (error instanceof UpstreamApiError) {
    return {
      error: error.name,
      code: error.code || "UPSTREAM_API_ERROR",
      message: "O provedor de rotas nao respondeu normalmente.",
    };
  }

  return {
    error: error?.name || "InternalServerError",
    code: error?.code || "INTERNAL_SERVER_ERROR",
    message: "Unexpected error while resolving route information.",
  };
}

function logRouteInfoError(error, origin, destination) {
  if (error instanceof ValidationError) {
    return;
  }

  console.error("[route-info-api]", {
    origin,
    destination,
    name: error?.name,
    code: error?.code,
    message: error?.message,
  });
}

export async function resolveRouteInfoResponse(origin, destination) {
  try {
    const routeInfo = await getRouteInfo(origin || "", destination || "");
    return {
      statusCode: 200,
      payload: routeInfo,
    };
  } catch (error) {
    logRouteInfoError(error, origin, destination);

    return {
      statusCode: getStatusCode(error),
      payload: toErrorPayload(error),
    };
  }
}
