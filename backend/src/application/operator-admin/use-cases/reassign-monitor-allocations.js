import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { ensureMonitorSheetCargo } from "./_shared.js";

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

  const normalized = moves.map((m) => {
    const lh = (m.lh ?? "").toString().trim();
    // Carga da planilha → resolvida por LH; carga do SISTEMA → cargoId explícito
    // (não tem LH). A coluna alloc_* é a mesma nos dois, então o swap planilha↔sistema
    // é só escrever em duas cargas; a trava de rota abaixo já garante "mesma rota".
    const explicitCargoId = (m.cargoId ?? "").toString().trim();
    if (!lh && !explicitCargoId) throw new ValidationError("Movimentação sem LH nem cargoId.");
    return {
      lh,
      explicitCargoId,
      motorista: val(m.motorista),
      cavalo: val(m.cavalo),
      carreta: val(m.carreta),
    };
  });

  // Chave de rota = origem→destino normalizado (mesma ideia do routeKeyOf do front).
  const routeKeyFromRow = (r) => `${(r.origem ?? "").trim()}→${(r.destino ?? "").trim()}`;

  const result = await withPgTransaction(async (client) => {
    // 1) Trava e valida TODAS as cargas afetadas ANTES de escrever (sem escrita
    //    parcial em caso de falha de validação): existência, fixo e rota.
    const routeKeys = new Set();
    const seen = new Set();
    for (const m of normalized) {
      // LH → resolve por id da PLANILHA OU por lh_manual (carga do SISTEMA lançada
      // na Programação), senão arrastar/remanejar uma carga lançada dava 404.
      // cargoId explícito (carga do sistema já identificada pelo grid) trava direto.
      let row;
      if (m.explicitCargoId) {
        const { rows } = await client.query(
          `SELECT id, sheet_lh, alloc_pinned, origem, destino FROM public.cargas WHERE id = $1 FOR UPDATE`,
          [m.explicitCargoId],
        );
        row = rows[0];
      } else {
        row = await ensureMonitorSheetCargo(client, m.lh, { columns: "id, sheet_lh, alloc_pinned, origem, destino" });
      }
      if (!row) {
        throw new NotFoundError(`Carga não encontrada para ${m.lh || m.explicitCargoId}.`);
      }
      // Id REAL resolvido (planilha OU sistema lançado) — usado no lock/update.
      m.cargoId = row.id;
      // Carga do sistema (sheet_lh NULL) não vai pro write-back da planilha.
      m.sheetLhNull = row.sheet_lh == null;
      if (seen.has(m.cargoId)) {
        throw new ValidationError(`Carga repetida na movimentação: ${m.lh || m.cargoId}`);
      }
      seen.add(m.cargoId);
      // Carga FIXA é intocável — não pode ser movida pela fila (nem origem nem
      // destino de uma troca/descida). O operador precisa desafixar antes.
      if (row.alloc_pinned) {
        throw new ValidationError(`A carga ${m.lh || m.cargoId} está fixada e não pode ser movida. Desafixe antes de reordenar.`);
      }
      routeKeys.add(routeKeyFromRow(row));
    }

    // Só reordena DENTRO da mesma rota (origem → destino). Um arrasto que cruza
    // rotas (troca entre rotas, ou descer a fila atravessando linhas de outra
    // rota) é recusado — rota diferente muda manualmente, sem arrastar.
    if (routeKeys.size > 1) {
      throw new ValidationError(
        "Só é possível reordenar dentro da mesma rota (origem → destino). Para mover entre rotas, edite manualmente.",
      );
    }

    // 2) Aplica os updates — validação já passou.
    const updated = [];
    for (const m of normalized) {
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
      updated.push(m.lh || m.cargoId);
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
  // Só cargas da PLANILHA têm linha na planilha; cargas do sistema — sem LH
  // (só cargoId) OU lançadas por lh_manual (sheet_lh NULL) — NÃO entram no
  // write-back (não têm linha própria na planilha para espelhar).
  void writeAllocationsToSheet(
    normalized
      .filter((m) => m.lh && !m.sheetLhNull)
      .map(({ lh, motorista, cavalo, carreta }) => ({ lh, motorista, cavalo, carreta })),
  ).catch(() => {});

  return result;
}
