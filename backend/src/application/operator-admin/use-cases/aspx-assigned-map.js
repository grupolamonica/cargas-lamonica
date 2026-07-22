import { fetchTripIndex } from "../../../infrastructure/spx/spx-allocation-client.js";
import { driverNamesMatch, normNameForMatch } from "../sheet-monitor-enrichment.js";

// Viagem já ENCERRADA (concluída/cancelada). Para essas, a atribuição não é mais
// acionável e o histórico do ASPX frequentemente diverge do que ficou no sistema
// (substituição na execução, edições posteriores) — marcar vermelho vira RUÍDO.
// Detecta pelo rótulo de status (SPX: "Completed"/"Cancelled"; PT: conclu/cancel/finaliz).
function isHistoricalTrip(trip) {
  const s = (trip?.statusName || "").toString().toLowerCase();
  return s.includes("complet") || s.includes("cancel") || s.includes("conclu") || s.includes("finaliz");
}

// Só códigos "LT…" são viagens reais do SPX (mesmo gate do assign/preview). Nestlé
// (B10…), manual e cargas do sistema NÃO existem no ASPX → selo N/A (cinza).
export function isSpxTripLh(lh) {
  return /^LT/i.test((lh ?? "").toString().trim());
}

// Cache do índice de viagens do SPX (trip_number → { status, driver }). O sidecar
// pagina 3 abas (Planejado+Aceito+Concluído), então é caro; a fonte SPX só atualiza
// ~a cada 10min, então ~60s deixa "quase ao vivo" sem martelar o portal. Env override.
const TTL_MS = (() => {
  const s = Number(process.env.SPX_ASSIGN_CACHE_SECONDS);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 60_000;
})();
let _cache = null; // { at: number, byNumber: Map }

async function getTripIndexCached(opts) {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.byNumber;
  // includeConcluido: viagens ATRIBUÍDAS que já concluíram saem das abas
  // Planejado/Aceito; sem incluir o histórico, o selo marcava "não atribuído"
  // (vermelho) por elas simplesmente não estarem no índice consultado.
  const index = await fetchTripIndex({ includeConcluido: true, concluidoDaysBack: 20 }, opts);
  const byNumber = index?.byNumber instanceof Map ? index.byNumber : new Map();
  _cache = { at: Date.now(), byNumber };
  return byNumber;
}

/** Só p/ testes: zera o cache do índice. */
export function resetAspxAssignedCacheForTests() {
  _cache = null;
}

/**
 * Para cada carga de viagem SPX ("LT…"), diz se o motorista informado (o EFETIVO da
 * carga) é o MESMO que está atribuído àquela viagem no SPX/ASPX.
 *   - true  → atribuído (motorista do sistema == motorista da viagem no SPX) → verde
 *   - false → NÃO atribuído (viagem sem esse motorista no SPX, ou motorista diferente,
 *             ou sem motorista) → vermelho
 * Cargas não-SPX não entram no mapa (selo fica N/A). Índice indisponível (sidecar
 * fora do ar) → mapa vazio (selo "não consultado"/cinza) — best-effort, nunca lança.
 *
 * @param {Array<{lh:string, motorista:string}>} items
 * @returns {Promise<Record<string, boolean>>}
 */
export async function buildAspxAssignedByLh(items, opts = {}) {
  const spx = (Array.isArray(items) ? items : []).filter((it) => it && isSpxTripLh(it.lh));
  if (spx.length === 0) return {};

  let byNumber;
  try {
    byNumber = await getTripIndexCached(opts);
  } catch {
    return {}; // sidecar indisponível → tudo "não consultado" (cinza)
  }

  const out = {};
  for (const it of spx) {
    const lh = String(it.lh).trim();
    const eff = normNameForMatch(it.motorista || "");
    if (!eff) { out[lh] = false; continue; } // carga sem motorista → não atribuído
    const trip = byNumber.get(lh);
    // Viagem FORA do índice consultado (não veio de Planejado/Aceito/Concluído — ex.:
    // além da janela/páginas): NÃO sabemos o estado → OMITE (selo cinza "não
    // consultado"), NUNCA marca vermelho. Marcar `false` aqui era o falso-negativo
    // que fazia motoristas JÁ atribuídos aparecerem como "não atribuídos".
    if (!trip) continue;
    // Match tolerante a acento/caixa/conectivo/nome-do-meio (mesma pessoa grafada
    // diferente entre planilha e ASPX — ex.: "WESLEY ARAUJO SOARES" vs "WESLEY DE
    // ARAUJO SOARES" — não é divergência de motorista).
    if (driverNamesMatch(it.motorista, trip.driver)) { out[lh] = true; continue; }
    // Divergência: para viagem ENCERRADA (concluída/cancelada), a maior parte é
    // ruído histórico (não acionável) → OMITE (cinza), NUNCA vermelho. Só viagem
    // ATIVA (planejada/aceita/em execução) com motorista diferente vira vermelho —
    // aí sim é acionável (o motorista do sistema não está atribuído no ASPX).
    if (isHistoricalTrip(trip)) continue;
    out[lh] = false;
  }
  return out;
}
