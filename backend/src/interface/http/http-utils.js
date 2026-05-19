import { logger } from "../../infrastructure/logger.js";

const DEFAULT_TRUSTED_IP_HEADERS = ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"];

// Warn at startup if proxy header trust is not explicitly configured
if (process.env.TRUST_PROXY_HEADERS === undefined || process.env.TRUST_PROXY_HEADERS === "") {
  logger.warn(
    {},
    "TRUST_PROXY_HEADERS is not set — defaulting to true (trusting cf-connecting-ip, x-real-ip, x-forwarded-for). " +
    "Set TRUST_PROXY_HEADERS=true to suppress this warning, or TRUST_PROXY_HEADERS=false to disable proxy header trust."
  );
}

export function normalizeForwardedAddress(value) {
  if (Array.isArray(value)) {
    return normalizeForwardedAddress(value[0]);
  }

  const normalizedValue = String(value || "")
    .split(",")[0]
    ?.trim();

  return normalizedValue || null;
}

function shouldTrustProxyHeaders() {
  const rawValue = process.env.TRUST_PROXY_HEADERS?.trim().toLowerCase();

  if (!rawValue) {
    return true;
  }

  return !["0", "false", "off", "no"].includes(rawValue);
}

function getTrustedIpHeaderCandidates() {
  const configuredHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();

  if (!configuredHeader) {
    return DEFAULT_TRUSTED_IP_HEADERS;
  }

  return [configuredHeader, ...DEFAULT_TRUSTED_IP_HEADERS.filter((headerName) => headerName !== configuredHeader)];
}

export function getRequestIp(request) {
  const remoteAddress = normalizeForwardedAddress(request.socket?.remoteAddress);

  if (!shouldTrustProxyHeaders()) {
    return remoteAddress;
  }

  for (const headerName of getTrustedIpHeaderCandidates()) {
    const headerValue = getHeaderValue(request, headerName);
    const normalizedIp = normalizeForwardedAddress(headerValue);

    if (normalizedIp) {
      return normalizedIp;
    }
  }

  return remoteAddress;
}

export function getHeaderValue(request, headerName) {
  return (
    request.headers?.[headerName.toLowerCase()] ||
    request.headers?.[headerName] ||
    request.headers?.get?.(headerName) ||
    request.headers?.get?.(headerName.toLowerCase()) ||
    null
  );
}

export function getAuthorizationHeader(request) {
  return getHeaderValue(request, "Authorization");
}

export function getCorrelationId(request) {
  return (
    getHeaderValue(request, "X-Correlation-Id") ||
    globalThis.crypto?.randomUUID?.() ||
    `corr-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function getQueryParam(request, name) {
  const value = request.query?.[name];
  return Array.isArray(value) ? value[0] : value || null;
}

const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

export async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }

  let rawBody = "";

  if (typeof request.body === "string") {
    if (Buffer.byteLength(request.body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large."), { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
    }
    rawBody = request.body;
  } else if (typeof request.text === "function") {
    rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large."), { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
    }
  } else if (typeof request?.[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;

      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        throw Object.assign(new Error("Request body too large."), { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
      }

      chunks.push(buf);
    }

    rawBody = Buffer.concat(chunks).toString("utf8").trim();
  }

  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400, code: "INVALID_JSON_BODY" });
  }
}
