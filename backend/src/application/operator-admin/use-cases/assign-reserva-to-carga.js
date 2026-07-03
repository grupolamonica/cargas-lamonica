import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";

// Status efetivo editável: vazio (Disponível/Reservado) ou "aguardando chegar no
// cliente". Espelha allocEditPolicy do front — qualquer outro status (Cancelado,
// Descarregado, etc.) trava a carga (já em atribuição no ASPX).
const AGUARDANDO_CLIENTE_RE = /aguardando\s+chegar/i;

/**
 * Puxa um motorista em STANDBY (monitor_reservas) para uma carga da planilha
 * (arrastar a reserva e soltar na carga). Grava a alocação do standby em
 * `cargas.alloc_*` e dá baixa na reserva. Se a carga já tinha motorista, esse
 * motorista vira uma NOVA reserva (swap — ninguém se perde, mesma semântica da
 * cascata de cancelamento). Numa transação só.
 *
 * Ordem de lock: cargas → monitor_reservas (igual ao cancel-load-cascade), p/ não
 * dar deadlock entre as duas vias quando rodam na mesma rota concorrentemente.
 *
 * @param {{ reservaId: string, targetLh: string, operatorId: string, requestIp?: string, correlationId?: string }} args
 */
export async function assignReservaToCarga({ reservaId, targetLh, operatorId, requestIp, correlationId }) {
  const cargoId = createSheetLoadId(targetLh);

  const result = await withPgTransaction(async (client) => {
    // 1) Trava a carga de destino PRIMEIRO (cargas-antes-de-reservas) — mesma ordem
    //    do cancel-load-cascade, evitando ciclo de deadlock entre as duas vias.
    const { rows: cgs } = await client.query(
      `SELECT id, alloc_pinned, origem, destino, alloc_status, sheet_status,
              alloc_motorista, sheet_motorista, alloc_cavalo, sheet_cavalo, alloc_carreta, sheet_carreta
       FROM public.cargas WHERE id = $1 FOR UPDATE`,
      [cargoId],
    );
    if (cgs.length === 0) {
      throw new NotFoundError("Carga de destino não encontrada para este LH.");
    }
    const carga = cgs[0];
    if (carga.alloc_pinned === true) {
      throw new ValidationError("A carga de destino está fixada. Desafixe antes de puxar o standby.");
    }
    // Trava por status (defesa no servidor — o front também bloqueia via allocEditPolicy).
    const effStatus = (carga.alloc_status ?? carga.sheet_status ?? "").toString().trim();
    if (effStatus && !AGUARDANDO_CLIENTE_RE.test(effStatus)) {
      throw new ValidationError(`A carga de destino está travada (status "${effStatus}") e não aceita standby.`);
    }

    // 2) Agora trava a reserva.
    const { rows: rsv } = await client.query(
      `SELECT id, motorista, cavalo, carreta, origem, destino
       FROM public.monitor_reservas WHERE id = $1 AND active = true FOR UPDATE`,
      [reservaId],
    );
    if (rsv.length === 0) {
      throw new NotFoundError("Reserva (standby) não encontrada ou já utilizada.");
    }
    const reserva = rsv[0];

    // Invariante: standby só entra em carga da MESMA rota (origem→destino). Defesa
    // no servidor — o front bloqueia, mas não pode ser a única linha de defesa.
    const sameRoute =
      (reserva.origem ?? "").trim() === (carga.origem ?? "").trim() &&
      (reserva.destino ?? "").trim() === (carga.destino ?? "").trim();
    if (!sameRoute) {
      throw new ValidationError("O standby é de outra rota. Só pode ser puxado para uma carga da mesma rota (origem → destino).");
    }

    // Motorista/veículo EFETIVO atual da carga (alloc ?? planilha) — se houver, é
    // "empurrado" de volta pro standby (swap), pra não perder ninguém.
    const curMot = (carga.alloc_motorista ?? carga.sheet_motorista ?? "").toString().trim();
    const curCav = (carga.alloc_cavalo ?? carga.sheet_cavalo ?? "").toString().trim();
    const curCar = (carga.alloc_carreta ?? carga.sheet_carreta ?? "").toString().trim();
    const novoMot = (reserva.motorista || "").trim();

    await client.query(
      `
        UPDATE public.cargas
        SET alloc_motorista = $2, alloc_cavalo = $3, alloc_carreta = $4,
            alloc_source = 'operator', alloc_updated_at = now(), alloc_updated_by = $5, updated_at = now()
        WHERE id = $1
      `,
      [cargoId, reserva.motorista || "", reserva.cavalo || "", reserva.carreta || "", operatorId],
    );

    // Baixa a reserva arrastada E quaisquer OUTRAS reservas ativas do mesmo motorista.
    // Um motorista pode ter >1 standby ativo (cancelamentos em rotas distintas geram
    // uma reserva cada); sem essa limpeza ele renderiza na carga E sobra como standby.
    // Mesma higienização do update-monitor-allocation.js.
    await client.query(
      `UPDATE public.monitor_reservas SET active = false, updated_at = now() WHERE id = $1`,
      [reservaId],
    );
    if (novoMot) {
      await client.query(
        `UPDATE public.monitor_reservas SET active = false, updated_at = now() WHERE active = true AND motorista = $1`,
        [novoMot],
      );
    }

    // Swap: o motorista que estava na carga (se havia, e é diferente) vira standby.
    // INSERIDO DEPOIS das baixas acima e como curMot !== novoMot, não é re-baixado.
    let bumped = false;
    if (curMot && curMot !== novoMot) {
      const routeKey = `${(carga.origem ?? "").trim()}→${(carga.destino ?? "").trim()}`;
      await client.query(
        `INSERT INTO public.monitor_reservas
           (motorista, cavalo, carreta, origem, destino, route_key, origin_lh, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [curMot, curCav, curCar, carga.origem ?? "", carga.destino ?? "", routeKey, targetLh, operatorId],
      );
      bumped = true;
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.reserva_assigned",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { reservaId, targetLh, motorista: novoMot, bumped },
    });

    return {
      statusCode: 200,
      payload: { ok: true, lh: targetLh, bumped, meta: { correlationId } },
      effective: { motorista: reserva.motorista || "", cavalo: reserva.cavalo || "", carreta: reserva.carreta || "" },
    };
  });

  // Espelho best-effort na planilha (mesma rota das outras edições do Monitor).
  void writeAllocationsToSheet([{ lh: targetLh, ...result.effective }]).catch(() => {});

  return { statusCode: result.statusCode, payload: result.payload };
}
