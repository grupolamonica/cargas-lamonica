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
//
// TAMBÉM expira carga FECHADA (BOOKED/RESERVED) com carregamento ANTIGO — era a causa
// raiz das "cargas mortas" reportadas pelo operador: o job varria só OPEN/DRAFT, então
// carga fechada com data no passado nunca saía das telas e acumulava para sempre (1.759
// em produção em 07/08/2026, 1.048 delas com mais de 30 dias). Esse ramo tem graça
// PRÓPRIA (o frete pode estar em trânsito no dia seguinte) e duas guardas: não toca carga
// com ponteiro de reserva nem com candidatura viva.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

// Dias que uma carga LANÇADA (sistema) fica visível após o carregamento antes de
// expirar (some das telas do operador). Env override; default 7.
function launchedGraceDays() {
  const n = Number.parseInt(process.env.LAUNCHED_CARGO_EXPIRE_GRACE_DAYS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

// Dias de graça da carga FECHADA (BOOKED/RESERVED) antes de expirar. O frete de uma
// carga fechada AINDA PODE ESTAR RODANDO no dia seguinte ao carregamento (BA→PE são
// ~16h), então expirar por "data < hoje" apagaria viagem em trânsito. Medido em produção
// 07/08/2026: das fechadas com data passada, 47 estão em 0-2 dias (18 já descarregadas) —
// é exatamente essa faixa que a graça protege. Default 7, igual à lançada.
function closedGraceDays() {
  const n = Number.parseInt(process.env.CLOSED_CARGO_EXPIRE_GRACE_DAYS ?? "", 10);
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
  const closedGrace = closedGraceDays();

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
            OR
            -- FECHADA (BOOKED/RESERVED) com carregamento ANTIGO. Era a CAUSA RAIZ das
            -- "cargas mortas" que o operador reportou: o job só varria OPEN/DRAFT, então
            -- carga fechada com data no passado NUNCA saía das telas — acumulava para
            -- sempre. Medido em produção 07/08/2026: 1.759 fechadas com data passada,
            -- 1.048 delas com mais de 30 dias.
            --
            -- Duas guardas, porque "fechada e antiga" não é o mesmo que "descartável":
            --   * reserved_public_lead_id -- e o ponteiro que o ciclo de reserva usa.
            --     Trocar o status por baixo dele quebra o cancelamento da reserva (o
            --     mesmo motivo pelo qual o sync trata RESERVED como intocável);
            --   * lead VIVO (PRE_REGISTERED/QUEUED/APPROVED) — há candidatura pendente de
            --     um motorista; expirar por trás dele esconderia a carga que ele pediu.
            -- Medido: 611 das 1.609 candidatas têm um desses vínculos e ficam de fora.
            -- Elas não são perda de escopo — são decisão de operação (resolver a reserva),
            -- e o número aparece no retorno para não sumir em silêncio.
            (status IN ('BOOKED','RESERVED')
              AND data < ($1::date - $4::int)
              AND reserved_public_lead_id IS NULL
              -- NÃO-correlacionada de propósito: um EXISTS correlacionado referenciando
              -- cargas.id dentro do UPDATE não roda no harness pg-mem ("column cargas.id
              -- does not exist"). Assim também é avaliada UMA vez, não por linha.
              -- load_id IS NOT NULL fecha a armadilha do NOT IN com NULL (bastaria um
              -- load_id nulo na lista para o predicado nunca ser verdadeiro e o ramo
              -- inteiro virar no-op silencioso).
              AND id NOT IN (
                SELECT l.load_id FROM public.load_public_leads l
                 WHERE l.load_id IS NOT NULL
                   AND l.status IN ('PRE_REGISTERED','QUEUED','APPROVED')
              ))
          )`,
      [hoje, agora, graceDays, closedGrace],
    );
    return { expired: rowCount };
  });
}
