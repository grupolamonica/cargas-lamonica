// backend/src/infrastructure/redis.js
// Redis client singleton — shared across rate-limit, idempotency, operator-directory cache.
// Fails open when Redis is unavailable so the application stays functional.
import "../config/load-env.js";
import { logger } from "./logger.js";
import Redis from "ioredis";

let client = null;

export function getRedisClient() {
  if (!client) {
    const url = process.env.REDIS_URL || "redis://redis:6379";
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      // Suppress ioredis "MaxRetriesPerRequestError" unhandled rejection noise
      enableOfflineQueue: false,
    });
    client.on("error", (err) =>
      logger.warn({ err }, "redis client error"),
    );
    client.on("connect", () =>
      logger.info({ url }, "redis connected"),
    );
    client.on("reconnecting", () =>
      logger.warn("redis reconnecting"),
    );
  }
  return client;
}

export async function closeRedisClient() {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}
