import { describe, expect, it } from "vitest";
import { mapSystemCargoToMonitorRow, listSystemCargasForMonitor } from "./list-system-cargas-monitor.js";
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
