import { withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { cancelLoadCascade } from "./use-cases/cancel-load-cascade.js";

/**
 * Varre as cargas CANCELADAS que ainda têm motorista (alocação efetiva) e dispara
 * a cascata da rota para cada uma. É o gatilho de cancelamento "vindo da planilha"
 * (o sync grava sheet_status = CANCELADO; aqui reagimos), complementando o gatilho
 * interativo do operador em updateMonitorAllocation.
 *
 * Naturalmente limitado: só pega cancelamentos AINDA não cascateados — depois da
 * cascata a carga fica sem motorista (alloc_motorista = "") e sai do filtro.
 * Cargas fixas são ignoradas (fixo é intocável). Cada cascata é idempotente.
 *
 * @param {{ operatorId?: string|null, correlationId?: string|null, limit?: number }} [args]
 * @returns {Promise<{ found: number, cascaded: number }>}
 */
export async function sweepCancelledCascades({ operatorId = null, correlationId = null, limit = 500 } = {}) {
  const candidates = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT sheet_lh FROM public.cargas
       WHERE sheet_lh IS NOT NULL
         AND alloc_pinned = false
         AND lower(COALESCE(alloc_status, sheet_status, '')) LIKE '%cancel%'
         AND COALESCE(alloc_motorista, sheet_motorista, '') <> ''
       LIMIT $1`,
      [limit],
    );
    return rows;
  });

  let cascaded = 0;
  for (const c of candidates) {
    try {
      const res = await cancelLoadCascade({ lh: c.sheet_lh, operatorId, correlationId });
      if (res.payload?.cascaded) cascaded += 1;
    } catch (err) {
      console.warn(
        `[sweep-cancelled-cascades] cascata falhou para ${c.sheet_lh}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { found: candidates.length, cascaded };
}
