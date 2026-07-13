import { readVehicleChecklistMapCached } from "../vehicle-checklist-cache.js";
import {
  computeChecklistLevel,
  aggregateLevel,
  normalizePlate,
} from "../../../domain/vehicle-checklist/status.js";

function resolveYellowDays() {
  const parsed = Number.parseInt(process.env.VEHICLE_CHECKLIST_YELLOW_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

// Resolve os itens crus de uma placa em { level, daysToDue, items }: calcula o
// semáforo ao vivo por item, consolida o pior nível e o menor daysToDue.
function resolvePlateEntry(items, { nowMs, yellowDays }) {
  const resolvedItems = (items || []).map((item) => {
    const { level, daysToDue } = computeChecklistLevel({
      validadeMs: item.validadeMs,
      vencimentoDias: item.vencimentoDias,
      statusRaw: item.statusRaw,
      nowMs,
      yellowDays,
    });
    return {
      tipoVeiculo: item.tipoVeiculo,
      statusRaw: item.statusRaw,
      ultimoStatus: item.ultimoStatus,
      proprietario: item.proprietario,
      dataInclusao: item.dataInclusao,
      level,
      daysToDue,
    };
  });

  const level = aggregateLevel(resolvedItems.map((item) => item.level));
  const daysList = resolvedItems.map((item) => item.daysToDue).filter((value) => Number.isFinite(value));
  const daysToDue = daysList.length ? Math.min(...daysList) : null;

  return { level, daysToDue, items: resolvedItems };
}

/**
 * Checklist de veículo por placa (cavalo/carreta) para o card do Monitor.
 *
 * Recebe placas (string separada por vírgula ou array), casa por placa
 * normalizada contra o cache da planilha e calcula o semáforo ao vivo. A
 * resposta é indexada pela placa EXATA que veio na query (sem normalizar),
 * para o front casar direto sem divergência.
 *
 * @param {object} p
 * @param {string|string[]} p.placas
 * @param {string} [p.correlationId]
 * @param {number} [p.nowMs] - injetável para teste
 */
export async function fetchVehicleChecklist({ placas, correlationId, nowMs = Date.now() } = {}) {
  const inputs = Array.isArray(placas) ? placas : String(placas ?? "").split(",");
  const cleaned = [...new Set(inputs.map((value) => String(value ?? "").trim()).filter(Boolean))];
  const yellowDays = resolveYellowDays();

  const map = await readVehicleChecklistMapCached();

  const byPlaca = {};
  for (const raw of cleaned) {
    const norm = normalizePlate(raw);
    const entry = resolvePlateEntry(norm ? map.get(norm) : [], { nowMs, yellowDays });
    byPlaca[raw] = { placa: raw, found: (norm && map.get(norm)?.length) > 0, ...entry };
  }

  return {
    statusCode: 200,
    payload: { byPlaca, meta: { correlationId, yellowDays } },
  };
}

/**
 * Mapa COMPACTO de níveis por placa (normalizada) de TODOS os veículos do
 * checklist — alimenta os ícones de semáforo por linha no Monitor sem N+1 nem
 * estourar o tamanho da URL. Sem a lista de itens (só level + daysToDue).
 *
 * @param {object} [p]
 * @param {number} [p.nowMs] - injetável para teste
 */
export async function fetchVehicleChecklistLevels({ correlationId, nowMs = Date.now() } = {}) {
  const yellowDays = resolveYellowDays();
  const map = await readVehicleChecklistMapCached();

  const byPlaca = {};
  for (const [placaNorm, items] of map) {
    const { level, daysToDue } = resolvePlateEntry(items, { nowMs, yellowDays });
    byPlaca[placaNorm] = { level, daysToDue };
  }

  return {
    statusCode: 200,
    payload: { byPlaca, meta: { correlationId, yellowDays, count: Object.keys(byPlaca).length } },
  };
}
