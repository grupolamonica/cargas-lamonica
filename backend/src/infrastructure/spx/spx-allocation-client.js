// Cliente do sidecar SPX (bots/spx, :8766) para a alocação no ASPX.
// Reusa o MESMO caminho da Torre (DC-151/DC-138): /spx/trips/assignable,
// /spx/drivers/assignable, /spx/trips/alocar (→ /api/line_haul/agency/trip/assign).
//
// Princípios:
// - O envio REAL só acontece com SPX_ALLOC_WRITE_ENABLED=true (kill switch). Caso
//   contrário a alocação roda em dry_run (o sidecar monta o body e devolve, sem
//   tocar o ASPX).
// - Se o sidecar estiver fora do ar, lança SpxSidecarUnavailable — preview e
//   assign propagam o erro (HTTP 503, nada é enviado ao ASPX). Sem simulação.

import { parseStation } from "../../domain/operator-admin/spx-station.js";
import { routeKeyFromLabels } from "../../domain/operator-admin/aspx-trip-presence.js";

const DEFAULT_SIDECAR_URL = "http://localhost:8766";

export function sidecarUrl() {
  return (process.env.SPX_SIDECAR_URL || "").trim() || DEFAULT_SIDECAR_URL;
}
export function aspxStationId() {
  return Number(process.env.SPX_ALLOC_STATION_ID) || 5015;
}
export function aspxAgencyId() {
  return Number(process.env.SPX_ALLOC_AGENCY_ID) || 1297;
}
/** Kill switch do envio real ao ASPX. Off por padrão (rollout seguro). */
export function isAspxWriteEnabled() {
  return (process.env.SPX_ALLOC_WRITE_ENABLED || "").trim() === "true";
}
/** Kill switch do ACEITE real de viagens no ASPX. Off por padrão. Separado do de
 *  alocação porque aceitar compromete a carga com a agência (impacto SLA/financeiro)
 *  — libera independente do envio de motorista. */
export function isAspxAcceptWriteEnabled() {
  return (process.env.SPX_ACCEPT_WRITE_ENABLED || "").trim() === "true";
}

export class SpxSidecarUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "SpxSidecarUnavailable";
  }
}

async function sidecarFetch(path, init, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const url = `${sidecarUrl()}${path}`;
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new SpxSidecarUnavailable(`sidecar SPX inacessível (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.detail || `sidecar ${path} → HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/** Viagens atribuíveis (status Assigning, sem motorista). [{trip_id, trip_number, origem, destino, ...}] */
export async function fetchAssignableTrips(opts = {}) {
  const data = await sidecarFetch(`/spx/trips/assignable?station_id=${aspxStationId()}`, { method: "GET" }, opts);
  return Array.isArray(data?.trips) ? data.trips : [];
}

/** Motoristas atribuíveis. [{driver_id, name, cpf}]. count alto porque o match é
 *  por nome — a agência tem milhares de motoristas e um fora da fatia não é achado.
 *  Timeout maior: o sidecar pagina o roster inteiro no Shopee (~15s p/ ~2k). */
export async function fetchAssignableDrivers(opts = {}) {
  const data = await sidecarFetch(
    `/spx/drivers/assignable?agency_id=${aspxAgencyId()}&count=5000`,
    { method: "GET" },
    { timeoutMs: 30000, ...opts },
  );
  return Array.isArray(data?.drivers) ? data.drivers : [];
}

// Enum tt_trip_status do portal (espelha TRIP_STATUS em bots/spx/backend/spx_robo/
// trips.py). Só estes dois interessam aqui: a aba Concluído é o /trip/history/list e
// devolve os DOIS — viagem que rodou (90) e viagem CANCELADA (100).
const TRIP_STATUS_COMPLETED = 90;

/**
 * Aceite da viagem a partir da ABA em que ela apareceu (`query_type`) + o
 * `acceptance_status` cru. Três estados, e o terceiro é o que importa: null =
 * DESCONHECIDO. Quem grava a observação (detect-aspx-missing-trips) só carimba
 * "checado" com resposta conclusiva — desconhecido não é evidência de nada.
 *   aba 1 (Planejado) — 1 = aceita, 0 = não aceita, ausente/outro = desconhecido;
 *   aba 2 (Aceito)    — estar nela É o aceite (a aba só existe para viagem aceita);
 *   aba 3 (Concluído) — histórico: Completed E Cancelled no MESMO endpoint.
 *
 * O "aba 3 ⇒ aceita" incondicional que existia aqui era um gerador de marca falsa:
 * uma viagem CANCELADA (trip_status 100) sem nunca ter sido aceita virava
 * `trip_accepted_at` — num campo que, por desenho, NUNCA é limpo (o rollback é UPDATE
 * manual). É o mesmo erro das 270 marcas fabricadas que a migration 20260806150000
 * documenta. Agora: só CONCLUSÃO REAL (Completed) ou sinal explícito de aceite provam
 * o aceite; cancelada sem sinal explícito volta DESCONHECIDA — nunca `true`.
 *
 * A ordem entre "Completed" e "acceptance_status = 0" não é arbitrária: uma viagem que
 * CONCLUIU foi, por definição, aceita em algum momento — não se carrega, sela, viaja e
 * descarrega uma viagem que a agência recusou. O 0 que o /trip/history/list devolve
 * junto com trip_status 90 é o campo do portal já sem valor de verdade no histórico, e
 * lê-lo como "não aceita" seria justamente o oposto do que os fatos dizem — e, pior,
 * uma classificação CONCLUSIVA (o observador carimba `checked_at` e o Monitor esconde a
 * linha). Por isso Completed vence o 0. Cancelled (100) NÃO ganha esse benefício: a
 * viagem pode ter sido cancelada antes de qualquer aceite, e nesse caso o 0 continua
 * sendo a melhor leitura disponível.
 */
function acceptanceFromTab(queryType, acceptanceStatus, tripStatus) {
  if (queryType === 2) return true;
  if (acceptanceStatus === 1) return true;
  if (tripStatus === TRIP_STATUS_COMPLETED) return true;
  if (acceptanceStatus === 0) return false;
  return null;
}

/**
 * Índice do ESTADO REAL das viagens por trip_number — base do check positivo de
 * "já atribuída no ASPX" (em vez de inferir por ausência da lista assignable).
 *
 * Varre as abas Planejado(1, com janela de data) e Aceito(2, ignora data),
 * com_veiculo=0 (traz inclusive viagens sem placa). A aba Concluído(3) hoje
 * rejeita os params na API SPX (131103001) — viagens concluídas ficam fora do
 * índice e caem em "unknown" no preview (honesto: não confirmado).
 *
 * Tolerante a falha por aba: se UMA aba falhar, segue com as outras. Se TODAS
 * falharem, propaga o erro; o use-case captura e marca warning "index_unavailable"
 * (os não-atribuíveis caem em "unknown" — degradação granular, não simulação).
 *
 * Cada entrada carrega também o ACEITE observado (`accepted`), em três estados:
 * true / false / null (desconhecido). O sidecar já devolve `acceptance_status` em
 * _norm_trip e nós descartávamos — sem isso o único caminho que gravava aceite era
 * o nosso próprio botão "Aceitar", e o aceite feito DIRETO no portal SPX nunca
 * chegava ao banco (medido em 06/08/2026: 0 cargas "LT…" marcadas, 0 eventos de
 * aceite desde 05/08). Ver acceptanceFromTab p/ a semântica por aba.
 *
 * @returns {Promise<{
 *   byNumber: Map<string,{tripId:number|null,status:number|null,statusName:string,driver:string,accepted:boolean|null}>,
 *   byRoute: Map<string,number>, truncated:boolean, partial:boolean }>}
 */
export async function fetchTripIndex(
  { daysBack = 45, daysForward = 30, includeConcluido = false, concluidoDaysBack = 20 } = {},
  opts = {},
) {
  const station = aspxStationId();
  const tabs = [
    // Planejado — precisa de janela de data. A janela DEVE incluir o FUTURO:
    // viagens já atribuídas com STA futuro (o caso comum de reassign) só existem
    // nesta aba; sem days_forward elas ficam fora do índice → "unknown" → a
    // divergência de motorista fica invisível no preview.
    { qt: 1, daysBack, daysForward },
    { qt: 2, daysBack: 0, daysForward: 0 }, // Aceito — ignora a janela; pega em-execução
    // Concluído (opt-in) — viagens já finalizadas (mudaram p/ a aba histórico). Sem
    // isso, uma viagem ATRIBUÍDA que já concluiu some do índice → o selo "atribuído
    // no ASPX" marcava vermelho (falso "não atribuído"). Janela curta p/ ser leve;
    // só o selo (aspx-assigned) liga isto — accept/assign/preview seguem com 1+2.
    ...(includeConcluido ? [{ qt: 3, daysBack: concluidoDaysBack, daysForward: 0 }] : []),
  ];

  // Abas em PARALELO (timeout menor por aba) — pior caso ~9s em vez de ~24s.
  const settled = await Promise.all(
    tabs.map(async ({ qt, daysBack: db, daysForward: df }) => {
      const qs = `query_type=${qt}&station_id=${station}&com_veiculo=0&max_pages=30${db ? `&days_back=${db}` : ""}${df ? `&days_forward=${df}` : ""}`;
      try {
        const data = await sidecarFetch(`/spx/trips/snapshot?${qs}`, { method: "GET" }, { ...opts, timeoutMs: 9000 });
        // `qt` viaja junto com a resposta: o aceite depende da ABA de origem e o
        // `settled` sozinho já perdeu essa informação.
        return { qt, ok: true, data };
      } catch (err) {
        return { qt, ok: false, err };
      }
    }),
  );

  const byNumber = new Map();
  // Viagens vivas AGRUPADAS POR ROTA (origem→destino), das MESMAS respostas — nenhuma
  // chamada extra ao portal. Base da detecção de "rota retirada do ASPX": rota com zero
  // viagem no índice é candidata; rota com >= 1 viagem nunca é.
  const byRoute = new Map();
  let truncated = false;
  let okCount = 0;
  let lastErr = null;

  // Itera na ordem de `tabs` (Planejado antes de Aceito) → primeira aba vence o dedup
  // (exceto o aceite, que só sobe — ver a promoção monotônica abaixo).
  for (const r of settled) {
    if (!r.ok) {
      lastErr = r.err;
      continue;
    }
    okCount += 1;
    if (r.data?.truncated) truncated = true;
    for (const t of Array.isArray(r.data?.trips) ? r.data.trips : []) {
      const num = String(t.trip_number ?? "").trim();
      if (!num) continue;
      const tripStatus = typeof t.trip_status === "number" ? t.trip_status : null;
      const accepted = acceptanceFromTab(
        r.qt,
        typeof t.acceptance_status === "number" ? t.acceptance_status : null,
        tripStatus,
      );
      const jaIndexada = byNumber.get(num);
      if (jaIndexada) {
        // Dedup: a primeira aba vence o resto do registro (status/motorista da mais
        // "fresca"). Mas o ACEITE é MONOTÔNICO — a Planejado vem ANTES da Aceito, e
        // sem esta promoção uma viagem presente nas duas ficaria com o accepted=false
        // da Planejado, NEGANDO a prova que a aba Aceito acabou de dar.
        if (accepted === true && jaIndexada.accepted !== true) jaIndexada.accepted = true;
        continue;
      }
      byNumber.set(num, {
        tripId: typeof t.trip_id === "number" ? t.trip_id : (t.trip_id ? Number(t.trip_id) : null),
        status: tripStatus,
        statusName: t.trip_status_name ?? "",
        driver: (t.driver_name ?? "").trim(),
        accepted,
      });
      const rota = routeKeyFromLabels(parseStation(t.origem).cityUf, parseStation(t.destino).cityUf);
      if (rota) byRoute.set(rota, (byRoute.get(rota) ?? 0) + 1);
    }
  }

  if (okCount === 0 && lastErr) throw lastErr; // nenhuma aba respondeu → use-case marca index_unavailable
  return { byNumber, byRoute, truncated, partial: okCount < tabs.length };
}

/**
 * Viagens de um tab (query_type) direto do portal SPX, via sidecar
 * (/spx/trips/snapshot, com_veiculo=0 → traz TODAS, com ou sem veículo). Base da
 * tela Programação (consulta DIRETA ao ASPX, sem passar pela API da Torre).
 *
 * Cada viagem já vem normalizada pelo sidecar (_norm_trip): trip_number, origem,
 * destino (station_name), carregamento_ts/descarga_ts (epoch), driver_name,
 * vehicle_type, cavalo, carreta, acceptance_status, trip_status, trip_status_name.
 *
 * Janela de data (days_back/days_forward) só faz sentido no Planejado(1); Aceito(2)
 * ignora e Concluído(3) rejeita os params na API SPX — por isso o caller passa
 * janela só p/ o tab 1.
 *
 * @returns {Promise<{ trips: object[], truncated: boolean, total: number }>}
 */
// Cache curto por querystring — o portal SPX só atualiza ~a cada 10min, então
// um TTL de 30s deixa a tela "fresca ao acessar" sem raspar o portal a cada
// poll/foco/montagem (o Concluído sozinho pagina ~7x). force=true ignora o cache.
const _tripCache = new Map();
function tripCacheTtlMs() {
  const s = Number(process.env.SPX_PROGRAMACAO_CACHE_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 30) * 1000;
}

export async function fetchSpxTripsByTab(queryType, { daysBack = 0, daysForward = 0, maxPages = 25, force = false } = {}, opts = {}) {
  const station = aspxStationId();
  const params = new URLSearchParams({
    query_type: String(queryType),
    station_id: String(station),
    com_veiculo: "0",
    max_pages: String(maxPages),
  });
  if (daysBack > 0) params.set("days_back", String(daysBack));
  if (daysForward > 0) params.set("days_forward", String(daysForward));
  const qs = params.toString();

  if (!force) {
    const cached = _tripCache.get(qs);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const data = await sidecarFetch(`/spx/trips/snapshot?${qs}`, { method: "GET" }, { timeoutMs: 30000, ...opts });
  const value = {
    trips: Array.isArray(data?.trips) ? data.trips : [],
    truncated: Boolean(data?.truncated),
    total: typeof data?.total === "number" ? data.total : null,
  };
  const ttl = tripCacheTtlMs();
  if (ttl > 0) _tripCache.set(qs, { value, expiresAt: Date.now() + ttl });
  return value;
}

/**
 * Aloca motorista+veículo numa viagem. dryRun=true (default) → sidecar só monta o
 * body, não envia ao ASPX.
 * @param {{tripId:number, driverIds:number[], vehiclePlates:string[], dryRun?:boolean}} args
 */
export async function assignTrip({ tripId, driverIds, vehiclePlates, dryRun = true }, opts = {}) {
  return sidecarFetch(
    "/spx/trips/alocar",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trip_id: tripId,
        driver_ids: driverIds,
        vehicle_plates: vehiclePlates,
        station_id: aspxStationId(),
        dry_run: dryRun,
      }),
    },
    { ...opts, timeoutMs: 20000 },
  );
}

/**
 * Aceita/reserva uma viagem para a agência (→ POST /api/line_haul/agency/trip/accept).
 * Passo ANTERIOR ao assign: acceptance_status 0→1 move a viagem para o pool
 * atribuível. dryRun=true (default) → o sidecar só monta o body, não toca o ASPX.
 * @param {{tripId:number, dryRun?:boolean}} args
 */
export async function acceptTrip({ tripId, dryRun = true }, opts = {}) {
  return sidecarFetch(
    "/spx/trips/accept",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trip_id: tripId,
        station_id: aspxStationId(),
        dry_run: dryRun,
      }),
    },
    { ...opts, timeoutMs: 20000 },
  );
}
