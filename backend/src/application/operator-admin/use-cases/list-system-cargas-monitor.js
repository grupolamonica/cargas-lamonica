// Cargas criadas no SISTEMA (sheet_lh IS NULL) projetadas no MESMO shape de linha
// do Monitor, para entrarem na visão unificada (planilha ∪ sistema). O sync da
// planilha ignora cargas sem sheet_lh, então elas são duráveis aqui.
//
// Campos efetivos: motorista/cavalo/carreta/status operacional vêm de alloc_*
// (mesmas colunas usadas como override das linhas da planilha — para o sistema
// elas são simplesmente "o valor"). origem/destino/data/horario são as colunas
// canônicas da carga. lh = lh_manual (editável no grid).

import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

const SELECT_COLS =
  "id, origem, destino, data, horario, sheet_data_descarga, alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, sheet_status, alloc_tipo, alloc_descricao, alloc_vinculo, alloc_tratativas, alloc_checklist_cavalo, alloc_checklist_carreta, alloc_pinned, status, driver_visibility, lh_manual, agenda_a_confirmar, cliente_id";
// Mesmo SELECT sem `agenda_a_confirmar` — usado no fallback de banco sem a coluna
// (migration 20260717210000): a fonte "sistema" do Monitor não pode cair só por isso.
const SELECT_COLS_SEM_AGENDA = SELECT_COLS.replace(" agenda_a_confirmar,", "");

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

/**
 * Lê TODAS as cargas do sistema (sheet_lh nulo, não-template, não-expiradas,
 * não-rascunho) paginando com .range para furar o cap de 1000 linhas do
 * PostgREST. Rascunho (status='DRAFT') é excluído do Monitor — segue acessível
 * no painel de Cargas por filtro de status. Retorna o
 * shape de linha do Monitor. Best-effort: lança o erro para o caller decidir
 * (o read do Monitor trata como não-fatal).
 *
 * @param {object} supabaseClient
 * @param {{ pageSize?: number, maxRows?: number }} [opts]
 */
export async function listSystemCargasForMonitor(supabaseClient, { pageSize = 1000, maxRows = 10000 } = {}) {
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

  // Carga cuja VIAGEM SAIU DO ASPX (aspx_missing_since preenchido pelo job
  // detect-aspx-missing-trips) não é mais operável: sai do Monitor mas CONTINUA na
  // tela de Cargas (com o selo "Fora do ASPX"). Nunca é apagada — política do
  // operador. Tolerante a banco sem a coluna (migration não aplicada): repete a
  // leitura sem o filtro em vez de derrubar a fonte "sistema" do Monitor.
  let filterAspxMissing = true;
  // Idem para agenda_a_confirmar: sem a coluna, relê sem ela (o mapper trata
  // undefined como false) em vez de derrubar a fonte "sistema".
  let selectAgendaAConfirmar = true;
  const page = (from) => {
    let q = supabaseClient
      .from("cargas")
      .select(selectAgendaAConfirmar ? SELECT_COLS : SELECT_COLS_SEM_AGENDA)
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
    if (filterAspxMissing) q = q.is("aspx_missing_since", null);
    return q.order("data", { ascending: false }).range(from, from + pageSize - 1);
  };

  const out = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    let { data, error } = await page(from);
    if (error && filterAspxMissing && isMissingAspxColumnError(error)) {
      filterAspxMissing = false;
      ({ data, error } = await page(from));
    }
    if (error && selectAgendaAConfirmar && isMissingAgendaAConfirmarColumn(error)) {
      selectAgendaAConfirmar = false;
      ({ data, error } = await page(from));
    }
    if (error) throw error;
    const batch = data || [];
    for (const c of batch) out.push(mapSystemCargoToMonitorRow(c, clientesById, now));
    if (batch.length < pageSize) break;
  }
  return out;
}

/** Coluna aspx_missing_since ausente (migration ainda não aplicada) — PostgREST
 *  devolve 42703/"column ... does not exist". Qualquer outro erro sobe. */
function isMissingAspxColumnError(error) {
  if (!error) return false;
  if (error.code === "42703") return true;
  return /aspx_missing_since/i.test(String(error.message ?? ""));
}

/** Coluna agenda_a_confirmar ausente (migration 20260717210000 não aplicada). */
function isMissingAgendaAConfirmarColumn(error) {
  if (!error) return false;
  return /agenda_a_confirmar/i.test(String(error.message ?? ""));
}
