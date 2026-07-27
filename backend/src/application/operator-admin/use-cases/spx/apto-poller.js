// Poller de "apto" do SPX.
//
// Um cadastro novo/importado no SPX fica salvo como RASCUNHO (etapa
// importado/request_pendente/completo) aguardando a Shopee aprovar — o job volta
// status "OK", mas NÃO é "cadastrado" ainda (ver deriveSpxOutcome no front). Este
// job periódico reavalia esses rascunhos via performSpxPrecheck(skipCache) e,
// quando a Shopee aprova (o precheck passa a devolver IS_MATCHED_NOSSA = ativo na
// NOSSA agência), promove o rótulo do job para "apto"
// (etapa = ja_cadastrado_nossa_agencia), que o painel passa a mostrar como APTO.
//
// É SÓ rótulo do cadastro externo — NÃO cria/ativa driver_profile nem mexe no
// status do cadastro (isso é do fluxo de aprovação do Angellira). Espelha o
// desligamento em 3 camadas do auto-approve: env kill-switch + toggle em
// app_settings + guarda de reentrância.
import { withPgClient } from "../../../../infrastructure/pg/postgres.js";
import { performSpxPrecheck } from "./precheck.js";
import { ensureAppSettingsTable } from "../angellira/auto-approve-vigentes.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

export const SPX_APTO_POLL_SETTING_KEY = "auto_apto_spx";

const DEFAULT_BATCH = 25;
const PACING_MS = 250; // serial + pausa: o precheck bate no bot SPX (externo).

// Etapas de RASCUNHO (aguardando aprovação da Shopee) que o poller reavalia.
const DRAFT_ETAPAS = ["importado", "request_pendente", "completo"];
// Etapa final quando aprovado — o painel (SPX_ETAPAS_APTO) trata como APTO.
const APTO_ETAPA = "ja_cadastrado_nossa_agencia";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Guard de reentrância (módulo ESM = singleton): impede o timer e o "rodar
// agora" de colidirem.
let running = false;
export function isSpxAptoPollRunning() {
  return running;
}

/** Lê o setting do poller. Default: desligado. */
export async function getSpxAptoPollSetting() {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    const { rows } = await client.query(
      `SELECT value FROM public.app_settings WHERE key = $1`,
      [SPX_APTO_POLL_SETTING_KEY],
    );
    const value = rows[0]?.value || {};
    return { enabled: Boolean(value.enabled), lastRun: value.lastRun || null };
  });
}

/** Liga/desliga o poller (o "rodar agora" independe disto). */
export async function setSpxAptoPollEnabled({ enabled, actorId = null }) {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `
      INSERT INTO public.app_settings (key, value, updated_by)
      VALUES ($1, jsonb_build_object('enabled', $2::boolean), $3)
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{enabled}', to_jsonb($2::boolean)),
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      `,
      [SPX_APTO_POLL_SETTING_KEY, Boolean(enabled), actorId],
    );
    return { enabled: Boolean(enabled) };
  });
}

async function persistLastRun(summary) {
  await withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `
      INSERT INTO public.app_settings (key, value)
      VALUES ($1, jsonb_build_object('lastRun', $2::jsonb))
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{lastRun}', $2::jsonb),
        updated_at = now()
      `,
      [SPX_APTO_POLL_SETTING_KEY, JSON.stringify(summary)],
    );
  });
}

/**
 * Reavalia até `limit` cadastros com SPX em rascunho (mais recentes por
 * cadastro) e promove p/ "apto" os que a Shopee já aprovou (IS_MATCHED_NOSSA).
 *
 * @param {object} opts
 * @param {number} [opts.limit=25]
 * @param {boolean} [opts.apply=true]  false = simulação (não grava)
 * @param {"timer"|"manual"} [opts.trigger="manual"]
 * @param {string|null} [opts.correlationId]
 * @returns {Promise<object>} { skipped?, candidates, checked, aptos, aindaRascunho, unavailable, updated, applied, trigger }
 */
export async function runSpxAptoPoll({
  limit = DEFAULT_BATCH,
  apply = true,
  trigger = "manual",
  correlationId = null,
} = {}) {
  if (running) return { skipped: true, reason: "already_running" };
  running = true;
  const startedAt = Date.now();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || DEFAULT_BATCH));

  try {
    // 1. Jobs SPX do motorista em RASCUNHO (status OK + etapa de rascunho), o
    //    mais recente por cadastro, com o `dados` p/ alimentar o precheck.
    let rows = [];
    await withPgClient(async (client) => {
      const res = await client.query(
        `
        WITH latest AS (
          SELECT DISTINCT ON (j.cadastro_id)
                 j.id, j.cadastro_id, j.driver_user_id,
                 j.response->>'etapa' AS etapa, p.dados
            FROM public.external_registration_jobs j
            JOIN public.pending_driver_registrations p ON p.id = j.cadastro_id
           WHERE j.target = 'spx' AND j.step = 'spx_motorista' AND j.status = 'OK'
           ORDER BY j.cadastro_id, j.finished_at DESC NULLS LAST
        )
        SELECT id, cadastro_id, driver_user_id, etapa, dados
          FROM latest
         WHERE etapa = ANY($1)
         LIMIT $2
        `,
        [DRAFT_ETAPAS, safeLimit],
      );
      rows = res.rows;
    });

    const result = {
      candidates: rows.length,
      checked: 0,
      aptos: 0,
      aindaRascunho: 0,
      unavailable: 0,
      updated: 0,
    };

    const toApto = []; // { jobId, etapaAnterior }

    // 2. Serial + pausa (o precheck bate no bot SPX). Circuit-breaker do próprio
    //    bot protege contra martelar; aqui só espaçamos.
    for (const row of rows) {
      const cpf = String(row?.dados?.motorista?.cpf ?? "").replace(/\D/g, "");
      if (cpf.length !== 11) continue; // sem CPF não dá p/ consultar
      let pre;
      try {
        pre = await performSpxPrecheck({
          cadastro: { id: row.cadastro_id, dados: row.dados },
          correlationId,
          skipCache: true, // sempre re-consulta (o cache de 60s mascararia a aprovação)
        });
      } catch {
        result.unavailable += 1;
        await sleep(PACING_MS);
        continue;
      }
      result.checked += 1;
      if (pre.status === "UNAVAILABLE") {
        result.unavailable += 1; // transitório — reavalia na próxima leva
      } else if (pre.status === "IS_MATCHED_NOSSA") {
        toApto.push({ jobId: row.id, etapaAnterior: row.etapa });
      } else {
        result.aindaRascunho += 1; // segue rascunho (ainda não aprovado)
      }
      await sleep(PACING_MS);
    }

    // 3. Promove p/ apto os aprovados. jsonb_set preserva o resto do response;
    //    a guarda `response->>'etapa' = etapaAnterior` evita clobber concorrente.
    if (apply && toApto.length) {
      const nowIso = new Date().toISOString();
      for (const { jobId, etapaAnterior } of toApto) {
        const { rowCount } = await withPgClient((client) =>
          client.query(
            `
            UPDATE public.external_registration_jobs
               SET response = jsonb_set(
                     jsonb_set(
                       jsonb_set(COALESCE(response, '{}'::jsonb), '{etapa}', to_jsonb($2::text)),
                       '{etapa_anterior}', to_jsonb($3::text)),
                     '{apto_via_poller_at}', to_jsonb($4::text)),
                   updated_at = now()
             WHERE id = $1 AND status = 'OK' AND response->>'etapa' = $3
            `,
            [jobId, APTO_ETAPA, etapaAnterior, nowIso],
          ),
        );
        if (rowCount) {
          result.aptos += 1;
          result.updated += 1;
        }
      }
    }

    const summary = {
      at: new Date().toISOString(),
      trigger,
      applied: Boolean(apply),
      ...result,
      durationMs: Date.now() - startedAt,
    };
    if (apply) await persistLastRun(summary);
    logStructuredEvent("info", "spx-apto-poll.run", { correlationId, ...summary });
    return summary;
  } finally {
    running = false;
  }
}
