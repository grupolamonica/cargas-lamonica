import { afterEach, describe, expect, it, vi } from "vitest";

import { getProgramacao } from "./get-programacao.js";
import { SpxSidecarUnavailable } from "../../../infrastructure/spx/spx-allocation-client.js";

// epochs deterministicos (Brasil = UTC-3, sem horario de verao)
const CARREG_TS = Math.floor(Date.UTC(2026, 6, 20, 15, 0) / 1000); // 2026-07-20 12:00 BRT
const DESCARGA_TS = Math.floor(Date.UTC(2026, 6, 21, 18, 30) / 1000); // 2026-07-21 15:30 BRT

// Viagem crua no shape do sidecar (_norm_trip)
function trip(trip_number, { status = "Assigning", acceptance = 0, driver = "", origem = "LM Hub_CE_Juazeiro do Norte", destino = "SoC_CE_Itaitinga", carregamentoTs = CARREG_TS } = {}) {
  return {
    trip_number,
    trip_name: `${origem}-${destino}`,
    trip_status_name: status,
    acceptance_status: acceptance,
    driver_name: driver,
    vehicle_type: "CARRETA",
    cavalo: driver ? "ABC1D23" : "",
    carreta: "",
    origem,
    destino,
    carregamento_ts: carregamentoTs,
    descarga_ts: DESCARGA_TS,
  };
}

function makeTripsFn(byQueryType) {
  return vi.fn(async (queryType) => {
    const entry = byQueryType[queryType];
    if (entry instanceof Error) throw entry;
    return { trips: entry ?? [], truncated: false, total: (entry ?? []).length };
  });
}

// "Agora" fixo p/ o cálculo de `expirada` (evita depender do relógio real). O
// carregamento dos trips de teste é 2026-07-20 → futuro vs este nowMs → não filtra.
const baseDeps = {
  listLaunchedLhs: async () => new Set(),
  // Fonte Nestlé é injetável (como fetchTripsByTab); vazia por padrão nos testes SPX.
  fetchNestleOfertas: async () => [],
  today: "2026-07-01",
  nowTime: "00:00:00",
  nowMs: Date.UTC(2026, 6, 1),
};

afterEach(() => {
  delete process.env.SPX_ACCEPT_WRITE_ENABLED;
  vi.restoreAllMocks();
});

describe("getProgramacao (consulta direta ao SPX via sidecar)", () => {
  it("agrupa por tab; podeAceitar só quando acceptance_status=0 e LT (Planejado)", async () => {
    const fetchTripsByTab = makeTripsFn({
      1: [
        trip("LT1", { acceptance: 0 }), // não aceita → podeAceitar
        trip("LT2", { acceptance: 1 }), // já aceita, sem motorista → aguardandoMotorista
        trip("LT3", { acceptance: 1, status: "Assigned", driver: "JOAO SILVA" }), // já com motorista
        trip("XX9", { acceptance: 0 }), // não-LT → não pode aceitar
      ],
      2: [trip("LT4", { status: "Departed", acceptance: 1, driver: "MARIA" })],
      3: [trip("LT5", { status: "Completed", acceptance: 1, driver: "PEDRO" })],
    });

    const res = await getProgramacao({ deps: { ...baseDeps, fetchTripsByTab } });

    expect(res.statusCode).toBe(200);
    expect(res.payload.source).toBe("spx-direct");
    expect(res.payload.byTab).toEqual({ planejado: 4, aceito: 1, concluido: 1 });
    expect(res.payload.summary.podeAceitar).toBe(1);
    expect(res.payload.summary.aguardandoMotorista).toBe(1);

    const lt1 = res.payload.rows.find((r) => r.lh === "LT1");
    expect(lt1.podeAceitar).toBe(true);
    expect(lt1.aguardandoMotorista).toBe(false);
    expect(lt1.acceptanceStatus).toBe(0);
    expect(lt1.statusOperacional).toBe("AGUARDANDO CHEGAR NO CLIENTE");
    expect(lt1.origem).toBe("Juazeiro do Norte/CE · LM Hub");
    expect(lt1.origemCidadeUf).toBe("Juazeiro do Norte/CE");
    expect(lt1.data).toBe("2026-07-20");
    expect(lt1.horario).toBe("12:00");
    expect(lt1.dataDescarga).toBe("2026-07-21");
    expect(lt1.horarioDescarga).toBe("15:30");

    expect(res.payload.rows.find((r) => r.lh === "LT2").aguardandoMotorista).toBe(true);
    expect(res.payload.rows.find((r) => r.lh === "LT2").podeAceitar).toBe(false);
    expect(res.payload.rows.find((r) => r.lh === "XX9").podeAceitar).toBe(false);
    expect(res.payload.rows.find((r) => r.lh === "LT4").tab).toBe("aceito");
    // podeLancar (SPX/Shopee): só a aba Planejado; a aba Aceito nunca lança pela tela.
    expect(lt1.podeLancar).toBe(true);
    expect(res.payload.rows.find((r) => r.lh === "LT4").podeLancar).toBe(false);
  });

  it("remove do Planejado viagens ATRASADAS (carregamento anterior ao instante atual, nível minuto)", async () => {
    const nowMs = Date.UTC(2026, 6, 10, 12, 0); // 2026-07-10 12:00 UTC
    const past = Math.floor(Date.UTC(2026, 6, 10, 9, 0) / 1000); // 3h ANTES de agora → atrasada
    const future = Math.floor(Date.UTC(2026, 6, 10, 18, 0) / 1000); // 6h DEPOIS → futura
    const fetchTripsByTab = makeTripsFn({
      1: [trip("LT-PAST", { carregamentoTs: past }), trip("LT-FUT", { carregamentoTs: future })],
    });
    const res = await getProgramacao({ deps: { ...baseDeps, nowMs, fetchTripsByTab } });
    const lhs = res.payload.rows.map((r) => r.lh);
    expect(lhs).toContain("LT-FUT");
    expect(lhs).not.toContain("LT-PAST");
    expect(res.payload.byTab.planejado).toBe(1);
    // o epoch do carregamento é exposto p/ o front reavaliar com o relógio corrente
    expect(res.payload.rows.find((r) => r.lh === "LT-FUT").carregamentoTs).toBe(future);
  });

  it("marca jaLancada pelos LHs já existentes como carga", async () => {
    const fetchTripsByTab = makeTripsFn({ 1: [trip("LT1"), trip("LT2")] });
    const res = await getProgramacao({
      deps: { ...baseDeps, fetchTripsByTab, listLaunchedLhs: async () => new Set(["LT2"]) },
    });
    expect(res.payload.rows.find((r) => r.lh === "LT2").jaLancada).toBe(true);
    expect(res.payload.rows.find((r) => r.lh === "LT1").jaLancada).toBe(false);
    expect(res.payload.summary.jaLancadas).toBe(1);
  });

  it("um tab falho → warning, os outros aparecem", async () => {
    const fetchTripsByTab = makeTripsFn({ 1: new Error("boom"), 2: [trip("LT4", { status: "Departed" })], 3: [] });
    const res = await getProgramacao({ deps: { ...baseDeps, fetchTripsByTab } });
    expect(res.statusCode).toBe(200);
    expect(res.payload.warnings).toContain("tab_planejado_unavailable");
    expect(res.payload.byTab.aceito).toBe(1);
  });

  it("todos os tabs falham (sidecar fora do ar) → 503", async () => {
    const err = new SpxSidecarUnavailable("down");
    const fetchTripsByTab = makeTripsFn({ 1: err, 2: err, 3: err });
    const res = await getProgramacao({ deps: { ...baseDeps, fetchTripsByTab } });
    expect(res.statusCode).toBe(503);
    expect(res.payload.error).toBe("SPX_UNAVAILABLE");
  });

  it("reflete o kill-switch de aceite no payload", async () => {
    process.env.SPX_ACCEPT_WRITE_ENABLED = "true";
    const fetchTripsByTab = makeTripsFn({ 1: [] });
    const res = await getProgramacao({ deps: { ...baseDeps, fetchTripsByTab } });
    expect(res.payload.acceptWriteEnabled).toBe(true);
  });

  it("funde a fonte Nestlé (nestle_ofertas): cliente Nestle, sem aceite, lançável, aba por status", async () => {
    const fetchTripsByTab = makeTripsFn({ 1: [trip("LT1", { acceptance: 0 })] });
    const fetchNestleOfertas = async () => [
      {
        codprogcoleta: "NST-1", codembarque: "2328110", grupos_id: "B101462715", descrstatprogcoleta: "PENDENTE",
        emporig_nomecid: "Caçapava", emporig_uf: "SP", empdest_nomecid: "Jundiaí", empdest_uf: "SP",
        tpveic_nome: "CARRETA", tipo: "CONTRATO",
        dtahrprevatual: "2026-07-20T08:00:00", dtahrpreventrega: "2026-07-21T10:00:00",
      },
      {
        codprogcoleta: "NST-2", grupos_id: "B101462999", descrstatprogcoleta: "CANCELADO",
        emporig_nomecid: "Montes Claros", emporig_uf: "MG", empdest_nomecid: "Contagem", empdest_uf: "MG",
        dtahrprevatual: "2026-07-22T09:00:00",
      },
      {
        // Aceita + embarque FINALIZADO (join): status/motorista reais → aba concluído.
        codprogcoleta: "NST-3", grupos_id: "B101463111", codembarque: "2328110",
        descrstatprogcoleta: "EMBARQUE EMITIDO",
        emporig_nomecid: "Feira de Santana", emporig_uf: "BA", empdest_nomecid: "Simoes Filho", empdest_uf: "BA",
        dtahrprevatual: "2026-07-18T06:00:00",
        emb_status: "FINALIZADO", emb_motorista: "MAXWELL GOMES DOURADO", emb_placa: "NWC3B78",
      },
    ];
    const res = await getProgramacao({ deps: { ...baseDeps, fetchTripsByTab, fetchNestleOfertas } });

    expect(res.statusCode).toBe(200);
    // Shopee e Nestlé convivem na mesma tela.
    expect(res.payload.rows.some((r) => r.lh === "LT1" && r.cliente === "Shopee")).toBe(true);
    // Código de viagem da Nestlé = grupos_id (B101…), tem prioridade sobre codembarque.
    const nst = res.payload.rows.find((r) => r.lh === "B101462715");
    expect(nst).toBeTruthy();
    expect(nst.cliente).toBe("Nestle");
    expect(nst.source).toBe("nestle-galileu");
    expect(nst.podeAceitar).toBe(false); // aceite Nestlé fica no Galileu
    expect(nst.isLinehaul).toBe(true); // lançável
    expect(nst.tab).toBe("planejado");
    expect(nst.podeLancar).toBe(true); // planejado (pendente) → lançável
    expect(nst.origemCidadeUf).toBe("Caçapava/SP");
    expect(nst.destinoCidadeUf).toBe("Jundiaí/SP");
    expect(nst.data).toBe("2026-07-20");
    expect(nst.horario).toBe("08:00");
    expect(nst.tipo).toBe("CONTRATO");
    // status final (CANCELADO) → aba concluído.
    expect(res.payload.rows.find((r) => r.lh === "B101462999").tab).toBe("concluido");
    // Embarque FINALIZADO (join) sobrepõe a oferta: aba concluído + motorista/placa reais.
    const fin = res.payload.rows.find((r) => r.lh === "B101463111");
    expect(fin.tab).toBe("concluido");
    expect(fin.statusOperacional).toBe("FINALIZADO");
    expect(fin.motorista).toBe("MAXWELL GOMES DOURADO");
    expect(fin.placa).toBe("NWC3B78");
    // cliente Nestle exposto no array clientes.
    expect(res.payload.clientes.some((c) => c.nome === "Nestle")).toBe(true);
  });

  it("Nestlé ACEITA sem motorista é lançável (podeLancar); com motorista não", async () => {
    const fetchTripsByTab = makeTripsFn({ 1: [], 2: [], 3: [] });
    const fetchNestleOfertas = async () => [
      {
        // ACEITA no Galileu, ainda SEM embarque/motorista → aba "aceito", lançável.
        codprogcoleta: "NST-ACC", grupos_id: "B900000001", descrstatprogcoleta: "ACEITA",
        emporig_nomecid: "Caçapava", emporig_uf: "SP", empdest_nomecid: "Jundiaí", empdest_uf: "SP",
        dtahrprevatual: "2026-07-20T08:00:00", dtahrpreventrega: "2026-07-21T10:00:00",
      },
      {
        // Aceita e JÁ com embarque em progresso + motorista (join) → aba "aceito", NÃO lançável.
        codprogcoleta: "NST-DRV", grupos_id: "B900000002", codembarque: "9000002",
        descrstatprogcoleta: "EMBARQUE EMITIDO",
        emporig_nomecid: "Betim", emporig_uf: "MG", empdest_nomecid: "Contagem", empdest_uf: "MG",
        dtahrprevatual: "2026-07-20T09:00:00",
        emb_status: "EM VIAGEM", emb_motorista: "CARLOS SOUZA", emb_placa: "ABC1D23",
      },
      {
        // Aceita mas com embarque MORTO (CANCELADO) e sem motorista → aba "aceito",
        // NÃO lançável (não republica viagem morta). Guarda do achado MEDIUM da revisão.
        codprogcoleta: "NST-DEAD", grupos_id: "B900000003", codembarque: "9000003",
        descrstatprogcoleta: "EMBARQUE EMITIDO",
        emporig_nomecid: "Betim", emporig_uf: "MG", empdest_nomecid: "Contagem", empdest_uf: "MG",
        dtahrprevatual: "2026-07-20T09:00:00",
        emb_status: "CANCELADO", emb_motorista: "",
      },
      {
        // Status de oferta desconhecido/malformado, sem embarque nem motorista → cai na
        // aba "aceito" (fail-open do nestleTab) mas NÃO é lançável. Guarda do achado LOW.
        codprogcoleta: "NST-UNK", grupos_id: "B900000004", descrstatprogcoleta: "AGUARDANDO SEI LA",
        emporig_nomecid: "Betim", emporig_uf: "MG", empdest_nomecid: "Contagem", empdest_uf: "MG",
        dtahrprevatual: "2026-07-20T09:00:00",
      },
    ];
    const res = await getProgramacao({ deps: { ...baseDeps, fetchTripsByTab, fetchNestleOfertas } });

    const acc = res.payload.rows.find((r) => r.lh === "B900000001");
    expect(acc.tab).toBe("aceito");
    expect(acc.motorista).toBe("");
    expect(acc.podeLancar).toBe(true);

    const drv = res.payload.rows.find((r) => r.lh === "B900000002");
    expect(drv.tab).toBe("aceito");
    expect(drv.motorista).toBe("CARLOS SOUZA");
    expect(drv.podeLancar).toBe(false);

    // Embarque morto e status desconhecido: aba "aceito" mas NÃO lançáveis.
    const dead = res.payload.rows.find((r) => r.lh === "B900000003");
    expect(dead.tab).toBe("aceito");
    expect(dead.motorista).toBe("");
    expect(dead.podeLancar).toBe(false);

    const unk = res.payload.rows.find((r) => r.lh === "B900000004");
    expect(unk.tab).toBe("aceito");
    expect(unk.podeLancar).toBe(false);
  });
});
