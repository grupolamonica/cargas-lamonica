import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { computeCancelCascade } from "../monitor-cascade.js";

/**
 * Cascata de cancelamento da fila do Monitor (Interpretação A).
 *
 * Dada uma carga cuja alocação efetiva está CANCELADA, o motorista/veículo dela
 * "desce a fila" da ROTA (mesma origem→destino, ordem cronológica): assume a
 * próxima carga, empurrando cada motorista seguinte; o último que fica sem carga
 * vira RESERVA (linha em monitor_reservas). Cargas fixas e outras canceladas são
 * puladas; o ripple para na primeira carga vazia.
 *
 * Roda numa transação (trava a rota inteira em ordem determinística → sem
 * deadlock entre cascatas). É IDEMPOTENTE: se a carga cancelada já não tem
 * motorista (cascata já rodou), é no-op — então pode ser disparada tanto pela
 * edição do operador quanto pelo sync da planilha sem duplicar reservas.
 *
 * @param {{ lh: string, operatorId: string, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function cancelLoadCascade({ lh, operatorId, requestIp, correlationId }) {
  const cargoId = createSheetLoadId(lh);

  const result = await withPgTransaction(async (client) => {
    // origem/destino da carga gatilho (sem lock — não mudam no cancelamento).
    const { rows: head } = await client.query(
      `SELECT origem, destino FROM public.cargas WHERE id = $1`,
      [cargoId],
    );
    if (head.length === 0) {
      throw new NotFoundError("Carga da planilha não encontrada para este LH.");
    }
    const { origem, destino } = head[0];

    // Trava a ROTA inteira na MESMA ordem da fila exibida no Monitor — data+horário
    // DECRESCENTE (mais recente no topo; NULLs por último), igual ao sort do
    // snapshot (parseAllGoogleSheetRows). É o que faz "descer na fila" bater com o
    // que o operador vê: o motorista da carga cancelada assume a carga logo ABAIXO
    // (a seguinte na fila), e não a de cima. Ordem determinística também evita
    // deadlock entre cascatas concorrentes na mesma rota.
    const { rows: routeRows } = await client.query(
      `SELECT sheet_lh, alloc_pinned,
              COALESCE(alloc_motorista, sheet_motorista, '') AS motorista,
              COALESCE(alloc_cavalo,    sheet_cavalo,    '') AS cavalo,
              COALESCE(alloc_carreta,   sheet_carreta,   '') AS carreta,
              COALESCE(alloc_status,    sheet_status,    '') AS status
       FROM public.cargas
       WHERE origem = $1 AND destino = $2 AND sheet_lh IS NOT NULL
       ORDER BY (data IS NULL), data DESC, horario DESC, sheet_lh
       FOR UPDATE`,
      [origem, destino],
    );

    const loads = routeRows.map((r) => {
      const st = (r.status || "").trim();
      return {
        lh: r.sheet_lh,
        motorista: r.motorista,
        cavalo: r.cavalo,
        carreta: r.carreta,
        pinned: r.alloc_pinned === true,
        cancelled: /cancel/i.test(st),
        // Status operacional (CARREGADO/DESCARGA/AGUARDANDO…) trava o remanejamento
        // — só Disponível/Reservado (status vazio) entram na cascata.
        locked: st !== "" && !/cancel/i.test(st),
      };
    });

    const source = loads.find((l) => l.lh === lh);
    const noop = {
      statusCode: 200,
      payload: { ok: true, cascaded: false, moves: 0, reserva: false, meta: { correlationId } },
      moves: [],
    };
    // Só cascateia se a carga gatilho está realmente cancelada (defesa p/ o sweep).
    if (!source || !source.cancelled) return noop;

    const { moves, reserva } = computeCancelCascade(loads, lh);
    if (moves.length === 0 && !reserva) return noop;
    // Reverter (DC-283): efetivo-ANTES por LH movida (do `loads`) p/ o undo do
    // Monitor restaurar cada carga ao estado pré-cascata.
    const beforeByLh = new Map(loads.map((l) => [l.lh, { motorista: l.motorista, cavalo: l.cavalo, carreta: l.carreta }]));

    // Aplica os moves (mesma semântica do reassign: "" = vazio explícito).
    for (const m of moves) {
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
        [createSheetLoadId(m.lh), m.motorista, m.cavalo, m.carreta, operatorId],
      );
    }

    let reservaCreated = false;
    if (reserva) {
      const routeKey = `${(origem ?? "").trim()}→${(destino ?? "").trim()}`;
      // Supersede qualquer reserva ativa anterior da MESMA carga cancelada — se a
      // cascata reprocessar (ex.: a carga recuperou motorista e foi cancelada de
      // novo), mantém no máximo 1 reserva ativa por origin_lh (sem duplicar).
      await client.query(
        `UPDATE public.monitor_reservas SET active = false, updated_at = now()
         WHERE active = true AND origin_lh = $1`,
        [lh],
      );
      await client.query(
        `INSERT INTO public.monitor_reservas
           (motorista, cavalo, carreta, origem, destino, route_key, origin_lh, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [reserva.motorista, reserva.cavalo, reserva.carreta, origem ?? "", destino ?? "", routeKey, lh, operatorId],
      );
      reservaCreated = true;
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.cancel_cascade",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        lh,
        route: `${origem ?? ""} → ${destino ?? ""}`,
        // Antes contava os moves; agora grava o array (depois) + o antes, p/ o
        // revert do Monitor poder restaurar cada carga da cascata.
        moves: moves.map(({ lh: mLh, motorista, cavalo, carreta }) => ({ lh: mLh, motorista, cavalo, carreta })),
        beforeMoves: moves.map(({ lh: mLh }) => ({ lh: mLh, ...(beforeByLh.get(mLh) || { motorista: "", cavalo: "", carreta: "" }) })),
        reserva: reservaCreated,
        reservaMotorista: reserva?.motorista ?? null,
      },
    });

    return {
      statusCode: 200,
      payload: { ok: true, cascaded: true, moves: moves.length, reserva: reservaCreated, meta: { correlationId } },
      moves,
    };
  });

  // Write-back best-effort dos moves relocados (espelho da planilha) — FORA da
  // transação, sem await. A reserva não tem LH → não vai pra planilha.
  if (result.moves.length > 0) {
    void writeAllocationsToSheet(
      result.moves.map(({ lh: mLh, motorista, cavalo, carreta }) => ({ lh: mLh, motorista, cavalo, carreta })),
    ).catch(() => {});
  }

  // movedLhs: linhas da rota cuja alocação efetiva mudou no remanejamento — o
  // chamador re-enriquece todas p/ o selo não ficar "não consultado" no fan-out.
  return { statusCode: result.statusCode, payload: result.payload, movedLhs: result.moves.map((m) => m.lh) };
}
