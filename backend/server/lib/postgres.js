import { Pool } from "pg";

import "../config/load-env.js";
import { buildPostgresSslConfig } from "./postgres-ssl.js";

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
      max: Number(process.env.CLAIMS_DB_POOL_MAX || 3),
      idleTimeoutMillis: 30_000,
      ssl: buildPostgresSslConfig(),
    });
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
        console.error("[postgres] ROLLBACK failed — original error follows:", rollbackError);
      }
      throw error;
    }
  });
}
