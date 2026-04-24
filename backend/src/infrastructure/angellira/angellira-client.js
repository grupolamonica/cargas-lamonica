import https from "node:https";
import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";
import { recordDriverValidationIntegrationResult } from "../metrics.js";

const ANGELLIRA_AUTH_URL = "https://auth.angellira.com.br/auth";
const ANGELLIRA_GRANT_URL = "https://auth.angellira.com.br/auth/grant";
const ANGELLIRA_QUERY_URL = "https://api.angellira.com.br/profile/query";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_TOKEN_TTL_MS = 20 * 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RESULT_CACHE_SIZE = 10_000;

let tokenCache = {
  token: null,
  expiresAt: 0,
};

const resultCache = new Map();
const inFlightRequests = new Map();
const circuitState = {
  failures: 0,
  openUntil: 0,
};

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("ANGELLIRA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function getCacheTtlMs() {
  return parsePositiveIntegerEnv("ANGELLIRA_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_MS / 1_000) * 1_000;
}

function getTokenTtlMs() {
  return parsePositiveIntegerEnv("ANGELLIRA_TOKEN_CACHE_TTL_SECONDS", DEFAULT_TOKEN_TTL_MS / 1_000) * 1_000;
}

function getFailureThreshold() {
  return parsePositiveIntegerEnv("ANGELLIRA_CIRCUIT_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}

function getCooldownMs() {
  return parsePositiveIntegerEnv("ANGELLIRA_CIRCUIT_BREAKER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_MS / 1_000) * 1_000;
}

function getAngelliraCredentials() {
  return {
    username: process.env.ANGELLIRA_USER?.trim() || "",
    password: process.env.ANGELLIRA_PASSWORD?.trim() || "",
    companyId: process.env.ANGELLIRA_EMPRESA_ID?.trim() || "",
  };
}

function hasAngelliraCredentials() {
  const { username, password, companyId } = getAngelliraCredentials();
  return Boolean(username && password && companyId);
}

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Normaliza placa para o formato esperado pela API Angellira.
 *
 * A API diferencia o formato:
 *   - Placa antiga (3 letras + 4 numeros): REQUER hifen → "ABC-1234"
 *   - Placa Mercosul (3 letras + 1 num + 1 letra + 2 num): SEM hifen → "ABC1D23"
 *
 * Detecta automaticamente o padrao e insere/remove o hifen conforme necessario.
 */
function normalizePlate(value) {
  const stripped = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!stripped || stripped.length < 7) {
    return stripped;
  }

  // Placa antiga: 3 letras + 4 numeros (ex: PKU8616 → PKU-8616)
  if (/^[A-Z]{3}\d{4}$/.test(stripped)) {
    return `${stripped.slice(0, 3)}-${stripped.slice(3)}`;
  }

  // Placa Mercosul: 3 letras + 1 digito + 1 letra + 2 digitos (ex: MJD5F07)
  // Enviada sem hifen
  return stripped;
}

function buildCacheKey(queryFor, value) {
  return `${queryFor}:${value}`;
}

function getCachedResult(cacheKey) {
  const cachedEntry = resultCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    resultCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

function setCachedResult(cacheKey, value) {
  if (resultCache.size >= MAX_RESULT_CACHE_SIZE) {
    resultCache.delete(resultCache.keys().next().value);
  }

  resultCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + getCacheTtlMs(),
  });
}

function markSourceFailure(error, context = {}) {
  circuitState.failures += 1;

  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }

  logStructuredEvent("warn", "driver-validation.angellira.failure", {
    queryFor: context.queryFor || null,
    correlationId: context.correlationId || null,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
    message: error instanceof Error ? error.message : String(error),
  });
}

function markSourceSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function parseDateOnly(value) {
  if (!value) {
    return null;
  }

  const rawValue = String(value).trim();
  const match = rawValue.match(/^(\d{4}-\d{2}-\d{2})/);

  if (match) {
    return match[1];
  }

  const parsedDate = new Date(rawValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate.toISOString().slice(0, 10);
}

function parseIsoDateTime(value) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(String(value));
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
}

function extractCookieHeader(headers) {
  if (!headers) {
    return "";
  }

  const rawCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? String(headers.get("set-cookie"))
            .split(/,(?=[^;,\s]+=)/)
            .map((entry) => entry.trim())
        : [];

  return rawCookies
    .map((cookieValue) => cookieValue.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || getTimeoutMs());

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * GET JSON via node:https — usado no lugar de fetch para o endpoint de consulta
 * (api.angellira.com.br). O modulo nativo evita problemas de connection pooling
 * do undici quando auth.angellira.com.br e api.angellira.com.br compartilham IP.
 */
function httpsGetJson(url, headers = {}, timeoutMs) {
  const effectiveTimeout = timeoutMs || getTimeoutMs();

  return new Promise((resolve, reject) => {
    const parsedUrl = typeof url === "string" ? new URL(url) : url;
    const req = https.get(
      parsedUrl,
      {
        headers: { ...headers, Accept: "application/json" },
        timeout: effectiveTimeout,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTPS GET timeout after ${effectiveTimeout}ms`));
    });
  });
}

async function requestAngelliraToken({ correlationId } = {}) {
  if (!hasAngelliraCredentials()) {
    throw new Error("ANGELLIRA_NOT_CONFIGURED");
  }

  if (isCircuitOpen()) {
    throw new Error("ANGELLIRA_CIRCUIT_OPEN");
  }

  if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const { username, password, companyId } = getAngelliraCredentials();

  // IMPORTANTE: O endpoint de login retorna 302 com cookies de sessao (koa.sess).
  // Usamos redirect: "manual" para capturar os cookies da resposta intermediaria,
  // pois fetch (undici) descarta set-cookie de respostas redirecionadas automaticamente.
  //
  // Connection: close evita que o pool de conexoes do undici reutilize a conexao
  // com auth.angellira.com.br ao conectar em api.angellira.com.br (mesmo IP).
  const loginResponse = await fetchWithTimeout(ANGELLIRA_AUTH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Connection: "close",
    },
    body: JSON.stringify({
      login: username,
      pass: password,
      lang: "pt-br",
    }),
    redirect: "manual",
  });

  // O login retorna 302 quando as credenciais estao corretas (redirect para /auth/grant).
  // Qualquer status fora de 2xx/3xx indica falha real.
  if (!loginResponse.ok && !(loginResponse.status >= 300 && loginResponse.status < 400)) {
    // Consumir body para liberar a conexao no pool do undici
    await loginResponse.text().catch(() => {});
    throw new Error(`ANGELLIRA_LOGIN_FAILED:${loginResponse.status}`);
  }

  const cookieHeader = extractCookieHeader(loginResponse.headers);

  // Consumir o body da resposta de login para liberar a conexao no pool do undici.
  // Sem isso, conexoes pendentes podem causar timeout em requests subsequentes
  // pois auth.angellira.com.br e api.angellira.com.br compartilham o mesmo IP.
  await loginResponse.text().catch(() => {});

  const grantBody = new URLSearchParams({
    company: companyId,
    user: '{"userName":"","userId":-1}',
  });

  const grantRequestOptions = {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://auth.angellira.com.br",
      Referer: `https://auth.angellira.com.br/grant?client=Angellira&scope=&company=${companyId}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Connection: "close",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: grantBody.toString(),
    // IMPORTANTE: O grant retorna 302 com o token no Location header (URL fragment).
    // redirect: "manual" e obrigatorio para capturar o header antes do redirect.
    redirect: "manual",
  };

  // Retry com backoff exponencial para erros 5xx transientes no grant endpoint.
  // O servidor da Angellira pode retornar 500 sob carga e se recuperar em seguida.
  const GRANT_MAX_ATTEMPTS = 3;
  const GRANT_BASE_DELAY_MS = 300;

  let grantResponse = null;

  for (let attempt = 1; attempt <= GRANT_MAX_ATTEMPTS; attempt++) {
    grantResponse = await fetchWithTimeout(ANGELLIRA_GRANT_URL, grantRequestOptions);

    // 302 = sucesso (token no Location header). Qualquer 2xx ou 3xx e aceitavel.
    if (grantResponse.status < 500) {
      break;
    }

    // Consumir body do retry para liberar a conexao
    await grantResponse.text().catch(() => {});

    logStructuredEvent("warn", "driver-validation.angellira.grant_retry", {
      correlationId: correlationId || null,
      attempt,
      grantStatus: grantResponse.status,
    });

    if (attempt < GRANT_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, GRANT_BASE_DELAY_MS * attempt));
    }
  }

  let token = null;
  let grantResponseShape = null;

  // Estrategia 1: extrair token do Location header (fluxo OAuth2 implicit grant).
  // O grant retorna 302 com Location contendo #access_token=<jwt>&...
  const locationHeader = grantResponse.headers?.get("location") || "";
  if (locationHeader) {
    // Token pode estar no fragment (#access_token=...) ou na query (?access_token=...)
    const fragmentMatch = locationHeader.match(/[#&]access_token=([^&\s]+)/);
    if (fragmentMatch) {
      token = decodeURIComponent(fragmentMatch[1]);
    }
    if (!token) {
      const queryMatch = locationHeader.match(/[?&]access_token=([^&#\s]+)/);
      if (queryMatch) {
        token = decodeURIComponent(queryMatch[1]);
      }
    }
    if (!token) {
      const tokenMatch = locationHeader.match(/[?&#]token=([^&#\s]+)/);
      if (tokenMatch) {
        token = decodeURIComponent(tokenMatch[1]);
      }
    }
  }

  // Estrategia 2: fallback para JSON body (caso a API mude para retornar token no body)
  if (!token) {
    try {
      const payload = await grantResponse.clone().json();
      grantResponseShape = Object.keys(payload || {}).join(",");
      token =
        (typeof payload?.token === "string" && payload.token.trim()) ||
        (typeof payload?.access_token === "string" && payload.access_token.trim()) ||
        (typeof payload?.accessToken === "string" && payload.accessToken.trim()) ||
        (typeof payload?.bearer === "string" && payload.bearer.trim()) ||
        (typeof payload?.jwt === "string" && payload.jwt.trim()) ||
        null;
    } catch {
      token = null;
    }
  }

  // Consumir body do grant para liberar a conexao
  await grantResponse.text().catch(() => {});

  if (!token) {
    logStructuredEvent("warn", "driver-validation.angellira.token_missing", {
      correlationId: correlationId || null,
      grantStatus: grantResponse.status,
      grantUrl: grantResponse.url,
      grantResponseShape,
    });
    throw new Error("ANGELLIRA_TOKEN_MISSING");
  }

  tokenCache = {
    token,
    expiresAt: Date.now() + getTokenTtlMs(),
  };

  markSourceSuccess();

  logStructuredEvent("info", "driver-validation.angellira.token_refreshed", {
    correlationId: correlationId || null,
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
  });

  return token;
}

function trimOrNull(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? trimmed : null;
  }
  return value != null ? value : null;
}

function mapAngelliraRecord(queryFor, queryValue, payload) {
  const firstMatch = Array.isArray(payload?.data) ? payload.data[0] : null;

  if (!firstMatch) {
    return {
      queryFor,
      queryValue,
      availability: "OK",
      status: "NOT_FOUND",
      found: false,
      displayName: null,
      validUntil: null,
      lastSeenAt: null,
      statusText: null,
      driverDetails: null,
      vehicleDetails: null,
    };
  }

  const history = firstMatch.history || {};
  const driver = firstMatch.driver || {};
  const displayName =
    typeof history.driverName === "string" && history.driverName.trim()
      ? history.driverName.trim()
      : typeof driver.name === "string" && driver.name.trim()
        ? driver.name.trim()
        : null;

  // Extract detailed driver fields (populated on CPF lookups)
  const hasDriverData = Boolean(trimOrNull(history.driverName) || trimOrNull(history.driverCPF));
  const driverDetails = hasDriverData
    ? {
        name: trimOrNull(history.driverName) || trimOrNull(driver.name),
        cpf: trimOrNull(history.driverCPF),
        birthDate: parseDateOnly(history.driverBirth),
        rg: trimOrNull(history.driverRg),
        uf: trimOrNull(history.driverState),
        fatherName: trimOrNull(history.driverFather),
        motherName: trimOrNull(history.driverMother),
        cnhNumber: trimOrNull(history.driverCNH),
        cnhCategory: trimOrNull(history.driverCNHCategory),
        cnhSecurityCode: trimOrNull(history.driverCNHSecurity),
        cnhValidity: parseDateOnly(history.driverCNHValidity),
        phone: trimOrNull(history.driverPhone),
        city: trimOrNull(history.driverCity),
        naturalness: trimOrNull(history.driverNaturalness),
      }
    : null;

  // Extract detailed vehicle fields (populated on plate lookups).
  // The Angellira API stores vehicle data in different prefixes depending on type:
  //   cab* = cavalo (truck), tow* = carreta 1, tow2* = carreta 2, tow3* = carreta 3
  // We check all prefixes and use the first one with actual data.
  const vehiclePrefixes = [
    { prefix: "cab", plateField: "cabPlate", brandField: "cabBrand", modelField: "cabModel",
      fabYearField: "cabFabricationYear", modelYearField: "cabModelYear", colorField: "cabColor",
      renavamField: "cabRenavam", chassisField: "cabChassis", anttField: "cabAntt",
      ufField: "cabUF", licensingField: "cabLastLicensing" },
    { prefix: "tow", plateField: "towPlate", brandField: "towBrand", modelField: "towModel",
      fabYearField: "towFabricationYear", modelYearField: "towModelYear", colorField: "towColor",
      renavamField: "towRenavam", chassisField: "towChassis", anttField: "towAntt",
      ufField: "towUF", licensingField: "towLastLicensing" },
    { prefix: "tow2", plateField: "tow2Plate", brandField: "tow2Brand", modelField: "tow2Model",
      fabYearField: "tow2FabricationYear", modelYearField: "tow2ModelYear", colorField: "tow2Color",
      renavamField: "tow2Renavam", chassisField: "tow2Chassis", anttField: "tow2Antt",
      ufField: "tow2UF", licensingField: "tow2LastLicensing" },
    { prefix: "tow3", plateField: "tow3Plate", brandField: "tow3Brand", modelField: "tow3Model",
      fabYearField: "tow3FabricationYear", modelYearField: "tow3ModelYear", colorField: "tow3Color",
      renavamField: "tow3Renavam", chassisField: "tow3Chassis", anttField: "tow3Antt",
      ufField: "tow3UF", licensingField: "tow3LastLicensing" },
  ];

  let vehicleDetails = null;
  for (const v of vehiclePrefixes) {
    if (trimOrNull(history[v.plateField]) || trimOrNull(history[v.brandField])) {
      vehicleDetails = {
        type: trimOrNull(firstMatch.type?.description),
        plate: trimOrNull(history[v.plateField]),
        brand: trimOrNull(history[v.brandField]),
        model: trimOrNull(history[v.modelField]),
        fabricationYear: history[v.fabYearField] ?? null,
        modelYear: history[v.modelYearField] ?? null,
        color: trimOrNull(history[v.colorField]),
        renavam: trimOrNull(history[v.renavamField]),
        chassis: trimOrNull(history[v.chassisField]),
        antt: trimOrNull(history[v.anttField]),
        uf: trimOrNull(history[v.ufField]),
        lastLicensing: parseDateOnly(history[v.licensingField]),
      };
      break;
    }
  }

  return {
    queryFor,
    queryValue,
    availability: "OK",
    status: "FOUND",
    found: true,
    displayName,
    validUntil: parseDateOnly(firstMatch.limitDate),
    lastSeenAt: parseIsoDateTime(firstMatch.sentDate),
    statusText:
      typeof firstMatch?.status?.description === "string" && firstMatch.status.description.trim()
        ? firstMatch.status.description.trim()
        : null,
    driverDetails,
    vehicleDetails,
  };
}

async function runAngelliraLookup(queryFor, rawValue, { correlationId } = {}) {
  const normalizedValue = queryFor === "cpf" ? normalizeCpf(rawValue) : normalizePlate(rawValue);

  if (!normalizedValue) {
    return {
      queryFor,
      queryValue: normalizedValue,
      availability: "OK",
      status: "NOT_FOUND",
      found: false,
      displayName: null,
      validUntil: null,
      lastSeenAt: null,
      statusText: null,
    };
  }

  // Short-circuit: se as credenciais nao estao configuradas, retorna UNAVAILABLE
  // sem acionar o circuit breaker (config ausente nao e falha transiente)
  if (!hasAngelliraCredentials()) {
    logStructuredEvent("info", "driver-validation.angellira.skipped", {
      queryFor,
      correlationId: correlationId || null,
      reason: "ANGELLIRA_NOT_CONFIGURED",
    });
    recordDriverValidationIntegrationResult("angellira", {
      availability: "UNAVAILABLE",
      latencyMs: 0,
    });

    return {
      queryFor,
      queryValue: normalizedValue,
      availability: "UNAVAILABLE",
      status: "UNAVAILABLE",
      found: false,
      displayName: null,
      validUntil: null,
      lastSeenAt: null,
      statusText: null,
      errorCode: "ANGELLIRA_NOT_CONFIGURED",
    };
  }

  const cacheKey = buildCacheKey(queryFor, normalizedValue);
  const cachedValue = getCachedResult(cacheKey);

  if (cachedValue) {
    return cachedValue;
  }

  const pendingRequest = inFlightRequests.get(cacheKey);

  if (pendingRequest) {
    return pendingRequest;
  }

  const requestPromise = (async () => {
    const startedAt = Date.now();

    try {
      // Retry automatico na aquisicao do token: a primeira conexao TLS via undici
      // pode falhar em cold-start quando auth e api compartilham o mesmo IP.
      let token;
      try {
        token = await requestAngelliraToken({ correlationId });
      } catch (tokenError) {
        logStructuredEvent("warn", "driver-validation.angellira.token_retry", {
          correlationId: correlationId || null,
          firstError: tokenError instanceof Error ? tokenError.message : String(tokenError),
        });
        // Aguardar brevemente e tentar novamente — a segunda tentativa geralmente funciona
        await new Promise((resolve) => setTimeout(resolve, 500));
        token = await requestAngelliraToken({ correlationId });
      }
      const url = new URL(ANGELLIRA_QUERY_URL);
      url.searchParams.set("q", normalizedValue);
      url.searchParams.set("detailed", "true");
      url.searchParams.set("since", "2000-01-01");
      url.searchParams.set("qFor", queryFor);
      url.searchParams.append("sort[]", "-sentDate");

      // Usamos node:https em vez de fetch para a consulta, pois o undici (fetch)
      // apresenta problemas de connection pool quando auth e api compartilham IP.
      let response = await httpsGetJson(url, {
        Authorization: `Bearer ${token}`,
      });

      if (response.status === 401 || response.status === 403) {
        tokenCache = {
          token: null,
          expiresAt: 0,
        };

        const refreshedToken = await requestAngelliraToken({ correlationId });
        response = await httpsGetJson(url, {
          Authorization: `Bearer ${refreshedToken}`,
        });
      }

      if (!response.ok) {
        throw new Error(`ANGELLIRA_QUERY_FAILED:${response.status}`);
      }

      const payload = JSON.parse(response.data);
      const mappedResult = mapAngelliraRecord(queryFor, normalizedValue, payload);
      setCachedResult(cacheKey, mappedResult);
      markSourceSuccess();

      logStructuredEvent("info", "driver-validation.angellira.lookup_completed", {
        queryFor,
        correlationId: correlationId || null,
        found: mappedResult.found,
        latencyMs: Date.now() - startedAt,
      });
      recordDriverValidationIntegrationResult("angellira", {
        availability: "OK",
        latencyMs: Date.now() - startedAt,
      });

      return mappedResult;
    } catch (error) {
      recordDriverValidationIntegrationResult("angellira", {
        availability: "UNAVAILABLE",
        latencyMs: Date.now() - startedAt,
      });
      markSourceFailure(error, {
        queryFor,
        correlationId,
      });

      return {
        queryFor,
        queryValue: normalizedValue,
        availability: "UNAVAILABLE",
        status: "UNAVAILABLE",
        found: false,
        displayName: null,
        validUntil: null,
        lastSeenAt: null,
        statusText: null,
        errorCode: error instanceof Error ? error.message : String(error),
      };
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

export async function lookupAngelliraDriverByCpf(cpf, options = {}) {
  return runAngelliraLookup("cpf", cpf, options);
}

export async function lookupAngelliraPlate(plate, options = {}) {
  return runAngelliraLookup("plate", plate, options);
}

export function resetAngelliraClientStateForTests() {
  tokenCache = {
    token: null,
    expiresAt: 0,
  };
  resultCache.clear();
  inFlightRequests.clear();
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
