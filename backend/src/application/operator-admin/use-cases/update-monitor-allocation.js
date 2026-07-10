import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { cancelLoadCascade } from "./cancel-load-cascade.js";
import { cancelPublicLoadLead } from "../../load-claims/public-leads.js";

/**
 * Grava a ALOCAÇÃO editada no Monitor (motorista/cavalo/carreta/status operacional)
 * nas colunas `alloc_*` da carga — a "decisão" do operador, dona do sistema.
 *
 * Resolve a carga pelo id determinístico da planilha (createSheetLoadId(lh)),
 * trava com FOR UPDATE (mesma garantia de writeCargo) e escreve SOMENTE `alloc_*`
 * + metadados. O sync da planilha NUNCA toca `alloc_*`, então a edição do
 * operador nunca é sobrescrita. Leitura efetiva = COALESCE(alloc_*, sheet_*).
 *
 * Normalização: "" = vazio EXPLÍCITO → grava "" em alloc_* (NÃO null). Assim
 * COALESCE(alloc_*, sheet_*) devolve "" e a carga fica realmente sem
 * motorista/veículo, em vez de "voltar a refletir a planilha" (o que
 * ressuscitava o valor antigo ao limpar). Mesma semântica do arrastar
 * (reassign-monitor-allocations).
 *
 * @param {{ lh: string, operatorId: string, payload: object, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function updateMonitorAllocation({ lh, operatorId, payload, requestIp, correlationId }) {
  const cargoId = createSheetLoadId(lh);
  // Semântica de atualização PARCIAL:
  //  - campo AUSENTE no payload  → preserva o alloc_* atual (não mexe);
  //  - campo enviado como ""     → vazio EXPLÍCITO: grava "" (NÃO null);
  //  - campo enviado com valor   → define.
  // "" fica "" (não vira null) porque null = "sem override → COALESCE volta pra
  // planilha", que era exatamente o bug: limpar o campo ressuscitava o
  // motorista/veículo da planilha. Todos os consumidores tratam
  // COALESCE(alloc, sheet, '') = '' como "sem alocação", então "" é seguro.
  // Ausente ≠ vazio é essencial: o cancelamento manda só `status`, e o
  // motorista/veículo precisam sobreviver p/ a cascata poder relocá-los.
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
  const norm = (value) => (value ?? "").toString().trim();

  const result = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, sheet_lh, sheet_motorista, sheet_cavalo, sheet_carreta, sheet_status,
              alloc_pinned, alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_tipo,
              alloc_descricao, alloc_vinculo, status, reserved_public_lead_id
       FROM public.cargas WHERE id = $1 FOR UPDATE`,
      [cargoId],
    );

    if (rows.length === 0) {
      throw new NotFoundError("Carga da planilha não encontrada para este LH.");
    }

    const sheetRow = rows[0];

    // Carga FIXA: motorista/veículo são intocáveis — preserva o que já está
    // alocado (ignora os valores recebidos) e deixa passar só o status operacional.
    // Campo ausente no payload também preserva o alloc_* atual; enviado "" =
    // vazio explícito; enviado com valor = define.
    const pinned = sheetRow.alloc_pinned === true;
    const finalMotorista = pinned || !has("motorista") ? (sheetRow.alloc_motorista ?? null) : norm(payload.motorista);
    const finalCavalo = pinned || !has("cavalo") ? (sheetRow.alloc_cavalo ?? null) : norm(payload.cavalo);
    const finalCarreta = pinned || !has("carreta") ? (sheetRow.alloc_carreta ?? null) : norm(payload.carreta);
    const finalStatus = has("status") ? norm(payload.status) : (sheetRow.alloc_status ?? null);
    const finalTipo = has("tipo") ? norm(payload.tipo) : (sheetRow.alloc_tipo ?? null);
    // Motivo da troca (modal "Confirmar troca"): ausente preserva o último motivo.
    const finalDescricao = has("descricao") ? norm(payload.descricao) : (sheetRow.alloc_descricao ?? null);
    // Vínculo (col H da planilha): override do operador. Ausente preserva; ""=limpa.
    const finalVinculo = has("vinculo") ? norm(payload.vinculo) : (sheetRow.alloc_vinculo ?? null);

    await client.query(
      `
        UPDATE public.cargas
        SET alloc_motorista = $2,
            alloc_cavalo = $3,
            alloc_carreta = $4,
            alloc_status = $5,
            alloc_tipo = $7,
            alloc_descricao = $8,
            alloc_vinculo = $9,
            alloc_source = 'operator',
            alloc_updated_at = now(),
            alloc_updated_by = $6,
            updated_at = now()
        WHERE id = $1
      `,
      [cargoId, finalMotorista, finalCavalo, finalCarreta, finalStatus, operatorId, finalTipo, finalDescricao, finalVinculo],
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
        status: finalStatus,
        descricao: finalDescricao,
        pinned,
        cleared: !finalMotorista && !finalCavalo && !finalCarreta && !finalStatus,
      },
    });

    // Motorista alocado numa carga NORMAL deixa de estar "em reserva": baixa as
    // reservas ativas desse motorista (senão aparece na carga E no standby). Não
    // baixa em cancelamento — aí quem move é a cascata.
    const effMotorista = (finalMotorista ?? sheetRow.sheet_motorista ?? "").toString().trim();
    const cancelling = Boolean(finalStatus) && /cancel/i.test(finalStatus);
    if (effMotorista && !cancelling) {
      await client.query(
        `UPDATE public.monitor_reservas SET active = false, updated_at = now()
         WHERE active = true AND motorista = $1`,
        [effMotorista],
      );
    }

    // Limpou o motorista de uma carga RESERVADA (o motorista havia reservado pelo
    // portal): a reserva cai e a carga tem de voltar a ficar ABERTA pro motorista.
    // Resolvido FORA da transação (cancelPublicLoadLead abre a própria e trava a
    // mesma linha) — aqui só sinalizamos o lead a cancelar.
    const reopenLeadId =
      !effMotorista && !cancelling &&
      sheetRow.status === "RESERVED" && sheetRow.reserved_public_lead_id
        ? sheetRow.reserved_public_lead_id
        : null;

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lh,
        allocation: { motorista: finalMotorista, cavalo: finalCavalo, carreta: finalCarreta, status: finalStatus, source: "operator" },
        meta: { correlationId },
      },
      resolvedStatus: finalStatus,
      reopenLeadId,
      // Valor EFETIVO (o que o Monitor mostra) = override do operador ?? planilha.
      // Usado no write-back pra refletir na planilha; "" limpa a célula.
      effective: {
        motorista: finalMotorista ?? sheetRow.sheet_motorista ?? "",
        cavalo: finalCavalo ?? sheetRow.sheet_cavalo ?? "",
        carreta: finalCarreta ?? sheetRow.sheet_carreta ?? "",
        // Status (col L) espelhado sempre — efetivo = alloc ?? planilha.
        status: finalStatus ?? sheetRow.sheet_status ?? "",
        // Vínculo (col H) só espelha quando o modal envia o campo (senão o robô
        // não toca H — evita apagar o vínculo de linhas não editadas).
        ...(has("vinculo") ? { vinculo: finalVinculo ?? "" } : {}),
      },
    };
  });

  // Cancelou no Monitor (status → CANCELADO) → dispara a cascata da rota: o
  // motorista desce a fila (Interpretação A) e o último sem carga vira reserva.
  const willCascade = Boolean(result.resolvedStatus) && /cancel/i.test(result.resolvedStatus);

  // Write-back best-effort pra planilha (espelho) — FORA da transação e SEM
  // await. Quando vai cascatear, o write-back fica por conta da cascata (que
  // sabe os valores relocados) — evita gravar o valor antigo e depois corrigir.
  if (!willCascade) {
    void writeAllocationsToSheet([{ lh, ...result.effective }]).catch(() => {});
  }

  let cascadeMovedLhs = [];
  if (willCascade) {
    // Best-effort: a edição de status já está commitada; se a cascata falhar, o
    // sweep do próximo sync recupera (cancelLoadCascade é idempotente).
    try {
      const cascade = await cancelLoadCascade({ lh, operatorId, requestIp, correlationId });
      cascadeMovedLhs = cascade.movedLhs ?? [];
    } catch (cascadeErr) {
      console.warn(
        `[update-monitor-allocation] cascata de cancelamento falhou para ${lh}:`,
        cascadeErr instanceof Error ? cascadeErr.message : cascadeErr,
      );
    }
  }

  // Reabrir carga reservada: o operador limpou o motorista → cancela o lead do
  // portal (APPROVED → CANCELLED) e a carga volta a OPEN (cancelPublicLoadLead
  // zera reserved_* e faz status→OPEN). Best-effort: a limpeza já está commitada;
  // se falhar, a carga fica RESERVED sem motorista até o operador tentar de novo.
  if (result.reopenLeadId) {
    try {
      await cancelPublicLoadLead({ loadId: cargoId, leadId: result.reopenLeadId, operatorId, correlationId });
    } catch (reopenErr) {
      console.warn(
        `[update-monitor-allocation] reabrir carga reservada falhou para ${lh}:`,
        reopenErr instanceof Error ? reopenErr.message : reopenErr,
      );
    }
  }

  // movedLhs: o lh editado já é re-enriquecido pelo handler; aqui devolvemos as
  // linhas que a cascata realocou p/ o handler re-enriquecer também (fan-out).
  return { statusCode: result.statusCode, payload: result.payload, movedLhs: cascadeMovedLhs };
}
