// backend/src/infrastructure/rate-limit-redis.js
// Distributed rate-limit helpers backed by Redis.
// Falls back to "allow" (fail open) when Redis is unavailable.
import { logger } from "./logger.js";
import { getRedisClient } from "./redis.js";

/**
 * Increment rate-limit counter and return whether the request is within the limit.
 * Returns true (allowed) on Redis failure to avoid blocking users when Redis is down.
 *
 * @param {string} key       - Unique key (e.g. "ratelimit:precheck:127.0.0.1")
 * @param {number} max       - Max requests allowed in the window
 * @param {number} windowMs  - Window duration in milliseconds
 * @returns {Promise<boolean>} true = allowed, false = rate-limited
 */
export async function checkRateLimit(key, max, windowMs) {
  try {
    const redis = getRedisClient();
    const windowSec = Math.ceil(windowMs / 1000);
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }
    return current <= max;
  } catch (err) {
    logger.warn({ err, key }, "redis rate-limit unavailable — failing open");
    return true;
  }
}

/**
 * Get remaining TTL of a rate-limit key in milliseconds.
 * Returns 0 on Redis failure.
 *
 * @param {string} key
 * @returns {Promise<number>}
 */
export async function getRateLimitTtlMs(key) {
  try {
    const redis = getRedisClient();
    const ttlSec = await redis.ttl(key);
    return ttlSec > 0 ? ttlSec * 1000 : 0;
  } catch {
    return 0;
  }
}
