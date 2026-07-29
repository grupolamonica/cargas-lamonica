import { getPostgresPool } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { lookupAngelliraDriverByCpf } from "../../../infrastructure/angellira/angellira-client.js";
import { syncDriverAngelliraValidation } from "./angellira-cache.js";

// Revalida a vigência Angellira dos motoristas do `motoristas_historico` consultando
// a API AO VIVO e gravando `angellira_limit_date` fresco. Resolve o problema do
// snapshot estático (a tabela era populada 1x por import manual e nunca mais
// atualizada — em prod ~55% ficaram com data vencida mesmo o motorista tendo
// renovado). Também mantém a vigência de quem é resolvido só ao vivo (fallback
// ASPX) durável, junto da persistência feita no enrichment do Monitor.
//
// Segurança:
//  - só grava quando `availability === "OK"` (NUNCA rebaixa dado bom por falha/timeout);
//  - NOT_FOUND é autoritativo (mesma convenção do cache de leads) → zera a vigência;
//  - teto por rodada (`limit`) + `staleHours` (não re-consulta quem foi tocado há
//    pouco) fazem um refresh ROTATIVO da base sem martelar a API / o circuit breaker.

const DEFAULT_BATCH = 100;
const DEFAULT_STALE_HOURS = 20;
const DEFAULT_CONCURRENCY = 5;
const CALL_TIMEOUT_MS = 8_000;

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function runConcurrent(tasks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await tasks[i]().catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length || 1) }, worker));
}

// Seleciona os motoristas com a Angellira MAIS defasada: nunca consultados
// (limit_date NULL) e os mais vencidos primeiro; `staleHours` pula quem foi tocado
// há pouco (updated_at) → cada motorista é reconsultado ~1x/staleHours (rotação).
async function selectStaleDrivers(db, { limit, staleHours }) {
  const params = [];
  let where = "cpf IS NOT NULL AND cpf <> ''";
  if (staleHours != null) {
    params.push(staleHours);
    where += ` AND (updated_at IS NULL OR updated_at < now() - ($${params.length} || ' hours')::interval)`;
  }
  let limitClause = "";
  if (limit != null) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT cpf, nome
       FROM public.motoristas_historico
      WHERE ${where}
      ORDER BY angellira_limit_date ASC NULLS FIRST, updated_at ASC NULLS FIRST
      ${limitClause}`,
    params,
  );
  return rows || [];
}

// Grava de volta o resultado da consulta ao vivo. FOUND → data/id frescos;
// NOT_FOUND → zera vigência (autoritativo). UNAVAILABLE nunca chega aqui.
async function writeBackDriver(db, cpf, result) {
  if (result.status === "FOUND") {
    await db.query(
      `UPDATE public.motoristas_historico
          SET angellira_query_id   = COALESCE($2, angellira_query_id),
              angellira_sent_date  = COALESCE($3, angellira_sent_date),
              angellira_limit_date = $4,
              nome                 = COALESCE(NULLIF($5, ''), nome),
              updated_at           = now()
        WHERE cpf = $1`,
      [cpf, result.queryId ?? null, result.lastSeenAt ?? null, result.validUntil ?? null, (result.displayName || "").trim()],
    );
    return "FOUND";
  }
  await db.query(
    `UPDATE public.motoristas_historico
        SET angellira_query_id = NULL, angellira_limit_date = NULL, updated_at = now()
      WHERE cpf = $1`,
    [cpf],
  );
  return "NOT_FOUND";
}

/**
 * Revalida UM motorista por CPF (consulta ao vivo + write-back). Reutilizável por
 * um futuro botão "revalidar ao vivo". Devolve { status: FOUND|NOT_FOUND|UNAVAILABLE|SKIP }.
 */
export async function revalidateDriverAngelliraByCpf(
  db,
  cpf,
  { lookup = lookupAngelliraDriverByCpf, syncDriver = syncDriverAngelliraValidation, correlationId = null } = {},
) {
  const norm = normalizeCpf(cpf);
  if (!norm) return { status: "SKIP" };

  let result;
  try {
    result = await withTimeout(lookup(norm, { correlationId }), CALL_TIMEOUT_MS);
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!result || result.availability !== "OK") return { status: "UNAVAILABLE" };

  const status = await writeBackDriver(db, norm, result);

  // Mantém driver_profiles (motorista REGISTRADO) coerente — best-effort, não bloqueia.
  if (status === "FOUND") {
    try {
      await syncDriver({ documentNumber: norm, angelliraResult: result, correlationId });
    } catch {
      /* driver_profiles não é obrigatório aqui — motoristas_historico já foi gravado */
    }
  }
  return { status };
}

/**
 * Revalida um LOTE de motoristas defasados. Chamado pelo timer do main.js (com
 * `limit`/`staleHours`) e pelo script de backfill (`limit=null, staleHours=null` →
 * base inteira). Injeções (`db`/`lookup`/`syncDriver`) existem para teste.
 */
export async function revalidateDriversAngellira({
  db = getPostgresPool(),
  lookup = lookupAngelliraDriverByCpf,
  syncDriver = syncDriverAngelliraValidation,
  limit = DEFAULT_BATCH,
  staleHours = DEFAULT_STALE_HOURS,
  concurrency = DEFAULT_CONCURRENCY,
  correlationId = null,
  onProgress = null,
} = {}) {
  const drivers = await selectStaleDrivers(db, { limit, staleHours });

  let found = 0;
  let notFound = 0;
  let unavailable = 0;
  let processed = 0;

  const tasks = drivers.map((d) => async () => {
    const r = await revalidateDriverAngelliraByCpf(db, d.cpf, { lookup, syncDriver, correlationId });
    if (r.status === "FOUND") found += 1;
    else if (r.status === "NOT_FOUND") notFound += 1;
    else if (r.status === "UNAVAILABLE") unavailable += 1;
    processed += 1;
    if (onProgress) onProgress({ processed, total: drivers.length, found, notFound, unavailable });
  });

  await runConcurrent(tasks, concurrency);

  const summary = { checked: drivers.length, found, notFound, unavailable };
  logStructuredEvent("info", "revalidate-drivers-angellira.done", { correlationId, ...summary });
  return summary;
}
