import { withPgClient, withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { logger } from "../../../infrastructure/logger.js";
import { createSupabaseAdminClient, syncGoogleSheetLoads } from "../../google-sheets/google-sheet-loads.js";

let workerRunning = false;

export async function enqueueSheetSyncJob({ operatorId, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO public.sheet_sync_jobs (operator_id)
       VALUES ($1)
       RETURNING id, status, created_at`,
      [operatorId],
    );
    const job = rows[0];
    logger.info({ jobId: job.id, operatorId, correlationId }, "sheet-sync-queue: job enqueued");
    return job.id;
  });
}

export async function getSheetSyncJob(jobId) {
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, operator_id, status, result, error, created_at, started_at, finished_at
       FROM public.sheet_sync_jobs
       WHERE id = $1`,
      [jobId],
    );
    return rows[0] ?? null;
  });
}

export async function processNextSheetSyncJob() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    await withPgTransaction(async (client) => {
      // Claim one pending job with advisory lock to prevent double-processing
      const { rows } = await client.query(
        `UPDATE public.sheet_sync_jobs
         SET status = 'running', started_at = NOW()
         WHERE id = (
           SELECT id FROM public.sheet_sync_jobs
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
      );

      if (!rows[0]) return;

      const jobId = rows[0].id;

      try {
        const supabaseClient = createSupabaseAdminClient();
        const result = await syncGoogleSheetLoads({ supabaseClient });

        await client.query(
          `UPDATE public.sheet_sync_jobs
           SET status = 'done', result = $2, finished_at = NOW()
           WHERE id = $1`,
          [jobId, JSON.stringify(result ?? {})],
        );

        logger.info({ jobId, inserted: result?.inserted, updated: result?.updated }, "sheet-sync-queue: job done");
      } catch (err) {
        await client.query(
          `UPDATE public.sheet_sync_jobs
           SET status = 'failed', error = $2, finished_at = NOW()
           WHERE id = $1`,
          [jobId, err instanceof Error ? err.message : String(err)],
        );
        logger.error({ err, jobId }, "sheet-sync-queue: job failed");
      }
    });
  } catch (err) {
    logger.error({ err }, "sheet-sync-queue: worker error");
  } finally {
    workerRunning = false;
  }
}
