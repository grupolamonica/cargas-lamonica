import { withPgClient } from "../../../infrastructure/pg/postgres.js";

// Cutoff REVERSÍVEL do backlog de pendentes (feature "zerar a fila").
//
// Guarda um timestamp em app_settings. Quando setado, TODO cadastro pendente
// criado ATÉ o cutoff é tratado como "backlog" → vai pra aba "Dados incompletos"
// (que agora é acionável), deixando a fila "Pendentes de revisão" só com os
// cadastros novos (created_at > cutoff). Nenhuma linha de cadastro muda no banco
// — é só um marcador de configuração. Para desfazer: limpar o cutoff (null).

export const BACKLOG_CUTOFF_SETTING_KEY = "pendentes_backlog_cutoff";

/** @returns {Promise<string|null>} ISO do cutoff, ou null quando não há. */
export async function getBacklogCutoff() {
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT value FROM public.app_settings WHERE key = $1`,
      [BACKLOG_CUTOFF_SETTING_KEY],
    );
    const raw = rows[0]?.value?.cutoff ?? null;
    return typeof raw === "string" && raw.trim() ? raw : null;
  });
}

/**
 * Define (ou limpa) o cutoff. `cutoffIso=null` desfaz (fila volta ao normal).
 * Mantém o mesmo shape/upsert do auto-approve (app_settings key/value/updated_by).
 */
export async function setBacklogCutoff({ cutoffIso, actorId = null }) {
  const value = cutoffIso ? String(cutoffIso) : null;
  return withPgClient(async (client) => {
    await client.query(
      `
      INSERT INTO public.app_settings (key, value, updated_by)
      VALUES ($1, jsonb_build_object('cutoff', $2::text), $3)
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{cutoff}', to_jsonb($2::text)),
        updated_by = $3,
        updated_at = now()
      `,
      [BACKLOG_CUTOFF_SETTING_KEY, value, actorId],
    );
    return { cutoffIso: value };
  });
}
