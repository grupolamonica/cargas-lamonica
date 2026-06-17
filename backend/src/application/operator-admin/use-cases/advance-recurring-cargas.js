import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { computeNextRecurrenceDate, toIsoDate } from "../../../domain/recurrence.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

// Re-export para compat com importadores existentes (e testes da função pura).
export { computeNextRecurrenceDate };

/**
 * Avança a data das cargas recorrentes ABERTAS cujo horário já passou para a
 * próxima ocorrência, mantendo-as perpetuamente na fila sem o operador recriar.
 * Idempotente: cargas já visíveis não são tocadas. Cargas reservadas/terminais
 * são ignoradas (a recorrência delas continua via clone-on-reserve).
 *
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ advanced: number, scanned: number }>}
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
      await client.query(
        `
          UPDATE public.cargas
          SET data = $2, version = version + 1, updated_at = now()
          WHERE id = $1 AND is_recurring = true AND status = 'OPEN'
        `,
        [row.id, nextDate],
      );
      advanced += 1;
    }

    if (advanced > 0) {
      logStructuredEvent("info", "recurring-cargo.advanced", { advanced, scanned: rows.length });
    }

    return { advanced, scanned: rows.length };
  });
}
