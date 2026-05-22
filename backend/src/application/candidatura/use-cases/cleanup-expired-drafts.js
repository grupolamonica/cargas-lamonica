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

/**
 * Apaga drafts v2 com updated_at < now() - 72h.
 *
 * Guard rigido (status='draft' AND versao_cadastro='v2') para nunca apagar:
 *   - submissoes finais (status='pendente'/'aprovado'/'rejeitado')
 *   - cadastros v1
 *
 * @returns {Promise<{ deletedCount: number, deletedIds: string[] }>}
 */
export async function cleanupExpiredDrafts() {
  return withPgClient(async (client) => {
    const result = await client.query(
      `
        DELETE FROM public.pending_driver_registrations
        WHERE status = 'draft'
          AND versao_cadastro = 'v2'
          AND updated_at < now() - interval '72 hours'
        RETURNING id, driver_user_id, dados->>'__cpf' AS cpf, carga_id
      `,
    );

    const rows = result.rows || [];
    return {
      deletedCount: result.rowCount || 0,
      deletedIds: rows.map((r) => r.id),
      deletedRows: rows,
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
 * @returns {ReturnType<typeof setInterval>} handle do interval (util para tests).
 */
export function startCandidaturaDraftCleanupWorker() {
  const runCleanup = async () => {
    try {
      const pgResult = await cleanupExpiredDrafts();
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
