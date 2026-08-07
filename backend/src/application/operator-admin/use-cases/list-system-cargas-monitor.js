// Cargas criadas no SISTEMA (sheet_lh IS NULL) projetadas no MESMO shape de linha
// do Monitor, para entrarem na visão unificada (planilha ∪ sistema). O sync da
// planilha ignora cargas sem sheet_lh, então elas são duráveis aqui.
//
// Campos efetivos: motorista/cavalo/carreta/status operacional vêm de alloc_*
// (mesmas colunas usadas como override das linhas da planilha — para o sistema
// elas são simplesmente "o valor"). origem/destino/data/horario são as colunas
// canônicas da carga. lh = lh_manual (editável no grid).

import { isOfferedToDriver } from "../../../domain/operator-admin/driver-offer-visibility.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { nestleClientNameCandidates, normalizeClientName } from "./_shared.js";

// Colunas que existem em qualquer banco onde este read model roda.
//
// `sheet_motorista` e `viagem_id` não são usadas pelo mapper — entram por causa do
// PORTÃO (`isOfferedToDriver`), que precisa da regra INTEIRA do portal: alocação
// efetiva é COALESCE(alloc_motorista, sheet_motorista, '') e a visibilidade muda de
// ramo conforme a carga seja avulsa (viagem_id nulo → driver_visibility) ou perna de
// pacote. Sem elas o portão trataria as duas como desconhecidas e resgataria linhas
// demais. Não são opcionais: existem no schema há muito tempo (ver test-harness.js) e
// nenhum banco onde este read model roda está sem elas — por isso não ganham variante
// no `buildSelectCols`.
const SELECT_COLS_BASE =
  "id, origem, destino, data, horario, sheet_data_descarga, alloc_motorista, sheet_motorista, alloc_cavalo, alloc_carreta, alloc_status, sheet_status, alloc_tipo, alloc_descricao, alloc_vinculo, alloc_tratativas, alloc_checklist_cavalo, alloc_checklist_carreta, alloc_pinned, status, driver_visibility, viagem_id, lh_manual, cliente_id, sheet_source";

/** Monta o SELECT com as colunas OPCIONAIS que o banco tiver — cada uma depende de
 *  uma migration que pode ainda não ter sido aplicada (deploy antes do migrate):
 *  `agenda_a_confirmar` (20260717210000), `trip_accepted_at` (20260805170000) e
 *  `trip_acceptance_checked_at` (20260806150000).
 *
 *  Compor a lista em vez de derivar constantes por `.replace()` encadeado: com três
 *  opcionais seriam 8 constantes, e a substituição de `", trip_accepted_at"` passa a
 *  conviver com o token `", trip_acceptance_checked_at"` — o tipo de acoplamento
 *  frágil que quebra em silêncio (e aqui "quebrar em silêncio" significa esconder
 *  carga do operador). */
function buildSelectCols({ agendaAConfirmar, tripAccepted, acceptanceChecked }) {
  const cols = [SELECT_COLS_BASE];
  if (agendaAConfirmar) cols.push("agenda_a_confirmar");
  if (tripAccepted) cols.push("trip_accepted_at");
  if (acceptanceChecked) cols.push("trip_acceptance_checked_at");
  return cols.join(", ");
}

// Leads que ainda podem virar reserva. Carga com um deles é carga que um motorista
// pediu — nunca some da tela do operador, aceite ou não.
const LIVE_LEAD_STATUSES = ["QUEUED", "APPROVED"];

/** DATE do Postgres pode chegar como '2026-06-25' ou ISO '2026-06-25T00:00:00.000Z'.
 *  Fatiar os 10 primeiros chars dá a data de parede correta (igual ao fix do
 *  off-by-one — usa a data UTC, não reinterpreta em BRT). */
function toDateStr(v) {
  if (!v) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}
function toTimeStr(v) {
  if (!v) return null;
  return String(v).slice(0, 5); // HH:MM
}

/** Label de agenda "DD/MM/YYYY HH:MM" a partir de data (YYYY-MM-DD) + hora (HH:MM). */
function agendaLabel(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}${timeStr ? ` ${timeStr.slice(0, 5)}` : ""}`;
}

/** Descarga (texto livre em sheet_data_descarga). Aceita 'YYYY-MM-DD[ T]HH:MM'
 *  (como o sistema grava) ou label BR 'DD/MM/YYYY HH:MM' (legado da planilha).
 *  Retorna { label (p/ exibir), at (datetime-local p/ o input do modal) }. */
function parseDescarga(v) {
  if (!v) return { label: null, at: null };
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return { label: `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` };
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[ ](\d{2}):(\d{2})/);
  if (m) return { label: s.slice(0, 16), at: `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` };
  return { label: s, at: null };
}

// Ciclo de vida da carga (coluna `status`) → rótulo exibido no Monitor quando NÃO
// há status operacional (alloc_status). Só "OPEN" (aberta pro motorista) aparece
// como "Disponível" (badge vazio); as demais mostram o status real — pedido do
// operador: nada que não esteja aberto pro motorista deve parecer "Disponível".
const SYSTEM_LIFECYCLE_LABEL = {
  DRAFT: "Rascunho",
  BOOKED: "Reservado",
  // RESERVED faltava no mapa: a carga reservada pela Fila SEM motorista resolvido
  // caía no `?? lifecycle` abaixo e a linha exibia o token cru "RESERVED" em badge
  // cinza (nenhum estilo do resolveSheetStatusStyle casa "reserved"), o oposto de
  // "reservada" para o operador. Mesmo rótulo de BOOKED — os dois são reserva.
  RESERVED: "Reservado",
  CANCELLED: "Cancelado",
  EXPIRED: "Expirada",
};

/** Projeta uma carga do sistema no shape de linha do Monitor. Puro/testável.
 *  clientesById: mapa id→nome do cliente (p/ exibir o cliente da carga na linha).
 *  now: { todayIso, nowTimeIso } (relógio de São Paulo) p/ a checagem de futuro;
 *  sem now, não checa a data (assume futura). */
export function mapSystemCargoToMonitorRow(c, clientesById = {}, now = null) {
  const motoristas = (c.alloc_motorista || "").trim();
  const cavalo = (c.alloc_cavalo || "").trim();
  const carreta = (c.alloc_carreta || "").trim();
  const dataStr = toDateStr(c.data);
  const horaStr = toTimeStr(c.horario);
  const descarga = parseDescarga(c.sheet_data_descarga);

  // Status EXIBIDO no Monitor. "Disponível" SÓ quando a carga aparece no painel do
  // motorista — mesma regra do buildDriverLoadFilters: ciclo de vida OPEN, pública,
  // sem motorista efetivo e carregamento no futuro (relógio de São Paulo). O status
  // operacional (alloc_status), quando o operador define, tem precedência.
  // Status operacional EFETIVO = override do operador ?? espelho do portal
  // (`sheet_status`). O espelho é gravado pela passada da carga lançada
  // (`reconcile-aspx-status-launched.js`, gate ASPX_STATUS_LAUNCHED): sem lê-lo aqui, o
  // valor era gravado e NINGUÉM o exibia — a linha continuava vazia e dependia do
  // overlay ao vivo do SPX (que cai junto com o sidecar). `??`, não `||`: override ""
  // é vazio EXPLÍCITO ("Disponível") e vence o espelho, mesma semântica de
  // COALESCE(alloc_*, sheet_*) das linhas da planilha.
  const opStatus = (c.alloc_status != null ? c.alloc_status : (c.sheet_status ?? "")).toString().trim();
  const lifecycle = (c.status || "").trim().toUpperCase();
  const isPublic = (c.driver_visibility || "PUBLIC").toString().toUpperCase() === "PUBLIC";
  // DC-271: a exceção "carga lançada fica disponível o dia inteiro (data >= hoje)" foi
  // removida do buildDriverLoadFilters — carga lançada com hora vencida SAI do portal.
  // Mantê-la aqui fazia o Monitor anunciar "Disponível" numa carga que o motorista já
  // não enxerga. A única exceção que sobra é a mesma do portal: agenda "A confirmar"
  // (agenda_a_confirmar), cujo data/horario é placeholder (dia do lançamento às 00:00)
  // e portanto não representa carregamento vencido. Banco sem a coluna → undefined →
  // false: o Monitor volta ao corte puro por data/hora (degradação, não erro).
  const agendaAConfirmar = c.agenda_a_confirmar === true;
  const isFuture = !now || !dataStr || dataStr > now.todayIso
    || (dataStr === now.todayIso && (!horaStr || horaStr >= now.nowTimeIso))
    || agendaAConfirmar;
  const openToDriver = lifecycle === "OPEN" && isPublic && motoristas === "" && isFuture;
  let status = opStatus;
  if (!opStatus) {
    if (openToDriver) status = "";                          // aparece pro motorista → Disponível
    else if (motoristas) status = "";                       // tem motorista → badge mostra "Reservado"
    else if (lifecycle === "OPEN") status = "Em aberto";    // OPEN mas não listada (passada/privada)
    else if (lifecycle) status = SYSTEM_LIFECYCLE_LABEL[lifecycle] ?? lifecycle;
  }
  return {
    lh: (c.lh_manual || "").trim(),
    tipo: (c.alloc_tipo || "").trim() || "SISTEMA",
    status,
    motoristas,
    cliente: c.cliente_id ? (clientesById[c.cliente_id] ?? null) : null,
    origem: c.origem || "",
    destino: c.destino || "",
    data: dataStr,
    horario: horaStr,
    carregamentoLabel: agendaLabel(dataStr, horaStr),
    descargaLabel: descarga.label,
    valor: undefined,
    cavalo,
    carreta,
    descricao: (c.alloc_descricao || "").trim() || null,
    vinculo: (c.alloc_vinculo || "").trim() || null,
    tratativas: (c.alloc_tratativas || "").trim() || null,
    // Verdito manual do checklist (Aprovado/Reprovado) — carga do sistema não tem
    // planilha por baixo, então a linha carrega o próprio override alloc_checklist_*.
    checklistCavalo: (c.alloc_checklist_cavalo || "").trim(),
    checklistCarreta: (c.alloc_checklist_carreta || "").trim(),
    isAvailable: motoristas === "" && status === "",
    hasDriver: motoristas !== "",
    // ── unificação ──
    rowKey: `cargo:${c.id}`,
    source: "sistema",
    cargoId: c.id,
    pinned: c.alloc_pinned === true,
    lifecycleStatus: c.status || null,
    // datetime-local p/ os inputs do modal de edição (carregamento = data+hora canônicos)
    cargaAt: dataStr ? `${dataStr}T${horaStr || "00:00"}` : null,
    descargaAt: descarga.at,
  };
}

/** Kill-switch do filtro "lançada não aceita" (default LIGADO). Só
 *  MONITOR_HIDE_UNACCEPTED_LAUNCHED=false desliga — qualquer outro valor mantém
 *  ligado, para o desligamento ser um ato explícito. */
export function isHideUnacceptedLaunchedEnabled() {
  return String(process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED ?? "").trim().toLowerCase() !== "false";
}

// Validade da EVIDÊNCIA de aceite, em horas. Observação velha não é observação: vira
// desconhecido e a linha volta a aparecer.
const DEFAULT_ACCEPTANCE_EVIDENCE_TTL_HOURS = 24;

/** TTL da evidência (MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS, default 24h). Valor não
 *  numérico, zero ou negativo cai no default — env mal preenchido não pode virar
 *  "esconde para sempre" nem "nunca esconde". Padrão da casa (ver routeStepConfig em
 *  detect-aspx-missing-trips.js). */
export function acceptanceEvidenceTtlHours() {
  const n = Number(process.env.MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACCEPTANCE_EVIDENCE_TTL_HOURS;
}

/**
 * A evidência de não-aceite ainda vale? `trip_acceptance_checked_at` é a ÚLTIMA
 * observação conclusiva, e o job só a regrava quando ela passa de 60 min (para não
 * abrir tempestade de UPDATE/realtime — o codebase tem cicatriz disso). Logo, carga
 * ativamente observada tem evidência de no máximo ~1h e o TTL de 24h nunca a alcança.
 *
 * Quem o TTL alcança é a carga que SAIU do recorte do job. Caso real levantado na
 * revisão: LT com carregamento hoje às 10:00, observada "não aceita" às 09:50 (Monitor
 * esconde), fora do recorte às 10:01, e o motorista aceita direto no portal SPX às
 * 10:30. Sem TTL essa carga fica aceita, viva e PERMANENTEMENTE invisível para o
 * operador — no dia em que mais importa. Com TTL, a evidência expira e a linha volta.
 *
 * Data ilegível conta como sem evidência: dado duvidoso nunca esconde linha.
 * Fronteira: exatamente TTL de idade ainda vale; mais velho que isso, não.
 */
export function isAcceptanceEvidenceFresh(
  checkedAt,
  { nowMs = Date.now(), ttlHours = acceptanceEvidenceTtlHours() } = {},
) {
  if (!checkedAt) return false;
  const t = checkedAt instanceof Date ? checkedAt.getTime() : Date.parse(String(checkedAt));
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= ttlHours * 3600_000;
}

/** Ids dos clientes Nestlé no mapa id→nome do Monitor. A comparação é por nome
 *  normalizado (sem acento/caixa) contra os candidatos do env + históricos — NUNCA
 *  por literal cravado: o operador renomeia o cliente na tela (em 30/07 "Nestlé"
 *  virou "Produtos Alimentícios") e um literal quebraria o escopo em silêncio. */
export function resolveNestleClientIds(clientesById = {}) {
  const alvos = new Set(nestleClientNameCandidates().map((n) => normalizeClientName(String(n))));
  const ids = new Set();
  for (const [id, nome] of Object.entries(clientesById)) {
    if (alvos.has(normalizeClientName(String(nome ?? "")))) ids.add(id);
  }
  return ids;
}

/** Carga da fonte Nestlé: pela fonte gravada no lançamento OU pelo cliente. As duas
 *  são necessárias — `sheet_source` só passou a ser gravado depois, então a maioria
 *  das lançadas antigas tem NULL (que `normSource` trata como shopee). */
function isNestleCargo(c, nestleClientIds) {
  if (String(c.sheet_source ?? "").trim().toLowerCase() === "nestle") return true;
  return c.cliente_id != null && nestleClientIds.has(c.cliente_id);
}

/**
 * Carga LANÇADA (Programação/auto-lançamento) da SHOPEE que ninguém aceitou —
 * sai do Monitor. Continua em /cargas (nada é apagado nem expirado por isto).
 *
 * O `accepted` do lançamento sempre governou só o write-back da planilha; o
 * INSERT e este read model o ignoravam, então toda lançada não-aceita entrava no
 * Monitor por construção (94 linhas em 05/08/2026, 93% da fonte SISTEMA).
 *
 * O primeiro desenho (PR #457) leu `trip_accepted_at IS NULL` como "ninguém
 * aceitou" — e isso foi um erro caro, medido em 06/08/2026: das 92 lançadas vivas,
 * 82 tinham a coluna NULL e 79 haviam sido CRIADAS antes de a coluna existir. O
 * silêncio virou veredito e sumiram 39-50 linhas da fonte SISTEMA, 26 delas ABERTAS
 * no portal /motorista — o motorista podia aceitar uma carga que o operador já não
 * enxergava. Some-se que o aceite feito direto no portal SPX nunca chega ao banco
 * (0 cargas "LT…" marcadas, 0 eventos de aceite desde 05/08): o marcador sozinho é
 * estruturalmente perdedor.
 *
 * Hoje o aceite é FATO OBSERVADO, em duas colunas: `trip_accepted_at` (vimos aceita)
 * e `trip_acceptance_checked_at` (ÚLTIMA vez que olhamos o SPX ao vivo por este LH com
 * resposta conclusiva — migration 20260806150000). Só há EVIDÊNCIA de não-aceite quando
 * checamos RECENTEMENTE e não achamos aceite; nunca checado é DESCONHECIDO, evidência
 * mais velha que o TTL volta a ser DESCONHECIDO, e desconhecido não esconde. Isso
 * dispensa corte por data (a lançada antiga nunca foi checada, então fica) e deixa o
 * sinal se auto-curar a cada passada do job.
 *
 * Guardas — some SÓ o que está inerte E com evidência. Qualquer sinal de vida (ou de
 * dúvida) mantém a linha:
 *   1. sem `lh_manual` → não é carga lançada (carga manual/recorrente do operador);
 *   2. `trip_accepted_at` → viagem aceita: frete comprometido, fica mesmo sem motorista;
 *   3. `trip_acceptance_checked_at` ausente OU mais VELHO que o TTL → aceite
 *      DESCONHECIDO (nunca observamos este LH, ou a última observação já não vale), fica;
 *   4. ciclo ≠ OPEN → alguém já agiu (RESERVED/BOOKED/CANCELLED);
 *   5. motorista alocado;
 *   6. status operacional (override do operador ou espelho do portal) preenchido;
 *   7. lead vivo na fila (QUEUED/APPROVED) — motorista pediu a carga;
 *   8. Nestlé → fora do escopo (só Shopee, por decisão do operador).
 *
 * Puro/testável.
 *
 * @param {object} c linha crua de `cargas`
 * @param {{ nestleClientIds?: Set<string>, cargoIdsWithLiveLead?: Set<string>,
 *          nowMs?: number, ttlHours?: number }} ctx
 */
export function isUnacceptedLaunchedShopeeCargo(
  c,
  {
    nestleClientIds = new Set(),
    cargoIdsWithLiveLead = new Set(),
    nowMs = Date.now(),
    ttlHours = acceptanceEvidenceTtlHours(),
  } = {},
) {
  if (!String(c.lh_manual ?? "").trim()) return false;
  if (c.trip_accepted_at) return false;
  // Sem observação conclusiva RECENTE não há evidência de não-aceite — e dado ausente,
  // duvidoso ou VELHO nunca esconde linha. Cobre de uma vez a lançada antiga (anterior
  // às colunas), a que o job ainda não visitou, a que o SPX respondeu inconclusivo e a
  // que saiu do recorte do job depois de uma única observação (ver isAcceptanceEvidenceFresh).
  if (!isAcceptanceEvidenceFresh(c.trip_acceptance_checked_at, { nowMs, ttlHours })) return false;
  if (String(c.status ?? "").trim().toUpperCase() !== "OPEN") return false;
  if (String(c.alloc_motorista ?? "").trim()) return false;
  if (String(c.alloc_status ?? c.sheet_status ?? "").trim()) return false;
  if (cargoIdsWithLiveLead.has(c.id)) return false;
  if (isNestleCargo(c, nestleClientIds)) return false;
  return true;
}

/**
 * Ids das cargas com lead VIVO (QUEUED/APPROVED) entre os candidatos a sumir.
 * Só consulta quando há candidato. Falha → devolve TODOS os candidatos como "tem
 * lead": na dúvida a linha fica visível (o erro nunca esconde carga).
 */
async function fetchCargoIdsWithLiveLead(supabaseClient, candidateIds) {
  if (candidateIds.length === 0) return new Set();
  try {
    const { data, error } = await supabaseClient
      .from("load_public_leads")
      .select("load_id")
      .in("load_id", candidateIds)
      .in("status", LIVE_LEAD_STATUSES);
    if (error) throw error;
    return new Set((data || []).map((l) => l.load_id));
  } catch {
    return new Set(candidateIds);
  }
}

/**
 * Lê TODAS as cargas do sistema (sheet_lh nulo, não-template, não-expiradas,
 * não-rascunho) paginando com .range para furar o cap de 1000 linhas do
 * PostgREST. Rascunho (status='DRAFT') é excluído do Monitor — segue acessível
 * no painel de Cargas por filtro de status. Retorna o
 * shape de linha do Monitor. Best-effort: lança o erro para o caller decidir
 * (o read do Monitor trata como não-fatal).
 *
 * @param {object} supabaseClient
 * @param {{ pageSize?: number, maxRows?: number, correlationId?: string|null }} [opts]
 *   `correlationId` é OPCIONAL e só viaja para o log de degradação (nenhum chamador
 *   atual o passa — handlers.js e sheet-monitor-enrichment.js chamam com o client
 *   sozinho; o parâmetro existe para quem quiser costurar o rastro depois).
 */
export async function listSystemCargasForMonitor(
  supabaseClient,
  { pageSize = 1000, maxRows = 10000, correlationId = null } = {},
) {
  // Mapa cliente_id→nome (tabela pequena) p/ exibir o cliente de cada carga.
  // Best-effort: sem clientes, o cliente da linha fica null.
  const clientesById = {};
  try {
    const { data: clientes } = await supabaseClient.from("clientes").select("id, nome");
    for (const cl of clientes || []) clientesById[cl.id] = cl.nome;
  } catch {
    /* sem clientes — cliente da linha fica null */
  }

  // "Agora" no relógio de São Paulo (carga.data/horario são horário do Brasil) —
  // usado p/ decidir se a carga está no futuro (aparece pro motorista). Uma vez só.
  const { dateIso, timeIso } = getSaoPauloWallClock();
  const now = { todayIso: dateIso, nowTimeIso: timeIso };

  // Estado das colunas OPCIONAIS nesta leitura: começam todas LIGADAS e cada uma é
  // desligada só quando o banco acusar a falta DELA (ver `blamedOptionalColumn`).
  //   * aspx_missing_since — carga cuja VIAGEM SAIU DO ASPX (marcada pelo job
  //     detect-aspx-missing-trips) não é mais operável: sai do Monitor mas CONTINUA
  //     na tela de Cargas com o selo "Fora do ASPX". Nunca é apagada — política do
  //     operador. Sem a coluna, relê sem o filtro em vez de derrubar a fonte "sistema".
  //   * agenda_a_confirmar — sem a coluna o mapper trata undefined como false.
  //   * trip_accepted_at (20260805170000) e trip_acceptance_checked_at (20260806150000)
  //     — faltando QUALQUER uma, o filtro de "lançada não aceita" fica desligado por
  //     inteiro: são elas que distinguem "observamos que não está aceita" de "nunca
  //     olhamos", e sem essa distinção voltaríamos ao incidente de 06/08/2026 (39-50
  //     linhas escondidas por dado ausente).
  const optional = {
    aspx_missing_since: true,
    agenda_a_confirmar: true,
    trip_accepted_at: true,
    trip_acceptance_checked_at: true,
  };
  const selectCols = () =>
    buildSelectCols({
      agendaAConfirmar: optional.agenda_a_confirmar,
      tripAccepted: optional.trip_accepted_at,
      acceptanceChecked: optional.trip_acceptance_checked_at,
    });
  const page = (from) => {
    let q = supabaseClient
      .from("cargas")
      .select(selectCols())
      .is("sheet_lh", null)
      .eq("is_template", false)
      .neq("status", "EXPIRED")
      .neq("status", "DRAFT") // rascunho não aparece no Monitor
      // Unificação da gêmea (TWIN_MERGE): o marcador NÃO muda `status` — uma carga
      // recém-mergeada pode continuar RESERVED/BOOKED e, sem este filtro, aparecia
      // aqui como linha do SISTEMA duplicando a canônica que já é exibida como linha
      // da PLANILHA (o dedup por LH em dedupe-monitor-rows.js só cobre o caso
      // "sistema OPEN", não este).
      .is("alloc_merged_into_cargo_id", null);
    if (optional.aspx_missing_since) q = q.is("aspx_missing_since", null);
    return q.order("data", { ascending: false }).range(from, from + pageSize - 1);
  };

  const raw = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    let { data, error } = await page(from);
    // Cada tentativa desliga NO MÁXIMO uma coluna opcional — a que o erro acusa — e
    // repete. O laço termina porque só desliga o que ainda estava ligado (4 no pior
    // caso) e `optional` é compartilhado entre as páginas: a degradação acontece uma
    // vez só na leitura inteira (e por isso o aviso também sai uma vez por coluna).
    while (error && disableBlamedOptionalColumn(error, optional, correlationId)) {
      ({ data, error } = await page(from));
    }
    if (error) throw error;
    const batch = data || [];
    for (const c of batch) raw.push(c);
    if (batch.length < pageSize) break;
  }

  // Carga LANÇADA da Shopee com EVIDÊNCIA de não-aceite sai do Monitor (segue em
  // /cargas). Só roda com as DUAS colunas de aceite disponíveis: falta qualquer uma
  // e o aceite é desconhecido em toda linha — filtrar aí esconderia a fonte inteira
  // por dado ausente, que é justamente o incidente que este desenho corrige. O lead
  // vivo é consultado só para os candidatos já filtrados pelas guardas baratas.
  let hidden = raw;
  if (optional.trip_accepted_at && optional.trip_acceptance_checked_at && isHideUnacceptedLaunchedEnabled()) {
    const nestleClientIds = resolveNestleClientIds(clientesById);
    // Relógio e TTL resolvidos UMA vez para a leitura inteira: a linha não pode
    // envelhecer no meio da varredura (duas cargas com a mesma evidência têm de ter
    // o mesmo veredito).
    const ttl = { nowMs: Date.now(), ttlHours: acceptanceEvidenceTtlHours() };
    const candidates = raw.filter((c) => isUnacceptedLaunchedShopeeCargo(c, { nestleClientIds, ...ttl }));
    if (candidates.length > 0) {
      const cargoIdsWithLiveLead = await fetchCargoIdsWithLiveLead(
        supabaseClient,
        candidates.map((c) => c.id),
      );
      const drop = new Set(
        candidates
          .filter((c) => isUnacceptedLaunchedShopeeCargo(c, { nestleClientIds, cargoIdsWithLiveLead, ...ttl }))
          .map((c) => c.id),
      );
      hidden = raw.filter((c) => !drop.has(c.id));
    }
  }

  // PORTÃO FINAL — o último passo antes do mapper, por construção. Ver
  // `applyDriverOfferGate`.
  const visiveis = applyDriverOfferGate(raw, hidden, { now, correlationId });

  return visiveis.map((c) => mapSystemCargoToMonitorRow(c, clientesById, now));
}

/**
 * PORTÃO: repõe toda linha que `isOfferedToDriver` aprova, DEPOIS de todas as regras de
 * ocultação. Norma do dono do produto: carga ofertada ao motorista nunca pode estar
 * invisível ao operador.
 *
 * Isto inverte quem carrega o ônus. Em 30 dias este read model acumulou seis regras de
 * ocultação e três precisaram de correção por esconderem demais — a última escondia 27
 * cargas ABERTAS no portal (64% do frete ofertado, medido em 06/08/2026). Consertar filtro por filtro é
 * enxugar gelo; com o portão, nenhum filtro CONSEGUE esconder frete vivo, inclusive os
 * que ainda não foram escritos.
 *
 * Escopo, e é uma limitação real: o portão opera sobre `raw` — as linhas que a QUERY
 * trouxe. Ele protege contra filtro em JS, NÃO contra filtro em SQL. Uma carga excluída
 * pelo `.neq("status", "DRAFT")` ou pelo `.is("aspx_missing_since", null)` nunca chega
 * aqui, e o portão não a inventa (nem poderia: não temos a linha). O que o portão
 * garante é que, do que foi lido, nada ofertado se perde no caminho até a tela.
 *
 * O log é o alarme: se o portão resgata, algum filtro está errado — e sem o evento essa
 * contradição ficaria muda, exatamente como ficou muda por 30 dias.
 *
 * Mas o alarme só serve se for LIDO, e é aqui que a primeira versão se sabotava. Ela
 * afirmava "em regime normal o portão resgata ZERO"; a medição do próprio PR diz 27
 * resgates assim que a migration entrar, porque este PR NÃO conserta o filtro #457 — ele
 * o neutraliza. Com o Monitor refazendo fetch a cada 30s por operador, isso seria ~8.600
 * eventos idênticos por dia. Em duas semanas ninguém leria mais nenhum `warn` deste read
 * model, incluindo os de `optional-column-missing`, que são acionáveis. Um alarme que
 * toca sem parar é indistinguível de alarme quebrado.
 *
 * Por isso o evento é emitido só quando a ASSINATURA do resgate MUDA — o conjunto de ids
 * resgatados. Estado estável (mesmo filtro escondendo as mesmas cargas) fala uma vez;
 * carga nova entrando ou saindo do resgate volta a falar. Memória de processo, sem TTL:
 * um restart re-anuncia, que é o comportamento desejado.
 *
 * A ordem de `raw` é preservada (filtramos `raw`, não concatenamos os resgatados no
 * fim), e o `Set` por id garante que nada é duplicado.
 */
// Assinatura do último resgate anunciado. Só existe para não repetir o mesmo aviso a
// cada leitura; nunca influencia QUAIS linhas o portão repõe.
let ultimaAssinaturaResgate = null;

/** Só para os testes: zera a memória do anúncio entre casos. */
export function __resetDriverOfferGateAlarm() {
  ultimaAssinaturaResgate = null;
}

function applyDriverOfferGate(raw, hidden, { now, correlationId = null } = {}) {
  // Nada foi escondido em JS → não há o que repor. Evita montar o Set no caminho comum.
  if (hidden.length === raw.length) return hidden;

  const mantidas = new Set(hidden.map((c) => c.id));
  const gateCtx = { todayIso: now?.todayIso ?? null, nowTimeIso: now?.nowTimeIso ?? null };
  const resgatadas = [];

  const visiveis = raw.filter((c) => {
    if (mantidas.has(c.id)) return true;
    if (!isOfferedToDriver(c, gateCtx)) return false;
    resgatadas.push(c);
    return true;
  });

  if (resgatadas.length > 0) {
    // Ids ordenados = assinatura estável do estado de resgate.
    const assinatura = resgatadas.map((c) => c.id).sort().join(",");
    if (assinatura !== ultimaAssinaturaResgate) {
      ultimaAssinaturaResgate = assinatura;
      logStructuredEvent("warn", "list-system-cargas-monitor.driver-offer-gate-rescued", {
        correlationId,
        resgatadas: resgatadas.length,
        escondidasPelosFiltros: raw.length - hidden.length,
        // Dois campos, e o nome do segundo é deliberado. O sanitizador redige qualquer
        // token >= 32 chars ([A-Za-z0-9+/=_-]), e um uuid casa: um id embutido em
        // `amostraLhs` virava `[REDACTED]` — inútil justo quando o id é o único
        // identificador que existe (11 cargas hoje sem `lh_manual`). A exceção olha o
        // NOME da chave, com `ID_LIKE_KEY_PATTERN = /(^id$|_id$|[a-z0-9]id$)/i`: termina
        // em `id`, passa. `amostraCargoIds` (plural) NÃO casa e seria redigida —
        // verificado contra o sanitizador real. Daí o singular, apesar de ser lista.
        amostraLhs: resgatadas.map((c) => String(c.lh_manual ?? "").trim()).filter(Boolean).slice(0, 10),
        amostraCargoId: resgatadas.filter((c) => !String(c.lh_manual ?? "").trim()).slice(0, 10).map((c) => c.id),
        efeito:
          "regra de ocultação tentou esconder carga ABERTA no portal do motorista; o portão a repôs — investigar o filtro",
      });
    }
  } else {
    // Voltou ao normal: o próximo resgate volta a ser anunciado.
    ultimaAssinaturaResgate = null;
  }

  return visiveis;
}

/** Ordem em que as opcionais são desligadas quando o erro NÃO diz qual falta (ver
 *  abaixo). Da menos custosa para a mais: soltar o filtro do ASPX só devolve linha à
 *  tela; soltar as colunas de aceite desliga o filtro de "lançada não aceita" — nas
 *  duas pontas a degradação MOSTRA carga a mais, nunca a menos. */
const OPTIONAL_COLUMNS = [
  "aspx_missing_since",
  "agenda_a_confirmar",
  "trip_accepted_at",
  "trip_acceptance_checked_at",
];

/** O que MUDA NA TELA quando cada opcional é desligada. Vai junto no aviso porque
 *  quem lê o log às 3h da manhã precisa do efeito, não do nome da migration: o texto
 *  é a diferença entre "coluna ausente" (ruído) e "o Monitor está sem o filtro de
 *  aceite" (ação). */
const OPTIONAL_COLUMN_EFFECT = {
  aspx_missing_since: "filtro 'fora do ASPX' desligado: viagem que saiu do ASPX volta ao Monitor",
  agenda_a_confirmar: "agenda 'A confirmar' deixa de ser exceção: volta o corte puro por data/hora",
  trip_accepted_at: "filtro de aceite desligado: lançada Shopee não aceita continua no Monitor",
  trip_acceptance_checked_at: "filtro de aceite desligado: lançada Shopee não aceita continua no Monitor",
};

/**
 * Qual coluna OPCIONAL (ainda ligada) este erro acusa como ausente — ou null se o
 * erro não é "coluna opcional faltando" e deve subir. Retorna `{ column, atribuicao }`:
 * `atribuicao` distingue o diagnóstico FIRME (o PostgREST nomeou a coluna) do palpite
 * pela ordem, e essa diferença vai para o log — degradar por palpite merece outro
 * grau de suspeita de quem lê.
 *
 * O desenho anterior tinha um atalho por CÓDIGO: `aspx_missing_since` casava qualquer
 * 42703, e por ser o primeiro elo da cadeia engolia a falta das OUTRAS opcionais. No
 * deploy de 06/08/2026 isso seria um bug silencioso e caro: o banco de produção ainda
 * não tem `trip_acceptance_checked_at` (migration é manual, deploy é automático no
 * merge), então o 42703 daquela coluna desligaria o filtro do ASPX — e ninguém o
 * religaria na leitura inteira. As 15 cargas marcadas "Fora do ASPX" voltariam ao
 * Monitor sem que nada aparecesse no log.
 *
 * Regra, à prova das opcionais que virão: a atribuição é sempre PELO NOME da coluna na
 * mensagem (o PostgREST manda 'column cargas.X does not exist'). O código 42703 sozinho
 * só vale como último recurso — quando a mensagem não nomeia NENHUMA opcional conhecida
 * — e aí desligamos uma por vez, na ordem acima, até a query passar ou acabarem as
 * candidatas (quando o erro sobe). Nomes com prefixo comum não se confundem:
 * "trip_acceptance_checked_at" não contém "trip_accepted_at".
 */
function blamedOptionalColumn(error, optional) {
  if (!error) return null;
  const msg = String(error.message ?? "").toLowerCase();
  const named = OPTIONAL_COLUMNS.find((col) => optional[col] && msg.includes(col));
  if (named) return { column: named, atribuicao: "nome" };
  if (String(error.code ?? "") !== "42703") return null;
  const porOrdem = OPTIONAL_COLUMNS.find((col) => optional[col]);
  return porOrdem ? { column: porOrdem, atribuicao: "ordem" } : null;
}

/**
 * Desliga a opcional acusada pelo erro e AVISA. `true` = vale repetir a query.
 *
 * O aviso é o ponto todo: até aqui a degradação era 100% silenciosa, e um banco sem a
 * migration ficava indistinguível de um banco saudável — o Monitor rodava semanas com o
 * filtro de aceite desligado e ninguém tinha como saber. O caso não é hipotético:
 * `trip_acceptance_checked_at` NÃO existe em produção hoje (migration é manual, deploy
 * é automático no merge), então este evento sai na primeira leitura pós-deploy e é ele
 * que lembra de rodar o migrate.
 *
 * Um evento POR COLUNA POR LEITURA, nunca por página: `optional` é compartilhado entre
 * as páginas e só se desliga o que ainda estava ligado, então a contagem é estrutural —
 * no pior caso 4 linhas de log por leitura, não 4 por página.
 */
function disableBlamedOptionalColumn(error, optional, correlationId = null) {
  const blamed = blamedOptionalColumn(error, optional);
  if (!blamed) return false;
  optional[blamed.column] = false;
  logStructuredEvent("warn", "list-system-cargas-monitor.optional-column-missing", {
    correlationId,
    coluna: blamed.column,
    atribuicao: blamed.atribuicao,
    efeito: OPTIONAL_COLUMN_EFFECT[blamed.column] ?? "leitura degradada",
  });
  return true;
}
