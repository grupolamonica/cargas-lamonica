import { Pool } from "pg";

import "../config/load-env.js";
import { buildPostgresSslConfig } from "./postgres-ssl.js";
import { logger } from "../logger.js";

let pool;

function getConnectionString() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();

  if (!connectionString) {
    throw new Error("Missing required environment variable: SUPABASE_DB_URL");
  }

  return connectionString;
}

export function getPostgresPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: Number(process.env.CLAIMS_DB_POOL_MAX || 25),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      statementTimeoutMillis: Number(process.env.CLAIMS_DB_STATEMENT_TIMEOUT_MS || 15_000),
      ssl: buildPostgresSslConfig(),
    });

    // Log pool pressure — warn when connections are exhausted or queued
    setInterval(() => {
      if (!pool) return;
      const { totalCount, idleCount, waitingCount } = pool;
      if (waitingCount > 2 || (totalCount > 0 && idleCount === 0)) {
        logger.warn({ totalCount, idleCount, waitingCount }, "pg pool pressure");
      }
    }, 30_000).unref();
  }

  return pool;
}

export async function withPgClient(callback) {
  const client = await getPostgresPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function withPgTransaction(callback) {
  return withPgClient(async (client) => {
    await client.query("BEGIN");

    try {
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error({ err: rollbackError }, "ROLLBACK failed — original error follows");
      }
      throw error;
    }
  });
}
