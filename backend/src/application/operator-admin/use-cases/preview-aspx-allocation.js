import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import {
  fetchAssignableTrips,
  fetchAssignableDrivers,
  fetchTripIndex,
  isAspxWriteEnabled,
} from "../../../infrastructure/spx/spx-allocation-client.js";

// Normaliza nome p/ casar com o motorista do ASPX (sem acento, maiúsculo, espaço único).
function normName(v) {
  return (v ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Classifica uma carga NÃO-atribuível pelo STATUS REAL da viagem no ASPX
// (espelha o enum tt_trip_status do sidecar spx_robo/trips.py).
//   5=Assigned · 0/200=Created/Pending · 10..80=Loading..Unloaded · 90=Completed · 100=Cancelled
function classifyByStatus(status, driver) {
  switch (status) {
    case 4:
      // Assigning. Status-4 SEM motorista cai na lista assignable (path 1) e nem
      // chega aqui; se chegou COM motorista, é handover em curso → já tem motorista.
      return driver ? "assigned" : "unknown";
    case 5:
      return "assigned"; // já atribuída, ainda não saiu
    case 100:
      return "cancelled";
    case 0:
    case 200:
      return "not_ready"; // criada / pendente — ainda não liberada p/ atribuir
    case 90:
      return "done"; // concluída
    case 10:
    case 30:
    case 40:
    case 50:
    case 60:
    case 70:
    case 80:
      return "in_progress"; // já em operação (tem motorista)
    default:
      return driver ? "assigned" : "unknown";
  }
}

// Loads candidatos a empurrar pro ASPX: viagem SPX (LT), com motorista EFETIVO
// (alocado pelo operador OU vindo da planilha) e não cancelada.
//
// O motorista pode vir da PLANILHA (sheet_motorista) sem o operador ter editado no
// sistema — e mesmo assim a carga pode estar atribuível AGORA no ASPX (viagem na
// fila status-4). Antes o filtro exigia `alloc_updated_at IS NOT NULL`, o que
// ESCONDIA essas cargas do modal "Atribuir no ASPX" (sobem no Monitor, mas somem
// do modal). Agora inclui também as cargas RECENTES/futuras (data >= hoje-4d) —
// mesmo sem alocação no sistema —, mantendo as alocadas independentemente da data.
// Histórico antigo (sem alocação e fora da janela) fica de fora p/ não inflar
// "unknown"/avisos.
async function defaultListCandidates() {
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sheet_lh, origem, destino, data, horario, sheet_data_descarga,
              COALESCE(alloc_motorista, sheet_motorista, '') AS motorista,
              COALESCE(alloc_cavalo,    sheet_cavalo,    '') AS cavalo,
              COALESCE(alloc_carreta,   sheet_carreta,   '') AS carreta,
              COALESCE(alloc_status,    sheet_status,    '') AS status,
              alloc_pinned
       FROM public.cargas
       WHERE sheet_lh IS NOT NULL
         AND upper(sheet_lh) LIKE 'LT%'
         AND COALESCE(alloc_motorista, sheet_motorista, '') <> ''
         AND lower(COALESCE(alloc_status, sheet_status, '')) NOT LIKE '%cancel%'
         AND (alloc_updated_at IS NOT NULL OR data >= CURRENT_DATE - INTERVAL '4 days')
       ORDER BY data DESC, horario DESC, sheet_lh
       LIMIT 500`,
    );
    return rows;
  });
}

// ── Agenda (carregamento + descarga) p/ exibir no modal ──
// pg devolve DATE como Date (UTC-midnight); PostgREST devolve string. Normaliza
// ambos p/ 'YYYY-MM-DD' (UTC, evita off-by-one).
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}
function agendaLabel(d, t) {
  if (!d) return null;
  const [y, mo, day] = d.split("-");
  return `${day}/${mo}/${y}${t ? ` ${String(t).slice(0, 5)}` : ""}`;
}
// sheet_data_descarga: 'YYYY-MM-DD[ T]HH:MM' (sistema) ou 'DD/MM/YYYY HH:MM' (planilha) → label BR.
function descargaLabel(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : s.slice(0, 16);
}
// Há divergência de motorista entre o sistema e o ASPX? Só p/ viagem ATIVA
// (assigned/in_progress). Viagem concluída (done) NÃO conta — não dá pra trocar
// motorista de viagem encerrada, e o histórico do ASPX frequentemente diverge do
// sistema (ruído). Antes "done" entrava aqui; com o índice passando a incluir o
// Concluído, isso encheria o modal de divergências históricas não-acionáveis.
function isDivergent(state, systemMotorista, aspxDriver) {
  if (!["assigned", "in_progress"].includes(state)) return false;
  if (!aspxDriver) return false;
  return normName(aspxDriver) !== normName(systemMotorista);
}

/**
 * Pré-visualização (dry-run) da atribuição no ASPX. Para cada carga alocada no
 * sistema, determina o estado REAL no ASPX cruzando 3 fontes do sidecar SPX:
 *   - /spx/trips/assignable  → viagens atribuíveis (status 4, sem motorista)
 *   - /spx/drivers/assignable → motoristas (casa por nome)
 *   - /spx/trips/snapshot     → ÍNDICE de status real por trip_number (check positivo)
 *
 * Estados por item: assign · pending · assigned · in_progress · done · cancelled ·
 * not_ready · unknown. "assigned/in_progress/done" = já tem motorista no ASPX
 * (mostra quem). "unknown" = não foi possível confirmar (ex.: concluída na aba que
 * a SPX não expõe) — honesto, não afirma "já atribuída".
 *
 * Só cargas com código LH iniciado em "LT" (line-haul real do SPX) entram na lista.
 * Se o sidecar SPX estiver fora do ar, a leitura falha e o erro propaga (sem simular).
 * Nada é enviado ao ASPX aqui — é só leitura/montagem.
 *
 * @param {{ correlationId?: string, deps?: object }} args
 */
export async function previewAspxAllocation({ correlationId, deps = {} } = {}) {
  const listCandidates = deps.listCandidates || defaultListCandidates;
  const getTrips = deps.fetchTrips || fetchAssignableTrips;
  const getDrivers = deps.fetchDrivers || fetchAssignableDrivers;
  const getIndex = deps.fetchIndex || fetchTripIndex;

  const candidates = await listCandidates();

  let trips = null;
  let drivers = null;
  let index = null;
  let indexFailed = false;

  // Listas atribuíveis + motoristas: base do assign/pending. Leitura obrigatória
  // do sidecar SPX — se estiver fora do ar, o erro propaga (sem modo simulação).
  [trips, drivers] = await Promise.all([getTrips(), getDrivers()]);

  // Índice de status real: BEST-EFFORT (degradação granular). Se só ele falhar,
  // mantém assign/pending das listas acima; os não-atribuíveis caem em "unknown"
  // (honesto). Inclui o CONCLUÍDO (mesma janela do selo, PR #262): sem ele, viagens
  // já concluídas ficavam "unknown/não encontrada no ASPX" (falso) e inflavam o
  // aviso index_gaps; agora caem em "done" (ocultas, rótulo correto).
  try {
    index = await getIndex({ includeConcluido: true, concluidoDaysBack: 20 });
  } catch {
    indexFailed = true;
  }

  const tripByLh = new Map((trips || []).map((t) => [String(t.trip_number ?? "").trim(), t]));
  const driverByName = new Map((drivers || []).map((d) => [normName(d.name), d.driver_id]));
  const statusByLh = index?.byNumber instanceof Map ? index.byNumber : new Map();

  const allItems = candidates.map((c) => {
    const d = dateStr(c.data);
    const base = {
      lh: c.sheet_lh,
      origem: c.origem,
      destino: c.destino,
      motorista: c.motorista,
      cavalo: c.cavalo,
      carreta: c.carreta,
      pinned: c.alloc_pinned === true,
      // Agenda (carregamento = data+hora canônicos; descarga = sheet_data_descarga)
      carregamentoLabel: agendaLabel(d, c.horario),
      descargaLabel: descargaLabel(c.sheet_data_descarga),
    };

    const lh = String(c.sheet_lh).trim();
    const trip = tripByLh.get(lh);
    const real = statusByLh.get(lh) || null;

    // 1) Atribuível agora (status 4, sem motorista) → vai ser ALTERADA.
    if (trip) {
      const driverId = driverByName.get(normName(c.motorista)) ?? null;
      if (!driverId) {
        return { ...base, tripId: trip.trip_id, driverId: null, state: "pending", realStatus: real?.statusName ?? null, assignedDriver: "", divergent: false, reassignable: false, reason: "motorista não encontrado no ASPX" };
      }
      return { ...base, tripId: trip.trip_id, driverId, state: "assign", realStatus: real?.statusName ?? null, assignedDriver: "", divergent: false, reassignable: false, reason: null };
    }

    // 2) Não atribuível → classifica pelo ESTADO REAL (check positivo).
    if (real) {
      const state = classifyByStatus(real.status, real.driver);
      const divergent = isDivergent(state, c.motorista, real.driver);
      // Divergente: resolve trip_id (do índice) + driver_id do motorista do SISTEMA
      // p/ permitir TROCAR no ASPX (reassign). Só é acionável se ambos resolverem.
      const tripId = divergent ? (real.tripId ?? null) : null;
      const driverId = divergent ? (driverByName.get(normName(c.motorista)) ?? null) : null;
      const reassignable = divergent && tripId != null && driverId != null;
      const reasonByState = {
        assigned: real.driver ? `já atribuída a ${real.driver}` : "já atribuída no ASPX",
        in_progress: `em operação (${real.statusName})${real.driver ? ` — ${real.driver}` : ""}`,
        done: "viagem concluída",
        cancelled: "viagem cancelada no ASPX",
        not_ready: `ainda não liberada (${real.statusName})`,
        unknown: `status ${real.statusName || "desconhecido"} — não atribuível`,
      };
      const reason = divergent
        ? `divergente — sistema: ${c.motorista} · ASPX: ${real.driver}${reassignable ? "" : " (motorista do sistema não está disponível no ASPX p/ trocar)"}`
        : (reasonByState[state] ?? null);
      return { ...base, tripId, driverId, state, realStatus: real.statusName, assignedDriver: real.driver || "", divergent, reassignable, reason };
    }

    // 3) Não está em nenhuma lista → não confirmado (NÃO afirma "já atribuída").
    return { ...base, tripId: null, driverId: null, state: "unknown", realStatus: null, assignedDriver: "", divergent: false, reassignable: false, reason: "não encontrada no ASPX (status não confirmado)" };
  });

  // Mostra SÓ o que vai ser alterado ou está diferente no ASPX:
  //   - assign  → vai ser atribuída agora
  //   - pending → ia atribuir mas o motorista não existe no ASPX (precisa atenção)
  //   - divergent → ASPX tem motorista diferente do sistema
  // O resto (já em dia, concluída, cancelada, não confirmada) é ocultado.
  const items = allItems.filter((i) => i.state === "assign" || i.state === "pending" || i.divergent === true);

  const count = (s) => allItems.filter((i) => i.state === s).length;
  const summary = {
    willAssign: count("assign"),
    pending: count("pending"),
    divergent: allItems.filter((i) => i.divergent).length,
    // Contexto (ocultas da lista): já atribuídas/concluídas/canceladas/não confirmadas.
    hidden: allItems.length - items.length,
    totalCandidates: allItems.length,
    alreadyAssigned: count("assigned") + count("in_progress") + count("done"),
    cancelled: count("cancelled"),
    notReady: count("not_ready"),
    unknown: count("unknown"),
  };

  // Guardas: avisos quando os dados de leitura podem estar incompletos/errados.
  const warnings = [];
  if ((trips || []).length === 0 && candidates.length > 0) warnings.push("assignable_empty");
  if (indexFailed) warnings.push("index_unavailable");
  if (index?.truncated) warnings.push("index_truncated");
  if (index?.partial) warnings.push("index_partial");
  // Cargas alocadas que não foram achadas em NENHUMA lista do ASPX (fora do
  // índice/abas). O modal as oculta — sem este aviso, "Tudo em dia" enganaria
  // quando uma divergência real está apenas invisível (ex.: viagem fora da janela).
  if (summary.unknown > 0) warnings.push("index_gaps");

  return {
    statusCode: 200,
    payload: {
      ok: true,
      configured: Boolean((process.env.SPX_SIDECAR_URL || "").trim()),
      writeEnabled: isAspxWriteEnabled(),
      summary,
      warnings,
      items,
      meta: { correlationId },
    },
  };
}
