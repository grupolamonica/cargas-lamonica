import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { resolveMonitorCargoByLh, resolveCargoFollowingMerge } from "./_shared.js";
import {
  extractRevertItemsFromAuditEvent,
  allocEqualsStrict,
} from "../../../domain/operator-admin/allocation-revert.js";

const ALLOC_COLUMNS =
  "id, sheet_lh, sheet_source, alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, sheet_motorista, sheet_cavalo, sheet_carreta";

// Efetivo espelhado na planilha após restaurar: um "antes" null (sem override →
// cai pra planilha) espelha o valor da planilha; string ("" ou valor) espelha ela.
const effectiveForSheet = (beforeVal, sheetVal) => (beforeVal == null ? sheetVal ?? "" : beforeVal);

/**
 * Reverte mudanças de ALOCAÇÃO do operador logado (DC-283) — backend do modal
 * "Reverter últimas mudanças" do Monitor.
 *
 * Recebe pares (auditLogId, carga) escolhidos no modal e restaura, numa única
 * transação, o estado ANTES gravado no metadata do evento. É AUTORITATIVO: lê o
 * "antes" do próprio audit log (o cliente não envia valores), só reverte eventos
 * do PRÓPRIO operador e só quando a alocação atual ainda bate com o "depois"
 * gravado (senão pula — alguém mexeu na carga desde então). Grava um evento
 * `operator.cargo.allocation_reverted` e espelha na planilha (best-effort).
 *
 * NÃO mexe em `monitor_reservas`: se a ação original criou/removeu um standby, o
 * operador é avisado no modal para revisar a reserva manualmente.
 *
 * @param {{ operatorId: string, items: Array<{auditLogId:string, lh?:string, cargoId?:string}>,
 *           requestIp?: string, correlationId?: string }} args
 */
export async function revertAllocationChanges({ operatorId, items, requestIp, correlationId }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("Nenhuma mudança selecionada para reverter.");
  }

  // Agrupa os refs pedidos por evento de auditoria.
  const byAudit = new Map();
  for (const raw of items) {
    const auditLogId = (raw?.auditLogId ?? "").toString().trim();
    const lh = (raw?.lh ?? "").toString().trim();
    const cargoId = (raw?.cargoId ?? "").toString().trim();
    if (!auditLogId || (!lh && !cargoId)) {
      throw new ValidationError("Cada item precisa de auditLogId e (lh ou cargoId).");
    }
    if (!byAudit.has(auditLogId)) byAudit.set(auditLogId, []);
    byAudit.get(auditLogId).push({ lh: lh || null, cargoId: cargoId || null });
  }
  const auditIds = [...byAudit.keys()];

  const result = await withPgTransaction(async (client) => {
    const { rows: auditRows } = await client.query(
      `SELECT id, event_type, actor_user_id, metadata
         FROM public.security_audit_logs
        WHERE id IN (${auditIds.map((_, i) => `$${i + 1}`).join(", ")})`,
      auditIds,
    );
    const auditById = new Map(auditRows.map((r) => [r.id, r]));

    const reverted = [];
    const skipped = [];
    const writebackMoves = [];

    for (const [auditLogId, refs] of byAudit) {
      const audit = auditById.get(auditLogId);
      if (!audit) {
        for (const ref of refs) skipped.push({ ...ref, auditLogId, reason: "Ação não encontrada." });
        continue;
      }
      // Escopo: o operador só reverte as PRÓPRIAS mudanças.
      if (audit.actor_user_id !== operatorId) {
        for (const ref of refs) skipped.push({ ...ref, auditLogId, reason: "Só é possível reverter as suas próprias mudanças." });
        continue;
      }
      const parsed = extractRevertItemsFromAuditEvent({ eventType: audit.event_type, metadata: audit.metadata });
      if (!parsed.supported) {
        for (const ref of refs) skipped.push({ ...ref, auditLogId, reason: parsed.reason || "Ação não revertível." });
        continue;
      }
      const fields = parsed.touchesStatus
        ? ["motorista", "cavalo", "carreta", "status"]
        : ["motorista", "cavalo", "carreta"];

      // Indexa as mudanças do evento por lh e por cargoId.
      const itemByLh = new Map();
      const itemByCargoId = new Map();
      for (const it of parsed.items) {
        if (it.lh) itemByLh.set(it.lh, it);
        if (it.cargoId) itemByCargoId.set(it.cargoId, it);
      }

      for (const ref of refs) {
        const change = ref.lh ? itemByLh.get(ref.lh) : itemByCargoId.get(ref.cargoId);
        if (!change) {
          skipped.push({ ...ref, auditLogId, reason: "Carga não faz parte desta ação." });
          continue;
        }

        // Resolve + trava a carga (planilha por LH ou sistema por cargoId). Segue
        // o ponteiro de merge: se o cargoId gravado no evento é hoje uma PERDEDORA
        // (gêmea já mergeada — TWIN_MERGE), reverter direto nela escreveria numa
        // linha morta (a carga visível/efetiva é a vencedora) — o operador veria
        // "revertido" sem nada mudar na tela. Resolvendo a vencedora primeiro, a
        // guarda `allocEqualsStrict` abaixo compara com o estado REAL e visível.
        // Resolve + trava a carga (planilha por LH ou sistema por cargoId).
        // A fonte da planilha (`sheetSource`) sai do próprio audit: é ela que põe o
        // id no namespace certo (createSheetLoadId(lh, source)). Evento ANTIGO não
        // gravava o campo — aí `sheetSource` é null e resolvemos como Shopee, que é
        // exatamente o comportamento de hoje. Reverter uma alocação de OUTRA fonte
        // registrada antes deste fix não é possível com segurança (o LH sozinho não
        // identifica a carga: `sheet_lh` só é único POR fonte), então esse item é
        // SKIPPED com motivo explícito em vez de resolver a carga errada.
        let cargo;
        if (change.lh) {
          cargo = await resolveMonitorCargoByLh(client, change.lh, {
            columns: ALLOC_COLUMNS,
            source: change.sheetSource ?? null,
          });
          if (!cargo && !change.sheetSource) {
            const { rows: ambiguas } = await client.query(
              `SELECT COUNT(*)::int AS total FROM public.cargas
                WHERE sheet_lh = $1 AND COALESCE(sheet_source, '') <> ''`,
              [change.lh],
            );
            if ((ambiguas[0]?.total ?? 0) > 0) {
              skipped.push({
                ...ref,
                auditLogId,
                reason: "Mudança registrada antes do suporte a múltiplas planilhas (não é possível identificar a planilha da carga).",
              });
              continue;
            }
          }
        } else {
          cargo = await resolveCargoFollowingMerge(client, change.cargoId, { columns: ALLOC_COLUMNS, forUpdate: true });
        }
        if (!cargo) {
          skipped.push({ ...ref, auditLogId, reason: "Carga não existe mais." });
          continue;
        }

        // Guarda: a alocação atual ainda tem que bater com o "depois" gravado.
        const currentAlloc = {
          motorista: cargo.alloc_motorista,
          cavalo: cargo.alloc_cavalo,
          carreta: cargo.alloc_carreta,
          status: cargo.alloc_status,
        };
        if (!allocEqualsStrict(currentAlloc, change.after, fields)) {
          skipped.push({ ...ref, auditLogId, reason: "A carga foi alterada depois desta ação." });
          continue;
        }

        // Restaura o "antes". Só toca alloc_status quando o evento mexeu em status.
        const before = change.before;
        if (parsed.touchesStatus) {
          await client.query(
            `UPDATE public.cargas
                SET alloc_motorista = $2, alloc_cavalo = $3, alloc_carreta = $4, alloc_status = $5,
                    alloc_source = 'operator', alloc_updated_at = now(), alloc_updated_by = $6, updated_at = now()
              WHERE id = $1`,
            [cargo.id, before.motorista ?? null, before.cavalo ?? null, before.carreta ?? null, before.status ?? null, operatorId],
          );
        } else {
          await client.query(
            `UPDATE public.cargas
                SET alloc_motorista = $2, alloc_cavalo = $3, alloc_carreta = $4,
                    alloc_source = 'operator', alloc_updated_at = now(), alloc_updated_by = $5, updated_at = now()
              WHERE id = $1`,
            [cargo.id, before.motorista ?? null, before.cavalo ?? null, before.carreta ?? null, operatorId],
          );
        }

        reverted.push({ auditLogId, lh: change.lh, cargoId: change.cargoId, before, after: change.after });

        // Write-back só p/ carga da PLANILHA (sheet_lh não nulo) — espelha o
        // efetivo restaurado ("" limpa a célula; null cai pro valor da planilha).
        if (cargo.sheet_lh != null && change.lh) {
          writebackMoves.push({
            lh: change.lh,
            // Fonte da carga RESOLVIDA: sem ela o write-back cai na planilha da
            // Shopee (normSource(null)) e escreveria o LH de outra fonte lá.
            source: cargo.sheet_source ?? null,
            motorista: effectiveForSheet(before.motorista, cargo.sheet_motorista),
            cavalo: effectiveForSheet(before.cavalo, cargo.sheet_cavalo),
            carreta: effectiveForSheet(before.carreta, cargo.sheet_carreta),
          });
        }
      }
    }

    if (reverted.length > 0) {
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cargo.allocation_reverted",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "cargo",
        resourceId: reverted[0].cargoId || null,
        action: "update",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: {
          count: reverted.length,
          reverted: reverted.map(({ auditLogId, lh, cargoId, before, after }) => ({ auditLogId, lh, cargoId, before, after })),
          skippedCount: skipped.length,
        },
      });
    }

    return { reverted, skipped, writebackMoves };
  });

  // Write-back best-effort dos valores restaurados — FORA da transação, sem await.
  if (result.writebackMoves.length > 0) {
    void writeAllocationsToSheet(result.writebackMoves).catch(() => {});
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      revertedCount: result.reverted.length,
      skippedCount: result.skipped.length,
      reverted: result.reverted.map(({ auditLogId, lh, cargoId }) => ({ auditLogId, lh, cargoId })),
      skipped: result.skipped,
      meta: { correlationId },
    },
    // LHs revertidos → o handler re-enriquece (fan-out) como nas outras mutações.
    movedLhs: result.reverted.map((r) => r.lh).filter(Boolean),
  };
}
