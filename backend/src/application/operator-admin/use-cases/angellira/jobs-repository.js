/**
 * Acesso a `public.external_registration_jobs` para o pipeline Angellira.
 *
 * Padrão: cada step (proprietario_cavalo, cavalo, proprietario_carreta,
 * carreta, motorista) tem 1 row. Idempotência via lookup por
 * (cadastro_id, target='angellira', step).
 *
 * DC-115 cria a tabela. DC-116 usa.
 */

import { stripUuidIfInvalid } from "./_utils.js";

/**
 * Insere ou retorna jobs PENDING para cada etapa do pipeline Angellira.
 * Usa ON CONFLICT? Não — `external_registration_jobs` permite múltiplos rows
 * pra retry; idempotência fica no use case (verifica status=OK antes de
 * disparar).
 *
 * @param {Object} args
 * @param {import('pg').PoolClient} args.client
 * @param {string} args.cadastroId
 * @param {string} [args.driverUserId]
 * @param {string[]} args.steps      — ex: ['proprietario_cavalo','cavalo','motorista']
 * @param {string} [args.createdBy]  — operatorId
 * @returns {Promise<Array<{id, step, status}>>}
 */
export async function createPendingJobs({
  client,
  cadastroId,
  driverUserId = null,
  steps,
  createdBy = null,
  target = "angellira",
}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return [];
  }
  const rows = [];
  for (const step of steps) {
    const { rows: inserted } = await client.query(
      `
        INSERT INTO public.external_registration_jobs
          (cadastro_id, driver_user_id, target, step, status, created_by)
        VALUES ($1, $2, $3, $4, 'PENDING', $5)
        RETURNING id, step, status
      `,
      [cadastroId, stripUuidIfInvalid(driverUserId), target, step, stripUuidIfInvalid(createdBy)],
    );
    rows.push(inserted[0]);
  }
  return rows;
}

/**
 * Verifica se já existe um job OK para esta etapa (idempotência).
 * Se sim, devolve a row OK pra caller pular o re-dispatch.
 */
export async function findExistingOkJob({ client, cadastroId, step, target = "angellira" }) {
  const { rows } = await client.query(
    `
      SELECT id, status, external_id, response, finished_at
      FROM public.external_registration_jobs
      WHERE cadastro_id = $1
        AND target = $2
        AND step = $3
        AND status = 'OK'
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 1
    `,
    [cadastroId, target, step],
  );
  return rows[0] || null;
}

/**
 * Marca um job como IN_PROGRESS no início e devolve a row (com attempts + 1).
 * Usa SELECT FOR UPDATE pra evitar 2 workers pegarem o mesmo step.
 */
export async function markJobInProgress({ client, cadastroId, step, payload = {}, target = "angellira" }) {
  // Pega o job PENDING mais recente; se não houver, cria um (re-tentativa
  // manual após OK/ERROR antigo).
  const { rows: pending } = await client.query(
    `
      SELECT id FROM public.external_registration_jobs
      WHERE cadastro_id = $1 AND target = $2 AND step = $3
        AND status IN ('PENDING', 'ERROR')
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE
    `,
    [cadastroId, target, step],
  );

  let jobId;
  if (pending.length) {
    jobId = pending[0].id;
    await client.query(
      `
        UPDATE public.external_registration_jobs
        SET status = 'IN_PROGRESS', attempts = attempts + 1,
            started_at = now(), payload = $1
        WHERE id = $2
      `,
      [payload, jobId],
    );
  } else {
    const { rows: created } = await client.query(
      `
        INSERT INTO public.external_registration_jobs
          (cadastro_id, target, step, status, payload, attempts, started_at)
        VALUES ($1, $2, $3, 'IN_PROGRESS', $4, 1, now())
        RETURNING id
      `,
      [cadastroId, target, step, payload],
    );
    jobId = created[0].id;
  }

  return jobId;
}

/**
 * Marca job como OK com response + external_id.
 */
export async function markJobOk({ client, jobId, response, externalId = null }) {
  await client.query(
    `
      UPDATE public.external_registration_jobs
      SET status = 'OK', response = $1, external_id = $2, finished_at = now()
      WHERE id = $3
    `,
    [response, externalId, jobId],
  );
}

/**
 * Marca job como ERROR com error payload estruturado.
 */
export async function markJobError({ client, jobId, error }) {
  await client.query(
    `
      UPDATE public.external_registration_jobs
      SET status = 'ERROR', error = $1, finished_at = now()
      WHERE id = $2
    `,
    [error, jobId],
  );
}

/**
 * Lista todos os jobs de um cadastro (paginação simples).
 */
export async function listJobsByCadastro({ client, cadastroId, limit = 100, offset = 0 }) {
  const { rows } = await client.query(
    `
      SELECT id, cadastro_id, driver_user_id, target, step, status,
             payload, response, error, external_id, attempts,
             started_at, finished_at, created_at, updated_at
      FROM public.external_registration_jobs
      WHERE cadastro_id = $1
      ORDER BY created_at ASC
      LIMIT $2 OFFSET $3
    `,
    [cadastroId, limit, offset],
  );
  return rows;
}
