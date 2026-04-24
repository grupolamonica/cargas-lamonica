import "../../config/load-env.js";

function parseBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue === undefined) {
    return defaultValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalizedValue);
}

function parseIntegerEnv(name, defaultValue) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
}

let _cachedConfig = null;

export function getLoadClaimConfig() {
  if (!_cachedConfig) {
    _cachedConfig = {
      claim_v2_enabled: parseBooleanEnv("CLAIM_V2_ENABLED", true),
      waitlist_enabled: parseBooleanEnv("WAITLIST_ENABLED", true),
      reservation_ttl_seconds: parseIntegerEnv("RESERVATION_TTL_SECONDS", 120),
      realtime_claim_updates_enabled: parseBooleanEnv("REALTIME_CLAIM_UPDATES_ENABLED", true),
      idempotency_ttl_seconds: parseIntegerEnv("CLAIM_IDEMPOTENCY_TTL_SECONDS", 86_400),
      maintenance_batch_size: parseIntegerEnv("CLAIM_MAINTENANCE_BATCH_SIZE", 25),
    };
  }
  return _cachedConfig;
}
