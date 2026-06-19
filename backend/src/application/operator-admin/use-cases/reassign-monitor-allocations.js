import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";

/**
 * Reatribui (move) a alocação motorista+cavalo+carreta entre cargas do Monitor,
 * numa única transação. É o backend do "arrastar para reordenar a fila de
 * motoristas/veículos" (trocar posições ou descer fila) — F3 do Monitor.
 *
 * Cada movimentação grava os valores efetivos relocados nas colunas `alloc_*`
 * da carga de destino. NÃO toca `alloc_status`: o status operacional pertence à
 * carga (onde ela está na viagem), não ao motorista que a puxa.
 *
 * Semântica de vazio (importante e diferente da Fase 0):
 * - ""  = vazio EXPLÍCITO → grava string vazia em alloc_* → COALESCE(alloc, sheet)
 *         devolve "" → a carga fica sem motorista (sobrepõe a planilha). É o que
 *         acontece com a linha de onde o motorista saiu numa reordenação.
 * - A Fase 0 (edição/limpar no modal) usa null para "voltar a refletir a
 *   planilha". Aqui nunca convertemos "" → null, senão a linha esvaziada
 *   voltaria a mostrar o motorista da planilha.
 *
 * O front envia só as linhas que realmente mudaram (diff da permutação), então
 * a transação grava exatamente o conjunto afetado.
 *
 * @param {{ moves: Array<{lh:string, motorista?:string, cavalo?:string, carreta?:string}>,
 *           operatorId: string, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function reassignMonitorAllocations({ moves, operatorId, requestIp, correlationId }) {
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new ValidationError("Nenhuma movimentação informada.");
  }

  // Mantém "" (vazio explícito); null/undefined também viram "".
  const val = (v) => (v ?? "").toString().trim();

  const seen = new Set();
  const normalized = moves.map((m) => {
    const lh = (m.lh ?? "").toString().trim();
    if (!lh) throw new ValidationError("LH ausente em uma movimentação.");
    if (seen.has(lh)) throw new ValidationError(`LH repetido na movimentação: ${lh}`);
    seen.add(lh);
    return {
      lh,
      cargoId: createSheetLoadId(lh),
      motorista: val(m.motorista),
      cavalo: val(m.cavalo),
      carreta: val(m.carreta),
    };
  });

  const result = await withPgTransaction(async (client) => {
    const updated = [];
    for (const m of normalized) {
      const { rows } = await client.query(
        `SELECT id, alloc_pinned FROM public.cargas WHERE id = $1 FOR UPDATE`,
        [m.cargoId],
      );
      if (rows.length === 0) {
        throw new NotFoundError(`Carga da planilha não encontrada para o LH ${m.lh}.`);
      }
      // Carga FIXA é intocável — não pode ser movida pela fila (nem origem nem
      // destino de uma troca/descida). O operador precisa desafixar antes.
      if (rows[0].alloc_pinned) {
        throw new ValidationError(`A carga ${m.lh} está fixada e não pode ser movida. Desafixe antes de reordenar.`);
      }
      await client.query(
        `
          UPDATE public.cargas
          SET alloc_motorista = $2,
              alloc_cavalo = $3,
              alloc_carreta = $4,
              alloc_source = 'operator',
              alloc_updated_at = now(),
              alloc_updated_by = $5,
              updated_at = now()
          WHERE id = $1
        `,
        [m.cargoId, m.motorista, m.cavalo, m.carreta, operatorId],
      );
      updated.push(m.lh);
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.allocation_reassigned",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: null,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        count: normalized.length,
        moves: normalized.map(({ lh, motorista, cavalo, carreta }) => ({ lh, motorista, cavalo, carreta })),
      },
    });

    return {
      statusCode: 200,
      payload: { ok: true, updated, count: updated.length, meta: { correlationId } },
    };
  });

  // Write-back best-effort pra planilha (espelho) — FORA da transação e SEM
  // await (o Apps Script pode levar segundos; não travamos a resposta). Os
  // moves já são os valores EFETIVOS relocados ("" = célula vazia). Nunca lança.
  void writeAllocationsToSheet(
    normalized.map(({ lh, motorista, cavalo, carreta }) => ({ lh, motorista, cavalo, carreta })),
  ).catch(() => {});

  return result;
}
