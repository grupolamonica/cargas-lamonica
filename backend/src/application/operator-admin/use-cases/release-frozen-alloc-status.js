// backend/src/application/operator-admin/use-cases/release-frozen-alloc-status.js
//
// Saneamento pontual dos `cargas.alloc_status` que ficaram CONGELADOS: o modal do
// Monitor gravava o status EXIBIDO como override sem o operador ter escolhido nada
// (race entre o prefill do form e o overlay ao vivo do SPX) e nada automático
// limpava esse valor depois.
//
// A causa foi corrigida no fluxo de escrita (gate por interação explícita no
// frontend + guarda de eco no backend) e o sync ASPX passou a soltar overrides
// atrasados. Este use-case cobre o RESÍDUO: cargas cujo LH já não aparece mais na
// janela da Torre (45 dias atrás / 30 à frente), que o sync nunca vai visitar.
//
// Usa a MESMA regra do sync (`shouldReleaseAllocStatusOverride`), então overrides
// deliberados são preservados: CTE EM EMISSÃO / CTE ENVIADO / NO SHOW / CANCELADO.
// Aqui o "valor da planilha" é o próprio `sheet_status` (não há ASPX para consultar).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { shouldReleaseAllocStatusOverride } from "../../../domain/operator-admin/aspx-status-rules.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

/**
 * @param {{ apply?: boolean, limit?: number, correlationId?: string, deps?: { withPgClient?: Function } }} [args]
 * @returns {Promise<{ scanned: number, released: number, applied: boolean, items: Array<{lh: string|null, de: string, para: string|null}> }>}
 */
export async function releaseFrozenAllocStatus({ apply = false, limit = 1000, correlationId = null, deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;

  return run(async (client) => {
    const { rows } = await client.query(
      `SELECT id, COALESCE(sheet_lh, lh_manual) AS lh, sheet_status, alloc_status
         FROM public.cargas
        WHERE alloc_status IS NOT NULL
          AND COALESCE(sheet_status, '') <> ''
        ORDER BY data DESC NULLS LAST, id
        LIMIT $1`,
      [limit],
    );

    const alvos = rows.filter((r) => shouldReleaseAllocStatusOverride(r.alloc_status, r.sheet_status));

    if (apply && alvos.length > 0) {
      // Placeholders explícitos (mesmo padrão de descend-queue-cascade) em vez de
      // `= ANY($1::uuid[])` — o cast de array não casa no harness de teste.
      const placeholders = alvos.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `UPDATE public.cargas SET alloc_status = NULL, updated_at = now() WHERE id IN (${placeholders})`,
        alvos.map((r) => r.id),
      );
    }

    const items = alvos.map((r) => ({ lh: r.lh ?? null, de: r.alloc_status, para: r.sheet_status }));
    logStructuredEvent("info", "monitor.frozen-alloc-status.release", {
      correlationId,
      scanned: rows.length,
      released: alvos.length,
      applied: apply,
    });

    return { scanned: rows.length, released: alvos.length, applied: apply, items };
  });
}
