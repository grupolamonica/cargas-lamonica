import { geocodeLocation } from "./geocoding.service.js";
import { getGeoapifyJson } from "./geoapify-client.js";
import { RouteResolutionError, ValidationError } from "./errors.js";

const DRIVE_MODE = "drive";
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ROUTE_CACHE_SIZE = 5_000;
const routeCache = new Map();
const inFlightRequests = new Map();

function normalizeLocationInput(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function createCacheKey(origin, destination) {
  return `${normalizeLocationInput(origin)}|${normalizeLocationInput(destination)}|${DRIVE_MODE}`;
}

function validateLocationInput(label, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} must be a non-empty string.`, {
      operation: "validation",
      details: { field: label.toLowerCase() },
    });
  }
}

function roundToTwoDecimals(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getCachedValue(cacheKey) {
  const cachedEntry = routeCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    routeCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

function extractRouteMetrics(payload, origin, destination) {
  const feature = Array.isArray(payload?.features) ? payload.features[0] : null;
  const properties = feature?.properties ?? null;

  const distanceMeters = Number(properties?.distance);
  const durationSeconds = Number(properties?.time);

  if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
    throw new RouteResolutionError("Geoapify routing response did not include valid route metrics.", {
      operation: "routing",
      details: {
        origin,
        destination,
      },
    });
  }

  return {
    distance_km: roundToTwoDecimals(distanceMeters / 1000),
    duration_hours: roundToTwoDecimals(durationSeconds / 3600),
  };
}

async function resolveRoute(origin, destination) {
  const geocodingResults = await Promise.allSettled([
    geocodeLocation(origin),
    geocodeLocation(destination),
  ]);

  const rejectedResult = geocodingResults.find((result) => result.status === "rejected");
  if (rejectedResult) {
    throw rejectedResult.reason;
  }

  const [originCoordinates, destinationCoordinates] = geocodingResults.map((result) => result.value);

  const payload = await getGeoapifyJson(
    "/v1/routing",
    {
      waypoints: `${originCoordinates.lat},${originCoordinates.lon}|${destinationCoordinates.lat},${destinationCoordinates.lon}`,
      mode: DRIVE_MODE,
    },
    {
      operation: "routing",
      context: {
        origin,
        destination,
      },
    },
  );

  return extractRouteMetrics(payload, origin, destination);
}

export async function getRouteInfo(origin, destination) {
  validateLocationInput("Origin", origin);
  validateLocationInput("Destination", destination);

  const normalizedOrigin = origin.trim();
  const normalizedDestination = destination.trim();
  const cacheKey = createCacheKey(normalizedOrigin, normalizedDestination);

  const cachedValue = getCachedValue(cacheKey);
  if (cachedValue) {
    return cachedValue;
  }

  const pendingRequest = inFlightRequests.get(cacheKey);
  if (pendingRequest) {
    return pendingRequest;
  }

  const requestPromise = resolveRoute(normalizedOrigin, normalizedDestination)
    .then((result) => {
      if (routeCache.size >= MAX_ROUTE_CACHE_SIZE) {
        routeCache.delete(routeCache.keys().next().value);
      }

      routeCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return result;
    })
    .finally(() => {
      inFlightRequests.delete(cacheKey);
    });

  inFlightRequests.set(cacheKey, requestPromise);

  return requestPromise;
}
