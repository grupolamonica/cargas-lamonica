// backend/src/application/operator-admin/use-cases/programacao-settings.js
//
// DC-201 — settings da tela Programação controláveis pelo operador. Hoje só o
// toggle do auto-lançamento de spots com rota (spot_autolaunch_enabled), mas o
// módulo é o ponto único p/ futuras flags da Programação.
//
// Fonte da verdade: tabela singleton public.programacao_settings (id=1). O scanner
// (main.js) lê a flag a cada ciclo. A env SPOT_AUTOLAUNCH_ENABLED=false é um
// kill-switch de infra ACIMA disto (força off). Tolerante a tabela ausente: se a
// migration ainda não rodou, cai no default LIGADO (o comportamento pré-feature).

import { withPgClient, withPgTransaction } from "../../../infrastructure/pg/postgres.js";

function isMissingTable(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

const DEFAULTS = { spotAutolaunchEnabled: true };

/** Lê a linha singleton (id=1). Default LIGADO se a tabela/linha não existir. */
export async function getProgramacaoSettings({ deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  try {
    const row = await run((client) =>
      client
        .query(
          `SELECT spot_autolaunch_enabled, updated_at FROM public.programacao_settings WHERE id = 1`,
        )
        .then((r) => r.rows[0] || null),
    );
    if (!row) return { ...DEFAULTS, updatedAt: null };
    return {
      spotAutolaunchEnabled: Boolean(row.spot_autolaunch_enabled),
      updatedAt: row.updated_at ?? null,
    };
  } catch (err) {
    if (isMissingTable(err)) return { ...DEFAULTS, updatedAt: null };
    throw err;
  }
}

/**
 * Aplica um patch parcial na linha singleton (cria se não existir). Hoje só
 * spotAutolaunchEnabled. Retorna o estado resultante.
 */
export async function updateProgramacaoSettings({ patch = {}, operatorId = null, deps = {} } = {}) {
  const run = deps.withPgTransaction || withPgTransaction;
  return run(async (client) => {
    await client.query(
      `INSERT INTO public.programacao_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    );
    if (typeof patch.spotAutolaunchEnabled === "boolean") {
      await client.query(
        `UPDATE public.programacao_settings
            SET spot_autolaunch_enabled = $1, updated_at = now(), updated_by = $2
          WHERE id = 1`,
        [patch.spotAutolaunchEnabled, operatorId],
      );
    }
    const row = await client
      .query(`SELECT spot_autolaunch_enabled, updated_at FROM public.programacao_settings WHERE id = 1`)
      .then((r) => r.rows[0] || null);
    return {
      spotAutolaunchEnabled: row ? Boolean(row.spot_autolaunch_enabled) : DEFAULTS.spotAutolaunchEnabled,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/**
 * Conveniência p/ o scanner: o auto-lançamento está ligado? Kill-switch de infra
 * (SPOT_AUTOLAUNCH_ENABLED=false) vence a linha do banco. Em erro de leitura,
 * NÃO derruba o ciclo — assume o default (ligado).
 */
export async function isSpotAutolaunchEnabled({ deps = {} } = {}) {
  if (String(process.env.SPOT_AUTOLAUNCH_ENABLED).trim() === "false") return false;
  try {
    const s = await getProgramacaoSettings({ deps });
    return s.spotAutolaunchEnabled;
  } catch {
    return true;
  }
}
