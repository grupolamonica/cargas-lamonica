// backend/src/application/operator-admin/use-cases/expire-past-cargas.js
//
// Transita OPEN → EXPIRED em cargas cujo (data+horario) JÁ passou e que o motorista
// não vê mais. Sem isso, cargas vencidas ficam OPEN no painel do operador (poluindo
// as listas "ativas" e criando a impressão de que "há cargas que não aparecem para o
// motorista") — o filtro de runtime (buildDriverLoadFilters) já as esconde do portal,
// mas o status só transita quando este job roda.
//
// A condição de "passado" espelha EXATAMENTE buildDriverLoadFilters, INCLUSIVE a
// exceção de carga LANÇADA (sheet_lh NULL + lh_manual + data >= hoje fica visível o
// dia todo) — senão expiraríamos uma carga que o motorista ainda enxerga. Preserva:
// templates, cargas com motorista atribuído (pipeline) e recorrentes (o motor de
// recorrência as avança; expirar quebraria a cadeia).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

/**
 * @param {{ deps?: { withPgClient?: Function } }} [args]
 * @returns {Promise<{ expired: number }>}
 */
export async function expirePastCargas({ deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  // "Agora" no fuso de São Paulo (cargas.data/horario são wall-clock BRT).
  const { dateIso: hoje, timeIso: agora } = getSaoPauloWallClock();

  return run(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE public.cargas
          SET status = 'EXPIRED', updated_at = now()
        WHERE data IS NOT NULL
          AND COALESCE(is_template, false) = false
          AND COALESCE(is_recurring, false) = false
          AND (
            -- OPEN: passada (dia anterior OU hoje-hora-vencida), respeitando a exceção
            -- da carga lançada (visível o dia todo) e o guard de motorista (haul ativo).
            (status = 'OPEN'
              AND (data < $1 OR (data = $1 AND horario IS NOT NULL AND horario < $2))
              AND NOT (sheet_lh IS NULL AND lh_manual IS NOT NULL AND data >= $1)
              AND COALESCE(alloc_motorista, sheet_motorista, '') = '')
            OR
            -- DRAFT: rascunho de DIA PASSADO (nunca publicado → não é haul ativo, sem
            -- exceção de lançada nem guard de motorista; sheet_motorista é só dado
            -- sincronizado). Rascunhos de hoje/futuros são preservados.
            (status = 'DRAFT' AND data < $1)
          )`,
      [hoje, agora],
    );
    return { expired: rowCount };
  });
}
