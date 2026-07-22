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
import { fetchSpxTripsByTab } from "../../../infrastructure/spx/spx-allocation-client.js";
import { spxTripStatusLabel } from "../../../domain/operator-admin/spx-trip-status.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const LH_TRIP_COL = "LH Trip Number";
const STATUS_OPERACIONAL_COL = "Status Operacional";

// Abas do portal SPX que carregam o status ao vivo das viagens COM motorista:
//  - Planejado (1): motorista ATRIBUÍDO no ASPX mas ainda NÃO aceito → status
//    "Assigned" (→ AGUARDANDO CHEGAR NO CLIENTE). É o momento "atribuiu no ASPX".
//  - Aceito (2): já aceita, progredindo (loading→departed→arrived→…).
// Só Aceito (o estado anterior) fazia o status do motorista recém-atribuído NÃO
// atualizar no sistema até a viagem ser aceita.
const SPX_PLANEJADO_QUERY_TYPE = 1;
const SPX_ACEITO_QUERY_TYPE = 2;

/** Kill-switch do status AO VIVO do SPX no Monitor. LIGADO por padrão; defina
 *  SPX_MONITOR_LIVE_STATUS_ENABLED=false para voltar ao status só da planilha. */
export function isSpxMonitorLiveStatusEnabled() {
  return (process.env.SPX_MONITOR_LIVE_STATUS_ENABLED || "").trim().toLowerCase() !== "false";
}

function statusIndexTtlMs() {
  const s = Number(process.env.SPX_MONITOR_STATUS_CACHE_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 90) * 1000;
}

// Cache do índice de status (Map lh→status) — memoizado process-wide. A fonte SPX
// só atualiza ~a cada 10min, então ~90s mantém "ao vivo" com no máximo 1 busca por
// ~90s, independentemente de quantos operadores estão com o Monitor aberto.
let _statusIndexCache = null; // { value: Map|null, expiresAt: number }

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

/**
 * Índice lh(trip_number) → status operacional AO VIVO das viagens SPX aceitas,
 * lido do portal SPX pelo sidecar spx-bot (tab "aceito"), com a MESMA tradução da
 * Programação (`spxTripStatusLabel` sobre `trip_status_name`). NÃO usa a Torre
 * /api/spx/asp (que colapsava origem×descarga — motivo do overlay antigo ter sido
 * desligado).
 *
 * Leve: índice memoizado por ~90s (SPX_MONITOR_STATUS_CACHE_SECONDS) e a busca por
 * tab já tem cache de 30s compartilhado com a Programação. Best-effort: falha →
 * null + backoff curto (não martela o sidecar fora do ar).
 *
 * @param {{ correlationId?: string, force?: boolean, deps?: { fetchSpxTripsByTab?: typeof fetchSpxTripsByTab } }} [args]
 * @returns {Promise<Map<string,string>|null>}
 */
export async function fetchSpxStatusIndexFromSnapshot({ correlationId = null, force = false, deps = {} } = {}) {
  if (!force && _statusIndexCache && _statusIndexCache.expiresAt > Date.now()) {
    return _statusIndexCache.value;
  }
  const fetchTab = deps.fetchSpxTripsByTab || fetchSpxTripsByTab;
  // Planejado (janela 45/30 — a viagem atribuída pode ter STD à frente) + Aceito.
  const tabs = [
    { qt: SPX_PLANEJADO_QUERY_TYPE, opts: { daysBack: 45, daysForward: 30, maxPages: 30 } },
    { qt: SPX_ACEITO_QUERY_TYPE, opts: { maxPages: 30 } },
  ];
  try {
    // timeout curto: numa falha de cache o Monitor espera no máx. ~10s por aba.
    // Best-effort por aba: uma aba fora do ar não derruba a outra.
    const perTab = await Promise.all(
      tabs.map((t) =>
        fetchTab(t.qt, t.opts, { correlationId, timeoutMs: 10000 })
          .then((r) => (Array.isArray(r?.trips) ? r.trips : []))
          .catch(() => null),
      ),
    );
    if (perTab.every((r) => r === null)) throw new Error("todas as abas SPX de status falharam");
    const map = new Map();
    // Planejado é processado ANTES; Aceito DEPOIS sobrescreve (status mais avançado
    // vence quando a MESMA viagem aparecer em ambas — raro, mas determinístico).
    for (const trips of perTab) {
      if (!trips) continue;
      for (const t of trips) {
        const lh = String(t?.trip_number ?? "").trim();
        const raw = t?.trip_status_name || t?.trip_status;
        if (!lh || !raw) continue;
        const label = spxTripStatusLabel(raw);
        if (label) map.set(lh, label);
      }
    }
    const ttl = statusIndexTtlMs();
    if (ttl > 0) _statusIndexCache = { value: map, expiresAt: Date.now() + ttl };
    return map;
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor.spx-live-status-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    // Backoff: memoiza null por 30s p/ não repetir a busca a cada leitura quando o
    // sidecar está fora do ar. Recupera sozinho no próximo ciclo.
    _statusIndexCache = { value: null, expiresAt: Date.now() + 30_000 };
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
