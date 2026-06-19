import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";

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
      `SELECT id, sheet_lh, sheet_motorista, sheet_cavalo, sheet_carreta FROM public.cargas WHERE id = $1 FOR UPDATE`,
      [cargoId],
    );

    if (rows.length === 0) {
      throw new NotFoundError("Carga da planilha não encontrada para este LH.");
    }

    const sheetRow = rows[0];

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
      [cargoId, motorista, cavalo, carreta, status, operatorId],
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
        motorista,
        cavalo,
        carreta,
        status,
        cleared: motorista === null && cavalo === null && carreta === null && status === null,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lh,
        allocation: { motorista, cavalo, carreta, status, source: "operator" },
        meta: { correlationId },
      },
      // Valor EFETIVO (o que o Monitor mostra) = override do operador ?? planilha.
      // Usado no write-back pra refletir na planilha; "" limpa a célula.
      effective: {
        motorista: motorista ?? sheetRow.sheet_motorista ?? "",
        cavalo: cavalo ?? sheetRow.sheet_cavalo ?? "",
        carreta: carreta ?? sheetRow.sheet_carreta ?? "",
      },
    };
  });

  // Write-back best-effort pra planilha (espelho) — FORA da transação, nunca lança.
  await writeAllocationsToSheet([{ lh, ...result.effective }]);

  return { statusCode: result.statusCode, payload: result.payload };
}
