import { getGeoapifyJson } from "./geoapify-client.js";
import { RouteResolutionError } from "./errors.js";

const GEOCODING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_GEOCODING_CACHE_SIZE = 10_000;
const geocodingCache = new Map();
const inFlightGeocoding = new Map();

function toCoordinate(value) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function normalizeLocationInput(location) {
  return location.trim().replace(/\s+/g, " ").toLowerCase();
}

function getCachedGeocoding(cacheKey) {
  const cachedEntry = geocodingCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    geocodingCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

async function resolveGeocoding(location) {
  const payload = await getGeoapifyJson(
    "/v1/geocode/search",
    {
      text: location,
      format: "json",
      limit: 1,
      lang: "pt",
      filter: "countrycode:br",
    },
    {
      operation: "geocoding",
      context: { location },
    },
  );

  const result = Array.isArray(payload?.results) ? payload.results[0] : null;
  const lat = toCoordinate(result?.lat);
  const lon = toCoordinate(result?.lon);

  if (!result || lat === null || lon === null) {
    throw new RouteResolutionError(`Could not geocode location: ${location}`, {
      operation: "geocoding",
      details: { location },
    });
  }

  return {
    lat,
    lon,
    formatted: result.formatted ?? location,
  };
}

export async function geocodeLocation(location) {
  const normalizedLocation = normalizeLocationInput(location);
  const cachedValue = getCachedGeocoding(normalizedLocation);

  if (cachedValue) {
    return cachedValue;
  }

  const pendingRequest = inFlightGeocoding.get(normalizedLocation);
  if (pendingRequest) {
    return pendingRequest;
  }

  const requestPromise = resolveGeocoding(location)
    .then((result) => {
      if (geocodingCache.size >= MAX_GEOCODING_CACHE_SIZE) {
        geocodingCache.delete(geocodingCache.keys().next().value);
      }

      geocodingCache.set(normalizedLocation, {
        value: result,
        expiresAt: Date.now() + GEOCODING_CACHE_TTL_MS,
      });

      return result;
    })
    .finally(() => {
      inFlightGeocoding.delete(normalizedLocation);
    });

  inFlightGeocoding.set(normalizedLocation, requestPromise);

  return requestPromise;
}
