import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Harness: cliente pg instrumentado que CONTA queries e LINHAS devolvidas.
//
// O objeto client é ÚNICO e reaproveitado entre chamadas (como o pool do pg-mem
// faz): o wrapper é marcado com um Symbol para não empilhar instrumentação e
// contar a mesma query duas vezes.
// ─────────────────────────────────────────────────────────────────────────────
const QUERY_INSTRUMENTED = Symbol("reconcile-test-query-instrumented");

const state = {
  cargas: [],
  /** Map "origem|destino|perfil" → métricas da rota (ou ausente = sem rota) */
  catalog: new Map(),
  updates: [],
  /** { kind, rows } por query executada */
  calls: [],
  /** quando true, toda query falha (teste de isolamento) */
  failQueries: false,
};

// Espelha CANDIDATE_CARGO_WHERE do use case.
const isCandidate = (c) =>
  !["CANCELLED", "COMPLETED", "FAILED"].includes(c.status ?? "OPEN") &&
  (c.sheet_lh != null || c.lh_manual != null) &&
  String(c.origem ?? "").trim() !== "" &&
  String(c.destino ?? "").trim() !== "" &&
  c.distancia_km !== null &&
  c.distancia_km !== undefined;

const routeKeyOf = (row) => `${row.origem}|${row.destino}|${row.perfil ?? ""}`;

// Mini-engine SQL: só o suficiente para as 3 formas de query do use case.
const rawClient = {
  async query(sql, params = []) {
    if (state.failQueries) throw new Error("connection terminated");
    const text = String(sql);

    if (/UPDATE\s+public\.cargas/i.test(text)) {
      state.updates.push({ params });
      // Aplica no dataset para que o ciclo SEGUINTE veja a carga já curada
      // (prova de idempotência com dados vivos, não com mock estático).
      const target = state.cargas.find((c) => c.id === params[0]);
      if (target) {
        target.valor = params[1];
        target.bonus = params[2];
        target.distancia_km = params[3];
        if (params[4] !== null) target.duracao_horas = params[4];
      }
      return { rows: [] };
    }

    if (/route_metrics_cache/i.test(text)) {
      // Uma linha por tarifa do catálogo (não é a query medida, mas conta).
      return { rows: Array.from(state.catalog.values()) };
    }

    if (/GROUP BY/i.test(text)) {
      const grouped = new Map();
      for (const c of state.cargas.filter(isCandidate)) {
        const key = JSON.stringify([c.origem, c.destino, c.perfil ?? null, c.distancia_km]);
        if (!grouped.has(key)) {
          grouped.set(key, {
            origem: c.origem,
            destino: c.destino,
            perfil: c.perfil ?? null,
            distancia_km: c.distancia_km,
            cargas: 0,
          });
        }
        grouped.get(key).cargas += 1;
      }
      // COUNT(*) volta como string no node-pg (bigint).
      return { rows: Array.from(grouped.values()).map((g) => ({ ...g, cargas: String(g.cargas) })) };
    }

    // Consulta LEGADA (versão anterior do job): SELECT sem GROUP BY e sem
    // parâmetros = uma linha por carga candidata. Mantida no harness só para
    // medir o baseline no teste de controle.
    if (params.length === 0) {
      return {
        rows: state.cargas.filter(isCandidate).map((c) => ({
          id: c.id,
          sheet_lh: c.sheet_lh,
          lh_manual: c.lh_manual,
          origem: c.origem,
          destino: c.destino,
          perfil: c.perfil,
          valor: c.valor,
          bonus: c.bonus,
          distancia_km: c.distancia_km,
          duracao_horas: c.duracao_horas,
        })),
      };
    }

    // FASE 2 — cargas de UMA tupla defasada, com LIMIT.
    const [origem, destino, perfil, distancia, limit] = params;
    const rows = state.cargas
      .filter(isCandidate)
      .filter(
        (c) =>
          c.origem === origem &&
          c.destino === destino &&
          (c.perfil ?? "") === perfil &&
          c.distancia_km === distancia,
      )
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(0, limit)
      .map((c) => ({ id: c.id, sheet_lh: c.sheet_lh, lh_manual: c.lh_manual, valor: c.valor }));
    return { rows };
  },
};

const classify = (text) => {
  if (/UPDATE\s+public\.cargas/i.test(text)) return "update";
  if (/route_metrics_cache/i.test(text)) return "catalog";
  if (/GROUP BY/i.test(text)) return "cargas-group";
  return "cargas-rows";
};

function instrument(client) {
  if (client[QUERY_INSTRUMENTED]) return client; // pool reusa o client — não contar 2x
  const original = client.query.bind(client);
  client.query = async (sql, params) => {
    const result = await original(sql, params);
    state.calls.push({
      kind: classify(String(sql)),
      sql: String(sql).replace(/\s+/g, " ").trim(),
      rows: result.rows.length,
    });
    return result;
  };
  client[QUERY_INSTRUMENTED] = true;
  return client;
}

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(instrument(rawClient)),
}));

// Matcher do catálogo: mesma semântica do real (Map id→métricas, null quando não
// casa) e faz UMA leitura de route_metrics_cache, como a implementação real.
vi.mock("../operator-admin/use-cases/_shared.js", () => ({
  fetchRouteCatalogMetricsByLoadId: vi.fn(async (client, loadRows) => {
    await client.query(
      "SELECT origin_key, destination_key, distancia_km, valor_padrao, bonus_padrao, duracao_horas FROM public.route_metrics_cache WHERE origin_key = ANY($1::text[])",
      [[]],
    );
    return new Map(loadRows.map((row) => [row.id, state.catalog.get(routeKeyOf(row)) ?? null]));
  }),
}));

const { reconcileStaleRouteMetrics } = await import("./reconcile-stale-route-metrics.js");

// Params do UPDATE: [id, valor, bonus, distancia, duracao]
const asUpdate = (u) => ({
  id: u.params[0],
  valor: u.params[1],
  bonus: u.params[2],
  distancia: u.params[3],
  duracao: u.params[4],
});

const rowsFromCargas = () =>
  state.calls.filter((c) => c.kind === "cargas-group" || c.kind === "cargas-rows").reduce((a, c) => a + c.rows, 0);
const callsOfKind = (kind) => state.calls.filter((c) => c.kind === kind).length;
const resetCalls = () => {
  state.calls = [];
  state.updates = [];
};

// Dataset com a FORMA REAL de produção (medida em 2026-08-03 no banco de prod):
// 1.389 cargas candidatas distribuídas em 36 tuplas distintas, maior grupo = 850.
const buildProdShapedDataset = () => {
  const sizes = [850, ...Array.from({ length: 34 }, () => 15), 29]; // 36 grupos = 1389 cargas
  const cargas = [];
  sizes.forEach((size, gi) => {
    const origem = `ORIGEM-${String(gi).padStart(2, "0")} / BA`;
    const destino = `DESTINO-${String(gi).padStart(2, "0")} / PE`;
    for (let j = 0; j < size; j += 1) {
      cargas.push({
        id: `c${String(gi).padStart(2, "0")}-${String(j).padStart(4, "0")}`,
        sheet_lh: `LH${gi}-${j}`,
        lh_manual: null,
        origem,
        destino,
        perfil: "CARRETA",
        status: "OPEN",
        valor: 1000 + gi,
        bonus: 100,
        distancia_km: 100 + gi,
        duracao_horas: 5,
      });
    }
  });
  const catalog = new Map(
    sizes.map((_size, gi) => [
      `ORIGEM-${String(gi).padStart(2, "0")} / BA|DESTINO-${String(gi).padStart(2, "0")} / PE|CARRETA`,
      { valor_padrao: 1000 + gi, bonus_padrao: 100, distancia_km: 100 + gi, duracao_horas: 5 },
    ]),
  );
  return { cargas, catalog, totalCargas: sizes.reduce((a, b) => a + b, 0), groups: sizes.length };
};

describe("reconcileStaleRouteMetrics", () => {
  beforeEach(() => {
    state.cargas = [];
    state.catalog = new Map();
    resetCalls();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Detecção (comportamento preservado) ────────────────────────────────────

  it("re-deriva a carga com distância DEFASADA (métricas de outra rota) do catálogo", async () => {
    // Carga Simões→Jaboatão (784km) presa em R$600/28km da rota Simões→Salvador.
    state.cargas = [
      {
        id: "c1",
        sheet_lh: "LT0Q8102C0G21",
        lh_manual: null,
        origem: "Simoes Filho / BA",
        destino: "Jaboatão dos Guararapes / PE",
        perfil: "CARRETA",
        status: "OPEN",
        valor: 600,
        bonus: 100,
        distancia_km: 28,
        duracao_horas: 1.98,
      },
    ];
    state.catalog = new Map([
      [
        "Simoes Filho / BA|Jaboatão dos Guararapes / PE|CARRETA",
        { valor_padrao: 5300, bonus_padrao: 300, distancia_km: 784, duracao_horas: 8.6 },
      ],
    ]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(1);
    expect(res.scanned).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(asUpdate(state.updates[0])).toEqual({ id: "c1", valor: 5300, bonus: 300, distancia: 784, duracao: 8.6 });
  });

  it("re-deriva também carga do SISTEMA (lh_manual) e no sentido OVERprecificado", async () => {
    // Simões→Feira (92km) presa em R$5300/784km de uma rota longa antiga.
    state.cargas = [
      {
        id: "c2",
        sheet_lh: null,
        lh_manual: "LT0Q5U026GH51",
        origem: "Simoes Filho / BA",
        destino: "Feira de Santana / BA",
        perfil: "CARRETA",
        status: "OPEN",
        valor: 5300,
        bonus: 0,
        distancia_km: 784,
        duracao_horas: 8.6,
      },
    ];
    state.catalog = new Map([
      [
        "Simoes Filho / BA|Feira de Santana / BA|CARRETA",
        { valor_padrao: 1100, bonus_padrao: 200, distancia_km: 92, duracao_horas: 1.5 },
      ],
    ]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(1);
    expect(asUpdate(state.updates[0])).toEqual({ id: "c2", valor: 1100, bonus: 200, distancia: 92, duracao: 1.5 });
  });

  it("NÃO toca carga cujo valor difere mas a distância BATE (edição de preço / drift de catálogo)", async () => {
    // distancia 780 vs rota 784 (<15%) → não é defasagem de ROTA; valor 6000 preservado.
    state.cargas = [
      { id: "c3", sheet_lh: "L3", lh_manual: null, origem: "A", destino: "B", perfil: "CARRETA", status: "OPEN", valor: 6000, bonus: 300, distancia_km: 780, duracao_horas: 8 },
    ];
    state.catalog = new Map([["A|B|CARRETA", { valor_padrao: 5300, bonus_padrao: 300, distancia_km: 784, duracao_horas: 8.6 }]]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(0);
    expect(state.updates).toHaveLength(0);
    // e não gastou uma leitura de cargas na fase 2
    expect(callsOfKind("cargas-rows")).toBe(0);
  });

  it("NÃO toca carga sem rota no catálogo (nada p/ re-derivar)", async () => {
    state.cargas = [
      { id: "c4", sheet_lh: "L4", lh_manual: null, origem: "X", destino: "Y", perfil: "CARRETA", status: "OPEN", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 2 },
    ];
    state.catalog = new Map(); // sem match

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("NÃO toca quando a rota do catálogo não tem valor (só re-deriva com valor de rota)", async () => {
    state.cargas = [
      { id: "c5", sheet_lh: "L5", lh_manual: null, origem: "X", destino: "Y", perfil: "CARRETA", status: "OPEN", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 2 },
    ];
    state.catalog = new Map([["X|Y|CARRETA", { valor_padrao: null, bonus_padrao: null, distancia_km: 784, duracao_horas: null }]]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("bônus/duração nulos no catálogo: grava bônus null e preserva duração (COALESCE)", async () => {
    state.cargas = [
      { id: "c6", sheet_lh: "L6", lh_manual: null, origem: "X", destino: "Y", perfil: "CARRETA", status: "OPEN", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 2 },
    ];
    state.catalog = new Map([["X|Y|CARRETA", { valor_padrao: 4800, bonus_padrao: null, distancia_km: 782, duracao_horas: null }]]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(1);
    const u = asUpdate(state.updates[0]);
    expect(u.valor).toBe(4800);
    expect(u.bonus).toBeNull();
    expect(u.distancia).toBe(782);
    expect(u.duracao).toBeNull(); // COALESCE no SQL preserva a duração existente
  });

  it("detecta defasagem que nasce no CATÁLOGO — carga intocada, updated_at inalterado", async () => {
    // Incidente real coberto pelo job: o operador corrige a distância da ROTA e as
    // cargas RESERVED/BOOKED (fora do cascade de updateRoute) ficam com métricas de
    // outra rota. A carga NÃO é escrita, logo `cargas.updated_at` NÃO muda — por
    // isso a varredura não pode filtrar por updated_at.
    const carga = {
      id: "c7",
      sheet_lh: "L7",
      lh_manual: null,
      origem: "Simoes Filho / BA",
      destino: "Salvador / BA",
      perfil: "CARRETA",
      status: "BOOKED",
      valor: 600,
      bonus: 100,
      distancia_km: 28,
      duracao_horas: 1.9,
      updated_at: "2026-01-01T00:00:00.000Z", // antiga e NUNCA alterada
    };
    state.cargas = [carga];
    // Catálogo re-cadastrado: a mesma rota agora tem 784km.
    state.catalog = new Map([
      ["Simoes Filho / BA|Salvador / BA|CARRETA", { valor_padrao: 5300, bonus_padrao: 300, distancia_km: 784, duracao_horas: 8.6 }],
    ]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(1);
    expect(asUpdate(state.updates[0]).distancia).toBe(784);
    // Nenhuma leitura filtra por updated_at (não há watermark incremental).
    const selects = state.calls.filter((c) => c.kind === "cargas-group" || c.kind === "cargas-rows");
    expect(selects.length).toBeGreaterThan(0);
    selects.forEach((c) => expect(c.sql).not.toMatch(/updated_at/i));
    expect(carga.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  // ── Egress: linhas lidas da tabela cargas ─────────────────────────────────

  it("MEDIÇÃO: dataset com a forma de produção (1389 candidatas / 36 tuplas) lê 36 linhas, não 1389", async () => {
    const ds = buildProdShapedDataset();
    state.cargas = ds.cargas;
    state.catalog = ds.catalog;
    expect(ds.totalCargas).toBe(1389);
    expect(ds.groups).toBe(36);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });

    expect(res.ok).toBe(true);
    expect(res.updated).toBe(0);
    // `scanned` continua reportando as 1389 candidatas examinadas…
    expect(res.scanned).toBe(1389);
    expect(res.groups).toBe(36);
    // …mas só 36 linhas trafegaram da tabela cargas (a query antiga trafegava 1389).
    expect(callsOfKind("cargas-group")).toBe(1);
    expect(callsOfKind("cargas-rows")).toBe(0); // regime estacionário: fase 2 nem roda
    expect(rowsFromCargas()).toBe(36);
    // baseline (comportamento anterior) = uma linha por carga candidata
    const baseline = ds.totalCargas;
    expect(rowsFromCargas() / baseline).toBeLessThan(0.03); // −97%+
    // a leitura do catálogo continua sendo UMA por ciclo
    expect(callsOfKind("catalog")).toBe(1);
  });

  it("CONTROLE antes/depois: a varredura por carga leria 1389 linhas; a atual lê 36", async () => {
    const ds = buildProdShapedDataset();
    state.cargas = ds.cargas;
    state.catalog = ds.catalog;

    // ANTES — SQL exato da versão anterior, no MESMO harness/dataset.
    const legacy = await instrument(rawClient).query(
      `
        SELECT id, sheet_lh, lh_manual, origem, destino, perfil,
               valor, bonus, distancia_km, duracao_horas
        FROM public.cargas
        WHERE status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED')
          AND (sheet_lh IS NOT NULL OR lh_manual IS NOT NULL)
          AND COALESCE(TRIM(origem), '') <> ''
          AND COALESCE(TRIM(destino), '') <> ''
          AND distancia_km IS NOT NULL
      `,
    );
    const before = legacy.rows.length;
    expect(before).toBe(1389);

    // DEPOIS — o job atual sobre o mesmo dataset.
    resetCalls();
    await reconcileStaleRouteMetrics({ log: () => {} });
    const after = rowsFromCargas();

    expect(after).toBe(36);
    expect(before / after).toBeGreaterThan(38); // 38,6× menos linhas
  });

  it("MEDIÇÃO: 6 ciclos no ritmo REAL do job (1 a cada 9 min) — 36 linhas por ciclo, sem depender de TTL", async () => {
    // O job é de fundo: não há usuário nem poll de tela, então cache com TTL curto
    // não ajudaria (um ciclo a cada 9 min nunca acerta um TTL de segundos). A
    // redução aqui é estrutural — vale em TODO ciclo, qualquer que seja o intervalo.
    const ds = buildProdShapedDataset();
    state.cargas = ds.cargas;
    state.catalog = ds.catalog;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T09:00:00.000Z"));

    const perCycle = [];
    const CYCLES = 6;
    const NINE_MINUTES_MS = 9 * 60 * 1000; // cadência observada em produção
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      resetCalls();
      const res = await reconcileStaleRouteMetrics({ log: () => {} });
      expect(res.updated).toBe(0);
      perCycle.push(rowsFromCargas());
      vi.setSystemTime(new Date(Date.now() + NINE_MINUTES_MS));
    }

    // Constante ciclo a ciclo — nenhuma janela de cache para "expirar".
    expect(perCycle).toEqual(Array.from({ length: CYCLES }, () => 36));
    const total = perCycle.reduce((a, b) => a + b, 0);
    const baselineTotal = ds.totalCargas * CYCLES;
    expect(total).toBe(216);
    expect(baselineTotal).toBe(8334);
    expect(total / baselineTotal).toBeLessThan(0.03);
  });

  it("MEDIÇÃO: com UMA tupla defasada entre as 36, lê 36 + só as cargas daquela tupla", async () => {
    const ds = buildProdShapedDataset();
    state.cargas = ds.cargas;
    state.catalog = ds.catalog;
    // Grupo 7 (15 cargas) passa a divergir: o catálogo agora diz 900km.
    const staleKey = "ORIGEM-07 / BA|DESTINO-07 / PE|CARRETA";
    state.catalog.set(staleKey, { valor_padrao: 7777, bonus_padrao: 321, distancia_km: 900, duracao_horas: 12 });

    const res = await reconcileStaleRouteMetrics({ log: () => {} });

    expect(res.updated).toBe(15);
    expect(callsOfKind("cargas-group")).toBe(1);
    expect(callsOfKind("cargas-rows")).toBe(1); // uma query só, para a tupla defasada
    expect(rowsFromCargas()).toBe(36 + 15);
    // todas as 15 cargas do grupo foram corrigidas, e só elas
    expect(state.updates).toHaveLength(15);
    state.updates.forEach((u) => {
      expect(asUpdate(u).id.startsWith("c07-")).toBe(true);
      expect(asUpdate(u)).toMatchObject({ valor: 7777, bonus: 321, distancia: 900, duracao: 12 });
    });

    // Ciclo seguinte: já curado → nada a corrigir e nenhuma linha de carga lida.
    resetCalls();
    const res2 = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res2.updated).toBe(0);
    expect(callsOfKind("cargas-rows")).toBe(0);
    expect(rowsFromCargas()).toBe(36);
  });

  it("preserva o cap de 200 por ciclo E não lê linha além do cap (LIMIT no saldo)", async () => {
    const ds = buildProdShapedDataset();
    state.cargas = ds.cargas;
    state.catalog = ds.catalog;
    // O MAIOR grupo real (850 cargas) fica defasado.
    state.catalog.set("ORIGEM-00 / BA|DESTINO-00 / PE|CARRETA", {
      valor_padrao: 9000,
      bonus_padrao: 500,
      distancia_km: 999,
      duracao_horas: 14,
    });

    const res = await reconcileStaleRouteMetrics({ log: () => {} });

    expect(res.updated).toBe(200); // cap preservado
    expect(state.updates).toHaveLength(200);
    // e a fase 2 leu exatamente 200 linhas — não as 850 do grupo
    expect(rowsFromCargas()).toBe(36 + 200);
  });

  it("perfil NULL e perfil vazio não geram gravação dupla na mesma tupla", async () => {
    state.cargas = [
      { id: "d1", sheet_lh: "LN", lh_manual: null, origem: "A", destino: "B", perfil: null, status: "OPEN", valor: 600, bonus: 1, distancia_km: 28, duracao_horas: 2 },
      { id: "d2", sheet_lh: "LE", lh_manual: null, origem: "A", destino: "B", perfil: "", status: "OPEN", valor: 600, bonus: 1, distancia_km: 28, duracao_horas: 2 },
    ];
    state.catalog = new Map([["A|B|", { valor_padrao: 4000, bonus_padrao: 200, distancia_km: 784, duracao_horas: 9 }]]);

    const res = await reconcileStaleRouteMetrics({ log: () => {} });
    expect(res.updated).toBe(2);
    expect(state.updates.map((u) => asUpdate(u).id).sort()).toEqual(["d1", "d2"]);
  });

  it("erro de banco é isolado (best-effort, nunca lança)", async () => {
    state.failQueries = true;
    try {
      const res = await reconcileStaleRouteMetrics({ log: () => {} });
      expect(res).toEqual({ ok: false, updated: 0 });
    } finally {
      state.failQueries = false;
    }
  });
});
