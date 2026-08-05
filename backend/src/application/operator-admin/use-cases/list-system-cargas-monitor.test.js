import { describe, expect, it } from "vitest";
import {
  mapSystemCargoToMonitorRow,
  listSystemCargasForMonitor,
  isUnacceptedLaunchedShopeeCargo,
  resolveNestleClientIds,
  isHideUnacceptedLaunchedEnabled,
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
describe("isUnacceptedLaunchedShopeeCargo (guardas do filtro)", () => {
  // Base = exatamente o caso que deve sumir: lançada, Shopee, OPEN, inerte.
  const inerte = (over = {}) => ({
    id: "c1", lh_manual: "LT-1", status: "OPEN",
    alloc_motorista: null, alloc_status: null, sheet_status: null,
    trip_accepted_at: null, sheet_source: null, cliente_id: "cli-shopee", ...over,
  });
  const nestleIds = new Set(["cli-nestle"]);
  const hide = (c, ctx = {}) => isUnacceptedLaunchedShopeeCargo(c, { nestleClientIds: nestleIds, ...ctx });

  it("esconde a lançada da Shopee sem nenhum sinal de vida", () => {
    expect(hide(inerte())).toBe(true);
  });

  it("carga SEM lh_manual não é lançada — nunca entra no filtro", () => {
    expect(hide(inerte({ lh_manual: null }))).toBe(false);
    expect(hide(inerte({ lh_manual: "   " }))).toBe(false);
  });

  it("viagem ACEITA fica, mesmo sem motorista (frete comprometido com a agência)", () => {
    expect(hide(inerte({ trip_accepted_at: "2026-08-05T12:00:00Z" }))).toBe(false);
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

  const carga = (over = {}) => ({
    id: "x", origem: "A", destino: "B", data: "2026-08-10", horario: "08:00:00",
    status: "OPEN", lh_manual: null, alloc_motorista: null, alloc_status: null,
    sheet_status: null, trip_accepted_at: null, sheet_source: null, cliente_id: "cli-shopee", ...over,
  });

  const ids = (rows) => rows.map((r) => r.cargoId);

  it("some a lançada Shopee inerte; ficam a aceita, a com motorista e a Nestlé", async () => {
    const client = fakeClient([
      carga({ id: "some", lh_manual: "LT-1" }),
      carga({ id: "aceita", lh_manual: "LT-2", trip_accepted_at: "2026-08-05T10:00:00Z" }),
      carga({ id: "com-motorista", lh_manual: "LT-3", alloc_motorista: "ANA" }),
      carga({ id: "nestle", lh_manual: "B1-9", cliente_id: "cli-nestle" }),
      carga({ id: "manual", lh_manual: null }), // carga do operador, sem LH: intocada
    ]);
    const rows = await listSystemCargasForMonitor(client, { pageSize: 50 });
    expect(ids(rows)).toEqual(["aceita", "com-motorista", "nestle", "manual"]);
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
});
