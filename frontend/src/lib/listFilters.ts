// Blocos reutilizáveis de filtro por rota + data para as telas de operador
// (Rotas, Links, Fila) — espelham o comportamento do filtro do Monitor de
// Produção (SheetMonitor): multi-seleção de rotas com busca + faixas de data de
// carregamento/descarga. Mantidos aqui (puros, sem React) para ficarem testáveis
// e compartilhados entre as telas.
import { parseDisplayDate, type DateDisplayInput } from "@/lib/dateDisplay";

/** Normaliza texto p/ busca no filtro: sem acentos + minúsculo. */
export function normalizeFilterText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Chave canônica de uma rota (trecho) — "ORIGEM → DESTINO". É o mesmo formato
 * usado pelo Monitor (routeKeyOf), então o rótulo do filtro fica idêntico entre
 * as telas. Origem/destino vazios viram "—".
 */
export function routeKeyOf(input: { origem?: string | null; destino?: string | null }): string {
  const o = (input.origem || "").trim();
  const d = (input.destino || "").trim();
  if (!o && !d) return "—";
  return `${o || "—"} → ${d || "—"}`;
}

/**
 * Filtro de data (datetime-local): ao ESCOLHER/mudar a data no calendário o
 * navegador preenche o horário ATUAL. Aqui forçamos o padrão 00:00 quando a data
 * muda (ou o campo estava vazio); se o operador editar só o horário na MESMA
 * data, o valor digitado é preservado. Idêntico ao Monitor.
 */
export function dateFilterWithMidnight(prev: string, next: string): string {
  if (!next) return next; // limpou
  const [nd] = next.split("T");
  const [pd = ""] = (prev || "").split("T");
  return nd !== pd ? `${nd}T00:00` : next;
}

/** Faixa de datas em ms epoch; null = sem limite naquele extremo. */
export interface CargoDateRange {
  carFrom: number | null;
  carTo: number | null;
  desFrom: number | null;
  desTo: number | null;
}

/** Estado (strings de <input datetime-local>) das duas faixas de data. */
export interface CargoDateFilterState {
  carFrom: string;
  carTo: string;
  desFrom: string;
  desTo: string;
}

export const EMPTY_CARGO_DATE_FILTER: CargoDateFilterState = {
  carFrom: "",
  carTo: "",
  desFrom: "",
  desTo: "",
};

/** Converte o estado de inputs (datetime-local) para ms epoch (hora local). */
export function toCargoDateRange(state: CargoDateFilterState): CargoDateRange {
  const ms = (value: string) => {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  };
  return { carFrom: ms(state.carFrom), carTo: ms(state.carTo), desFrom: ms(state.desFrom), desTo: ms(state.desTo) };
}

export function hasCargoDateFilter(state: CargoDateFilterState): boolean {
  return Boolean(state.carFrom || state.carTo || state.desFrom || state.desTo);
}

function toTimestamp(value: DateDisplayInput): number | null {
  const parsed = parseDisplayDate(value);
  const t = parsed ? parsed.getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Uma carga passa nas faixas de data quando:
 * - o carregamento cai dentro de [carFrom, carTo] (se algum extremo definido); e
 * - a descarga cai dentro de [desFrom, desTo] (se algum extremo definido).
 *
 * Datas não parseáveis são EXCLUÍDAS quando a faixa correspondente está ativa
 * (mesmo critério do Monitor). Sem nenhuma faixa ativa, tudo passa.
 */
export function matchesCargoDateRange(
  carregamento: DateDisplayInput,
  descarga: DateDisplayInput,
  range: CargoDateRange,
): boolean {
  if (range.carFrom === null && range.carTo === null && range.desFrom === null && range.desTo === null) {
    return true;
  }
  if (range.carFrom !== null || range.carTo !== null) {
    const t = toTimestamp(carregamento);
    if (t === null) return false;
    if (range.carFrom !== null && t < range.carFrom) return false;
    if (range.carTo !== null && t > range.carTo) return false;
  }
  if (range.desFrom !== null || range.desTo !== null) {
    const t = toTimestamp(descarga);
    if (t === null) return false;
    if (range.desFrom !== null && t < range.desFrom) return false;
    if (range.desTo !== null && t > range.desTo) return false;
  }
  return true;
}

export interface RouteFacetOption {
  value: string;
  label: string;
}

/**
 * Opções de rota (shape do FacetMultiSelect) a partir de uma lista de itens,
 * deduplicadas por chave e ordenadas por nome (pt-BR). `getRoute` extrai
 * origem/destino de cada item.
 */
export function buildRouteFacetOptions<T>(
  items: readonly T[],
  getRoute: (item: T) => { origem?: string | null; destino?: string | null },
): RouteFacetOption[] {
  const keys = new Set<string>();
  for (const item of items) {
    const key = routeKeyOf(getRoute(item));
    if (key !== "—") keys.add(key);
  }
  return Array.from(keys)
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((key) => ({ value: key, label: key }));
}
