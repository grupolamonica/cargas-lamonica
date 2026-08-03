// backend/src/application/operator-admin/use-cases/release-frozen-alloc-status.js
//
// Saneamento pontual dos `cargas.alloc_status` que ficaram presos, nas DUAS formas
// que o mesmo defeito produzia:
//
//  1. ATRASADO — o modal do Monitor gravava o status EXIBIDO como override sem o
//     operador ter escolhido nada (race entre o prefill do form e o overlay ao vivo
//     do SPX). O painel mostra um estágio anterior ao real ("status atrasado").
//  2. VAZIO ("") — o editor inline mandava `status: allocStatus ?? ""` ao salvar só
//     motorista/veículo, gravando vazio EXPLÍCITO. Como `COALESCE(alloc_*, sheet_*)`
//     devolve "", a carga passa a aparecer SEM status mesmo com a planilha em
//     DESCARREGADO. Só é artefato quando há motorista (ver a regra).
//
// Nada automático limpava esses valores. A causa foi corrigida no fluxo de escrita
// (gate por interação explícita no frontend + guarda de eco no backend) e o sync
// ASPX passou a soltar os dois casos. Este use-case cobre o RESÍDUO: cargas cujo LH
// não aparece na janela da Torre (45 dias atrás / 30 à frente) ou que não são linha
// de planilha — o sync nunca as visita.
//
// Usa a MESMA regra do sync (`shouldReleaseAllocStatusOverride`), então overrides
// deliberados são preservados: CTE EM EMISSÃO / CTE ENVIADO / NO SHOW / CANCELADO,
// e o "" de "Disponível" em carga sem motorista.
// Aqui o "valor da planilha" é o próprio `sheet_status` (não há ASPX para consultar).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { shouldReleaseAllocStatusOverride } from "../../../domain/operator-admin/aspx-status-rules.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

/** Alocação EFETIVA do motorista (semântica do Monitor: alloc "" é vazio explícito e vence). */
const motoristaEfetivo = (row) =>
  String((row.alloc_motorista != null ? row.alloc_motorista : row.sheet_motorista) ?? "").trim();

/**
 * @param {{ apply?: boolean, limit?: number, correlationId?: string, deps?: { withPgClient?: Function } }} [args]
 * @returns {Promise<{ scanned: number, released: number, applied: boolean, items: Array<{lh: string|null, de: string, para: string|null}> }>}
 */
export async function releaseFrozenAllocStatus({ apply = false, limit = 1000, correlationId = null, deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;

  return run(async (client) => {
    const { rows } = await client.query(
      `SELECT id, COALESCE(sheet_lh, lh_manual) AS lh, sheet_status, alloc_status,
              alloc_motorista, sheet_motorista
         FROM public.cargas
        WHERE alloc_status IS NOT NULL
          AND COALESCE(sheet_status, '') <> ''
        ORDER BY data DESC NULLS LAST, id
        LIMIT $1`,
      [limit],
    );

    const alvos = rows.filter((r) =>
      shouldReleaseAllocStatusOverride(r.alloc_status, r.sheet_status, {
        hasDriver: motoristaEfetivo(r) !== "",
      }),
    );

    if (apply && alvos.length > 0) {
      // Placeholders explícitos (mesmo padrão de descend-queue-cascade) em vez de
      // `= ANY($1::uuid[])` — o cast de array não casa no harness de teste.
      const placeholders = alvos.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `UPDATE public.cargas SET alloc_status = NULL, updated_at = now() WHERE id IN (${placeholders})`,
        alvos.map((r) => r.id),
      );
    }

    // `de` distingue os dois sintomas no relatório: "(vazio)" = carga aparecia SEM
    // status; qualquer outro = estágio atrasado mascarando o avanço da viagem.
    const items = alvos.map((r) => ({
      lh: r.lh ?? null,
      de: String(r.alloc_status).trim() === "" ? "(vazio)" : r.alloc_status,
      para: r.sheet_status,
    }));
    logStructuredEvent("info", "monitor.frozen-alloc-status.release", {
      correlationId,
      scanned: rows.length,
      released: alvos.length,
      applied: apply,
    });

    return { scanned: rows.length, released: alvos.length, applied: apply, items };
  });
}
