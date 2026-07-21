import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { computeDescendFromDrop } from "../monitor-cascade.js";

// Regra de editabilidade (espelha o allocEditPolicy do front): Disponível/Reservado
// (sem status) e o pré-carregamento ("aguardando chegar/carregamento") podem ceder/
// receber motorista pela fila. De CARREGADO em diante fica travado. Uma carga não
// editável (ou fixada) NÃO participa do remanejamento — a cascata pula.
const PRE_CARREGAMENTO_RE = /aguardando\s+(chegar|carreg)/i;
function isEditableStatus(status) {
  const st = (status ?? "").toString().trim();
  return st === "" || PRE_CARREGAMENTO_RE.test(st);
}

/**
 * Descer a fila (MANUAL) — backend AUTORITATIVO do arrastar "descer a partir de
 * onde soltei" do Monitor (F3). O front manda só a ORDEM exibida da rota
 * (`orderedLhs`, topo→base, respeitando os filtros da tela), a carga de origem
 * (`sourceLh`, motorista arrastado) e a carga de destino (`targetLh`, onde foi
 * solto). O backend lê pinned/status/alocação REAIS do banco e calcula a cascata
 * aqui — assim uma carga FIXADA nunca é movida, mesmo que a tela esteja com o flag
 * desatualizado (era a causa do erro "está fixada e não pode ser movida").
 *
 * Comportamento: o motorista de `sourceLh` ASSUME a carga `targetLh` e, dali pra
 * baixo, cada motorista desce uma carga; cargas fixadas/travadas são PULADAS
 * (ficam no lugar); a carga em branco (inclusive a vaga que a origem deixou) absorve
 * o ripple; quem sobra no fim vira RESERVA. Funciona nos dois sentidos (soltar
 * acima = subir/rotacionar sem reserva; soltar abaixo = descer, pode gerar reserva).
 * NÃO cancela nada e NÃO toca alloc_status.
 *
 * @param {{ sourceLh: string, targetLh: string, orderedLhs: string[], operatorId: string, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object, movedLhs: string[] }>}
 */
export async function descendQueueCascade({ sourceLh, targetLh, orderedLhs, operatorId, requestIp, correlationId }) {
  const source = (sourceLh ?? "").toString().trim();
  if (!source) throw new ValidationError("Carga de origem (sourceLh) obrigatória.");
  const target = (targetLh ?? "").toString().trim();
  if (!target) throw new ValidationError("Carga de destino (targetLh) obrigatória.");
  const order = Array.isArray(orderedLhs) ? orderedLhs.map((x) => (x ?? "").toString().trim()).filter(Boolean) : [];
  if (order.length === 0) throw new ValidationError("Ordem da fila (orderedLhs) obrigatória.");
  if (!order.includes(source)) throw new ValidationError("A carga de origem não está na ordem da fila enviada.");
  if (!order.includes(target)) throw new ValidationError("A carga de destino não está na ordem da fila enviada.");

  const sheetIds = order.map((lh) => createSheetLoadId(lh));

  const result = await withPgTransaction(async (client) => {
    // Trava TODAS as cargas da fila. A ordem de aquisição do lock DEVE bater com a
    // da cascata de CANCELAMENTO (cancel-load-cascade: (data IS NULL), data DESC,
    // horario DESC, sheet_lh) — se as duas travarem a mesma rota em ordens
    // diferentes, concorrência entre elas dá deadlock. Lê o EFETIVO (alloc ??
    // planilha). IN-list de params (não ANY(array)) p/ compatibilidade com o harness.
    //
    // Resolve tanto a carga da PLANILHA (id = createSheetLoadId(lh)) quanto a carga
    // do SISTEMA lançada na Programação (lh_manual == LH, sheet_lh NULL) — uma
    // viagem lançada aparece na fila como linha da planilha; sem incluí-la aqui a
    // descida dava 404 (origem lançada) ou pulava a carga silenciosamente (destino/
    // miolo lançado), embaralhando a cascata. `id` no fim do ORDER BY desempata
    // gêmeos lh_manual (sheet_lh NULL) sem alterar a ordem das cargas da planilha
    // (sheet_lh único), preservando a compatibilidade de lock com o cancelamento.
    const idPlaceholders = sheetIds.map((_, i) => `$${i + 1}`).join(", ");
    const lhPlaceholders = order.map((_, i) => `$${sheetIds.length + i + 1}`).join(", ");
    const { rows } = await client.query(
      `SELECT id, sheet_lh, lh_manual, origem, destino, alloc_pinned,
              COALESCE(alloc_motorista, sheet_motorista, '') AS motorista,
              COALESCE(alloc_cavalo,    sheet_cavalo,    '') AS cavalo,
              COALESCE(alloc_carreta,   sheet_carreta,   '') AS carreta,
              COALESCE(alloc_status,    sheet_status,    '') AS status
       FROM public.cargas
       WHERE id IN (${idPlaceholders})
          OR (lh_manual IN (${lhPlaceholders}) AND sheet_lh IS NULL)
       ORDER BY (data IS NULL), data DESC, horario DESC, sheet_lh, id
       FOR UPDATE`,
      [...sheetIds, ...order],
    );
    // Chaveia pela identidade exibida na fila: sheet_lh (planilha) OU lh_manual
    // (sistema lançado). Se o MESMO LH existir como planilha E como sistema (corrida
    // lançamento↔sync), a da PLANILHA vence — a fila da rota é da planilha.
    const byLh = new Map();
    for (const r of rows) {
      const key = r.sheet_lh ?? r.lh_manual;
      if (!key) continue;
      const existing = byLh.get(key);
      if (!existing || (existing.sheet_lh == null && r.sheet_lh != null)) byLh.set(key, r);
    }

    const sourceRow = byLh.get(source);
    if (!sourceRow) throw new NotFoundError(`Carga de origem ${source} não encontrada.`);

    // A ORIGEM não pode descer se estiver FIXADA ou já em OPERAÇÃO (não editável):
    // moveria/esvaziaria uma carga travada. computeCancelCascade só protege a
    // origem FIXADA (não a travada por status), então validamos aqui — defesa
    // contra aba desatualizada (o front já bloqueia, mas o banco é a autoridade).
    if (sourceRow.alloc_pinned === true || !isEditableStatus(sourceRow.status)) {
      throw new ValidationError(
        "A carga de origem está fixada ou já em operação — não dá para descer a fila a partir dela. Atualize a tela e tente de novo.",
      );
    }

    // Monta a fila na ORDEM EXIBIDA (a que o front enviou), só com as cargas que
    // ainda existem. Valida rota única (origem→destino) — descer é dentro da rota.
    const routeKeyOf = (r) => `${(r.origem ?? "").trim()}→${(r.destino ?? "").trim()}`;
    const sourceRouteKey = routeKeyOf(sourceRow);
    const loads = [];
    for (const lh of order) {
      const r = byLh.get(lh);
      if (!r) continue; // carga saiu da rota entre o carregamento da tela e o drop
      if (routeKeyOf(r) !== sourceRouteKey) {
        throw new ValidationError("Só é possível descer a fila dentro da mesma rota (origem → destino).");
      }
      loads.push({
        // Identidade exibida na fila: sheet_lh (planilha) OU lh_manual (sistema
        // lançado). Usar r.sheet_lh cru deixava a carga lançada com lh=null e o
        // computeDescendFromDrop não a encontrava (source/target NÃO batiam → no-op).
        lh: r.sheet_lh ?? r.lh_manual,
        motorista: r.motorista,
        cavalo: r.cavalo,
        carreta: r.carreta,
        pinned: r.alloc_pinned === true,
        cancelled: false,
        // Fixada ou já em operação (não editável) → não recebe motorista: a cascata pula.
        locked: !isEditableStatus(r.status),
      });
    }

    const { moves, reserva } = computeDescendFromDrop(loads, source, target);
    const skippedPinnedLhs = loads.filter((l) => l.pinned).map((l) => l.lh);

    if (moves.length === 0 && !reserva) {
      return {
        statusCode: 200,
        payload: { ok: true, count: 0, reserva: false, skippedPinned: skippedPinnedLhs, moves: [], meta: { correlationId } },
        moves: [],
        writebackMoves: [],
      };
    }

    // Aplica os moves (só alloc_*; status operacional pertence à carga). Usa o id
    // REAL resolvido (planilha OU sistema lançado) — não createSheetLoadId(m.lh),
    // que não bate na carga lançada (lh_manual).
    for (const m of moves) {
      const target = byLh.get(m.lh);
      if (!target) continue; // defensivo: carga saiu da fila entre lock e cálculo
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
        [target.id, m.motorista, m.cavalo, m.carreta, operatorId],
      );
    }

    // Motorista que sobrou no fim → RESERVA (standby na rota). Supersede reserva
    // ativa anterior da MESMA origem (não duplica se descer de novo).
    let reservaCreated = false;
    if (reserva) {
      const origem = sourceRow.origem ?? "";
      const destino = sourceRow.destino ?? "";
      await client.query(
        `UPDATE public.monitor_reservas SET active = false, updated_at = now()
         WHERE active = true AND origin_lh = $1`,
        [source],
      );
      await client.query(
        `INSERT INTO public.monitor_reservas
           (motorista, cavalo, carreta, origem, destino, route_key, origin_lh, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [reserva.motorista, reserva.cavalo, reserva.carreta, origem, destino, `${origem.trim()}→${destino.trim()}`, source, operatorId],
      );
      reservaCreated = true;
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.queue_descended",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: sourceRow.id,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        sourceLh: source,
        targetLh: target,
        route: sourceRouteKey,
        moves: moves.map(({ lh, motorista, cavalo, carreta }) => ({ lh, motorista, cavalo, carreta })),
        reserva: reservaCreated,
        reservaMotorista: reserva?.motorista ?? null,
        skippedPinned: skippedPinnedLhs,
      },
    });

    return {
      statusCode: 200,
      // `moves` no payload = as alocações relocadas; o front aplica direto no cache
      // (atualização instantânea da fila, sem refetch pesado do read model).
      payload: {
        ok: true,
        count: moves.length,
        reserva: reservaCreated,
        skippedPinned: skippedPinnedLhs,
        moves: moves.map(({ lh, motorista, cavalo, carreta }) => ({ lh, motorista, cavalo, carreta })),
        meta: { correlationId },
      },
      moves,
      // Só os moves que caíram em carga da PLANILHA (sheet_lh não nulo) vão pro
      // write-back; cargas do SISTEMA lançadas (lh_manual) não têm linha própria
      // na planilha para espelhar. Computado aqui (byLh só existe na transação).
      writebackMoves: moves.filter((m) => byLh.get(m.lh)?.sheet_lh != null),
    };
  });

  // Write-back best-effort dos moves (espelho da planilha) — FORA da transação,
  // sem await. A reserva não tem LH → não vai pra planilha; cargas do sistema
  // lançadas (lh_manual) também não (writebackMoves já as exclui).
  if (result.writebackMoves.length > 0) {
    void writeAllocationsToSheet(
      result.writebackMoves.map(({ lh, motorista, cavalo, carreta }) => ({ lh, motorista, cavalo, carreta })),
    ).catch(() => {});
  }

  return { statusCode: result.statusCode, payload: result.payload, movedLhs: result.moves.map((m) => m.lh) };
}
