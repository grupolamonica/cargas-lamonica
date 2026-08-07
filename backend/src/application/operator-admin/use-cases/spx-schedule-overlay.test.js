import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSpxScheduleSidecarCache,
  applySpxSchedule,
  epochToSchedule,
  fetchSpxScheduleIndex,
  fetchSpxScheduleIndexFromSidecar,
  mergeLiveIndexes,
  peekSpxScheduleIndexFromTorre,
  __resetSpxScheduleTorreCache,
} from "./spx-schedule-overlay.js";
import { SpxAspNotConfigured, SpxAspUnavailable } from "../../../infrastructure/torre/torre-spx-trips-client.js";

// Linha da Torre asp (chaves humanas, como o payload real).
function aspRow(lh, o = {}) {
  return {
    "LH Trip Number": lh,
    "ETA ORIGEM PROGRAMADO": o.origProg ?? "",
    "ETA ORIGEM REAL": o.origReal ?? "",
    "ETA DESTINO PROGRAMADO": o.destProg ?? "",
    "ETA DESTINO REAL": o.destReal ?? "",
  };
}
const makeFetch = (rows) => vi.fn(async () => ({ ok: true, rows }));

describe("fetchSpxScheduleIndex (Torre asp → carga/descarga por LH)", () => {
  it("indexa ETA ORIGEM (carga) e ETA DESTINO (descarga) e converte o formato", async () => {
    const fetchSpx = makeFetch([
      aspRow("LT0Q7L02BUPP1", { origProg: "21/07/2026 18:00", destProg: "26/07/2026 08:00" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    const s = idx.get("LT0Q7L02BUPP1");
    expect(s.carga).toEqual({ label: "21/07/2026 18:00", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" });
    expect(s.descarga).toEqual({ label: "26/07/2026 08:00", dateIso: "2026-07-26", timeIso: "08:00", at: "2026-07-26T08:00" });
  });

  it("usa PROGRAMADO (== planilha) mesmo quando há REAL", async () => {
    const fetchSpx = makeFetch([
      aspRow("LT1", { origProg: "21/07/2026 18:00", origReal: "21/07/2026 19:30", destProg: "26/07/2026 08:00", destReal: "26/07/2026 07:10" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    expect(idx.get("LT1").carga.label).toBe("21/07/2026 18:00");
    expect(idx.get("LT1").descarga.label).toBe("26/07/2026 08:00");
  });

  it("cai para REAL quando PROGRAMADO vem vazio (fallback)", async () => {
    const fetchSpx = makeFetch([
      aspRow("LT2", { origProg: "", origReal: "21/07/2026 19:30", destProg: "", destReal: "26/07/2026 07:10" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    expect(idx.get("LT2").carga.label).toBe("21/07/2026 19:30");
    expect(idx.get("LT2").descarga.label).toBe("26/07/2026 07:10");
  });

  it("ignora linha sem LH e linha sem nenhuma data", async () => {
    const fetchSpx = makeFetch([
      aspRow("", { origProg: "21/07/2026 18:00" }),
      aspRow("LT-VAZIO", {}),
      aspRow("LT-OK", { origProg: "21/07/2026 18:00" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    expect(idx.has("LT-VAZIO")).toBe(false);
    expect(idx.size).toBe(1);
    expect(idx.get("LT-OK").carga.label).toBe("21/07/2026 18:00");
    expect(idx.get("LT-OK").descarga).toBeNull();
  });

  it("sem chave configurada → null (silencioso)", async () => {
    const fetchSpx = vi.fn(async () => { throw new SpxAspNotConfigured(); });
    expect(await fetchSpxScheduleIndex({ deps: { fetchSpx } })).toBeNull();
  });

  it("Torre indisponível → null (best-effort, não quebra)", async () => {
    const fetchSpx = vi.fn(async () => { throw new SpxAspUnavailable(); });
    expect(await fetchSpxScheduleIndex({ deps: { fetchSpx } })).toBeNull();
  });

  it("Torre UP-porém-LENTA → estoura o orçamento de tempo e degrada p/ null (não trava)", async () => {
    // fetch que nunca resolve (Torre lenta); o teto de tempo (timeoutMs) vence.
    const fetchSpx = vi.fn(() => new Promise(() => {}));
    const idx = await fetchSpxScheduleIndex({ timeoutMs: 20, deps: { fetchSpx } });
    expect(idx).toBeNull();
    expect(fetchSpx).toHaveBeenCalledTimes(1);
  });
});

describe("applySpxSchedule (sobrepõe agenda por LH)", () => {
  const sheetRow = () => ({
    lh: "LT0Q7L02BUPP1",
    carregamentoLabel: "21/07/2026 16:00",
    descargaLabel: "25/07/2026 06:00",
    data: "2026-07-21",
    horario: "16:00:00",
    motoristas: "JOAO",
    status: "AGUARDANDO CARREGAMENTO",
  });

  it("sobrepõe carga+descarga (label/data/horario/cargaAt/descargaAt) quando o LH casa", () => {
    const idx = new Map([["LT0Q7L02BUPP1", {
      carga: { label: "21/07/2026 18:00", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" },
      descarga: { label: "26/07/2026 08:00", dateIso: "2026-07-26", timeIso: "08:00", at: "2026-07-26T08:00" },
    }]]);
    const out = applySpxSchedule(sheetRow(), { spxScheduleByLh: idx });
    expect(out.carregamentoLabel).toBe("21/07/2026 18:00");
    expect(out.data).toBe("2026-07-21");
    expect(out.horario).toBe("18:00");
    expect(out.cargaAt).toBe("2026-07-21T18:00");
    expect(out.descargaLabel).toBe("26/07/2026 08:00");
    expect(out.descargaAt).toBe("2026-07-26T08:00");
    // Não toca motorista/status.
    expect(out.motoristas).toBe("JOAO");
    expect(out.status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("só carga presente → não zera descarga da planilha", () => {
    const idx = new Map([["LT0Q7L02BUPP1", {
      carga: { label: "21/07/2026 18:00", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" },
      descarga: null,
    }]]);
    const out = applySpxSchedule(sheetRow(), { spxScheduleByLh: idx });
    expect(out.carregamentoLabel).toBe("21/07/2026 18:00");
    expect(out.descargaLabel).toBe("25/07/2026 06:00"); // preservada
  });

  it("sem índice ou sem match → linha inalterada", () => {
    const row = sheetRow();
    expect(applySpxSchedule(row, { spxScheduleByLh: null })).toBe(row);
    expect(applySpxSchedule(row, { spxScheduleByLh: new Map() })).toBe(row);
    expect(applySpxSchedule(row, { spxScheduleByLh: new Map([["OUTRO", { carga: null, descarga: null }]]) })).toBe(row);
  });

  it("linha Nestlé/sistema (LH que não casa) fica intacta", () => {
    const nestle = { lh: "B101462715", carregamentoLabel: "20/07/2026 08:00", descargaLabel: "21/07/2026 10:00" };
    const idx = new Map([["LT-XYZ", { carga: { label: "x", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" }, descarga: null }]]);
    const out = applySpxSchedule(nestle, { spxScheduleByLh: idx });
    expect(out.carregamentoLabel).toBe("20/07/2026 08:00");
  });
});

// ── Fonte PRIMÁRIA: sidecar SPX ─────────────────────────────────────────────────
// 1785855600 = 2026-08-04 12:00 BRT; 1785920400 = 2026-08-05 06:00 BRT.
const tripRow = (lh, o = {}) => ({
  trip_number: lh,
  carregamento_ts: o.carregamento ?? 0,
  descarga_ts: o.descarga ?? 0,
  std: o.std ?? 0,
});

describe("epochToSchedule (epoch → agenda BRT)", () => {
  it("converte para o MESMO shape que a Torre produz", () => {
    expect(epochToSchedule(1785855600)).toEqual({
      label: "04/08/2026 12:00",
      dateIso: "2026-08-04",
      timeIso: "12:00",
      at: "2026-08-04T12:00",
    });
  });

  it("0/ausente/inválido → null (0 é 'sem data' no payload SPX)", () => {
    expect(epochToSchedule(0)).toBeNull();
    expect(epochToSchedule(null)).toBeNull();
    expect(epochToSchedule("abc")).toBeNull();
  });
});

describe("fetchSpxScheduleIndexFromSidecar", () => {
  beforeEach(() => {
    __resetSpxScheduleSidecarCache();
    process.env.SPX_MONITOR_STATUS_CACHE_SECONDS = "0"; // sem memo entre casos
  });

  it("indexa carregamento (STA origem) e descarga do payload do sidecar", async () => {
    const fetchSpxTripsByTab = vi.fn(async (qt) => ({
      trips: qt === 1 ? [tripRow("LT0Q8602CPLC1", { carregamento: 1786050000, descarga: 1786114800 })] : [],
    }));
    const idx = await fetchSpxScheduleIndexFromSidecar({ deps: { fetchSpxTripsByTab } });
    expect(idx.get("LT0Q8602CPLC1").carga.at).toBe("2026-08-06T18:00");
    expect(idx.get("LT0Q8602CPLC1").descarga.at).toBe("2026-08-07T12:00");
  });

  it("usa as MESMAS abas/janelas do índice de status (fetch compartilhado)", async () => {
    const fetchSpxTripsByTab = vi.fn(async () => ({ trips: [] }));
    await fetchSpxScheduleIndexFromSidecar({ deps: { fetchSpxTripsByTab } });
    expect(fetchSpxTripsByTab).toHaveBeenCalledTimes(2);
    expect(fetchSpxTripsByTab.mock.calls[0][0]).toBe(1);
    expect(fetchSpxTripsByTab.mock.calls[0][1]).toMatchObject({ daysBack: 45, daysForward: 30 });
    expect(fetchSpxTripsByTab.mock.calls[1][0]).toBe(2);
  });

  it("cai para std quando carregamento_ts vem 0", async () => {
    const fetchSpxTripsByTab = vi.fn(async (qt) => ({
      trips: qt === 1 ? [tripRow("LT9", { carregamento: 0, std: 1785855600 })] : [],
    }));
    const idx = await fetchSpxScheduleIndexFromSidecar({ deps: { fetchSpxTripsByTab } });
    expect(idx.get("LT9").carga.at).toBe("2026-08-04T12:00");
  });

  it("uma aba fora do ar não derruba a outra", async () => {
    const fetchSpxTripsByTab = vi.fn(async (qt) => {
      if (qt === 1) throw new Error("planejado fora");
      return { trips: [tripRow("LT_ACEITO", { carregamento: 1785855600 })] };
    });
    const idx = await fetchSpxScheduleIndexFromSidecar({ deps: { fetchSpxTripsByTab } });
    expect(idx.get("LT_ACEITO").carga.at).toBe("2026-08-04T12:00");
  });

  it("todas as abas fora do ar → null (Monitor segue sem overlay)", async () => {
    const fetchSpxTripsByTab = vi.fn(async () => {
      throw new Error("sidecar fora");
    });
    expect(await fetchSpxScheduleIndexFromSidecar({ deps: { fetchSpxTripsByTab } })).toBeNull();
  });
});

describe("mergeLiveIndexes", () => {
  it("o PRIMEIRO índice vence (sidecar antes da Torre)", () => {
    const sidecar = new Map([["LT1", { carga: { at: "2026-08-06T18:00" }, descarga: null }]]);
    const torre = new Map([
      ["LT1", { carga: { at: "1999-01-01T00:00" }, descarga: null }],
      ["LT2", { carga: { at: "2026-08-07T00:00" }, descarga: null }],
    ]);
    const out = mergeLiveIndexes(sidecar, torre);
    expect(out.get("LT1").carga.at).toBe("2026-08-06T18:00");
    // A Torre ainda cobre o que o sidecar não viu (viagens fora de Planejado/Aceito).
    expect(out.get("LT2").carga.at).toBe("2026-08-07T00:00");
  });

  it("ignora índices null/vazios; nada casando → null", () => {
    expect(mergeLiveIndexes(null, new Map())).toBeNull();
    expect(mergeLiveIndexes(null, new Map([["LT1", { carga: null, descarga: null }]])).size).toBe(1);
  });
});

// A Torre é FALLBACK e não pode custar latência no caminho quente do Monitor.
//
// Medido em produção 07/08/2026: `spx-schedule-timeout:4000ms` 43x em 6 h, ZERO
// sucessos — a Torre respondeu em 10.268 ms numa chamada direta, ou seja, é lenta e
// nunca cabia no orçamento de 4 s. Como as duas fontes eram aguardadas juntas, a tela
// pagava 4 s por carga para receber nada.
describe("peekSpxScheduleIndexFromTorre — fallback que NÃO bloqueia a leitura", () => {
  beforeEach(() => {
    __resetSpxScheduleTorreCache();
  });

  it("cache FRIO → devolve null na hora, sem esperar a Torre", () => {
    // Fetch que nunca resolve: se a função esperasse, o teste travaria.
    const fetchIndex = vi.fn(() => new Promise(() => {}));
    const out = peekSpxScheduleIndexFromTorre({ deps: { fetchIndex } });
    expect(out).toBeNull();
    expect(fetchIndex).toHaveBeenCalledTimes(1); // aqueceu em background
  });

  it("depois do aquecimento, devolve o índice sem tocar a rede de novo", async () => {
    const mapa = new Map([["LT9", { carga: { at: "2026-08-09T07:00" }, descarga: null }]]);
    let resolver;
    const fetchIndex = vi.fn(() => new Promise((r) => { resolver = r; }));

    expect(peekSpxScheduleIndexFromTorre({ deps: { fetchIndex } })).toBeNull();
    resolver(mapa);
    await new Promise((r) => setTimeout(r, 0)); // deixa o .then gravar o cache

    expect(peekSpxScheduleIndexFromTorre({ deps: { fetchIndex } })).toBe(mapa);
    expect(fetchIndex).toHaveBeenCalledTimes(1); // ninguém refez a chamada
  });

  it("chamadas concorrentes com cache frio aquecem UMA vez (dedupe)", () => {
    const fetchIndex = vi.fn(() => new Promise(() => {}));
    for (let i = 0; i < 5; i += 1) peekSpxScheduleIndexFromTorre({ deps: { fetchIndex } });
    expect(fetchIndex).toHaveBeenCalledTimes(1);
  });

  it("falha da Torre não martela: guarda o vazio por um tempo", async () => {
    const fetchIndex = vi.fn(async () => {
      throw new Error("torre fora");
    });
    expect(peekSpxScheduleIndexFromTorre({ deps: { fetchIndex } })).toBeNull();
    await new Promise((r) => setTimeout(r, 0));

    expect(peekSpxScheduleIndexFromTorre({ deps: { fetchIndex } })).toBeNull();
    expect(fetchIndex).toHaveBeenCalledTimes(1); // não tentou de novo na hora
  });
});
