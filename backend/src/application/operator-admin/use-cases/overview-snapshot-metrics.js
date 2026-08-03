/**
 * Painel do operador (/painel) — metade DERIVADA do snapshot.
 *
 * Contexto: a tela montava o snapshot no navegador a partir de 3x select(500)
 * direto no PostgREST (cargas + load_public_leads + load_claims, ~0,5 MB por
 * abertura de aba). Este módulo é a porta pura da conta: recebe os AGREGADOS que
 * o SQL já resolveu (contagens escalares) mais a projeção enxuta das cargas
 * abertas, e devolve exatamente o mesmo objeto que
 * `frontend/src/lib/overviewMetrics.ts#buildOverviewSnapshot` devolvia.
 *
 * ⚠ FUSO — o ponto que faz esta porta ser NÃO-trivial. No navegador,
 * `buildLoadingDateTime` (frontend/src/lib/estimatedTime.ts) usa `parseISO` sem
 * offset, então "2026-08-01T00:30" vira 00:30 no fuso LOCAL — que em produção é
 * BRT, porque o operador está no Brasil. O container do backend roda em UTC
 * (docker-compose não seta TZ), então repetir a mesma linha aqui deslocaria toda
 * carga em 3 horas (uma carga de 00:30 BRT contaria como 21:30 do dia anterior,
 * e "saídas nas próximas 24h" mudaria de valor todo dia). A solução é a mesma que
 * o resto do backend já usa para `cargas.data`/`cargas.horario`: comparar
 * RELÓGIO DE PAREDE de São Paulo (`getSaoPauloWallClock`), nunca instantes
 * derivados do fuso do processo.
 *
 * Comparar em relógio de parede é equivalente a comparar instantes porque
 * America/Sao_Paulo tem offset fixo (UTC-3) desde a extinção do horário de verão
 * (2019) — mesma premissa de `domain/recurrence.js` e dos filtros do portal.
 */
import { differenceInHours, isValid, parse, parseISO } from "date-fns";

import { toIsoDate } from "../../../domain/recurrence.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

/** Janela lida por tabela — espelha o `.limit(500)` que o front usava. */
export const OVERVIEW_WINDOW_ROWS = 500;

export const ACTIVE_LEAD_STATUSES = ["QUEUED", "APPROVED"];
export const ACTIVE_CLAIM_STATUSES = ["WON_RESERVATION", "WAITLISTED", "PROMOTED", "CONFIRMED"];
/** Status terminais de carga: ficam fora da tela de Fila (alinhado a Leads.tsx). */
export const TERMINAL_LOAD_STATUSES = ["EXPIRED", "CANCELLED", "COMPLETED", "FAILED", "BOOKED"];
/** "Cargas fechadas" do Painel = BOOKED + COMPLETED. */
export const BOOKED_LOAD_STATUSES = ["BOOKED", "COMPLETED"];

const HOURS_AHEAD_WINDOW = 24;
const STALE_HOURS_THRESHOLD = 48;
const SHEET_DATETIME_PATTERN = "dd/MM/yyyy HH:mm";

/**
 * Offset explícito no texto (Z, ±HH:MM, ±HHMM, ±HH, GMT/UTC). Nesses casos o
 * valor já é um INSTANTE absoluto — idêntico no navegador e no container — e o
 * relógio de parede correto é o de São Paulo, não os getters locais do processo.
 *
 * O offset é ancorado DEPOIS de um horário de propósito: um `[+-]\\d{2}...`
 * solto casaria com o final de uma data pura ("2026-08-01" termina em "-01") e
 * jogaria uma data-only no caminho errado.
 */
const EXPLICIT_OFFSET_PATTERN = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?|GMT|UTC)\s*$/i;

function pad(value, size) {
  return String(value).padStart(size, "0");
}

/**
 * Relógio de parede LOCAL de um Date, em "YYYY-MM-DDTHH:MM:SS.mmm".
 *
 * Para textos SEM offset (o caso normal aqui), os getters locais devolvem de
 * volta exatamente os dígitos que entraram no parser, em QUALQUER fuso de
 * processo — é justamente essa invariância que permite provar paridade com o
 * navegador sem depender do TZ do runner de teste.
 */
function localWallClock(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/** Relógio de parede de São Paulo de um instante, no mesmo formato comparável. */
export function saoPauloWallClock(date) {
  const { dateIso, timeIso } = getSaoPauloWallClock(date);
  return `${dateIso}T${timeIso}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Porta de `parseDateInput` (frontend/src/lib/estimatedTime.ts) para relógio de
 * parede. Usa as MESMAS funções do date-fns (v3 nos dois lados do monorepo), na
 * mesma ordem de tentativa, para não abrir espaço a divergência de parser:
 * parseISO → parse("dd/MM/yyyy HH:mm") → `new Date(...)`.
 *
 * @param {string|null|undefined} value
 * @param {Date} reference data de referência do `parse` (irrelevante para o
 *   padrão usado — todas as unidades maiores são fornecidas e as menores são
 *   zeradas — mas mantida para espelhar a chamada do front)
 * @returns {string|null} relógio de parede comparável, ou null
 */
export function parseDateInputWallClock(value, reference) {
  if (!value) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const absolute = EXPLICIT_OFFSET_PATTERN.test(trimmed);

  const isoDate = parseISO(trimmed);
  if (isValid(isoDate)) {
    return absolute ? saoPauloWallClock(isoDate) : localWallClock(isoDate);
  }

  const sheetDate = parse(trimmed, SHEET_DATETIME_PATTERN, reference);
  if (isValid(sheetDate)) {
    return localWallClock(sheetDate);
  }

  const nativeDate = new Date(trimmed);
  if (isValid(nativeDate)) {
    return absolute ? saoPauloWallClock(nativeDate) : localWallClock(nativeDate);
  }

  return null;
}

function normalizeDateOnlyValue(value) {
  const trimmed = value.trim();
  const matchedDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return matchedDate?.[1] ?? trimmed;
}

/**
 * Porta de `buildLoadingDateTime`: rótulo denormalizado tem prioridade sobre
 * data+horário, exatamente como no front.
 *
 * @returns {string|null} relógio de parede (São Paulo) do carregamento
 */
export function resolveLoadingWallClock({ carregamentoLabel, dataIso, horario }, reference) {
  const fromLabel = parseDateInputWallClock(carregamentoLabel, reference);
  if (fromLabel) return fromLabel;

  if (!dataIso || !horario) return null;

  const normalizedDate = normalizeDateOnlyValue(String(dataIso));
  // Espelha o front: `horario` pode chegar como timestamp ISO ("...T02:00").
  const rawTime = String(horario).includes("T")
    ? (String(horario).split("T")[1] ?? String(horario))
    : String(horario);
  const normalizedTime = rawTime.slice(0, 5);

  return parseDateInputWallClock(`${normalizedDate}T${normalizedTime}`, reference);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  // pg devolve `numeric` como STRING em produção e como Number no pg-mem.
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `cargas.data` é DATE. O driver do Postgres devolve MEIA-NOITE LOCAL do
 * processo; o pg-mem devolve MEIA-NOITE UTC. Distinguir pelo horário UTC do
 * instante cobre os dois casos em qualquer fuso de processo (e eles coincidem
 * quando o processo roda em UTC, como o container de produção) — sem isso, um
 * runner fora de UTC leria o dia anterior/seguinte.
 */
export function resolveCargoDateIso(value) {
  if (value == null) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 10);

  const isUtcMidnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;

  if (isUtcMidnight) return toIsoDate(value);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1, 2)}-${pad(value.getDate(), 2)}`;
}

/**
 * Normaliza uma linha de carga aberta vinda do SQL para a forma neutra usada
 * pelas contas (independente de pg vs pg-mem: `date` volta como Date, `numeric`
 * como string em produção e como number no pg-mem).
 */
export function normalizeOpenLoadRow(row) {
  return {
    id: row.id,
    dataIso: resolveCargoDateIso(row.data),
    horario: row.horario == null ? null : String(row.horario),
    carregamentoLabel: row.sheet_data_carregamento ?? null,
    origem: row.origem ?? null,
    destino: row.destino ?? null,
    distanciaKm: toNullableNumber(row.distancia_km),
    perfil: row.perfil ?? null,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    interest: Number(row.interesse ?? 0),
    queuedLeads: Number(row.leads_na_fila ?? 0),
  };
}

/**
 * Porta de `buildAttentionLoads`. Mantém a MESMA ordenação: `sort` por idade
 * decrescente sobre a lista já em ordem `created_at DESC` — e `Array#sort` é
 * estável, então empates de idade (a idade é truncada em horas) preservam a
 * ordem da consulta, igual ao front.
 */
function buildAttentionLoads(openLoads, now) {
  const attentionItems = [];

  for (const cargo of openLoads) {
    const ageHours = differenceInHours(now, cargo.createdAt);
    const missingFields = [];

    if (!cargo.perfil) {
      missingFields.push("perfil");
    }
    if (typeof cargo.distanciaKm !== "number" || cargo.distanciaKm <= 0) {
      missingFields.push("distancia_km");
    }
    if (!cargo.origem) {
      missingFields.push("origem");
    }
    if (!cargo.destino) {
      missingFields.push("destino");
    }

    const isStale = ageHours >= STALE_HOURS_THRESHOLD && cargo.interest === 0;

    if (isStale || missingFields.length > 0) {
      attentionItems.push({
        id: cargo.id,
        origem: cargo.origem || "?",
        destino: cargo.destino || "?",
        status: cargo.status,
        createdAt: cargo.createdAt.toISOString(),
        ageHours,
        missingFields,
      });
    }
  }

  return attentionItems.sort((a, b) => b.ageHours - a.ageHours).slice(0, 10);
}

/**
 * Monta o snapshot final a partir dos agregados do SQL.
 *
 * `recentActivity` NÃO faz parte do payload: o feed exigiria as 3 tabelas
 * inteiras de volta (é o que se está eliminando) e nenhum componente do Painel o
 * renderiza. O builder do cliente continua produzindo-o e continua coberto pelos
 * testes dele.
 *
 * @param {{ cargoCounts: object, leadCounts: object, lastUpdatedAt: Date|string|null,
 *           openLoadRows: Array<object> }} aggregates
 * @param {Date} [now]
 */
export function buildOverviewSnapshotFromAggregates(aggregates, now = new Date()) {
  const { cargoCounts, leadCounts, lastUpdatedAt, openLoadRows } = aggregates;
  const openLoads = openLoadRows.map(normalizeOpenLoadRow);

  const nowWall = saoPauloWallClock(now);
  const horizonWall = saoPauloWallClock(new Date(now.getTime() + HOURS_AHEAD_WINDOW * 60 * 60 * 1000));

  let departuresNext24h = 0;
  let overdueLoads = 0;
  let noDriverLoads = 0;
  const queuedCargoIds = new Set();

  for (const cargo of openLoads) {
    const loadingWall = resolveLoadingWallClock(cargo, now);
    if (loadingWall) {
      if (loadingWall >= nowWall && loadingWall <= horizonWall) departuresNext24h += 1;
      if (loadingWall < nowWall) overdueLoads += 1;
    }
    if (cargo.interest === 0) noDriverLoads += 1;
    // "NA FILA" = cargas OPEN distintas com pelo menos um lead QUEUED na Fila.
    if (cargo.queuedLeads > 0) queuedCargoIds.add(cargo.id);
  }

  return {
    hero: {
      activeLoads: cargoCounts.activeLoads,
      departuresNext24h,
      queuedLeads: queuedCargoIds.size,
      noDriverLoads,
      // Disputas ativas = leads vivos (QUEUED + APPROVED) cujas cargas estão nas
      // telas de Fila (não-terminais) — a tabela legada `load_claims` não conta
      // aqui, igual ao front.
      activeClaims: leadCounts.queueActiveLeads,
      draftCount: cargoCounts.draftCount,
      bookedCount: cargoCounts.bookedCount,
      approvedToday: leadCounts.approvedToday,
      overdueLoads,
      reservedCount: cargoCounts.reservedCount,
      pendingApprovals: leadCounts.pendingApprovals,
    },
    attentionLoads: buildAttentionLoads(openLoads, now),
    lastUpdatedAt:
      lastUpdatedAt == null
        ? null
        : lastUpdatedAt instanceof Date
          ? lastUpdatedAt.toISOString()
          : String(lastUpdatedAt),
  };
}

/**
 * Limites do dia corrente em São Paulo, como instantes — usados no filtro de
 * `approved_at` ("aprovados hoje"). O front usava
 * `new Date(y, m, d)`/local do navegador; aqui o dia é fixado no fuso da
 * operação para não virar meia-noite UTC (3h adiantada).
 */
export function resolveSaoPauloDayBounds(now = new Date()) {
  const { dateIso } = getSaoPauloWallClock(now);
  // Offset fixo UTC-3 (sem horário de verão desde 2019) — mesma premissa das
  // comparações de relógio de parede acima. `startOfTomorrow` usa +24h, a mesma
  // fórmula do front (`startOfToday.getTime() + 24h`).
  const startOfToday = new Date(`${dateIso}T00:00:00.000-03:00`);
  return {
    startOfToday,
    startOfTomorrow: new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000),
  };
}
