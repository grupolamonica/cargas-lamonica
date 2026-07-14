// backend/src/application/operator-admin/use-cases/spx-operational-status.js
//
// Sobreposição do STATUS OPERACIONAL real do SPX/Shopee (via API da Torre
// /api/spx/asp, DC-136) nas cargas do Monitor que JÁ têm motorista alocado no
// sistema. Regra pedida pelo operador: "após alocar um motorista, puxar o status
// operacional da carga na Shopee".
//
// A Torre já devolve a coluna "Status Operacional" traduzida (AGUARDANDO ACEITE,
// AGUARDANDO CHEGAR NO CLIENTE, CARREGANDO, CARREGADO, AGUARDANDO DESCARGA,
// DESCARREGANDO, DESCARREGADO, CANCELADO…) — o mesmo vocabulário dos status do
// Monitor —, então basta casar por LH (== "LH Trip Number" == trip_number do SPX)
// e usar esse valor. Best-effort: qualquer falha da Torre → NÃO sobrepõe (o
// Monitor segue com o status da planilha/alocação, sem quebrar).

import { fetchSpxTrips, SpxAspNotConfigured } from "../../../infrastructure/torre/torre-spx-trips-client.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const LH_TRIP_COL = "LH Trip Number";
const STATUS_OPERACIONAL_COL = "Status Operacional";

/**
 * Índice lh(trip_number) → "Status Operacional" das viagens SPX (Torre asp).
 * Best-effort: retorna null em qualquer falha (sem chave, Torre fora, circuito
 * aberto), pra o read model do Monitor não sobrepor e nunca quebrar por causa disso.
 *
 * @param {{ daysBack?: number, daysFwd?: number, correlationId?: string, deps?: { fetchSpx?: typeof fetchSpxTrips } }} [args]
 * @returns {Promise<Map<string,string>|null>}
 */
export async function fetchSpxStatusIndex({ daysBack = 30, daysFwd = 15, correlationId = null, deps = {} } = {}) {
  const fetchSpx = deps.fetchSpx || fetchSpxTrips;
  try {
    const payload = await fetchSpx({ daysBack, daysFwd }, { correlationId });
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const map = new Map();
    for (const r of rows) {
      const lh = String(r?.[LH_TRIP_COL] ?? "").trim();
      const statusOperacional = String(r?.[STATUS_OPERACIONAL_COL] ?? "").trim();
      if (lh && statusOperacional) map.set(lh, statusOperacional);
    }
    return map;
  } catch (err) {
    // Sem chave configurada é esperado em alguns ambientes — não polui como erro.
    if (!(err instanceof SpxAspNotConfigured)) {
      logStructuredEvent("warn", "sheet-monitor.spx-status-index-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/** Motorista EFETIVO = override do operador (alloc_motorista, "" = vazio explícito) ?? planilha. */
function effectiveDriver(row, allocByLh) {
  const alloc = allocByLh ? allocByLh[row.lh] : null;
  const v = alloc && alloc.alloc_motorista != null ? alloc.alloc_motorista : row.motoristas ?? "";
  return String(v).trim();
}

/**
 * Sobrepõe o status operacional EXIBIDO de uma carga pelo status real do SPX,
 * QUANDO a carga tem motorista alocado no sistema e o LH bate com uma viagem do
 * SPX. Pura/testável. Sem índice, sem motorista ou sem match → devolve a linha
 * inalterada.
 *
 * @param {object} row linha do Monitor (tem `lh`, `motoristas`, `status`…)
 * @param {{ spxStatusByLh: Map<string,string>|null, allocByLh?: Record<string,any> }} ctx
 */
export function applySpxOperationalStatus(row, { spxStatusByLh, allocByLh = {} } = {}) {
  if (!spxStatusByLh || spxStatusByLh.size === 0) return row;
  const lh = row?.lh;
  if (!lh) return row;
  // Só cargas COM motorista alocado no sistema (regra: "após alocar um motorista").
  if (effectiveDriver(row, allocByLh) === "") return row;
  const spxStatus = spxStatusByLh.get(String(lh).trim());
  if (!spxStatus) return row;
  return { ...row, status: spxStatus, spxStatus };
}
