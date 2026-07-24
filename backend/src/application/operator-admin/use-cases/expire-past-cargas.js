// backend/src/application/operator-admin/use-cases/expire-past-cargas.js
//
// Transita OPEN → EXPIRED em cargas cujo (data+horario) JÁ passou e que o motorista
// não vê mais. Sem isso, cargas vencidas ficam OPEN no painel do operador (poluindo
// as listas "ativas" e criando a impressão de que "há cargas que não aparecem para o
// motorista") — o filtro de runtime (buildDriverLoadFilters) já as esconde do portal,
// mas o status só transita quando este job roda.
//
// A condição de "passado" espelha buildDriverLoadFilters. Carga LANÇADA (sistema:
// lh_manual, sem sheet_lh) tem uma JANELA DE GRAÇA: NÃO expira no mesmo dia do
// carregamento nem nos dias seguintes dentro da janela — fica visível em /cargas e
// no Monitor (pedido do operador: "a carga lançada pode expirar/trocar de status,
// mas não pode SAIR de /cargas e Monitor"). Só expira quando fica ANTIGA (data <
// hoje - GRACE dias). O portal do motorista continua escondendo carregamento
// passado (buildDriverLoadFilters, por data/horario — não depende do status).
// Cargas "a confirmar" (agenda placeholder) NUNCA expiram pelo horário 00:00.
// Preserva: templates, cargas com motorista atribuído (pipeline) e recorrentes.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

// Dias que uma carga LANÇADA (sistema) fica visível após o carregamento antes de
// expirar (some das telas do operador). Env override; default 7.
function launchedGraceDays() {
  const n = Number.parseInt(process.env.LAUNCHED_CARGO_EXPIRE_GRACE_DAYS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/**
 * @param {{ deps?: { withPgClient?: Function } }} [args]
 * @returns {Promise<{ expired: number }>}
 */
export async function expirePastCargas({ deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  // "Agora" no fuso de São Paulo (cargas.data/horario são wall-clock BRT).
  const { dateIso: hoje, timeIso: agora } = getSaoPauloWallClock();
  const graceDays = launchedGraceDays();

  return run(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE public.cargas
          SET status = 'EXPIRED', updated_at = now()
        WHERE data IS NOT NULL
          AND COALESCE(is_template, false) = false
          AND COALESCE(is_recurring, false) = false
          -- "A confirmar" (agenda placeholder, data=hoje/horario 00:00) nunca expira
          -- pelo horário — some indevidamente antes de o operador confirmar a agenda.
          AND COALESCE(agenda_a_confirmar, false) = false
          -- Carga LANÇADA (sistema) dentro da janela de graça NÃO expira — fica
          -- visível p/ o operador (não sai de /cargas e Monitor). Só expira quando
          -- data < hoje - GRACE (fica antiga).
          AND NOT (
            lh_manual IS NOT NULL AND sheet_lh IS NULL
            AND data >= ($1::date - $3::int)
          )
          AND (
            -- OPEN: passada (dia anterior OU hoje-hora-vencida). Guard de motorista
            -- (haul ativo) mantido.
            (status = 'OPEN'
              AND (data < $1 OR (data = $1 AND horario IS NOT NULL AND horario < $2))
              AND COALESCE(alloc_motorista, sheet_motorista, '') = '')
            OR
            -- DRAFT: rascunho de DIA PASSADO (nunca publicado → não é haul ativo, sem
            -- guard de motorista; sheet_motorista é só dado sincronizado). Rascunhos
            -- de hoje/futuros são preservados.
            (status = 'DRAFT' AND data < $1)
          )`,
      [hoje, agora, graceDays],
    );
    return { expired: rowCount };
  });
}
