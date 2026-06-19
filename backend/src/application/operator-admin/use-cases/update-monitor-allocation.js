import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { cancelLoadCascade } from "./cancel-load-cascade.js";

/**
 * Grava a ALOCAÇÃO editada no Monitor (motorista/cavalo/carreta/status operacional)
 * nas colunas `alloc_*` da carga — a "decisão" do operador, dona do sistema.
 *
 * Resolve a carga pelo id determinístico da planilha (createSheetLoadId(lh)),
 * trava com FOR UPDATE (mesma garantia de writeCargo) e escreve SOMENTE `alloc_*`
 * + metadados. O sync da planilha NUNCA toca `alloc_*`, então a edição do
 * operador nunca é sobrescrita. Leitura efetiva = COALESCE(alloc_*, sheet_*).
 *
 * Normalização: "" → null = limpa o override (volta a refletir a planilha).
 *
 * @param {{ lh: string, operatorId: string, payload: object, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function updateMonitorAllocation({ lh, operatorId, payload, requestIp, correlationId }) {
  const cargoId = createSheetLoadId(lh);
  const norm = (value) => {
    const trimmed = (value ?? "").toString().trim();
    return trimmed === "" ? null : trimmed;
  };
  const motorista = norm(payload.motorista);
  const cavalo = norm(payload.cavalo);
  const carreta = norm(payload.carreta);
  const status = norm(payload.status);

  const result = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, sheet_lh, sheet_motorista, sheet_cavalo, sheet_carreta,
              alloc_pinned, alloc_motorista, alloc_cavalo, alloc_carreta
       FROM public.cargas WHERE id = $1 FOR UPDATE`,
      [cargoId],
    );

    if (rows.length === 0) {
      throw new NotFoundError("Carga da planilha não encontrada para este LH.");
    }

    const sheetRow = rows[0];

    // Carga FIXA: motorista/veículo são intocáveis — preserva o que já está
    // alocado (ignora os valores recebidos) e deixa passar só o status operacional.
    const pinned = sheetRow.alloc_pinned === true;
    const finalMotorista = pinned ? (sheetRow.alloc_motorista ?? null) : motorista;
    const finalCavalo = pinned ? (sheetRow.alloc_cavalo ?? null) : cavalo;
    const finalCarreta = pinned ? (sheetRow.alloc_carreta ?? null) : carreta;

    await client.query(
      `
        UPDATE public.cargas
        SET alloc_motorista = $2,
            alloc_cavalo = $3,
            alloc_carreta = $4,
            alloc_status = $5,
            alloc_source = 'operator',
            alloc_updated_at = now(),
            alloc_updated_by = $6,
            updated_at = now()
        WHERE id = $1
      `,
      [cargoId, finalMotorista, finalCavalo, finalCarreta, status, operatorId],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.allocation_updated",
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
        motorista: finalMotorista,
        cavalo: finalCavalo,
        carreta: finalCarreta,
        status,
        pinned,
        cleared: finalMotorista === null && finalCavalo === null && finalCarreta === null && status === null,
      },
    });

    // Motorista alocado numa carga NORMAL deixa de estar "em reserva": baixa as
    // reservas ativas desse motorista (senão aparece na carga E no standby). Não
    // baixa em cancelamento — aí quem move é a cascata.
    const effMotorista = (finalMotorista ?? sheetRow.sheet_motorista ?? "").toString().trim();
    const cancelling = Boolean(status) && /cancel/i.test(status);
    if (effMotorista && !cancelling) {
      await client.query(
        `UPDATE public.monitor_reservas SET active = false, updated_at = now()
         WHERE active = true AND motorista = $1`,
        [effMotorista],
      );
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lh,
        allocation: { motorista: finalMotorista, cavalo: finalCavalo, carreta: finalCarreta, status, source: "operator" },
        meta: { correlationId },
      },
      // Valor EFETIVO (o que o Monitor mostra) = override do operador ?? planilha.
      // Usado no write-back pra refletir na planilha; "" limpa a célula.
      effective: {
        motorista: finalMotorista ?? sheetRow.sheet_motorista ?? "",
        cavalo: finalCavalo ?? sheetRow.sheet_cavalo ?? "",
        carreta: finalCarreta ?? sheetRow.sheet_carreta ?? "",
      },
    };
  });

  // Cancelou no Monitor (status → CANCELADO) → dispara a cascata da rota: o
  // motorista desce a fila (Interpretação A) e o último sem carga vira reserva.
  const willCascade = Boolean(status) && /cancel/i.test(status);

  // Write-back best-effort pra planilha (espelho) — FORA da transação e SEM
  // await. Quando vai cascatear, o write-back fica por conta da cascata (que
  // sabe os valores relocados) — evita gravar o valor antigo e depois corrigir.
  if (!willCascade) {
    void writeAllocationsToSheet([{ lh, ...result.effective }]).catch(() => {});
  }

  if (willCascade) {
    // Best-effort: a edição de status já está commitada; se a cascata falhar, o
    // sweep do próximo sync recupera (cancelLoadCascade é idempotente).
    try {
      await cancelLoadCascade({ lh, operatorId, requestIp, correlationId });
    } catch (cascadeErr) {
      console.warn(
        `[update-monitor-allocation] cascata de cancelamento falhou para ${lh}:`,
        cascadeErr instanceof Error ? cascadeErr.message : cascadeErr,
      );
    }
  }

  return { statusCode: result.statusCode, payload: result.payload };
}
