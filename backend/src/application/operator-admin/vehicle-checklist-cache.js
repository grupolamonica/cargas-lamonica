import { fetchVehicleChecklistRows, isVehicleChecklistEnabled } from "../google-sheets/vehicle-checklist-sheet.js";

// Cache em memória do checklist de veículos (placaNorm → itens). A planilha do
// robô GRIFFI é lida por CSV; o status/cor é calculado ao vivo pelo domínio, então
// mesmo uma linha com alguns minutos gera cor correta. TTL curto + single-flight
// evita reler o CSV a cada abertura de modal/linha (mesma estratégia do
// [[sheet-monitor-enriched-cache]]). Single-replica → cache em processo é ok.
const TTL_MS = 60_000;

let cache = null; // Map<placaNorm, item[]>
let expiresAt = 0;
let inFlight = null;

export function bustVehicleChecklistCache() {
  cache = null;
  expiresAt = 0;
}

export async function readVehicleChecklistMapCached() {
  if (!isVehicleChecklistEnabled()) return new Map();
  if (cache && expiresAt > Date.now()) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const rows = await fetchVehicleChecklistRows();
      const map = new Map();
      for (const item of rows) {
        if (!item.placaNorm) continue;
        const list = map.get(item.placaNorm);
        if (list) list.push(item);
        else map.set(item.placaNorm, [item]);
      }
      cache = map;
      expiresAt = Date.now() + TTL_MS;
      return cache;
    } catch (error) {
      console.error(
        "[vehicle-checklist] leitura da planilha falhou — servindo cache antigo/vazio:",
        error instanceof Error ? error.message : String(error),
      );
      // Best-effort: mantém o último cache bom (ou vazio) e faz backoff para não
      // martelar a planilha em falha persistente.
      if (!cache) cache = new Map();
      expiresAt = Date.now() + TTL_MS;
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
