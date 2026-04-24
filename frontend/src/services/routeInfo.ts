export interface RouteInfoResult {
  distance_km: number;
  duration_hours: number;
}

const resolvedCache = new Map<string, RouteInfoResult>();
const pendingCache = new Map<string, Promise<RouteInfoResult>>();

function normalizeLocation(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function createRouteCacheKey(origin: string, destination: string) {
  return `${normalizeLocation(origin)}|${normalizeLocation(destination)}`;
}

function createEndpointUrl(origin: string, destination: string) {
  const baseUrl = import.meta.env.VITE_ROUTE_INFO_API_URL?.trim() || "/api/route-info";
  const url =
    baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
      ? new URL(baseUrl)
      : new URL(baseUrl, window.location.origin);

  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);

  return url;
}

function validatePayload(payload: unknown): payload is RouteInfoResult {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as RouteInfoResult;

  return (
    typeof candidate.distance_km === "number" &&
    Number.isFinite(candidate.distance_km) &&
    typeof candidate.duration_hours === "number" &&
    Number.isFinite(candidate.duration_hours)
  );
}

export async function fetchRouteInfo(origin: string, destination: string) {
  if (!origin?.trim() || !destination?.trim()) {
    throw new Error("Origin and destination are required.");
  }

  const cacheKey = createRouteCacheKey(origin, destination);
  const cachedValue = resolvedCache.get(cacheKey);
  if (cachedValue) {
    return cachedValue;
  }

  const pendingValue = pendingCache.get(cacheKey);
  if (pendingValue) {
    return pendingValue;
  }

  const requestPromise = fetch(createEndpointUrl(origin, destination), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          typeof payload?.message === "string" ? payload.message : "Failed to fetch route information.",
        );
      }

      if (!validatePayload(payload)) {
        throw new Error("Invalid route information payload.");
      }

      resolvedCache.set(cacheKey, payload);
      return payload;
    })
    .finally(() => {
      pendingCache.delete(cacheKey);
    });

  pendingCache.set(cacheKey, requestPromise);

  return requestPromise;
}
