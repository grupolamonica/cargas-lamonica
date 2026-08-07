import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapSystemCargoToMonitorRow,
  listSystemCargasForMonitor,
  isUnacceptedLaunchedShopeeCargo,
  resolveNestleClientIds,
  isHideUnacceptedLaunchedEnabled,
  acceptanceEvidenceTtlHours,
  isAcceptanceEvidenceFresh,
  __resetDriverOfferGateAlarm,
} from "./list-system-cargas-monitor.js";
import { applySpxOperationalStatus } from "./spx-operational-status.js";

// Ponta que nenhum teste cobria: o que o operador VÊ na carga lançada depois que a
// passada da lançada (`reconcile-aspx-status-launched.js`) grava o espelho e solta o
// override. Antes, o espelho era gravado e ninguém o exibia — a linha continuava
// vazia e o overlay AO VIVO do SPX (que só avança) passava a mandar nela.
describe("carga lançada: espelho do portal + overlay ao vivo do SPX (integração de exibição)", () => {
  const cargaLancada = (over = {}) => ({
    id: "c1", lh_manual: "LT-1", origem: "A", destino: "B",
    data: "2026-08-10", horario: "08:00:00", status: "RESERVED",
    alloc_motorista: "ANA", alloc_status: null, sheet_status: null, ...over,
  });
  const idx = (lh, label) => new Map([[lh, label]]);

  it("espelho preenchido é EXIBIDO e o SPX atrasado não o rebaixa", () => {
    const row = mapSystemCargoToMonitorRow(cargaLancada({ sheet_status: "DESCARREGADO" }));
    expect(row.status).toBe("DESCARREGADO");
    const final = applySpxOperationalStatus(row, { spxStatusByLh: idx("LT-1", "CARREGADO") });
    expect(final.status).toBe("DESCARREGADO"); // só avança
    expect(final.spxStatus).toBeUndefined();
  });

  it("sem espelho e sem override, o SPX ao vivo preenche (comportamento preservado)", () => {
    const row = mapSystemCargoToMonitorRow(cargaLancada());
    expect(row.status).toBe("");
    const final = applySpxOperationalStatus(row, { spxStatusByLh: idx("LT-1", "CARREGADO") });
    expect(final.status).toBe("CARREGADO");
  });

  it("override do operador vence o espelho, e o SPX ainda avança sobre ele", () => {
    const row = mapSystemCargoToMonitorRow(
      cargaLancada({ alloc_status: "CTE EM EMISSÃO", sheet_status: "CARREGADO" }),
    );
    expect(row.status).toBe("CTE EM EMISSÃO");
    // SPX atrás → preserva o CTE
    expect(applySpxOperationalStatus(row, { spxStatusByLh: idx("LT-1", "CARREGADO") }).status)
      .toBe("CTE EM EMISSÃO");
    // SPX à frente → avança
    expect(applySpxOperationalStatus(row, { spxStatusByLh: idx("LT-1", "DESCARREGADO") }).status)
      .toBe("DESCARREGADO");
  });

  it('override VAZIO ("Disponível") vence o espelho — `??`, não `||`', () => {
    const row = mapSystemCargoToMonitorRow(
      cargaLancada({ alloc_status: "", sheet_status: "DESCARREGADO", alloc_motorista: null, status: "OPEN" }),
    );
    expect(row.status).toBe(""); // segue Disponível/Reservado pela derivação, não "DESCARREGADO"
  });
});

describe("mapSystemCargoToMonitorRow", () => {
  it("projeta uma carga do sistema no shape de linha do Monitor", () => {
    const r = mapSystemCargoToMonitorRow({
      id: "11111111-1111-1111-1111-111111111111",
      origem: "São Paulo/SP",
      destino: "Salvador/BA",
      data: "2026-06-25",
      horario: "08:30:00",
      alloc_motorista: "João Silva",
      alloc_cavalo: "ABC1234",
      alloc_carreta: "",
      alloc_status: "CARREGADO",
      alloc_pinned: false,
      status: "OPEN",
      lh_manual: "MINHA-LH-1",
      sheet_data_descarga: "2026-06-26 18:00",
    });
    expect(r.rowKey).toBe("cargo:11111111-1111-1111-1111-111111111111");
    expect(r.source).toBe("sistema");
    expect(r.cargoId).toBe("11111111-1111-1111-1111-111111111111");
    expect(r.lh).toBe("MINHA-LH-1");
    expect(r.tipo).toBe("SISTEMA");
    expect(r.motoristas).toBe("João Silva");
    expect(r.cavalo).toBe("ABC1234");
    expect(r.status).toBe("CARREGADO");
    expect(r.data).toBe("2026-06-25");
    expect(r.horario).toBe("08:30");
    expect(r.hasDriver).toBe(true);
    expect(r.isAvailable).toBe(false);
    expect(r.lifecycleStatus).toBe("OPEN");
    // Agenda: carregamento (data+hora) + descarga (sheet_data_descarga)
    expect(r.carregamentoLabel).toBe("25/06/2026 08:30");
    expect(r.cargaAt).toBe("2026-06-25T08:30");
    expect(r.descargaLabel).toBe("26/06/2026 18:00");
    expect(r.descargaAt).toBe("2026-06-26T18:00");
  });

  it("status do Monitor: só OPEN é 'Disponível'; demais ciclos mostram o status real", () => {
    const base = { id: "x", origem: "A", destino: "B", data: "2026-06-25", horario: "08:00:00", alloc_motorista: null, alloc_status: null };
    // OPEN (aberta pro motorista), sem motorista → Disponível (status vazio).
    const open = mapSystemCargoToMonitorRow({ ...base, status: "OPEN" });
    expect(open.status).toBe("");
    expect(open.isAvailable).toBe(true);
    // BOOKED não está aberta → NÃO é "Disponível".
    const booked = mapSystemCargoToMonitorRow({ ...base, status: "BOOKED" });
    expect(booked.status).toBe("Reservado");
    expect(booked.isAvailable).toBe(false);
    // DRAFT (rascunho) e CANCELLED idem.
    expect(mapSystemCargoToMonitorRow({ ...base, status: "DRAFT" }).status).toBe("Rascunho");
    expect(mapSystemCargoToMonitorRow({ ...base, status: "CANCELLED" }).status).toBe("Cancelado");
    // Status operacional (alloc_status) tem precedência sobre o ciclo de vida.
    expect(mapSystemCargoToMonitorRow({ ...base, status: "BOOKED", alloc_status: "DESCARREGADO" }).status).toBe("DESCARREGADO");
  });

  it("'Disponível' exige a MESMA regra do painel do motorista: OPEN + pública + sem motorista + carregamento futuro", () => {
    const now = { todayIso: "2026-06-30", nowTimeIso: "12:00" };
    const base = { id: "x", origem: "A", destino: "B", status: "OPEN", alloc_motorista: null, alloc_status: null, driver_visibility: "PUBLIC" };
    // OPEN, pública, futura → Disponível ("")
    expect(mapSystemCargoToMonitorRow({ ...base, data: "2026-07-05", horario: "08:00:00" }, {}, now).status).toBe("");
    // OPEN mas PASSADA → não aparece pro motorista → "Em aberto"
    expect(mapSystemCargoToMonitorRow({ ...base, data: "2026-06-20", horario: "08:00:00" }, {}, now).status).toBe("Em aberto");
    // OPEN futura mas PRIVADA → "Em aberto"
    expect(mapSystemCargoToMonitorRow({ ...base, data: "2026-07-05", driver_visibility: "PRIVATE" }, {}, now).status).toBe("Em aberto");
    // OPEN futura com motorista → não é Disponível (badge mostra "Reservado"); isAvailable=false
    const comMot = mapSystemCargoToMonitorRow({ ...base, data: "2026-07-05", alloc_motorista: "FULANO" }, {}, now);
    expect(comMot.status).toBe("");
    expect(comMot.isAvailable).toBe(false);
  });

  it("DC-271: carga LANÇADA com hora vencida NÃO é 'Disponível' (some do portal); só a agenda 'A confirmar' escapa do corte", () => {
    const now = { todayIso: "2026-06-30", nowTimeIso: "12:00" };
    // HOJE, hora já passada (06:00 < 12:00). Espelha buildDriverLoadFilters pós-DC-271.
    const base = { id: "x", origem: "A", destino: "B", status: "OPEN", alloc_motorista: null, alloc_status: null, driver_visibility: "PUBLIC", data: "2026-06-30", horario: "06:00:00" };
    // Lançada com agenda DEFINIDA e hora vencida → saiu do portal → "Em aberto".
    // (Antes o Monitor dizia "Disponível" — divergia do que o motorista via.)
    const lancada = mapSystemCargoToMonitorRow({ ...base, lh_manual: "LT-LAUNCH-1" }, {}, now);
    expect(lancada.status).toBe("Em aberto");
    expect(lancada.isAvailable).toBe(false);
    // Sistema SEM lh_manual (mesma data/hora) → regra minuto-a-minuto → "Em aberto".
    expect(mapSystemCargoToMonitorRow({ ...base }, {}, now).status).toBe("Em aberto");
    // Planilha (sheet_lh) idem → "Em aberto".
    expect(mapSystemCargoToMonitorRow({ ...base, lh_manual: "LT-X", sheet_lh: "SHEET-1" }, {}, now).status).toBe("Em aberto");

    // Agenda "A CONFIRMAR": data/horario são placeholder (dia do lançamento às 00:00),
    // não carregamento vencido — o portal a lista, então o Monitor mostra "Disponível".
    const aConfirmar = mapSystemCargoToMonitorRow(
      { ...base, horario: "00:00:00", lh_manual: "B101474063", agenda_a_confirmar: true },
      {},
      now,
    );
    expect(aConfirmar.status).toBe("");
    expect(aConfirmar.isAvailable).toBe(true);
    // Placeholder de dia anterior segue "Disponível" — a flag tira do corte por completo,
    // igual ao portal (quem encerra a oferta é o operador, ao confirmar/cancelar a agenda).
    expect(
      mapSystemCargoToMonitorRow({ ...base, data: "2026-06-29", horario: "00:00:00", lh_manual: "B1-OLD", agenda_a_confirmar: true }, {}, now).status,
    ).toBe("");
    // Banco sem a coluna (undefined) → corte puro por data/hora → "Em aberto".
    expect(mapSystemCargoToMonitorRow({ ...base, lh_manual: "LT-NOCOL" }, {}, now).status).toBe("Em aberto");
  });

  it("resolve o cliente da carga via clientesById (id→nome); null sem id/match", () => {
    const base = { id: "x", origem: "A", destino: "B", data: "2026-06-25", horario: "08:00:00" };
    expect(mapSystemCargoToMonitorRow({ ...base, cliente_id: "c1" }, { c1: "Mercado Livre" }).cliente).toBe("Mercado Livre");
    expect(mapSystemCargoToMonitorRow({ ...base }).cliente).toBeNull(); // sem cliente_id
    expect(mapSystemCargoToMonitorRow({ ...base, cliente_id: "zzz" }, { c1: "X" }).cliente).toBeNull(); // sem match
  });

  it("tipo da carga do sistema = alloc_tipo (override) ?? 'SISTEMA'", () => {
    const base = { id: "x", origem: "A", destino: "B", data: "2026-06-25", horario: "08:00:00" };
    expect(mapSystemCargoToMonitorRow({ ...base }).tipo).toBe("SISTEMA");
    expect(mapSystemCargoToMonitorRow({ ...base, alloc_tipo: "Spot" }).tipo).toBe("Spot");
  });

  it("data ISO (UTC-midnight) é fatiada corretamente; sem motorista = disponível", () => {
    const r = mapSystemCargoToMonitorRow({
      id: "22222222-2222-2222-2222-222222222222",
      origem: "A",
      destino: "B",
      data: "2026-06-25T00:00:00.000Z",
      horario: "14:00:00",
      alloc_motorista: null,
      alloc_status: null,
      lh_manual: null,
    });
    expect(r.data).toBe("2026-06-25");
    expect(r.horario).toBe("14:00");
    expect(r.lh).toBe("");
    expect(r.isAvailable).toBe(true);
    expect(r.hasDriver).toBe(false);
  });
});

describe("listSystemCargasForMonitor", () => {
  function fakeClient(pages) {
    let call = 0;
    const api = {
      from: () => api,
      select: () => api,
      is: () => api,
      eq: () => api,
      neq: () => api,
      order: () => api,
      range: async () => ({ data: pages[call++] ?? [], error: null }),
    };
    return api;
  }

  it("pagina via .range até esgotar (< pageSize encerra)", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({ id: `a${i}`, origem: "X", destino: "Y", data: "2026-06-01", horario: "07:00:00" }));
    const rows = await listSystemCargasForMonitor(fakeClient([page1]), { pageSize: 2, maxRows: 10 });
    // page1 tem 2 (== pageSize) → busca page2; page2 vazia → encerra. Total 2.
    expect(rows.length).toBe(2);
    expect(rows[0].rowKey).toBe("cargo:a0");
  });

  it("propaga erro do supabase", async () => {
    const api = { from: () => api, select: () => api, is: () => api, eq: () => api, neq: () => api, order: () => api, range: async () => ({ data: null, error: new Error("boom") }) };
    await expect(listSystemCargasForMonitor(api)).rejects.toThrow("boom");
  });

  it("exclui rascunho (DRAFT) e expiradas da query do Monitor", async () => {
    const neqCalls = [];
    const isCalls = [];
    const eqCalls = [];
    const api = {
      from: () => api,
      select: () => api,
      is: (col, val) => { isCalls.push([col, val]); return api; },
      eq: (col, val) => { eqCalls.push([col, val]); return api; },
      neq: (col, val) => { neqCalls.push([col, val]); return api; },
      order: () => api,
      range: async () => ({ data: [], error: null }),
    };
    await listSystemCargasForMonitor(api);
    expect(neqCalls).toContainEqual(["status", "EXPIRED"]);
    expect(neqCalls).toContainEqual(["status", "DRAFT"]); // rascunho fora do Monitor
    expect(isCalls).toContainEqual(["sheet_lh", null]);
    expect(eqCalls).toContainEqual(["is_template", false]);
    // Carga cuja VIAGEM saiu do ASPX sai do Monitor (continua em /cargas).
    expect(isCalls).toContainEqual(["aspx_missing_since", null]);
    // Unificação da gêmea (TWIN_MERGE): já mergeada não duplica a canônica no
    // Monitor como linha do sistema.
    expect(isCalls).toContainEqual(["alloc_merged_into_cargo_id", null]);
  });

  it("banco sem a coluna aspx_missing_since: repete a leitura sem o filtro (não derruba o Monitor)", async () => {
    const isCalls = [];
    let attempt = 0;
    const api = {
      from: () => api,
      select: () => api,
      is: (col, val) => { isCalls.push([col, val]); return api; },
      eq: () => api,
      neq: () => api,
      order: () => api,
      range: async () => {
        attempt += 1;
        // 1ª tentativa (com o filtro) → coluna ausente; 2ª (sem o filtro) → OK.
        if (attempt === 1) {
          return { data: null, error: { code: "42703", message: 'column cargas.aspx_missing_since does not exist' } };
        }
        return { data: [{ id: "a0", origem: "X", destino: "Y", data: "2026-06-01", horario: "07:00:00" }], error: null };
      },
    };

    const rows = await listSystemCargasForMonitor(api, { pageSize: 2, maxRows: 4 });

    expect(rows.map((r) => r.rowKey)).toEqual(["cargo:a0"]);
    expect(isCalls).toContainEqual(["aspx_missing_since", null]); // tentou filtrar
    expect(attempt).toBe(2); // e caiu no fallback sem o filtro
  });

  it("propaga erro que não é 'coluna ausente' mesmo na 1ª tentativa", async () => {
    const api = {
      from: () => api, select: () => api, is: () => api, eq: () => api, neq: () => api, order: () => api,
      range: async () => ({ data: null, error: new Error("timeout") }),
    };
    await expect(listSystemCargasForMonitor(api)).rejects.toThrow("timeout");
  });
});

// A carga LANÇADA que ninguém aceitou entrava no Monitor por construção: `accepted`
// governava só o write-back da planilha e nem o INSERT nem este read model o
// enxergavam. Medido em prod (05/08/2026): 94 lançadas na tela, 93% da fonte SISTEMA,
// 72 nunca aceitas.
//
// O primeiro desenho (PR #457) leu `trip_accepted_at IS NULL` como "ninguém aceitou".
// Medido em 06/08/2026: das 92 lançadas vivas, 82 tinham NULL e 79 haviam sido criadas
// ANTES de a coluna existir — o silêncio virou veredito e sumiram 39-50 linhas da
// fonte SISTEMA, 26 delas ABERTAS no portal /motorista. Hoje o filtro exige EVIDÊNCIA:
// `trip_acceptance_checked_at` preenchido (olhamos o SPX ao vivo, resposta conclusiva)
// E `trip_accepted_at` nulo. Nunca checado = DESCONHECIDO = a linha fica.
const HOUR_MS = 3600_000;
/** Evidência de N horas atrás. RELATIVA ao relógio de propósito: com a data cravada,
 *  a suíte inteira passaria a esconder/mostrar conforme o dia em que rodasse assim que
 *  o TTL entrou em cena. */
const horasAtras = (h) => new Date(Date.now() - h * HOUR_MS).toISOString();

describe("isUnacceptedLaunchedShopeeCargo (guardas do filtro)", () => {
  // Base = exatamente o caso que deve sumir: lançada, Shopee, OPEN, inerte e com
  // EVIDÊNCIA observada de não-aceite RECENTE (checada há 1h, sem aceite).
  const inerte = (over = {}) => ({
    id: "c1", lh_manual: "LT-1", status: "OPEN",
    alloc_motorista: null, alloc_status: null, sheet_status: null,
    trip_accepted_at: null, trip_acceptance_checked_at: horasAtras(1),
    sheet_source: null, cliente_id: "cli-shopee", ...over,
  });
  const nestleIds = new Set(["cli-nestle"]);
  const hide = (c, ctx = {}) => isUnacceptedLaunchedShopeeCargo(c, { nestleClientIds: nestleIds, ...ctx });

  it("esconde a lançada da Shopee checada, sem aceite e sem nenhum sinal de vida", () => {
    expect(hide(inerte())).toBe(true);
  });

  // A regressão que originou o redesenho: 79 das 82 lançadas com aceite NULL nunca
  // tiveram chance de ser marcadas (nasceram antes da coluna). Silêncio não é veredito.
  it("NUNCA CHECADA fica: aceite desconhecido não é evidência de não-aceite", () => {
    expect(hide(inerte({ trip_acceptance_checked_at: null }))).toBe(false);
    expect(hide(inerte({ trip_acceptance_checked_at: undefined }))).toBe(false);
  });

  // Caso levantado na revisão: LT com carregamento hoje 10:00, observada "não aceita"
  // às 09:50 (Monitor esconde), fora do recorte do job às 10:01, aceita direto no portal
  // SPX às 10:30. Sem prazo de validade, essa carga fica aceita, viva e PERMANENTEMENTE
  // invisível para o operador — no dia em que mais importa.
  it("evidência VELHA (> TTL) volta a ser desconhecida: a linha reaparece", () => {
    expect(hide(inerte({ trip_acceptance_checked_at: horasAtras(1) }))).toBe(true);   // fresca
    expect(hide(inerte({ trip_acceptance_checked_at: horasAtras(48) }))).toBe(false); // expirada
  });

  it("fronteira do TTL: exatamente o limite ainda vale; 1 ms além, não", () => {
    const nowMs = Date.parse("2026-08-06T12:00:00Z");
    const emPonto = new Date(nowMs - 24 * HOUR_MS).toISOString();
    expect(hide(inerte({ trip_acceptance_checked_at: emPonto }), { nowMs })).toBe(true);
    const umMsAlem = new Date(nowMs - 24 * HOUR_MS - 1).toISOString();
    expect(hide(inerte({ trip_acceptance_checked_at: umMsAlem }), { nowMs })).toBe(false);
    // TTL menor via ctx: a mesma evidência de 12h já não vale.
    const doze = new Date(nowMs - 12 * HOUR_MS).toISOString();
    expect(hide(inerte({ trip_acceptance_checked_at: doze }), { nowMs })).toBe(true);
    expect(hide(inerte({ trip_acceptance_checked_at: doze }), { nowMs, ttlHours: 6 })).toBe(false);
  });

  it("checked_at ilegível conta como desconhecido (dado duvidoso nunca esconde)", () => {
    expect(hide(inerte({ trip_acceptance_checked_at: "ontem de manhã" }))).toBe(false);
  });

  it("aceita como objeto Date (o driver pg entrega timestamptz assim)", () => {
    expect(hide(inerte({ trip_acceptance_checked_at: new Date(Date.now() - HOUR_MS) }))).toBe(true);
    expect(hide(inerte({ trip_acceptance_checked_at: new Date(Date.now() - 48 * HOUR_MS) }))).toBe(false);
  });

  it("carga SEM lh_manual não é lançada — nunca entra no filtro", () => {
    expect(hide(inerte({ lh_manual: null }))).toBe(false);
    expect(hide(inerte({ lh_manual: "   " }))).toBe(false);
  });

  it("viagem ACEITA fica, mesmo sem motorista (frete comprometido com a agência)", () => {
    // Checada E aceita: observamos o aceite, a carga fica.
    expect(hide(inerte({ trip_accepted_at: "2026-08-05T12:00:00Z" }))).toBe(false);
    // Aceita sem nunca ter sido checada (aceite gravado no lançamento, antes de
    // qualquer passada do job) — o aceite positivo basta, não depende da observação.
    expect(
      hide(inerte({ trip_accepted_at: "2026-08-05T12:00:00Z", trip_acceptance_checked_at: null })),
    ).toBe(false);
  });

  it("ciclo diferente de OPEN fica (alguém já agiu na carga)", () => {
    for (const status of ["RESERVED", "BOOKED", "CANCELLED"]) {
      expect(hide(inerte({ status }))).toBe(false);
    }
  });

  it("motorista alocado fica", () => {
    expect(hide(inerte({ alloc_motorista: "ANA" }))).toBe(false);
  });

  it("status operacional fica — override do operador OU espelho do portal", () => {
    expect(hide(inerte({ alloc_status: "CTE ENVIADO" }))).toBe(false);
    expect(hide(inerte({ sheet_status: "CARREGADO" }))).toBe(false);
    // Override VAZIO é "Disponível" explícito, não status: segue escondendo.
    expect(hide(inerte({ alloc_status: "", sheet_status: "CARREGADO" }))).toBe(true);
  });

  it("lead vivo na fila fica (motorista pediu a carga)", () => {
    expect(hide(inerte(), { cargoIdsWithLiveLead: new Set(["c1"]) })).toBe(false);
  });

  it("Nestlé está fora do escopo — pela fonte OU pelo cliente", () => {
    expect(hide(inerte({ sheet_source: "nestle" }))).toBe(false);
    // sheet_source só passou a ser gravado depois: a lançada Nestlé antiga tem NULL
    // e só o cliente a identifica.
    expect(hide(inerte({ sheet_source: null, cliente_id: "cli-nestle" }))).toBe(false);
  });
});

describe("acceptanceEvidenceTtlHours (TTL da evidência, env override)", () => {
  const comEnv = (v, fn) => {
    const prev = process.env.MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS;
    if (v === undefined) delete process.env.MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS;
    else process.env.MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS = v;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS;
      else process.env.MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS = prev;
    }
  };

  it("default 24h — folgadamente maior que o intervalo de regravação (60 min) do job", () => {
    comEnv(undefined, () => expect(acceptanceEvidenceTtlHours()).toBe(24));
  });

  it("env válido manda", () => {
    comEnv("6", () => expect(acceptanceEvidenceTtlHours()).toBe(6));
    comEnv("0.5", () => expect(acceptanceEvidenceTtlHours()).toBe(0.5));
  });

  // Env mal preenchido não pode virar "esconde para sempre" (TTL gigante por NaN→0?) nem
  // "nunca esconde" (TTL zero): cai no default e o comportamento segue previsível.
  it("valor inválido, vazio, zero ou negativo cai no default", () => {
    for (const v of ["", "  ", "abc", "0", "-3", "NaN"]) {
      comEnv(v, () => expect(acceptanceEvidenceTtlHours()).toBe(24));
    }
  });

  it("isAcceptanceEvidenceFresh respeita o env", () => {
    const nowMs = Date.parse("2026-08-06T12:00:00Z");
    const oitoHoras = new Date(nowMs - 8 * HOUR_MS).toISOString();
    comEnv(undefined, () => expect(isAcceptanceEvidenceFresh(oitoHoras, { nowMs })).toBe(true));
    comEnv("4", () => expect(isAcceptanceEvidenceFresh(oitoHoras, { nowMs })).toBe(false));
    // Sem evidência nenhuma nunca é "fresca".
    expect(isAcceptanceEvidenceFresh(null, { nowMs })).toBe(false);
    expect(isAcceptanceEvidenceFresh(undefined, { nowMs })).toBe(false);
  });
});

describe("resolveNestleClientIds", () => {
  it("casa o cliente Nestlé sem acento/caixa e ignora os demais", () => {
    const ids = resolveNestleClientIds({
      "cli-1": "Produtos Alimentícios",
      "cli-2": "E-COMMERCE",
      "cli-3": "nestle",
    });
    expect(ids).toEqual(new Set(["cli-1", "cli-3"]));
  });
});

describe("listSystemCargasForMonitor: lançada não aceita sai do Monitor", () => {
  const CLIENTES = [
    { id: "cli-shopee", nome: "E-COMMERCE" },
    { id: "cli-nestle", nome: "Produtos Alimentícios" },
  ];

  /** Fake do PostgREST com as duas tabelas que o read model toca. */
  function fakeClient(cargas, { leadIds = [], leadError = null, cargasError = null } = {}) {
    const calls = { leads: 0 };
    const api = (table) => {
      const q = {
        _table: table, _served: false,
        select: () => q,
        is: () => q,
        eq: () => q,
        neq: () => q,
        in: () => q,
        order: () => q,
        range: async () => {
          if (cargasError) return { data: null, error: cargasError };
          // 1ª página devolve tudo; 2ª encerra (batch < pageSize).
          const first = !q._served;
          q._served = true;
          return { data: first ? cargas : [], error: null };
        },
        then: undefined,
      };
      if (table === "load_public_leads") {
        calls.leads += 1;
        q.select = () => q;
        q.in = () => q;
        // O read model faz `await query` direto (sem .range) nesta tabela.
        q.then = (resolve) =>
          resolve(leadError ? { data: null, error: leadError } : { data: leadIds.map((id) => ({ load_id: id })), error: null });
      }
      if (table === "clientes") {
        q.then = (resolve) => resolve({ data: CLIENTES, error: null });
      }
      return q;
    };
    return { from: (t) => api(t), _calls: calls };
  }

  // Base já CHECADA HÁ POUCO (evidência RECENTE de não-aceite) — é o único estado em
  // que o filtro pode agir. Quem quiser "nunca checado" sobrescreve com null; quem
  // quiser evidência expirada usa horasAtras(48).
  //
  // O carregamento é DELIBERADAMENTE vencido (2020). Depois do PORTÃO, uma lançada
  // OPEN/pública/sem motorista com carregamento no futuro está OFERTADA no portal e
  // NENHUM filtro consegue escondê-la — um fixture assim não mediria mais o filtro,
  // mediria o portão. O que sobra para o filtro de aceite é exatamente esta carga: viva
  // no cadastro, mas já fora da tela do motorista. O portão em ação tem describe próprio
  // ("portão do frete ofertado"), logo abaixo.
  const carga = (over = {}) => ({
    id: "x", origem: "A", destino: "B", data: "2020-01-01", horario: "08:00:00",
    agenda_a_confirmar: false, status: "OPEN", lh_manual: null, alloc_motorista: null,
    alloc_status: null, sheet_status: null, trip_accepted_at: null,
    trip_acceptance_checked_at: horasAtras(1), sheet_source: null, cliente_id: "cli-shopee",
    ...over,
  });

  const ids = (rows) => rows.map((r) => r.cargoId);

  it("some a lançada Shopee checada e não aceita; ficam a aceita, a com motorista, a Nestlé e a NUNCA CHECADA", async () => {
    const client = fakeClient([
      carga({ id: "some", lh_manual: "LT-1" }),
      carga({ id: "aceita", lh_manual: "LT-2", trip_accepted_at: "2026-08-05T10:00:00Z" }),
      carga({ id: "com-motorista", lh_manual: "LT-3", alloc_motorista: "ANA" }),
      carga({ id: "nestle", lh_manual: "B1-9", cliente_id: "cli-nestle" }),
      // As 79 lançadas de produção criadas antes de a coluna existir: nunca foram
      // observadas, então o aceite é DESCONHECIDO e a linha não pode sumir.
      carga({ id: "nunca-checada", lh_manual: "LT-4", trip_acceptance_checked_at: null }),
      // Observada uma vez, saiu do recorte do job e nunca mais: a evidência venceu
      // (TTL 24h) e o aceite volta a ser desconhecido.
      carga({ id: "evidencia-velha", lh_manual: "LT-5", trip_acceptance_checked_at: horasAtras(48) }),
      carga({ id: "manual", lh_manual: null }), // carga do operador, sem LH: intocada
    ]);
    const rows = await listSystemCargasForMonitor(client, { pageSize: 50 });
    expect(ids(rows)).toEqual(["aceita", "com-motorista", "nestle", "nunca-checada", "evidencia-velha", "manual"]);
  });

  it("lead vivo na fila segura a carga na tela", async () => {
    const client = fakeClient([carga({ id: "com-lead", lh_manual: "LT-1" })], { leadIds: ["com-lead"] });
    expect(ids(await listSystemCargasForMonitor(client, { pageSize: 50 }))).toEqual(["com-lead"]);
  });

  it("consulta de leads falhando NÃO esconde ninguém (erro nunca some com carga)", async () => {
    const client = fakeClient([carga({ id: "a", lh_manual: "LT-1" })], { leadError: new Error("boom") });
    expect(ids(await listSystemCargasForMonitor(client, { pageSize: 50 }))).toEqual(["a"]);
  });

  it("sem candidato a sumir, nem consulta os leads", async () => {
    const client = fakeClient([carga({ id: "a", lh_manual: null })]);
    await listSystemCargasForMonitor(client, { pageSize: 50 });
    expect(client._calls.leads).toBe(0);
  });

  it("lançada nunca checada não é nem candidata — não gasta consulta de leads", async () => {
    const client = fakeClient([carga({ id: "a", lh_manual: "LT-1", trip_acceptance_checked_at: null })]);
    expect(ids(await listSystemCargasForMonitor(client, { pageSize: 50 }))).toEqual(["a"]);
    expect(client._calls.leads).toBe(0);
  });

  it("MONITOR_HIDE_UNACCEPTED_LAUNCHED=false desliga o filtro", async () => {
    const prev = process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED;
    process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED = "false";
    try {
      expect(isHideUnacceptedLaunchedEnabled()).toBe(false);
      const client = fakeClient([carga({ id: "a", lh_manual: "LT-1" })]);
      expect(ids(await listSystemCargasForMonitor(client, { pageSize: 50 }))).toEqual(["a"]);
    } finally {
      if (prev === undefined) delete process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED;
      else process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED = prev;
    }
  });

  // Deploy antes da migration: a coluna não existe. Sem a coluna o aceite é
  // undefined em TODAS as linhas — aplicar o filtro aí esvaziaria a fonte SISTEMA
  // inteira. A degradação correta é não filtrar nada.
  it("banco sem trip_accepted_at: relê sem a coluna e NÃO filtra (aceite desconhecido em todas)", async () => {
    const selects = [];
    let served = false;
    const api = {
      from: (t) => {
        let cols = "";
        const q = {
          select: (c) => { cols = c; selects.push([t, c]); return q; },
          is: () => q, eq: () => q, neq: () => q, in: () => q, order: () => q,
          // O erro persiste enquanto o SELECT ainda pedir a coluna ausente — é assim
          // que o PostgREST se comporta, e é o que exercita a cadeia de fallbacks
          // (o de aspx_missing_since dispara antes por casar qualquer 42703).
          range: async () => {
            if (cols.includes("trip_accepted_at")) {
              return { data: null, error: { code: "42703", message: 'column cargas.trip_accepted_at does not exist' } };
            }
            if (served) return { data: [], error: null };
            served = true;
            return { data: [{ id: "a", origem: "A", destino: "B", data: "2026-08-10", horario: "08:00:00", status: "OPEN", lh_manual: "LT-1" }], error: null };
          },
          then: t === "clientes" ? (resolve) => resolve({ data: CLIENTES, error: null }) : undefined,
        };
        return q;
      },
    };
    const rows = await listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 3 });
    expect(rows.map((r) => r.cargoId)).toEqual(["a"]); // sobreviveu: sem coluna, sem filtro
    expect(selects.some(([t, cols]) => t === "cargas" && cols.includes("trip_accepted_at"))).toBe(true);
    expect(selects.some(([t, cols]) => t === "cargas" && !cols.includes("trip_accepted_at"))).toBe(true);
  });

  // Mesmo raciocínio para a coluna de OBSERVAÇÃO (migration 20260806150000): sem ela
  // não dá para distinguir "checamos e não está aceita" de "nunca olhamos" — e é
  // exatamente essa confusão que escondeu 39-50 linhas em 06/08/2026. Sem a coluna, o
  // filtro inteiro fica desligado: NENHUMA linha some, nem a lançada inerte.
  it("banco sem trip_acceptance_checked_at: relê sem a coluna e NÃO filtra (nem a lançada inerte some)", async () => {
    const selects = [];
    let served = false;
    const api = {
      from: (t) => {
        let cols = "";
        const q = {
          select: (c) => { cols = c; selects.push([t, c]); return q; },
          is: () => q, eq: () => q, neq: () => q, in: () => q, order: () => q,
          range: async () => {
            if (cols.includes("trip_acceptance_checked_at")) {
              return { data: null, error: { code: "42703", message: 'column cargas.trip_acceptance_checked_at does not exist' } };
            }
            if (served) return { data: [], error: null };
            served = true;
            // Lançada Shopee OPEN, sem aceite e sem sinal de vida: sumiria se o
            // filtro estivesse ligado.
            return { data: [{ id: "a", origem: "A", destino: "B", data: "2026-08-10", horario: "08:00:00", status: "OPEN", lh_manual: "LT-1", trip_accepted_at: null, cliente_id: "cli-shopee" }], error: null };
          },
          then: t === "clientes" ? (resolve) => resolve({ data: CLIENTES, error: null }) : undefined,
        };
        return q;
      },
    };
    const rows = await listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 3 });
    expect(rows.map((r) => r.cargoId)).toEqual(["a"]);
    // O fallback derrubou SÓ a coluna nova — `trip_accepted_at` continua no SELECT.
    const ultimo = selects.filter(([t]) => t === "cargas").at(-1)[1];
    expect(ultimo).not.toContain("trip_acceptance_checked_at");
    expect(ultimo).toContain("trip_accepted_at");
  });

  /** Fake que registra, POR TENTATIVA, o SELECT e os `.is()` aplicados. O fake antigo
   *  tinha `is: () => q` — o liga/desliga do filtro era invisível, e por isso a cadeia
   *  de fallbacks podia soltar o filtro do ASPX sem nenhum teste reclamar. */
  function recordingClient(onRange) {
    const attempts = [];
    const api = {
      _attempts: attempts,
      from: (t) => {
        const at = { table: t, cols: "", isCalls: [] };
        const q = {
          select: (c) => { at.cols = c; return q; },
          is: (col, val) => { at.isCalls.push([col, val]); return q; },
          eq: () => q, neq: () => q, in: () => q, order: () => q,
          range: async () => { attempts.push(at); return onRange(at); },
          then: t === "clientes" ? (resolve) => resolve({ data: CLIENTES, error: null }) : undefined,
        };
        return q;
      },
    };
    return api;
  }

  // REGRESSÃO (bloqueador da revisão): o matcher de `aspx_missing_since` casava
  // QUALQUER 42703 e era o primeiro elo da cadeia. Em produção a coluna
  // `trip_acceptance_checked_at` ainda não existe (migration é manual, deploy é
  // automático no merge), então o 42703 DELA soltava o filtro do ASPX e ninguém o
  // religava: as 15 cargas marcadas "Fora do ASPX" voltariam ao Monitor em silêncio.
  it("42703 da coluna nova NÃO desliga o filtro aspx_missing_since (cada erro solta só a SUA coluna)", async () => {
    let served = false;
    const api = recordingClient((at) => {
      if (at.cols.includes("trip_acceptance_checked_at")) {
        return { data: null, error: { code: "42703", message: "column cargas.trip_acceptance_checked_at does not exist" } };
      }
      if (served) return { data: [], error: null };
      served = true;
      return { data: [{ id: "a", origem: "A", destino: "B", data: "2026-08-10", horario: "08:00:00", status: "OPEN", lh_manual: "LT-1" }], error: null };
    });

    const rows = await listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 3 });
    expect(rows.map((r) => r.cargoId)).toEqual(["a"]);

    const cargas = api._attempts.filter((a) => a.table === "cargas");
    // A query FINAL (a que passou) segue filtrando a viagem fora do ASPX...
    expect(cargas.at(-1).isCalls).toContainEqual(["aspx_missing_since", null]);
    // ...e TODAS as tentativas também: o fallback da coluna nova não encostou no filtro.
    for (const a of cargas) expect(a.isCalls).toContainEqual(["aspx_missing_since", null]);
  });

  // Último recurso: 42703 cuja mensagem não nomeia opcional nenhuma. Aí não dá para
  // atribuir, então degradamos UMA por vez, na ordem — sempre na direção de MOSTRAR
  // carga a mais. Se nem assim passar, o erro sobe (não engolimos falha real).
  it("42703 sem nome de coluna: degrada uma opcional por vez, do filtro do ASPX em diante", async () => {
    const api = recordingClient((at) =>
      at.isCalls.some(([c]) => c === "aspx_missing_since")
        ? { data: null, error: { code: "42703", message: "column does not exist" } }
        : { data: [], error: null },
    );
    const rows = await listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 2 });
    expect(rows).toEqual([]);
    const cargas = api._attempts.filter((a) => a.table === "cargas");
    // 1ª com o filtro (erro), 2ª sem ele (passou) — e o SELECT ficou intacto.
    expect(cargas[0].isCalls).toContainEqual(["aspx_missing_since", null]);
    expect(cargas[1].isCalls).not.toContainEqual(["aspx_missing_since", null]);
    expect(cargas[1].cols).toContain("trip_acceptance_checked_at");
  });

  it("42703 que nenhuma opcional explica sobe depois de esgotar as candidatas", async () => {
    const api = recordingClient(() => ({ data: null, error: { code: "42703", message: "column does not exist" } }));
    await expect(listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 2 })).rejects.toMatchObject({ code: "42703" });
    // 1 tentativa inicial + 4 opcionais desligadas uma a uma = 5, e para.
    expect(api._attempts.filter((a) => a.table === "cargas").length).toBe(5);
  });

  // O cenário do DEPLOY REAL, e o único que faltava: as DUAS opcionais de aceite
  // ausentes na mesma leitura. Produção hoje não tem `trip_acceptance_checked_at`
  // (20260806150000) e um banco um pouco mais atrasado também não tem
  // `trip_accepted_at` (20260805170000) — as duas caem, uma por tentativa, e nada
  // além delas pode cair junto (a cadeia de fallbacks já derrubou o filtro errado uma
  // vez; esta é a versão com duas quedas encadeadas).
  it("banco sem AS DUAS colunas de aceite: derruba só elas e a lançada inerte VOLTA visível", async () => {
    let served = false;
    const err = (col) => ({ data: null, error: { code: "42703", message: `column cargas.${col} does not exist` } });
    const api = recordingClient((at) => {
      // "trip_acceptance_checked_at" NÃO contém "trip_accepted_at": o prefixo comum
      // não confunde nem o fake nem o `blamedOptionalColumn`.
      if (at.cols.includes("trip_accepted_at")) return err("trip_accepted_at");
      if (at.cols.includes("trip_acceptance_checked_at")) return err("trip_acceptance_checked_at");
      if (served) return { data: [], error: null };
      served = true;
      // Fixture HOSTIL de propósito: lançada Shopee OPEN, inerte e com evidência
      // FRESCA de não-aceite. Com o filtro ligado ela sumiria — é ela que prova que
      // faltando as colunas o filtro fica desligado por INTEIRO.
      return {
        data: [{
          id: "a", origem: "A", destino: "B", data: "2026-08-10", horario: "08:00:00",
          status: "OPEN", lh_manual: "LT-1", cliente_id: "cli-shopee",
          trip_accepted_at: null, trip_acceptance_checked_at: horasAtras(1),
        }],
        error: null,
      };
    });

    const rows = await listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 3 });
    expect(rows.map((r) => r.cargoId)).toEqual(["a"]); // dado ausente não esconde linha

    const cargas = api._attempts.filter((a) => a.table === "cargas");
    const final = cargas.at(-1);
    // Só as duas NOMEADAS saíram do SELECT...
    expect(final.cols).not.toContain("trip_accepted_at");
    expect(final.cols).not.toContain("trip_acceptance_checked_at");
    // ...`agenda_a_confirmar` seguiu pedida (duas quedas não viram efeito dominó)...
    expect(final.cols).toContain("agenda_a_confirmar");
    // ...e o filtro do "fora do ASPX" continuou aplicado em TODAS as tentativas.
    for (const a of cargas) expect(a.isCalls).toContainEqual(["aspx_missing_since", null]);
  });

  // A degradação era 100% SILENCIOSA: um banco sem a migration ficava indistinguível
  // de um banco saudável, e o Monitor podia rodar semanas com o filtro de aceite
  // desligado sem ninguém notar. O aviso é o que transforma "some do log" em
  // "alguém roda o migrate".
  it("coluna faltando EMITE aviso: UMA vez na leitura inteira, com nome e efeito", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let pagina = 0;
      const api = recordingClient((at) => {
        if (at.cols.includes("trip_acceptance_checked_at")) {
          return { data: null, error: { code: "42703", message: "column cargas.trip_acceptance_checked_at does not exist" } };
        }
        pagina += 1;
        // Duas páginas cheias antes de esgotar: se o aviso saísse por página (e não
        // por leitura), viriam três — `optional` é compartilhado justamente p/ isso.
        return {
          data: pagina <= 2
            ? [{ id: `p${pagina}`, origem: "A", destino: "B", data: "2026-08-10", horario: "08:00:00" }]
            : [],
          error: null,
        };
      });

      const rows = await listSystemCargasForMonitor(api, { pageSize: 1, maxRows: 5 });
      expect(rows.map((r) => r.cargoId)).toEqual(["p1", "p2"]);
      expect(api._attempts.filter((a) => a.table === "cargas").length).toBe(4); // 1 falha + 3 páginas

      const avisos = warn.mock.calls.filter(([msg]) =>
        String(msg).includes("list-system-cargas-monitor.optional-column-missing"),
      );
      expect(avisos).toHaveLength(1);
      expect(avisos[0][1]).toMatchObject({ coluna: "trip_acceptance_checked_at", atribuicao: "nome" });
      // O efeito NA TELA vai no log — quem lê o alerta não deve precisar do código.
      expect(avisos[0][1].efeito).toContain("filtro de aceite desligado");
    } finally {
      warn.mockRestore();
    }
  });
});

// ── PORTÃO DO FRETE OFERTADO ────────────────────────────────────────────────────
//
// Norma do dono do produto: carga ofertada ao motorista NUNCA pode estar invisível ao
// operador. Em 30 dias este read model acumulou SEIS regras de ocultação e TRÊS
// precisaram de correção por esconderem demais; a última (#457) escondia 24 cargas
// ABERTAS no portal — 57% do frete ofertado. O portão inverte o ônus: em vez de cada
// filtro ter de lembrar de não esconder frete vivo, NENHUM consegue.
//
// Os testes abaixo usam o filtro de aceite como INSTRUMENTO — ele é só o filtro que
// existe hoje. O que está sendo travado é o portão, que vale para o sétimo filtro
// também.
describe("listSystemCargasForMonitor: portão do frete ofertado", () => {
  // O alarme só anuncia quando a assinatura do resgate MUDA (memória de processo). Sem
  // zerar entre casos, um teste herdaria o silêncio provocado pelo anterior e passaria
  // por engano.
  beforeEach(() => __resetDriverOfferGateAlarm());

  const CLIENTES = [{ id: "cli-shopee", nome: "E-COMMERCE" }];
  const AMANHA = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  function fakeClient(cargas) {
    const api = (table) => {
      const q = {
        _served: false,
        select: () => q, is: () => q, eq: () => q, neq: () => q, in: () => q, order: () => q,
        range: async () => {
          const first = !q._served;
          q._served = true;
          return { data: first ? cargas : [], error: null };
        },
        then: table === "clientes" ? (resolve) => resolve({ data: CLIENTES, error: null }) : undefined,
      };
      if (table === "load_public_leads") q.then = (resolve) => resolve({ data: [], error: null });
      return q;
    };
    return { from: (t) => api(t) };
  }

  /** Lançada Shopee inerte e com evidência fresca de não-aceite: o alvo exato do filtro
   *  de aceite. `data` decide se ela está OFERTADA (amanhã) ou já fora do portal (2020). */
  const lancadaInerte = (id, over = {}) => ({
    id, origem: "A", destino: "B", data: AMANHA, horario: "08:00:00",
    status: "OPEN", lh_manual: `LT-${id}`, alloc_motorista: null, sheet_motorista: null,
    alloc_status: null, sheet_status: null, viagem_id: null, driver_visibility: "PUBLIC",
    agenda_a_confirmar: false, trip_accepted_at: null,
    trip_acceptance_checked_at: horasAtras(1), sheet_source: null, cliente_id: "cli-shopee",
    ...over,
  });

  /** Lê o Monitor capturando os eventos do portão. Os eventos são extraídos ANTES do
   *  `mockRestore()` de propósito: restaurar o spy também LIMPA `mock.calls`, e um
   *  `expect(...).toHaveLength(0)` sobre a lista já zerada passaria sempre — teste que
   *  nunca falha é pior que teste nenhum. */
  async function ler(cargas) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rows = await listSystemCargasForMonitor(fakeClient(cargas), { pageSize: 50 });
      const eventos = warn.mock.calls
        .filter(([msg]) => String(msg).includes("list-system-cargas-monitor.driver-offer-gate-rescued"))
        .map(([, payload]) => payload);
      return { rows, eventos };
    } finally {
      warn.mockRestore();
    }
  }

  it("filtro de aceite tentando esconder carga OFERTADA: a linha FICA e o alarme sai", async () => {
    const { rows, eventos } = await ler([lancadaInerte("a")]);
    expect(rows.map((r) => r.cargoId)).toEqual(["a"]);

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ resgatadas: 1, escondidasPelosFiltros: 1, amostraLhs: ["LT-a"] });
    // Quem lê o alerta precisa do EFEITO, não do nome do filtro: resgate > 0 em regime
    // normal significa filtro errado, e é essa a frase que manda investigar.
    expect(eventos[0].efeito).toContain("portão a repôs");
  });

  it("carga INERTE (fora do portal) o filtro esconde normalmente, e sem alarme", async () => {
    // Mesma carga, carregamento vencido: o motorista já não a vê, então o portão não
    // tem nada a proteger e o filtro faz o trabalho dele.
    const { rows, eventos } = await ler([lancadaInerte("a", { data: "2020-01-01" })]);
    expect(rows).toEqual([]);
    expect(eventos).toHaveLength(0);
  });

  it("sem nenhum resgate, NENHUM log — o evento é alarme, não ruído de rotina", async () => {
    const { rows, eventos } = await ler([
      lancadaInerte("nao-lancada", { lh_manual: null }),          // nem candidata
      lancadaInerte("vencida", { data: "2020-01-01" }),           // escondida com razão
    ]);
    expect(rows.map((r) => r.cargoId)).toEqual(["nao-lancada"]);
    expect(eventos).toHaveLength(0);
  });

  it("o portão não duplica linha nem altera a ordem da leitura", async () => {
    const entrada = [
      lancadaInerte("intocada", { lh_manual: null }),   // nenhum filtro encosta
      lancadaInerte("resgatada"),                       // filtro tenta esconder, portão repõe
      lancadaInerte("vencida", { data: "2020-01-01" }), // some de verdade
      lancadaInerte("intocada-2", { alloc_motorista: "ANA" }),
    ];
    const { rows } = await ler(entrada);
    const ids = rows.map((r) => r.cargoId);
    // Ordem da QUERY preservada — a resgatada volta ao LUGAR dela, não ao fim da lista
    // (o Monitor ordena por data desc na query; concatenar os resgatados no fim
    // embaralharia a tela sem ninguém perceber).
    expect(ids).toEqual(["intocada", "resgatada", "intocada-2"]);
    // Nada aparece duas vezes.
    expect(new Set(ids).size).toBe(ids.length);
    // O portão opera sobre o que a QUERY trouxe: ele protege contra filtro em JS, não
    // contra filtro em SQL — nenhuma linha nova é inventada.
    expect(ids.every((id) => entrada.some((c) => c.id === id))).toBe(true);
  });

  it("resgate em massa: o log é UM por leitura, com a contagem cheia e amostra de até 10 LHs", async () => {
    const { rows, eventos } = await ler(Array.from({ length: 12 }, (_, i) => lancadaInerte(`m${i}`)));
    expect(rows).toHaveLength(12);
    expect(eventos).toHaveLength(1); // agregado, não uma linha de log por carga
    expect(eventos[0].resgatadas).toBe(12);
    expect(eventos[0].amostraLhs).toHaveLength(10);
    expect(eventos[0].amostraLhs[0]).toBe("LT-m0");
  });

  // O portão não depende do filtro de aceite estar ligado nem de conhecer os filtros que
  // virão: ele compara o que a query trouxe com o que sobrou. Com o filtro desligado
  // nada é escondido, então o portão não tem trabalho e o log fica quieto.
  it("com o filtro desligado (kill-switch) o portão fica inerte, sem resgate e sem log", async () => {
    const prev = process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED;
    process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED = "false";
    try {
      const { rows, eventos } = await ler([lancadaInerte("a"), lancadaInerte("b", { data: "2020-01-01" })]);
      expect(rows.map((r) => r.cargoId)).toEqual(["a", "b"]);
      expect(eventos).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED;
      else process.env.MONITOR_HIDE_UNACCEPTED_LAUNCHED = prev;
    }
  });

  // O alarme só vale se for LIDO. O Monitor refaz fetch a cada 30s por operador, e o
  // resgate é um estado ESTÁVEL enquanto o filtro errado não for consertado (medido: 27
  // linhas resgatadas assim que a migration do aceite entrar). Sem esta trava seriam
  // ~8.600 eventos idênticos por dia, e em duas semanas ninguém leria mais nenhum `warn`
  // deste read model — inclusive os de `optional-column-missing`, que são acionáveis.
  it("o alarme fala UMA vez por estado: leitura repetida não repete o evento", async () => {
    const cargas = [lancadaInerte("a"), lancadaInerte("b")];
    expect((await ler(cargas)).eventos).toHaveLength(1);
    expect((await ler(cargas)).eventos).toHaveLength(0); // mesmo conjunto → silêncio
    expect((await ler(cargas)).eventos).toHaveLength(0);
  });

  it("o alarme volta a falar quando o CONJUNTO resgatado muda", async () => {
    expect((await ler([lancadaInerte("a")])).eventos).toHaveLength(1);
    // Entrou uma carga nova no resgate → assinatura diferente → anuncia de novo.
    const { eventos } = await ler([lancadaInerte("a"), lancadaInerte("b")]);
    expect(eventos).toHaveLength(1);
    expect(eventos[0].resgatadas).toBe(2);
  });

  it("voltando a zero resgates, o próximo resgate é anunciado (a trava não vira mordaça)", async () => {
    expect((await ler([lancadaInerte("a")])).eventos).toHaveLength(1);
    expect((await ler([lancadaInerte("vencida", { data: "2020-01-01" })])).eventos).toHaveLength(0);
    // Mesmo conjunto de antes: como houve um ciclo limpo no meio, o estado é NOVO.
    expect((await ler([lancadaInerte("a")])).eventos).toHaveLength(1);
  });

  // NOTA sobre `amostraCargoId` (carga resgatada sem `lh_manual`): não há teste de
  // integração porque o caminho é INALCANÇÁVEL hoje — o único filtro que esconde exige
  // `lh_manual` preenchido, então uma carga sem LH nunca chega a ser resgatada. O campo
  // existe para o próximo filtro, e o que ele precisa garantir (o uuid sobreviver ao
  // sanitizador de log) é propriedade do sanitizador, coberta em security-log.
  // Escrever aqui um teste que força o cenário exigiria burlar o filtro e mediria o
  // mock, não o comportamento.
});
