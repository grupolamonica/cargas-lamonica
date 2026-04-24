import { supabase } from "@/integrations/supabase/client";
import { fetchRouteInfo } from "@/services/routeInfo";

export interface ResolvedRouteMetrics {
  distancia_km: number | null;
  duracao_horas: number | null;
}

const resolvedCache = new Map<string, ResolvedRouteMetrics>();
const pendingCache = new Map<string, Promise<ResolvedRouteMetrics>>();

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

function hasResolvedMetrics(
  metrics: Partial<ResolvedRouteMetrics> | null | undefined,
): metrics is { distancia_km: number; duracao_horas: number } {
  return (
    typeof metrics?.distancia_km === "number" &&
    Number.isFinite(metrics.distancia_km) &&
    typeof metrics?.duracao_horas === "number" &&
    Number.isFinite(metrics.duracao_horas)
  );
}

function isMissingRouteMetricsCacheTableError(error: { message?: string; details?: string } | null) {
  const combinedMessage = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return combinedMessage.includes("route_metrics_cache");
}

function isMissingRouteMetricsColumnsError(error: { message?: string; details?: string } | null) {
  const combinedMessage = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return combinedMessage.includes("distancia_km") || combinedMessage.includes("duracao_horas");
}

async function getMetricsFromPersistentCache(origin: string, destination: string) {
  const originKey = normalizeLocation(origin);
  const destinationKey = normalizeLocation(destination);

  const { data, error } = await supabase
    .from("route_metrics_cache")
    .select("distancia_km, duracao_horas")
    .eq("origin_key", originKey)
    .eq("destination_key", destinationKey)
    .maybeSingle();

  if (error) {
    if (!isMissingRouteMetricsCacheTableError(error)) {
      if (import.meta.env.DEV) console.error("Erro ao consultar cache persistente de rotas", error);
    }

    return null;
  }

  return hasResolvedMetrics(data)
    ? {
        distancia_km: data.distancia_km,
        duracao_horas: data.duracao_horas,
      }
    : null;
}

async function getMetricsFromSavedLoads(origin: string, destination: string) {
  const { data, error } = await supabase
    .from("cargas")
    .select("distancia_km, duracao_horas")
    .eq("origem", origin)
    .eq("destino", destination)
    .not("distancia_km", "is", null)
    .not("duracao_horas", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (!isMissingRouteMetricsColumnsError(error)) {
      if (import.meta.env.DEV) console.error("Erro ao consultar cargas salvas para reaproveitar rota", error);
    }

    return null;
  }

  return hasResolvedMetrics(data)
    ? {
        distancia_km: data.distancia_km,
        duracao_horas: data.duracao_horas,
      }
    : null;
}

async function persistRouteMetrics(origin: string, destination: string, metrics: ResolvedRouteMetrics) {
  if (!hasResolvedMetrics(metrics)) {
    return;
  }

  const now = new Date().toISOString();
  const payload = {
    origin_key: normalizeLocation(origin),
    destination_key: normalizeLocation(destination),
    origem: origin,
    destino: destination,
    distancia_km: metrics.distancia_km,
    duracao_horas: metrics.duracao_horas,
    updated_at: now,
  };

  const { error } = await supabase.from("route_metrics_cache").upsert(payload, {
    onConflict: "origin_key,destination_key",
  });

  if (error && !isMissingRouteMetricsCacheTableError(error)) {
    if (import.meta.env.DEV) console.error("Erro ao salvar cache persistente de rotas", error);
  }
}

export async function resolveRouteMetrics(origin: string, destination: string): Promise<ResolvedRouteMetrics> {
  const originValue = origin.trim();
  const destinationValue = destination.trim();

  if (!originValue || !destinationValue) {
    return {
      distancia_km: null,
      duracao_horas: null,
    };
  }

  const cacheKey = createRouteCacheKey(originValue, destinationValue);
  const cachedValue = resolvedCache.get(cacheKey);
  if (cachedValue) {
    return cachedValue;
  }

  const pendingValue = pendingCache.get(cacheKey);
  if (pendingValue) {
    return pendingValue;
  }

  const requestPromise = (async () => {
    const persistentCacheValue = await getMetricsFromPersistentCache(originValue, destinationValue);
    if (persistentCacheValue) {
      resolvedCache.set(cacheKey, persistentCacheValue);
      return persistentCacheValue;
    }

    const savedLoadValue = await getMetricsFromSavedLoads(originValue, destinationValue);
    if (savedLoadValue) {
      resolvedCache.set(cacheKey, savedLoadValue);
      await persistRouteMetrics(originValue, destinationValue, savedLoadValue);
      return savedLoadValue;
    }

    const routeInfo = await fetchRouteInfo(originValue, destinationValue);
    const resolvedValue = {
      distancia_km: routeInfo.distance_km,
      duracao_horas: routeInfo.duration_hours,
    };

    resolvedCache.set(cacheKey, resolvedValue);
    await persistRouteMetrics(originValue, destinationValue, resolvedValue);
    return resolvedValue;
  })().finally(() => {
    pendingCache.delete(cacheKey);
  });

  pendingCache.set(cacheKey, requestPromise);

  return requestPromise;
}
