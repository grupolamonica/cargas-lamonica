import { fetchTripIndex } from "../../../infrastructure/spx/spx-allocation-client.js";
import { normNameForMatch } from "../sheet-monitor-enrichment.js";

// Só códigos "LT…" são viagens reais do SPX (mesmo gate do assign/preview). Nestlé
// (B10…), manual e cargas do sistema NÃO existem no ASPX → selo N/A (cinza).
export function isSpxTripLh(lh) {
  return /^LT/i.test((lh ?? "").toString().trim());
}

// Cache curto do índice de viagens do SPX (trip_number → { status, driver }).
// O sidecar SPX é caro (pagina várias abas); um TTL curto deixa "quase ao vivo"
// sem martelar a cada consulta. Sobrescrevível por env.
const TTL_MS = (() => {
  const s = Number(process.env.SPX_ASSIGN_CACHE_SECONDS);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 15_000;
})();
let _cache = null; // { at: number, byNumber: Map }

async function getTripIndexCached(opts) {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.byNumber;
  const index = await fetchTripIndex({}, opts);
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
    const assignedDriver = trip ? normNameForMatch(trip.driver || "") : "";
    out[lh] = Boolean(assignedDriver && assignedDriver === eff);
  }
  return out;
}
