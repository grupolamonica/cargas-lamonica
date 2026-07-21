// backend/src/application/operator-admin/use-cases/spx-schedule-overlay.js
//
// Overlay de CARGA/DESCARGA (agenda) das viagens SPX/Shopee no Monitor, puxando os
// horários AO VIVO da Torre (/api/spx/asp) — colunas "ETA ORIGEM" (carga) e "ETA
// DESTINO" (descarga). Mantém a Carga/Descarga do Monitor sincronizadas com o SPX sem
// depender do ciclo LENTO da planilha (sheet → sync). A planilha vira só o fallback.
//
// IMPORTANTE — por que é seguro usar a Torre aqui (o overlay de STATUS está desligado):
// o problema que desligou o status era a TRADUÇÃO do "Status Operacional" da Torre,
// que conflava origem↔destino ("Arrived" na origem virava "AGUARDANDO DESCARGA"). As
// colunas ETA ORIGEM/ETA DESTINO são GEOGRÁFICAS e explícitas — carga=origem,
// descarga=destino, sem ambiguidade —, então não sofrem desse problema.
//
// PROGRAMADO (previsto) é a fonte: é EXATAMENTE o que a planilha Shopee espelha hoje
// na Carga/Descarga (verificado — a coluna "data carregamento" == "ETA ORIGEM
// PROGRAMADO" e "data descarga" == "ETA DESTINO PROGRAMADO", casando 100% nas linhas
// frescas). Ou seja: mesmo valor da planilha, só que AO VIVO (sem esperar o sync). REAL
// (o que realmente aconteceu) fica só como fallback quando o PROGRAMADO vier vazio.
// Best-effort: qualquer falha da Torre → sem overlay (Monitor segue com a planilha).

import { fetchSpxTrips, SpxAspNotConfigured } from "../../../infrastructure/torre/torre-spx-trips-client.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const LH_TRIP_COL = "LH Trip Number";
// PROGRAMADO primeiro (== semântica da planilha), REAL só como fallback.
const CARGA_COLS = ["ETA ORIGEM PROGRAMADO", "ETA ORIGEM REAL"];
const DESCARGA_COLS = ["ETA DESTINO PROGRAMADO", "ETA DESTINO REAL"];

// "DD/MM/YYYY HH:MM" (formato da Torre) → { label, dateIso, timeIso, at } ou null.
//   label  = "DD/MM/YYYY HH:MM" (== formato exibido no Monitor: carregamentoLabel)
//   dateIso= "YYYY-MM-DD"       (row.data — ordenação/filtro de carga)
//   timeIso= "HH:MM"            (row.horario)
//   at     = "YYYY-MM-DDTHH:MM" (row.cargaAt/descargaAt — datetime-local)
function parseAspDateTime(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  return {
    label: `${d}/${mo}/${y} ${h}:${mi}`,
    dateIso: `${y}-${mo}-${d}`,
    timeIso: `${h}:${mi}`,
    at: `${y}-${mo}-${d}T${h}:${mi}`,
  };
}

function firstNonEmpty(row, cols) {
  for (const c of cols) {
    const v = String(row?.[c] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/**
 * Índice lh(trip_number) → { carga, descarga } (cada um { label, dateIso, timeIso, at }
 * ou null) das viagens SPX (Torre asp). Best-effort: null em qualquer falha (sem chave,
 * Torre fora, circuito aberto) — o Monitor não sobrepõe e nunca quebra por causa disso.
 * Reusa fetchSpxTrips (cache 60s + circuit breaker) → 1 chamada barata amortizada.
 *
 * @param {{ daysBack?: number, daysFwd?: number, correlationId?: string, deps?: { fetchSpx?: typeof fetchSpxTrips } }} [args]
 * @returns {Promise<Map<string, { carga: object|null, descarga: object|null }>|null>}
 */
export async function fetchSpxScheduleIndex({ daysBack = 30, daysFwd = 15, correlationId = null, deps = {} } = {}) {
  const fetchSpx = deps.fetchSpx || fetchSpxTrips;
  try {
    const payload = await fetchSpx({ daysBack, daysFwd }, { correlationId });
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const map = new Map();
    for (const r of rows) {
      const lh = String(r?.[LH_TRIP_COL] ?? "").trim();
      if (!lh) continue;
      const carga = parseAspDateTime(firstNonEmpty(r, CARGA_COLS));
      const descarga = parseAspDateTime(firstNonEmpty(r, DESCARGA_COLS));
      if (carga || descarga) map.set(lh, { carga, descarga });
    }
    return map;
  } catch (err) {
    // Sem chave configurada é esperado em alguns ambientes — não polui como erro.
    if (!(err instanceof SpxAspNotConfigured)) {
      logStructuredEvent("warn", "sheet-monitor.spx-schedule-index-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/**
 * Sobrepõe a Carga/Descarga EXIBIDA de uma linha da planilha pelo horário AO VIVO do
 * SPX (Torre), casando por LH (== trip_number). Só linhas Shopee casam (LH "LT…");
 * Nestlé/importadas/sistema não têm match → inalteradas. Sem índice/sem match → linha
 * inalterada. Toca SÓ campos de agenda (carga/descarga) — nunca motorista/status.
 *
 * @param {object} row linha do Monitor (tem `lh`, `carregamentoLabel`, `descargaLabel`, `data`, `horario`…)
 * @param {{ spxScheduleByLh: Map<string,{carga:object|null,descarga:object|null}>|null }} ctx
 */
export function applySpxSchedule(row, { spxScheduleByLh } = {}) {
  if (!spxScheduleByLh || spxScheduleByLh.size === 0) return row;
  const lh = row?.lh;
  if (!lh) return row;
  const sched = spxScheduleByLh.get(String(lh).trim());
  if (!sched || (!sched.carga && !sched.descarga)) return row;
  const next = { ...row };
  if (sched.carga) {
    next.carregamentoLabel = sched.carga.label;
    next.data = sched.carga.dateIso; // ordenação/filtro de carga acompanham o SPX
    next.horario = sched.carga.timeIso;
    next.cargaAt = sched.carga.at;
  }
  if (sched.descarga) {
    next.descargaLabel = sched.descarga.label;
    next.descargaAt = sched.descarga.at; // habilita o filtro de descarga p/ linhas Shopee
  }
  return next;
}
