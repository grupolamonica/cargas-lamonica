import { createClient } from "@supabase/supabase-js";

import { withPgClient } from "../../../infrastructure/pg/postgres.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const STORAGE_BUCKET = "cadastro-drafts";

let supabaseAdminSingleton = null;
function getSupabaseAdmin() {
  if (!supabaseAdminSingleton) {
    const url = process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRole) return null;
    supabaseAdminSingleton = createClient(url, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseAdminSingleton;
}

export const DEFAULT_CLEANUP_BATCH_SIZE = 50;

/**
 * Apaga drafts v2 com updated_at < now() - 72h.
 *
 * Guard rigido (status='draft' AND versao_cadastro='v2') para nunca apagar:
 *   - submissoes finais (status='pendente'/'aprovado'/'rejeitado')
 *   - cadastros v1
 *
 * @param {object} [options]
 * @param {number} [options.limit] Teto de linhas por ciclo. Sem teto, o primeiro
 *   ciclo apaga TODO o acumulado de uma vez e dispara 2 chamadas de Storage por
 *   linha — em 2026-08-07 havia 382 drafts elegiveis, ou seja ~764 chamadas num
 *   unico tick. Com teto, o acumulado drena ao longo de varios ciclos.
 * @param {boolean} [options.dryRun] So conta, nao apaga. Serve pra medir o
 *   alcance antes de habilitar de verdade.
 * @returns {Promise<{ deletedCount: number, deletedIds: string[], dryRun: boolean }>}
 */
export async function cleanupExpiredDrafts({ limit = DEFAULT_CLEANUP_BATCH_SIZE, dryRun = false } = {}) {
  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_CLEANUP_BATCH_SIZE;

  return withPgClient(async (client) => {
    if (dryRun) {
      const { rows } = await client.query(
        `
          SELECT COUNT(*)::int AS elegiveis
          FROM public.pending_driver_registrations
          WHERE status = 'draft'
            AND versao_cadastro = 'v2'
            AND updated_at < now() - interval '72 hours'
        `,
      );

      return {
        deletedCount: 0,
        eligibleCount: rows[0]?.elegiveis || 0,
        deletedIds: [],
        deletedRows: [],
        dryRun: true,
      };
    }

    const result = await client.query(
      `
        DELETE FROM public.pending_driver_registrations
        WHERE id IN (
          SELECT id
          FROM public.pending_driver_registrations
          WHERE status = 'draft'
            AND versao_cadastro = 'v2'
            AND updated_at < now() - interval '72 hours'
          ORDER BY updated_at ASC
          LIMIT $1
        )
        RETURNING id, driver_user_id, dados->>'__cpf' AS cpf, carga_id
      `,
      [effectiveLimit],
    );

    const rows = result.rows || [];
    return {
      deletedCount: result.rowCount || 0,
      eligibleCount: null,
      deletedIds: rows.map((r) => r.id),
      deletedRows: rows,
      dryRun: false,
    };
  });
}

/**
 * Apaga arquivos orfaos do bucket `cadastro-drafts` no Supabase Storage.
 *
 * Estrategia: para cada draft expirado removido do PG, deleta o prefix
 * `{ownerKey}/{cargaId}/` (todos os slots) do bucket. Best-effort — se o
 * Storage indisponivel, registra mas nao falha o cleanup do PG.
 *
 * @param {Array<{ driver_user_id?: string|null, cpf?: string|null, carga_id: string }>} expiredRows
 * @returns {Promise<{ storageDeletedCount: number, storageErrors: number }>}
 */
export async function cleanupOrphanStorageFiles(expiredRows) {
  const supabase = getSupabaseAdmin();
  if (!supabase || expiredRows.length === 0) {
    return { storageDeletedCount: 0, storageErrors: 0 };
  }

  let storageDeletedCount = 0;
  let storageErrors = 0;

  for (const row of expiredRows) {
    const ownerKey = row.driver_user_id || row.cpf;
    if (!ownerKey || !row.carga_id) continue;
    const prefix = `${ownerKey}/${row.carga_id}`;

    try {
      // Lista todos os arquivos sob o prefix; remove em batch.
      const { data: files, error: listError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .list(prefix, { limit: 100 });

      if (listError || !files || files.length === 0) {
        if (listError) storageErrors++;
        continue;
      }

      const paths = files.map((f) => `${prefix}/${f.name}`);
      const { error: removeError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(paths);

      if (removeError) {
        storageErrors++;
      } else {
        storageDeletedCount += paths.length;
      }
    } catch {
      storageErrors++;
    }
  }

  return { storageDeletedCount, storageErrors };
}

export const CLEANUP_MODES = ["off", "report", "on"];

/**
 * Resolve o modo do worker a partir de CANDIDATURA_DRAFT_CLEANUP_MODE.
 *
 * Default `report` — e nao `on` — porque este worker apaga de forma
 * IRREVERSIVEL: alem da linha no PG, remove do Storage a CNH, a selfie e o CRLV
 * enviados. Ele nunca rodou em producao, entao o primeiro ciclo enfrenta todo o
 * acumulado historico. `report` mede o alcance no log sem apagar nada; virar
 * `on` passa a ser decisao consciente, com o numero na mao.
 *
 * Isso inverte a convencao opt-out do resto do main.js (`!== "false"`), que e a
 * certa pra job de leitura/sync e a errada pra um expurgo de estreia.
 */
export function resolveDraftCleanupMode(rawValue = process.env.CANDIDATURA_DRAFT_CLEANUP_MODE) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  return CLEANUP_MODES.includes(normalized) ? normalized : "report";
}

/**
 * Bootstrap do worker periodico de cleanup. Roda imediatamente + a cada 1h.
 *
 * Cobre 2 camadas:
 *   1. PG `pending_driver_registrations` — drafts v2 > 72h DELETADOS.
 *   2. Supabase Storage `cadastro-drafts` — arquivos sob `{ownerKey}/{cargaId}/`
 *      dos drafts removidos no passo 1 sao limpos best-effort.
 *
 * setInterval(...).unref() para nao bloquear shutdown.
 *
 * @returns {ReturnType<typeof setInterval>|null} handle do interval, ou null se
 *   o modo for "off" (util para tests).
 */
export function startCandidaturaDraftCleanupWorker() {
  const mode = resolveDraftCleanupMode();

  if (mode === "off") {
    console.info("[draft-cleanup] desabilitado (CANDIDATURA_DRAFT_CLEANUP_MODE=off)");
    return null;
  }

  const batchSize = Number(process.env.CANDIDATURA_DRAFT_CLEANUP_BATCH || DEFAULT_CLEANUP_BATCH_SIZE);

  const runCleanup = async () => {
    try {
      const pgResult = await cleanupExpiredDrafts({ limit: batchSize, dryRun: mode === "report" });

      if (pgResult.dryRun) {
        console.info(
          "[draft-cleanup] modo report — nada foi apagado",
          JSON.stringify({
            elegiveis: pgResult.eligibleCount,
            apagaria_por_ciclo: Math.min(pgResult.eligibleCount, batchSize),
            para_habilitar: "CANDIDATURA_DRAFT_CLEANUP_MODE=on",
          }),
        );
        return;
      }

      if (pgResult.deletedCount > 0) {
        const storageResult = await cleanupOrphanStorageFiles(pgResult.deletedRows);
        console.log(
          "[draft-cleanup]",
          JSON.stringify({
            pg_deleted: pgResult.deletedCount,
            storage_deleted: storageResult.storageDeletedCount,
            storage_errors: storageResult.storageErrors,
          }),
        );
      }
    } catch (err) {
      console.error(
        "[draft-cleanup]",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Rodada imediata para garantir limpeza no boot (idempotente).
  void runCleanup();

  const handle = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  handle.unref();
  return handle;
}
