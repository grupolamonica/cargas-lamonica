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
  "id, origem, destino, data, horario, sheet_data_descarga, alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_tipo, alloc_pinned, status, driver_visibility, lh_manual, cliente_id";

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
  const opStatus = (c.alloc_status || "").trim();
  const lifecycle = (c.status || "").trim().toUpperCase();
  const isPublic = (c.driver_visibility || "PUBLIC").toString().toUpperCase() === "PUBLIC";
  const isFuture = !now || !dataStr || dataStr > now.todayIso
    || (dataStr === now.todayIso && (!horaStr || horaStr >= now.nowTimeIso));
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
    checklistCavalo: "",
    checklistCarreta: "",
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

  const out = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await supabaseClient
      .from("cargas")
      .select(SELECT_COLS)
      .is("sheet_lh", null)
      .eq("is_template", false)
      .neq("status", "EXPIRED")
      .neq("status", "DRAFT") // rascunho não aparece no Monitor
      .order("data", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    for (const c of batch) out.push(mapSystemCargoToMonitorRow(c, clientesById, now));
    if (batch.length < pageSize) break;
  }
  return out;
}
