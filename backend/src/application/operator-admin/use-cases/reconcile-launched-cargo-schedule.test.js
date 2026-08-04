import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  diffLaunchedSchedule,
  launchedScheduleSyncMode,
  reconcileLaunchedCargoSchedule,
} from "./reconcile-launched-cargo-schedule.js";

const fonte = (at, descargaAt = null) => ({
  carga: { label: "x", dateIso: at.slice(0, 10), timeIso: at.slice(11, 16), at },
  descarga: descargaAt ? { label: "y", dateIso: descargaAt.slice(0, 10), timeIso: descargaAt.slice(11, 16), at: descargaAt } : null,
});

// `label` usa `in` e não `??`: `{ label: null }` tem de produzir rótulo NULL de
// verdade (é um caso testado), não cair no default.
const cargo = (o = {}) => ({
  id: "c1",
  data: o.data ?? "2026-08-06",
  horario: o.horario ?? "18:00:00",
  sheet_data_carregamento: "label" in o ? o.label : "2026-08-06T18:00",
  sheet_data_descarga: o.descarga ?? null,
  agenda_a_confirmar: o.aConfirmar ?? false,
});

beforeEach(() => {
  delete process.env.LAUNCHED_SCHEDULE_SYNC;
});
afterEach(() => {
  delete process.env.LAUNCHED_SCHEDULE_SYNC;
});

describe("launchedScheduleSyncMode", () => {
  it("default é off (escrever aqui move a agenda que o motorista vê)", () => {
    expect(launchedScheduleSyncMode()).toBe("off");
  });
  it("aceita dry/on e ignora valor inválido", () => {
    process.env.LAUNCHED_SCHEDULE_SYNC = "dry";
    expect(launchedScheduleSyncMode()).toBe("dry");
    process.env.LAUNCHED_SCHEDULE_SYNC = "ON";
    expect(launchedScheduleSyncMode()).toBe("on");
    process.env.LAUNCHED_SCHEDULE_SYNC = "sim";
    expect(launchedScheduleSyncMode()).toBe("off");
  });
});

describe("diffLaunchedSchedule", () => {
  it("agenda já igual → null (nada a fazer)", () => {
    expect(diffLaunchedSchedule(cargo(), fonte("2026-08-06T18:00"))).toBeNull();
  });

  it("carregamento mudou na fonte → propõe data+horário+rótulo", () => {
    const d = diffLaunchedSchedule(cargo({ data: "2026-08-03", horario: "16:00:00", label: "2026-08-03T16:00" }), fonte("2026-08-04T16:00"));
    expect(d).toMatchObject({ dataIso: "2026-08-04", timeIso: "16:00", carregamentoLabel: "2026-08-04T16:00" });
    expect(d.de).toBe("2026-08-03 16:00");
    expect(d.para).toBe("2026-08-04 16:00");
  });

  it("placeholder 'a confirmar' com data real na fonte → propõe e limpa a flag", () => {
    const d = diffLaunchedSchedule(
      cargo({ data: "2026-08-03", horario: "00:00:00", label: "A confirmar", aConfirmar: true }),
      fonte("2026-08-05T10:00"),
    );
    expect(d.dataIso).toBe("2026-08-05");
    expect(d.de).toContain("(a confirmar)");
  });

  it("rótulo denormalizado divergente das colunas canônicas → propõe (era a origem do 'um horário no Monitor, outro no portal')", () => {
    const d = diffLaunchedSchedule(cargo({ label: "A confirmar" }), fonte("2026-08-06T18:00"));
    expect(d.carregamentoLabel).toBe("2026-08-06T18:00");
    expect(d.dataIso).toBe("2026-08-06");
  });

  // REGRESSÃO: node-postgres devolve DATE como objeto Date (UTC-midnight). Com
  // `String(date).slice(0,10)` a comparação dava "Sun Aug 09" vs "2026-08-09" —
  // sempre diferente — e a passada reescrevia TODA carga lançada a cada ciclo
  // (medido em prod: 102 de 131 "mudariam" com nada mudado).
  it("DATE como objeto Date (driver pg) → nada a fazer quando a agenda já bate", () => {
    expect(diffLaunchedSchedule(cargo({ data: new Date("2026-08-06T00:00:00.000Z") }), fonte("2026-08-06T18:00"))).toBeNull();
  });

  it("DATE como objeto Date → detecta mudança real e reporta a data de parede", () => {
    const d = diffLaunchedSchedule(cargo({ data: new Date("2026-08-03T00:00:00.000Z"), horario: "16:00:00", label: "2026-08-03T16:00" }), fonte("2026-08-04T16:00"));
    expect(d.de).toBe("2026-08-03 16:00");
    expect(d.para).toBe("2026-08-04 16:00");
  });

  it("DATE como string ISO (PostgREST) segue funcionando", () => {
    expect(diffLaunchedSchedule(cargo({ data: "2026-08-06T00:00:00.000Z" }), fonte("2026-08-06T18:00"))).toBeNull();
  });

  it("descarga nova entra; descarga ausente na fonte NÃO apaga a atual", () => {
    expect(diffLaunchedSchedule(cargo(), fonte("2026-08-06T18:00", "2026-08-07T12:00")).descargaLabel).toBe("2026-08-07T12:00");
    expect(diffLaunchedSchedule(cargo({ descarga: "2026-08-07T12:00" }), fonte("2026-08-06T18:00"))).toBeNull();
  });

  // REGRESSÃO: sheet_data_descarga é gravada com ESPAÇO ('2026-08-07 12:00') mas a
  // fonte gera com "T". Comparando como string, a mesma agenda parecia diferente e a
  // passada reescrevia a carga em TODO ciclo, para sempre (medido em prod: 2 cargas
  // com data/hora/rótulo consistentes marcadas como "mudariam" só pelo separador).
  it("descarga com separador ESPAÇO é o mesmo instante que com T → nada a fazer", () => {
    expect(diffLaunchedSchedule(cargo({ descarga: "2026-08-07 12:00" }), fonte("2026-08-06T18:00", "2026-08-07T12:00"))).toBeNull();
  });

  it("descarga no formato BR legado também é comparada por instante", () => {
    expect(diffLaunchedSchedule(cargo({ descarga: "07/08/2026 12:00" }), fonte("2026-08-06T18:00", "2026-08-07T12:00"))).toBeNull();
  });

  it("descarga realmente diferente → propõe só ela e informa o motivo", () => {
    const d = diffLaunchedSchedule(cargo({ descarga: "2026-08-07 12:00" }), fonte("2026-08-06T18:00", "2026-08-08T09:00"));
    expect(d.descargaLabel).toBe("2026-08-08T09:00");
    expect(d.motivo).toBe("descarga");
  });

  it("rótulo de carregamento com separador ESPAÇO → mesmo instante, nada a fazer", () => {
    expect(diffLaunchedSchedule(cargo({ label: "2026-08-06 18:00" }), fonte("2026-08-06T18:00"))).toBeNull();
  });

  // syncedCarregamentoLabel: rótulo nulo é estado deliberado (carga criada pelo
  // Monitor cai no fallback data+horário no front). Preencher mudaria de qual campo
  // as telas leem.
  it("rótulo NULL é preservado (não passa a gravar rótulo em quem não tem)", () => {
    expect(diffLaunchedSchedule(cargo({ label: null }), fonte("2026-08-06T18:00"))).toBeNull();
    const d = diffLaunchedSchedule(cargo({ label: null, data: "2026-08-03" }), fonte("2026-08-06T18:00"));
    expect(d.motivo).toBe("agenda");
    expect(d.carregamentoLabel).toBeNull(); // COALESCE preserva o nulo
  });

  it("'A confirmar' não é instante → o rótulo É substituído", () => {
    const d = diffLaunchedSchedule(cargo({ label: "A confirmar", aConfirmar: true }), fonte("2026-08-06T18:00"));
    expect(d.carregamentoLabel).toBe("2026-08-06T18:00");
    expect(d.motivo).toContain("rótulo");
    expect(d.motivo).toContain("flag a-confirmar");
  });

  it("fonte sem carregamento → null (não decide nada a partir de índice incompleto)", () => {
    expect(diffLaunchedSchedule(cargo(), { carga: null, descarga: null })).toBeNull();
    expect(diffLaunchedSchedule(cargo(), null)).toBeNull();
  });
});

describe("reconcileLaunchedCargoSchedule", () => {
  it("gate off (default) → no-op, nem lê os índices", async () => {
    const fetchSpxScheduleIndexFromSidecar = vi.fn();
    const r = await reconcileLaunchedCargoSchedule({ deps: { fetchSpxScheduleIndexFromSidecar } });
    expect(r).toMatchObject({ ok: true, skipped: "disabled", mode: "off", updated: 0 });
    expect(fetchSpxScheduleIndexFromSidecar).not.toHaveBeenCalled();
  });

  it("sem nenhum índice disponível → skipped, sem tocar o banco", async () => {
    process.env.LAUNCHED_SCHEDULE_SYNC = "on";
    const withPgClient = vi.fn();
    const r = await reconcileLaunchedCargoSchedule({
      deps: {
        withPgClient,
        fetchSpxScheduleIndexFromSidecar: async () => null,
        fetchSpxScheduleIndex: async () => null,
        fetchNestleMonitorIndex: async () => null,
      },
    });
    expect(r.skipped).toBe("no-index");
    expect(withPgClient).not.toHaveBeenCalled();
  });

  it("modo dry: conta o que MUDARIA e não escreve", async () => {
    process.env.LAUNCHED_SCHEDULE_SYNC = "dry";
    const queries = [];
    const client = {
      query: vi.fn(async (sql) => {
        queries.push(sql);
        if (/^\s*SELECT/.test(sql)) {
          return {
            rows: [
              { id: "c1", lh: "LT0Q8602CPLC1", data: new Date("2026-08-01T00:00:00.000Z"), horario: "00:00:00", sheet_data_carregamento: "2026-08-01T00:00", sheet_data_descarga: null, agenda_a_confirmar: false },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const r = await reconcileLaunchedCargoSchedule({
      deps: {
        withPgClient: async (fn) => fn(client),
        fetchSpxScheduleIndexFromSidecar: async () => new Map([["LT0Q8602CPLC1", fonte("2026-08-06T18:00")]]),
        fetchSpxScheduleIndex: async () => null,
        fetchNestleMonitorIndex: async () => null,
      },
    });
    expect(r).toMatchObject({ ok: true, mode: "dry", checked: 1, updated: 1 });
    expect(queries.some((s) => /UPDATE/.test(s))).toBe(false);
  });

  it("modo on: grava data/horario/rótulos e audita", async () => {
    process.env.LAUNCHED_SCHEDULE_SYNC = "on";
    const updates = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        if (/^\s*SELECT/.test(sql)) {
          return {
            rows: [
              { id: "c1", lh: "B101474063, B101473490", data: new Date("2026-08-03T00:00:00.000Z"), horario: "00:00:00", sheet_data_carregamento: "A confirmar", sheet_data_descarga: null, agenda_a_confirmar: true },
            ],
          };
        }
        if (/UPDATE public\.cargas/.test(sql)) updates.push(params);
        return { rows: [{ id: "audit" }] };
      }),
    };
    const r = await reconcileLaunchedCargoSchedule({
      deps: {
        withPgClient: async (fn) => fn(client),
        fetchSpxScheduleIndexFromSidecar: async () => null,
        fetchSpxScheduleIndex: async () => null,
        // LH multi-grupo: só casa via nestleIndexLookup (quebra por vírgula).
        fetchNestleMonitorIndex: async () => new Map([["B101473490", { ...fonte("2026-08-05T10:00"), status: "CARREGADO" }]]),
      },
    });
    expect(r).toMatchObject({ ok: true, mode: "on", updated: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0].slice(0, 4)).toEqual(["c1", "2026-08-05", "10:00", "2026-08-05T10:00"]);
  });

  it("LH sem match na fonte → intocado (nunca apaga agenda existente)", async () => {
    process.env.LAUNCHED_SCHEDULE_SYNC = "on";
    const client = {
      query: vi.fn(async (sql) =>
        /^\s*SELECT/.test(sql)
          ? { rows: [{ id: "c1", lh: "LT_DESCONHECIDA", data: new Date("2026-08-01T00:00:00.000Z"), horario: "00:00:00", sheet_data_carregamento: null, sheet_data_descarga: null, agenda_a_confirmar: false }] }
          : { rows: [] },
      ),
    };
    const r = await reconcileLaunchedCargoSchedule({
      deps: {
        withPgClient: async (fn) => fn(client),
        fetchSpxScheduleIndexFromSidecar: async () => new Map([["OUTRA", fonte("2026-08-06T18:00")]]),
        fetchSpxScheduleIndex: async () => null,
        fetchNestleMonitorIndex: async () => null,
      },
    });
    expect(r).toMatchObject({ checked: 1, updated: 0 });
  });
});
