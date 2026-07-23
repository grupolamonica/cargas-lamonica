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

const DEFAULTS = { spotAutolaunchEnabled: true, alertRouteKeys: [] };

// Coluna spot_alert_route_keys (DC-279) pode não existir ainda (migration não
// rodou) — degradamos para lista vazia sem derrubar a leitura das demais flags.
function isMissingColumn(err) {
  return Boolean(err) && (err.code === "42703" || /column .* does not exist/i.test(err.message || ""));
}

function normalizeRouteKeys(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const key = String(entry ?? "").trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** Lê a linha singleton (id=1). Default LIGADO se a tabela/linha não existir. */
export async function getProgramacaoSettings({ deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  const readRow = (columns) =>
    run((client) =>
      client
        .query(`SELECT ${columns} FROM public.programacao_settings WHERE id = 1`)
        .then((r) => r.rows[0] || null),
    );
  try {
    let row;
    try {
      row = await readRow("spot_autolaunch_enabled, spot_alert_route_keys, updated_at");
    } catch (err) {
      // Migration do DC-279 ainda não rodou: relê sem a coluna nova.
      if (!isMissingColumn(err)) throw err;
      row = await readRow("spot_autolaunch_enabled, updated_at");
    }
    if (!row) return { ...DEFAULTS, updatedAt: null };
    return {
      spotAutolaunchEnabled: Boolean(row.spot_autolaunch_enabled),
      alertRouteKeys: normalizeRouteKeys(row.spot_alert_route_keys),
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
  await run(async (client) => {
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
    if (Array.isArray(patch.alertRouteKeys)) {
      await client.query(
        `UPDATE public.programacao_settings
            SET spot_alert_route_keys = $1::jsonb, updated_at = now(), updated_by = $2
          WHERE id = 1`,
        [JSON.stringify(normalizeRouteKeys(patch.alertRouteKeys)), operatorId],
      );
    }
  });
  // Estado final lido FORA da transação, pelo leitor tolerante a coluna ausente
  // (review DC-279 #4): um SELECT da coluna nova DENTRO da txn abortaria a txn se a
  // migration do DC-279 ainda não tivesse rodado — quebrando o toggle DC-201.
  return getProgramacaoSettings({ deps });
}

/**
 * Conveniência p/ o scanner de notificação de spot (DC-279): quais route keys
 * o operador marcou p/ alertar. Lista vazia = feature inerte. Erros de leitura
 * NÃO derrubam o ciclo (retorna []).
 */
export async function getSpotAlertRouteKeys({ deps = {} } = {}) {
  try {
    const s = await getProgramacaoSettings({ deps });
    return Array.isArray(s.alertRouteKeys) ? s.alertRouteKeys : [];
  } catch {
    return [];
  }
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
