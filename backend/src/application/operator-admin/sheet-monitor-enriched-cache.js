import { selectAllParallel } from "../../infrastructure/supabase/paginate.js";

// Cache em memória dos mapas de enriquecimento do Monitor (selos Angellira/ASPX).
// A leitura é pesada (~5k linhas, paginadas) e roda a CADA interação da fila
// (editar/reordenar dispara invalidate + refetch atrasado) — sem cache isso
// re-lê tudo toda hora (lento + egress, ver [[pooler_egress_incident]]).
//
// Estratégia: TTL curto + single-flight + BUST quando o enrich escreve. Assim
// reorders consecutivos batem no cache (instantâneo), e quando o enrich
// (fire-and-forget pós-alocação) grava, o cache é invalidado → o próximo refetch
// traz os selos novos. allocByLh (o motorista/placa efetivo) NÃO é cacheado, então
// a troca aparece na hora; só o selo é eventualmente-consistente (já era assíncrono).
const TTL_MS = 20_000;

let cache = null; // { enrichedByLh, enrichedByCargoId }
let expiresAt = 0;
let inFlight = null;

export function bustSheetMonitorEnrichedCache() {
  cache = null;
  expiresAt = 0;
}

export async function readEnrichedMapsCached(supabaseClient, correlationId) {
  if (cache && expiresAt > Date.now()) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const rows = await selectAllParallel(supabaseClient, "sheet_monitor_enriched", {
        columns: "*",
        orderColumn: "lh",
        correlationId,
      });
      const enrichedByLh = {};
      const enrichedByCargoId = {};
      for (const r of rows) {
        if (r.lh) enrichedByLh[r.lh] = r;
        if (r.cargo_id) enrichedByCargoId[r.cargo_id] = r;
      }
      cache = { enrichedByLh, enrichedByCargoId };
      expiresAt = Date.now() + TTL_MS;
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
