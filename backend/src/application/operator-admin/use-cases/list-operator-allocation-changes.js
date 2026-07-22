import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { buildPaginationMeta } from "../../../domain/operator-admin/route-utils.js";
import { resolveEventLabel } from "../../../domain/operator-admin/audit-log-taxonomy.js";
import {
  REVERTIBLE_EVENT_TYPES,
  extractRevertItemsFromAuditEvent,
  allocChanged,
  allocEqualsStrict,
} from "../../../domain/operator-admin/allocation-revert.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function parsePagination(query) {
  const rawPage = Number.parseInt(query?.page ?? "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawPageSize = Number.parseInt(query?.pageSize ?? "", 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * Lista as últimas mudanças de ALOCAÇÃO do operador logado (DC-283) — fonte do
 * modal "Reverter últimas mudanças" do Monitor.
 *
 * Lê security_audit_logs do PRÓPRIO operador (actor_user_id = operatorId) nos
 * tipos de evento de alocação, normaliza cada evento em mudanças POR CARGA
 * (antes → depois) e marca, por carga, se o estado atual ainda bate com o
 * "depois" gravado (`currentMatchesAfter`) — só então a reversão é segura. Eventos
 * anteriores ao deploy (sem estado "antes") vêm como `revertible: false`.
 *
 * @param {{ operatorId: string, query?: object, correlationId?: string }} args
 */
export async function listOperatorAllocationChanges({ operatorId, query, correlationId }) {
  const { page, pageSize, offset } = parsePagination(query);

  return withPgClient(async (client) => {
    const typePlaceholders = REVERTIBLE_EVENT_TYPES.map((_, i) => `$${i + 2}`).join(", ");
    const [eventsResult, countResult] = await Promise.all([
      client.query(
        `SELECT id, event_type, resource_id, correlation_id, metadata, created_at
           FROM public.security_audit_logs
          WHERE actor_user_id = $1
            AND event_type IN (${typePlaceholders})
          ORDER BY created_at DESC, id DESC
          LIMIT $${REVERTIBLE_EVENT_TYPES.length + 2} OFFSET $${REVERTIBLE_EVENT_TYPES.length + 3}`,
        [operatorId, ...REVERTIBLE_EVENT_TYPES, pageSize, offset],
      ),
      client.query(
        `SELECT COUNT(*)::int AS total
           FROM public.security_audit_logs
          WHERE actor_user_id = $1 AND event_type IN (${typePlaceholders})`,
        [operatorId, ...REVERTIBLE_EVENT_TYPES],
      ),
    ]);
    const totalCount = Number(countResult.rows[0]?.total) || 0;

    // Extrai as mudanças por carga de cada evento e reúne as cargas a resolver.
    const extracted = eventsResult.rows.map((row) => ({
      row,
      parsed: extractRevertItemsFromAuditEvent({ eventType: row.event_type, metadata: row.metadata }),
    }));

    const sheetIdSet = new Set();
    const lhSet = new Set();
    const cargoIdSet = new Set();
    for (const { parsed } of extracted) {
      if (!parsed.supported) continue;
      for (const it of parsed.items) {
        if (it.lh) {
          sheetIdSet.add(createSheetLoadId(it.lh));
          lhSet.add(it.lh);
        } else if (it.cargoId) {
          cargoIdSet.add(it.cargoId);
        }
      }
    }

    // Alocação BRUTA atual das cargas envolvidas (IN-list de params p/
    // compatibilidade com o harness pg-mem). Resolve carga da planilha (id =
    // createSheetLoadId(lh)) OU do sistema lançado (lh_manual, sheet_lh NULL).
    const byId = new Map();
    const byLhManual = new Map();
    const idParams = [...sheetIdSet, ...cargoIdSet];
    const lhParams = [...lhSet];
    if (idParams.length > 0 || lhParams.length > 0) {
      const clauses = [];
      const params = [];
      if (idParams.length > 0) {
        clauses.push(`id IN (${idParams.map((_, i) => `$${i + 1}`).join(", ")})`);
        params.push(...idParams);
      }
      if (lhParams.length > 0) {
        clauses.push(`(lh_manual IN (${lhParams.map((_, i) => `$${idParams.length + i + 1}`).join(", ")}) AND sheet_lh IS NULL)`);
        params.push(...lhParams);
      }
      const { rows } = await client.query(
        `SELECT id, sheet_lh, lh_manual, alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status
           FROM public.cargas WHERE ${clauses.join(" OR ")}`,
        params,
      );
      for (const r of rows) {
        byId.set(r.id, r);
        if (r.sheet_lh == null && r.lh_manual != null) byLhManual.set(r.lh_manual, r);
      }
    }

    const currentAllocFor = (item) => {
      if (item.lh) return byId.get(createSheetLoadId(item.lh)) || byLhManual.get(item.lh) || null;
      if (item.cargoId) return byId.get(item.cargoId) || null;
      return null;
    };

    const items = extracted.map(({ row, parsed }) => {
      const fields = parsed.touchesStatus
        ? ["motorista", "cavalo", "carreta", "status"]
        : ["motorista", "cavalo", "carreta"];

      // Só as cargas que de fato mudaram (before ≠ after) entram no modal.
      const cargos = parsed.items
        .filter((it) => allocChanged(it.before, it.after, fields))
        .map((it) => {
          const current = currentAllocFor(it);
          const currentMatchesAfter = allocEqualsStrict(
            current
              ? { motorista: current.alloc_motorista, cavalo: current.alloc_cavalo, carreta: current.alloc_carreta, status: current.alloc_status }
              : null,
            it.after,
            fields,
          );
          return {
            lh: it.lh,
            cargoId: it.cargoId,
            before: it.before,
            after: it.after,
            currentMatchesAfter,
            cargoFound: Boolean(current),
          };
        });

      const anyRevertable = parsed.supported && cargos.some((c) => c.currentMatchesAfter);
      let reason = null;
      if (!parsed.supported) reason = parsed.reason;
      else if (cargos.length === 0) reason = "Sem alterações de alocação para reverter.";
      else if (!anyRevertable) reason = "As cargas já foram alteradas depois desta ação.";

      return {
        auditLogId: row.id,
        eventType: row.event_type,
        eventLabel: resolveEventLabel(row.event_type),
        createdAt: row.created_at,
        route: parsed.route,
        reserva: parsed.reserva,
        touchesStatus: parsed.touchesStatus,
        revertible: anyRevertable,
        reason,
        cargos,
      };
    });

    return {
      statusCode: 200,
      payload: {
        items,
        meta: buildPaginationMeta(page, pageSize, totalCount, MAX_PAGE_SIZE, correlationId),
      },
    };
  });
}
