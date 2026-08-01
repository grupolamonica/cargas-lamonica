import { Pool } from "pg";

import "../config/load-env.js";
import { buildPostgresSslConfig } from "./postgres-ssl.js";

// Pool pg do backend — SINGLETON de processo (memo em `pool`, encerrado só no
// graceful shutdown de main.js).
//
// DIAGNÓSTICO de churn/introspecção de catálogo (perf, PONTO 10): o
// pg_stat_statements de produção acusa volume alto de introspecção de catálogo
// (`pg_catalog.pg_type` com `typarray`, CTE recursiva `base_types`,
// `pks_uniques_cols`). NADA disso sai daqui:
//   - o driver `pg` resolve tipos por tabela de OIDs compilada no pacote
//     `pg-types` (as únicas menções a pg_type lá são comentários que documentam
//     como a tabela foi gerada) e não emite UMA query no handshake — o
//     `_connect` de pg/lib/client.js só faz startup packet + auth e já entra em
//     readyForQuery;
//   - o pool é construído uma única vez por processo; nenhum handler/job abre
//     `new Pool`/`new Client` por request (só os scripts one-shot de
//     src/scripts/, que encerram com pool.end());
//   - `supabase-js` (infrastructure/supabase/admin-client.js) fala HTTP com o
//     PostgREST; construí-lo por request — como vários handlers fazem — NÃO
//     abre conexão Postgres nem consulta catálogo.
// Aquelas queries são o PostgREST recarregando o schema cache: serviço
// gerenciado pela Supabase, disparado por restart do PostgREST ou por NOTIFY dos
// event triggers de DDL do projeto. Reduzi-las é trabalho de OPS + de eliminar
// DDL em caminho quente (ex.: `CREATE TABLE IF NOT EXISTS` a cada leitura de
// app_settings), não de tunar os números deste pool.
let pool;

function getConnectionString() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();

  if (!connectionString) {
    throw new Error("Missing required environment variable: SUPABASE_DB_URL");
  }

  return connectionString;
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getPostgresPool() {
  if (!pool) {
    // Pool sizing — Supabase pgBouncer default permite ~15-20 client conexões
    // por role. Default 20 cobre tráfego sustentado de operadores + sync,
    // sobrando margem para circuit-breakers. Tunável via CLAIMS_DB_POOL_MAX.
    const poolMax = parsePositiveInt(process.env.CLAIMS_DB_POOL_MAX, 20);

    // statement_timeout — defesa contra queries que não-deveriam-terminar
    // segurando connection slots. 30s cobre operações pesadas legítimas
    // (sheet-sync ETL, route catalog refresh). Override via PG_STATEMENT_TIMEOUT_MS.
    const statementTimeoutMs = parsePositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 30_000);

    pool = new Pool({
      connectionString: getConnectionString(),
      max: poolMax,
      // idleTimeout — conexão ociosa é fechada em 30s. Baixar isso NÃO economiza
      // egress: só troca slot parado no pooler por mais handshake TLS + startup.
      // Documentado em backend/.env.example (bloco "Pool Postgres").
      idleTimeoutMillis: parsePositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
      connectionTimeoutMillis: parsePositiveInt(process.env.PG_CONNECT_TIMEOUT_MS, 5_000),
      ssl: buildPostgresSslConfig(),
      // Aplica statement_timeout em cada checkout — protege contra queries
      // mortas que vazariam connection slot.
      statement_timeout: statementTimeoutMs,
    });

    // O pooler do Supabase (pgBouncer) encerra conexões ociosas; o `pg` emite
    // 'error' no client ocioso. Sem listener, o Node trata como erro não
    // capturado e derruba o processo. Logamos e seguimos — o pool descarta o
    // client morto e abre outro sob demanda.
    pool.on("error", (error) => {
      console.error("[postgres] idle client error (conexão ociosa derrubada):", error.message);
    });
  }

  return pool;
}

export async function withPgClient(callback) {
  const client = await getPostgresPool().connect();

  // `pool.on('error')` só cobre clients OCIOSOS. Um client CHECKED-OUT (em uso
  // por um job/handler) cujo socket o pgBouncer derruba emite 'error' direto no
  // client — sem listener, o Node trata como erro não capturado e MATA o
  // processo (foi o que derrubou o backend). Anexamos um listener por checkout:
  // logamos, marcamos e, no release, destruímos o client quebrado em vez de
  // devolvê-lo ao pool.
  let clientError = null;
  const onError = (error) => {
    clientError = error;
    console.error("[postgres] checked-out client error (conexão derrubada em uso):", error.message);
  };
  client.on("error", onError);

  try {
    return await callback(client);
  } finally {
    client.removeListener("error", onError);
    // release(err) com valor truthy descarta o client (não volta ao pool).
    client.release(clientError || undefined);
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

// Diagnóstico — expõe stats do pool para endpoint /metrics ou healthcheck.
export function getPostgresPoolStats() {
  if (!pool) {
    return { total: 0, idle: 0, waiting: 0, max: 0 };
  }
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options?.max ?? 0,
  };
}
