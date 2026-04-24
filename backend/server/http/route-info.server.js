import "../config/load-env.js";
import http from "node:http";
import { URL } from "node:url";

import { resolveRouteInfoResponse } from "./route-info.handler.js";

const DEFAULT_PORT = 8787;

function getCacheHeaders(statusCode) {
  if (statusCode === 200) {
    return {
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    };
  }

  return {
    "Cache-Control": "no-store",
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...getCacheHeaders(statusCode),
  });
  response.end(JSON.stringify(payload));
}

async function handleRouteInfoRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, {
      error: "MethodNotAllowed",
      code: "METHOD_NOT_ALLOWED",
      message: "Use GET /api/route-info",
    });
    return;
  }

  const requestUrl = new URL(request.url || "/", "http://localhost");

  if (requestUrl.pathname !== "/api/route-info") {
    sendJson(response, 404, {
      error: "NotFound",
      code: "NOT_FOUND",
      message: "Route info endpoint not found.",
    });
    return;
  }

  const origin = requestUrl.searchParams.get("origin") || "";
  const destination = requestUrl.searchParams.get("destination") || "";

  const { statusCode, payload } = await resolveRouteInfoResponse(origin, destination);
  sendJson(response, statusCode, payload);
}

export function createRouteInfoServer() {
  return http.createServer((request, response) => {
    void handleRouteInfoRequest(request, response);
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const port = Number(process.env.ROUTE_INFO_PORT || DEFAULT_PORT);
  const server = createRouteInfoServer();

  server.listen(port, () => {
    console.log(`[route-info-api] listening on http://127.0.0.1:${port}/api/route-info`);
  });
}
