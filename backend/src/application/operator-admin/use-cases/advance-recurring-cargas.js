import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { addDaysIso, computeNextRecurrenceDate, toIsoDate } from "../../../domain/recurrence.js";
import { syncedCarregamentoLabel } from "../../../domain/cargo-schedule.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

// Re-export para compat com importadores existentes (e testes da função pura).
export { computeNextRecurrenceDate };

/**
 * Avança a data das cargas recorrentes ABERTAS cujo horário já passou para a
 * próxima ocorrência, mantendo-as perpetuamente na fila sem o operador recriar.
 * Idempotente: cargas já visíveis não são tocadas. Cargas reservadas/terminais
 * são ignoradas aqui (a recorrência delas continua via clone-on-reserve) — mas
 * cadeias que perderam a sucessora OPEN são retomadas por
 * reviveOrphanRecurrenceChains (auto-cura), fechando o buraco em que um clone
 * falho/interrompido matava a cadeia silenciosamente.
 *
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ advanced: number, scanned: number, revived: number }>}
 */
export async function advanceRecurringCargas({ now = new Date() } = {}) {
  return withPgTransaction(async (client) => {
    // Relógio de São Paulo (container roda em UTC; cargas.data/horario são BRT) —
    // idêntico a buildDriverLoadFilters, para varrer exatamente as cargas que o
    // portal considera vencidas.
    const { dateIso: todayIso, timeIso: nowTime } = getSaoPauloWallClock(now);

    const { rows } = await client.query(
      `
        SELECT
          id,
          data,
          horario,
          sheet_data_carregamento,
          COALESCE(recurrence_interval_days, 1) AS interval_days
        FROM public.cargas
        WHERE is_recurring = true
          AND status = 'OPEN'
          AND (data < $1 OR (data = $1 AND horario < $2))
        FOR UPDATE
      `,
      [todayIso, nowTime],
    );

    let advanced = 0;
    for (const row of rows) {
      const currentDateIso = toIsoDate(row.data);
      const horario = String(row.horario).slice(0, 8);
      const nextDate = computeNextRecurrenceDate(currentDateIso, horario, Number(row.interval_days), now);
      if (nextDate === currentDateIso) {
        continue;
      }
      // Mantém o rótulo denormalizado de carregamento em sincronia com a nova
      // data (só quando já preenchido — preserva NULL). Sem isso, o campo
      // congela na data antiga e as telas que o preferem mostram a agenda velha.
      const nextCarreg = syncedCarregamentoLabel(row.sheet_data_carregamento, nextDate, row.horario);
      await client.query(
        `
          UPDATE public.cargas
          SET data = $2, sheet_data_carregamento = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND is_recurring = true AND status = 'OPEN'
        `,
        [row.id, nextDate, nextCarreg],
      );
      advanced += 1;
    }

    if (advanced > 0) {
      logStructuredEvent("info", "recurring-cargo.advanced", { advanced, scanned: rows.length });
    }

    // Auto-cura: retoma cadeias recorrentes órfãs (reservadas/booked, vencidas e
    // sem nenhuma carga OPEN) que o clone-on-reserve deixou de renovar.
    const revived = await reviveOrphanRecurrenceChains(client, now, todayIso, nowTime);

    return { advanced, scanned: rows.length, revived };
  });
}

/**
 * Auto-cura de cadeias recorrentes ÓRFÃS.
 *
 * O clone-on-reserve (load-claims) é a única engrenagem que renova a cadeia
 * quando a carga é RESERVADA: cria a próxima ocorrência OPEN e marca a reservada
 * como is_recurring=false. Se esse clone falha/é interrompido (erro do sidecar,
 * restart no meio, sucessora removida), a cadeia fica sem NENHUMA carga OPEN — a
 * cauda é RESERVED/BOOKED e is_recurring=false, então nem o clone nem o
 * auto-avanço (que só toca OPEN) a resgatam. A cadeia morre silenciosamente.
 *
 * Esta rotina detecta essas cadeias e recria a próxima ocorrência OPEN
 * recorrente, retomando a renovação. Conservadora e idempotente:
 *   - só cadeias SEM nenhuma carga OPEN (uma OPEN viva já é cuidada pelo avanço);
 *   - só se a cauda está RESERVED/BOOKED (cadeia em uso ativo) — nunca
 *     EXPIRED/CANCELLED, que podem ter sido encerradas de propósito;
 *   - só se a cauda já venceu (data/horário passaram);
 *   - assim que a sucessora OPEN existe, a cadeia deixa de ser órfã (no-op).
 *
 * Agrupa/filtra em JS (SQL simples) para rodar tanto no Postgres real quanto no
 * motor de teste in-memory (sem window functions).
 *
 * @returns {Promise<number>} nº de cadeias retomadas
 */
async function reviveOrphanRecurrenceChains(client, now, todayIso, nowTime) {
  const { rows } = await client.query(
    `
      SELECT
        id, data, horario, origem, destino, distancia_km, duracao_horas,
        perfil, valor, bonus, bonus_exigencias, driver_visibility,
        cliente_id, created_by, sheet_data_carregamento, sheet_data_descarga,
        status, is_recurring,
        COALESCE(recurrence_interval_days, 1) AS interval_days,
        COALESCE(recurrence_parent_id, id) AS chain_root
      FROM public.cargas
      WHERE recurrence_interval_days IS NOT NULL
    `,
  );

  // Agrupa por raiz da cadeia (recurrence_parent_id, ou o próprio id na raiz).
  const chains = new Map();
  for (const row of rows) {
    const key = String(row.chain_root);
    const members = chains.get(key);
    if (members) members.push(row);
    else chains.set(key, [row]);
  }

  const sortKey = (r) => `${toIsoDate(r.data)} ${String(r.horario || "00:00:00").slice(0, 8)}`;

  let revived = 0;
  for (const members of chains.values()) {
    // Cadeia viva: já tem uma carga OPEN → o auto-avanço cuida dela.
    if (members.some((m) => m.status === "OPEN")) continue;

    // Cauda = ocorrência mais recente da cadeia (maior data + horário).
    const tail = members.reduce((a, b) => (sortKey(b) > sortKey(a) ? b : a));

    // Só retoma cadeias EM USO (cauda reservada/booked). EXPIRED/CANCELLED podem
    // ter sido encerradas de propósito — não ressuscita.
    if (tail.status !== "RESERVED" && tail.status !== "BOOKED") continue;

    // Só se a cauda já venceu (senão a próxima ainda não é devida).
    const tailDate = toIsoDate(tail.data);
    const tailTime = String(tail.horario || "00:00:00").slice(0, 8);
    const overdue = tailDate < todayIso || (tailDate === todayIso && tailTime < nowTime);
    if (!overdue) continue;

    const interval = Number(tail.interval_days) > 0 ? Number(tail.interval_days) : 1;
    const startIso = addDaysIso(tailDate, interval);
    const nextDate = computeNextRecurrenceDate(startIso, tailTime, interval, now);
    // Deriva o rótulo da nova ocorrência da data/horário dela (não copia o da
    // cauda, que pode estar defasado); preserva NULL.
    const nextCarreg = syncedCarregamentoLabel(tail.sheet_data_carregamento, nextDate, tail.horario);

    await client.query(
      `
        INSERT INTO public.cargas (
          data, horario, origem, destino, distancia_km, duracao_horas,
          perfil, valor, bonus, bonus_exigencias, driver_visibility,
          cliente_id, status, is_template, created_by,
          sheet_data_carregamento, sheet_data_descarga,
          is_recurring, recurrence_interval_days, recurrence_parent_id
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, 'OPEN', false, $13, $14, $15,
          true, $16, $17
        )
      `,
      [
        nextDate, tail.horario, tail.origem, tail.destino, tail.distancia_km, tail.duracao_horas,
        tail.perfil, tail.valor, tail.bonus, tail.bonus_exigencias, tail.driver_visibility,
        tail.cliente_id, tail.created_by, nextCarreg, tail.sheet_data_descarga,
        interval, tail.chain_root,
      ],
    );
    revived += 1;
  }

  if (revived > 0) {
    logStructuredEvent("warn", "recurring-cargo.chain-revived", { revived });
  }
  return revived;
}
