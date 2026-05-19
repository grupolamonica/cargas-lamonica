// backend/src/infrastructure/idempotency-redis.js
// Idempotency cache backed by Redis — shared across replicas.
// Falls back to null (cache miss) on Redis failure, causing the request to
// be processed again — acceptable for idempotent operations.
import { logger } from "./logger.js";
import { getRedisClient } from "./redis.js";

const DEFAULT_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * Retrieve a cached idempotency result.
 * Returns null on cache miss or Redis failure.
 *
 * @param {string} cacheKey
 * @returns {Promise<object|null>}
 */
export async function getIdempotencyResult(cacheKey) {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(`idempotency:${cacheKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn({ err, cacheKey }, "redis idempotency get failed — cache miss");
    return null;
  }
}

/**
 * Store an idempotency result.
 * Silently no-ops on Redis failure.
 *
 * @param {string} cacheKey
 * @param {object} result
 * @param {number} [ttlSeconds]
 */
export async function setIdempotencyResult(cacheKey, result, ttlSeconds = DEFAULT_TTL_SECONDS) {
  try {
    const redis = getRedisClient();
    await redis.setex(`idempotency:${cacheKey}`, ttlSeconds, JSON.stringify(result));
  } catch (err) {
    logger.warn({ err, cacheKey }, "redis idempotency set failed — continuing without cache");
  }
}
