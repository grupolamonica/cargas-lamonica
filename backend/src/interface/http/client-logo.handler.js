import { request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { logger } from "../../infrastructure/logger.js";

const SUCCESS_CACHE_CONTROL = "public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800";
const DEFAULT_MAX_LOGO_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LOGO_REDIRECTS = 3;

function parsePositiveIntegerEnv(name, defaultValue) {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
}

function getMaxLogoBytes() {
  return parsePositiveIntegerEnv("CLIENT_LOGO_MAX_BYTES", DEFAULT_MAX_LOGO_BYTES);
}

function getMaxLogoRedirects() {
  return parsePositiveIntegerEnv("CLIENT_LOGO_MAX_REDIRECTS", DEFAULT_MAX_LOGO_REDIRECTS);
}

function isLocalHostname(hostname) {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");

  return (
    !normalizedHostname ||
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost") ||
    normalizedHostname.endsWith(".local")
  );
}

export function isPrivateNetworkIpAddress(address) {
  const normalizedAddress = address.trim().toLowerCase();
  const ipVersion = isIP(normalizedAddress);

  if (ipVersion === 4) {
    const octets = normalizedAddress.split(".").map((segment) => Number.parseInt(segment, 10));

    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
      return true;
    }

    if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) {
      return true;
    }

    if (octets[0] === 169 && octets[1] === 254) {
      return true;
    }

    if (octets[0] === 192 && octets[1] === 168) {
      return true;
    }

    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      return true;
    }

    return octets[0] >= 224;
  }

  if (ipVersion === 6) {
    if (
      normalizedAddress === "::1" ||
      normalizedAddress.startsWith("fc") ||
      normalizedAddress.startsWith("fd") ||
      normalizedAddress.startsWith("fe80:")
    ) {
      return true;
    }

    if (normalizedAddress.startsWith("::ffff:")) {
      return isPrivateNetworkIpAddress(normalizedAddress.slice(7));
    }

    return false;
  }

  return false;
}

async function resolvePublicInternetAddresses(hostname) {
  const ipVersion = isIP(hostname);

  if (ipVersion) {
    return isPrivateNetworkIpAddress(hostname)
      ? []
      : [
          {
            address: hostname,
            family: ipVersion,
          },
        ];
  }

  let resolvedAddresses;

  try {
    resolvedAddresses = await lookup(hostname, {
      all: true,
      verbatim: true,
    });
  } catch {
    return [];
  }

  if (!resolvedAddresses.length) {
    return [];
  }

  if (resolvedAddresses.some((entry) => isPrivateNetworkIpAddress(entry.address))) {
    return [];
  }

  return resolvedAddresses.map((entry) => ({
    address: entry.address,
    family: isIP(entry.address),
  }));
}

async function resolvesToPublicAddress(hostname) {
  const publicAddresses = await resolvePublicInternetAddresses(hostname);
  return publicAddresses.length > 0;
}

function createJsonBuffer(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function createJsonError(statusCode, code, message) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: createJsonBuffer({
      error: code,
      code,
      message,
    }),
  };
}

function parseTargetLogoUrl(rawUrl) {
  const normalizedUrl = rawUrl?.trim();

  if (!normalizedUrl) {
    return null;
  }

  try {
    return new URL(normalizedUrl);
  } catch {
    return null;
  }
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function resolveRedirectTargetUrl(currentUrl, locationHeader) {
  if (!locationHeader?.trim()) {
    return null;
  }

  try {
    return new URL(locationHeader, currentUrl);
  } catch {
    return null;
  }
}

async function validateTargetLogoUrl(targetUrl) {
  if (targetUrl.username || targetUrl.password) {
    return createJsonError(400, "INVALID_LOGO_URL", "A URL da logo nao pode usar credenciais.");
  }

  const hostname = targetUrl.hostname.toLowerCase();

  if (isLocalHostname(hostname)) {
    return createJsonError(403, "UNSUPPORTED_LOGO_HOST", "Hosts locais nao podem ser usados para logos.");
  }

  const isPublicAddress = await resolvesToPublicAddress(hostname);

  if (!isPublicAddress) {
    return createJsonError(
      403,
      "UNSUPPORTED_LOGO_HOST",
      "Esse host de logo nao pode ser acessado automaticamente.",
    );
  }

  return null;
}


function createNodeResponseHeaders(headers = {}) {
  return {
    get(name) {
      const rawValue = headers[name.toLowerCase()];

      if (Array.isArray(rawValue)) {
        return rawValue.join(", ");
      }

      return typeof rawValue === "string" ? rawValue : null;
    },
  };
}

function createFixedLookup(addressEntry) {
  const normalizedAddress = addressEntry?.address || "";
  const normalizedFamily = addressEntry?.family || isIP(normalizedAddress) || 4;

  return (_hostname, options, callback) => {
    if (!normalizedAddress) {
      callback(new Error("No public address available"));
      return;
    }

    if (options && typeof options === "object" && options.all) {
      callback(null, [
        {
          address: normalizedAddress,
          family: normalizedFamily,
        },
      ]);
      return;
    }

    callback(null, normalizedAddress, normalizedFamily);
  };
}

function requestLogoWithNodeTransport(targetUrl, addressEntry) {
  const requestImpl = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      targetUrl,
      {
        headers: {
          Accept: "image/*",
          "User-Agent": "Lamonica-Cargas-LogoProxy/1.0",
        },
        lookup: createFixedLookup(addressEntry),
      },
      (response) => {
        resolve(response);
      },
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Logo upstream request timed out"));
    });
    request.setTimeout?.(10_000);
    request.end();
  });
}

async function fetchLogoUpstreamResponseViaNodeRequest(targetUrl, redirectCount = 0) {
  const publicAddresses = await resolvePublicInternetAddresses(targetUrl.hostname);

  if (!publicAddresses.length) {
    return {
      error: createJsonError(502, "LOGO_FETCH_FAILED", "Nao foi possivel baixar a logo informada."),
    };
  }

  let upstreamResponse = null;
  const failedAddressMessages = [];

  for (const addressEntry of publicAddresses) {
    try {
      upstreamResponse = await requestLogoWithNodeTransport(targetUrl, addressEntry);
      break;
    } catch (error) {
      failedAddressMessages.push(`${addressEntry.address}/${addressEntry.family}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!upstreamResponse) {
    logger.error({ host: targetUrl.hostname, attempts: failedAddressMessages }, "client-logo-proxy: node request failed");

    return {
      error: createJsonError(502, "LOGO_FETCH_FAILED", "Nao foi possivel baixar a logo informada."),
    };
  }

  const statusCode = upstreamResponse.statusCode || 502;

  if (!isRedirectStatus(statusCode)) {
    return {
      response: {
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        headers: createNodeResponseHeaders(upstreamResponse.headers),
        body: upstreamResponse,
      },
    };
  }

  upstreamResponse.resume();

  if (redirectCount >= getMaxLogoRedirects()) {
    return {
      error: createJsonError(502, "LOGO_FETCH_FAILED", "Nao foi possivel baixar a logo informada."),
    };
  }

  const redirectHeader = Array.isArray(upstreamResponse.headers.location)
    ? upstreamResponse.headers.location[0]
    : upstreamResponse.headers.location;
  const redirectTarget = resolveRedirectTargetUrl(targetUrl, redirectHeader);

  if (!redirectTarget || (redirectTarget.protocol !== "https:" && redirectTarget.protocol !== "http:")) {
    return {
      error: createJsonError(502, "LOGO_FETCH_FAILED", "Nao foi possivel baixar a logo informada."),
    };
  }

  const redirectValidationError = await validateTargetLogoUrl(redirectTarget);

  if (redirectValidationError) {
    return {
      error: createJsonError(502, "LOGO_FETCH_FAILED", "Nao foi possivel baixar a logo informada."),
    };
  }

  return fetchLogoUpstreamResponseViaNodeRequest(redirectTarget, redirectCount + 1);
}

async function readResponseBodyWithLimit(upstreamResponse, maxBytes) {
  const contentLengthHeader = upstreamResponse.headers.get("content-length");
  const declaredSize = Number.parseInt(contentLengthHeader || "", 10);

  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    return null;
  }

  if (!upstreamResponse.body || typeof upstreamResponse.body.getReader !== "function") {
    if (upstreamResponse.body && typeof upstreamResponse.body.on === "function") {
      const chunks = [];
      let totalBytes = 0;

      return await new Promise((resolve, reject) => {
        upstreamResponse.body.on("data", (chunk) => {
          const chunkBuffer = Buffer.from(chunk);
          totalBytes += chunkBuffer.byteLength;

          if (totalBytes > maxBytes) {
            upstreamResponse.body.destroy();
            resolve(null);
            return;
          }

          chunks.push(chunkBuffer);
        });

        upstreamResponse.body.on("end", () => {
          resolve(Buffer.concat(chunks, totalBytes));
        });

        upstreamResponse.body.on("error", reject);
      });
    }

    const arrayBuffer = await upstreamResponse.arrayBuffer();
    return arrayBuffer.byteLength > maxBytes ? null : Buffer.from(arrayBuffer);
  }

  const reader = upstreamResponse.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunkBuffer = Buffer.from(value);
    totalBytes += chunkBuffer.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }

    chunks.push(chunkBuffer);
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function resolveClientLogoResponse(rawUrl) {
  const targetUrl = parseTargetLogoUrl(rawUrl);

  if (!targetUrl) {
    return createJsonError(400, "INVALID_LOGO_URL", "Informe uma URL valida para a logo.");
  }

  if (targetUrl.protocol !== "https:") {
    return createJsonError(400, "INVALID_LOGO_PROTOCOL", "A logo precisa usar HTTPS.");
  }

  const validationError = await validateTargetLogoUrl(targetUrl);

  if (validationError) {
    return validationError;
  }

  // Always use the IP-pinned Node HTTP transport to prevent DNS rebinding (SSRF/TOCTOU).
  // The global fetch() path was removed: it re-resolved DNS after the validation check,
  // opening a window for DNS rebinding attacks (e.g. redirect to 169.254.169.254).
  const upstreamResult = await fetchLogoUpstreamResponseViaNodeRequest(targetUrl);

  if (upstreamResult.error) {
    return upstreamResult.error;
  }

  const upstreamResponse = upstreamResult.response;

  if (!upstreamResponse.ok) {
    return createJsonError(502, "LOGO_FETCH_FAILED", "Nao foi possivel baixar a logo informada.");
  }

  const contentTypeHeader = upstreamResponse.headers.get("content-type") || "application/octet-stream";
  const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

  if (!contentType.startsWith("image/")) {
    return createJsonError(422, "INVALID_LOGO_CONTENT", "A URL informada nao retornou uma imagem valida.");
  }

  const responseBody = await readResponseBodyWithLimit(upstreamResponse, getMaxLogoBytes());

  if (!responseBody) {
    return createJsonError(413, "LOGO_TOO_LARGE", "A imagem informada excede o tamanho maximo permitido.");
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": contentTypeHeader,
      "Cache-Control": SUCCESS_CACHE_CONTROL,
    },
    body: responseBody,
  };
}
