import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Recording mock do camada pg: captura cada query (SQL + params) do caminho de
// limpeza (staleInSheet / staleTrulyGone) para assertar o escopo por fonte.
// pg-mem NÃO suporta ANY(::uuid[]) nem UNNEST — por isso não executamos o UPDATE
// de verdade; a garantia de não-contaminação se prova pelo SQL/params emitidos
// + pelo escopo do fetchExistingSheetLoads (Supabase .eq('sheet_source', ...)).
const pgQueryCalls = [];
vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: vi.fn(async (callback) => {
    const mockClient = {
      query: vi.fn(async (sql, params) => {
        pgQueryCalls.push({ sql: sql.trim(), params });
        return { rows: [], rowCount: 0 };
      }),
    };
    return callback(mockClient);
  }),
  withPgTransaction: vi.fn(async (callback) => {
    const mockClient = {
      query: vi.fn(async (sql, params) => {
        pgQueryCalls.push({ sql: sql.trim(), params });
        return { rows: [], rowCount: 0 };
      }),
    };
    return callback(mockClient);
  }),
}));

const {
  createSheetLoadId,
  parseAvailableGoogleSheetLoads,
  syncGoogleSheetLoads,
  getSheetSources,
} = await import("./google-sheet-loads.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NESTLE_CSV = readFileSync(
  path.join(__dirname, "__fixtures__", "nestle-sample.csv"),
  "utf-8",
);

const NESTLE_CLIENT_ID = "client-nestle";
const SHOPEE_CLIENT_ID = "client-shopee";

// CSV mínimo no layout Shopee (schema identidade) com uma linha disponível que
// NÃO colide com os LHs seedados — usado no teste reverso.
const SHOPEE_CSV = [
  "Titulo",
  "Sub",
  "LH,TIPO,DATA CARREGAMENTO,DATA DESCARGA,Motoristas,ORIGEM,DESTINO,STATUS",
  "LT-SHOPEE-NEW,ForeCast,31/12/2099 22:30:00,01/01/2100 16:30:00,,SoC_SP_Cajamar,SoC_BA_Feira de Santana,",
].join("\n");

function nestleHeaderSchema() {
  return getSheetSources().find((s) => s.source === "nestle").headerSchema;
}

// Supabase mock com cargas em memória filtráveis por sheet_source (emula o
// escopo por fonte de fetchExistingSheetLoads). O upsert de cargas é registrado.
function createSupabaseMock({ existingSheetRows = [], clientRows } = {}) {
  const calls = [];
  const tableRows = {
    cargas: existingSheetRows,
    route_metrics_cache: [],
    clientes: clientRows ?? [{ id: NESTLE_CLIENT_ID, nome: "Nestlé" }],
    sheet_monitor_snapshot: [],
  };

  function createQueryBuilder(table) {
    const state = { filters: [] };
    const builder = {
      select(columns) {
        calls.push(["select", table, columns]);
        return builder;
      },
      not(column, operator, value) {
        calls.push(["not", table, column, operator, value]);
        if (operator === "is") state.filters.push((row) => row[column] !== value);
        return builder;
      },
      eq(column, value) {
        calls.push(["eq", table, column, value]);
        state.filters.push((row) => row[column] === value);
        return builder;
      },
      order() {
        return builder;
      },
      range(from, to) {
        calls.push(["range", table, from, to]);
        const rows = (tableRows[table] || []).filter((row) => state.filters.every((f) => f(row)));
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
      upsert(payload, options) {
        calls.push(["upsert", table, payload, options]);
        const result = { data: payload, error: null };
        const thenable = Promise.resolve(result);
        thenable.select = () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: Array.isArray(payload) ? payload[0] ?? null : payload,
              error: null,
            }),
        });
        return thenable;
      },
    };
    return builder;
  }

  return {
    calls,
    from(table) {
      calls.push(["from", table]);
      return createQueryBuilder(table);
    },
  };
}

function mockFetch(csv) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(csv)),
    text: vi.fn().mockResolvedValue(csv),
  });
}

describe("nestle sheet source", () => {
  beforeEach(() => {
    pgQueryCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parses exactly one available load from the Nestlé fixture, mapped from CHEGADA PREVISTA", () => {
    const loads = parseAvailableGoogleSheetLoads(NESTLE_CSV, {
      headerSchema: nestleHeaderSchema(),
    });

    // DESCARREGADO (com motorista) → NÃO disponível. Só a linha em branco conta.
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      lh: "NST-0002",
      // data vem de CHEGADA PREVISTA (31/12/2099 09:30) via alias.
      data: "2099-12-31",
      horario: "09:30:00",
      carregamentoLabel: "31/12/2099 09:30",
      origem: "Cajamar / SP",
      destino: "Contagem / MG",
    });
  });

  it("assigns sheet_source='nestle' and a namespaced id on the built payload", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = mockFetch(NESTLE_CSV);

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/nestle.csv",
      supabaseClient,
      sheetClientId: NESTLE_CLIENT_ID,
      source: "nestle",
      headerSchema: nestleHeaderSchema(),
    });

    const upsertCall = supabaseClient.calls.find(
      (call) => call[0] === "upsert" && call[1] === "cargas",
    );
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "NST-0002",
      sheet_source: "nestle",
      id: createSheetLoadId("NST-0002", "nestle"),
      origem: "Cajamar / SP",
      destino: "Contagem / MG",
      data: "2099-12-31",
      status: "OPEN",
    });
  });

  it("gives the same LH different ids under shopee vs nestle (id namespacing)", () => {
    const shopeeId = createSheetLoadId("NST-0002", "shopee");
    const shopeeDefaultId = createSheetLoadId("NST-0002");
    const nestleId = createSheetLoadId("NST-0002", "nestle");

    // shopee (explícito) == default (sem source) → namespace histórico preservado.
    expect(shopeeId).toBe(shopeeDefaultId);
    // nestle usa namespace próprio → id distinto.
    expect(nestleId).not.toBe(shopeeId);
  });

  it("CROSS-CONTAMINATION: a Nestlé sync only ever targets Nestlé cargas for cleanup, never Shopee", async () => {
    const shopeeId = createSheetLoadId("LT-SHOPEE-ALIVE", "shopee");
    const nestleGoneId = createSheetLoadId("NST-GONE", "nestle");

    // Ambas OPEN, ambas do sync (sheet_synced_at set). A da Shopee tem
    // sheet_source='shopee'; a da Nestlé 'nestle'. Nenhuma aparece no CSV da
    // Nestlé rodado → a limpeza da Nestlé deve mirar SÓ a carga da Nestlé.
    const existingSheetRows = [
      {
        id: shopeeId,
        sheet_lh: "LT-SHOPEE-ALIVE",
        status: "OPEN",
        sheet_source: "shopee",
        sheet_synced_at: "2026-07-01T00:00:00.000Z",
        perfil: "CARRETA",
        cliente_id: SHOPEE_CLIENT_ID,
        is_template: false,
        created_by: null,
      },
      {
        id: nestleGoneId,
        sheet_lh: "NST-GONE",
        status: "OPEN",
        sheet_source: "nestle",
        sheet_synced_at: "2026-07-01T00:00:00.000Z",
        perfil: "CARRETA",
        cliente_id: NESTLE_CLIENT_ID,
        is_template: false,
        created_by: null,
      },
    ];

    const supabaseClient = createSupabaseMock({ existingSheetRows });
    const fetchImpl = mockFetch(NESTLE_CSV);

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/nestle.csv",
      supabaseClient,
      sheetClientId: NESTLE_CLIENT_ID,
      source: "nestle",
      headerSchema: nestleHeaderSchema(),
    });

    // 1) fetchExistingSheetLoads escopou por fonte: .eq('sheet_source','nestle').
    expect(
      supabaseClient.calls.some(
        (c) => c[0] === "eq" && c[1] === "cargas" && c[2] === "sheet_source" && c[3] === "nestle",
      ),
    ).toBe(true);

    // 2) O UPDATE trulyGone (EXPIRE OPEN→EXPIRED) foi emitido, escopado por
    //    AND sheet_source = $2 com $2 = 'nestle', mirando a carga da Nestlé.
    const trulyGone = pgQueryCalls.find(
      (c) => c.sql.includes("WHEN status = 'OPEN' THEN 'EXPIRED'") && c.sql.includes("id = ANY($1::uuid[])"),
    );
    expect(trulyGone).toBeTruthy();
    expect(trulyGone.sql).toContain("AND sheet_source = $2");
    expect(trulyGone.params[0]).toContain(nestleGoneId);
    expect(trulyGone.params[1]).toBe("nestle");

    // 3) NÃO-CONTAMINAÇÃO: a carga da Shopee NUNCA aparece em nenhum param de
    //    query pg (nem no fetch escopado, nem no UPDATE) → intocável pela Nestlé.
    const shopeeTouched = pgQueryCalls.some((c) =>
      JSON.stringify(c.params ?? []).includes(shopeeId),
    );
    expect(shopeeTouched).toBe(false);
  });

  it("CROSS-CONTAMINATION (reverse): a Shopee sync only ever targets Shopee cargas for cleanup, never Nestlé", async () => {
    const shopeeGoneId = createSheetLoadId("LT-SHOPEE-GONE", "shopee");
    const nestleId = createSheetLoadId("NST-ALIVE", "nestle");

    const existingSheetRows = [
      {
        id: shopeeGoneId,
        sheet_lh: "LT-SHOPEE-GONE",
        status: "OPEN",
        sheet_source: "shopee",
        sheet_synced_at: "2026-07-01T00:00:00.000Z",
        perfil: "CARRETA",
        cliente_id: SHOPEE_CLIENT_ID,
        is_template: false,
        created_by: null,
      },
      {
        id: nestleId,
        sheet_lh: "NST-ALIVE",
        status: "OPEN",
        sheet_source: "nestle",
        sheet_synced_at: "2026-07-01T00:00:00.000Z",
        perfil: "CARRETA",
        cliente_id: NESTLE_CLIENT_ID,
        is_template: false,
        created_by: null,
      },
    ];

    const supabaseClient = createSupabaseMock({
      existingSheetRows,
      clientRows: [{ id: SHOPEE_CLIENT_ID, nome: "Shopee" }],
    });
    const fetchImpl = mockFetch(SHOPEE_CSV);

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/shopee.csv",
      supabaseClient,
      sheetClientId: SHOPEE_CLIENT_ID,
      source: "shopee",
    });

    // fetch escopado por sheet_source='shopee'.
    expect(
      supabaseClient.calls.some(
        (c) => c[0] === "eq" && c[1] === "cargas" && c[2] === "sheet_source" && c[3] === "shopee",
      ),
    ).toBe(true);

    // UPDATE trulyGone escopado por AND sheet_source = $2 com $2 = 'shopee',
    // mirando a carga da Shopee.
    const trulyGone = pgQueryCalls.find(
      (c) => c.sql.includes("WHEN status = 'OPEN' THEN 'EXPIRED'") && c.sql.includes("id = ANY($1::uuid[])"),
    );
    expect(trulyGone).toBeTruthy();
    expect(trulyGone.sql).toContain("AND sheet_source = $2");
    expect(trulyGone.params[0]).toContain(shopeeGoneId);
    expect(trulyGone.params[1]).toBe("shopee");

    // NÃO-CONTAMINAÇÃO: a carga da Nestlé nunca é alvo de nenhuma query pg.
    const nestleTouched = pgQueryCalls.some((c) =>
      JSON.stringify(c.params ?? []).includes(nestleId),
    );
    expect(nestleTouched).toBe(false);
  });

  it("pullAllRows: importa também a linha JÁ alocada como BOOKED (espelho da planilha inteira)", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = mockFetch(NESTLE_CSV);

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/nestle.csv",
      supabaseClient,
      sheetClientId: NESTLE_CLIENT_ID,
      source: "nestle",
      headerSchema: nestleHeaderSchema(),
      pullAllRows: true,
    });

    const payloads = supabaseClient.calls
      .filter((c) => c[0] === "upsert" && c[1] === "cargas")
      .flatMap((c) => c[2]);
    const byLh = Object.fromEntries(payloads.map((p) => [p.sheet_lh, p]));

    // Disponível → OPEN.
    expect(byLh["NST-0002"]).toMatchObject({ status: "OPEN", sheet_source: "nestle" });
    // JÁ alocada (DESCARREGADO + motorista) → BOOKED, com os campos sheet_* da planilha.
    expect(byLh["NST-0001"]).toMatchObject({
      status: "BOOKED",
      sheet_source: "nestle",
      sheet_motorista: "João da Silva",
      sheet_status: "DESCARREGADO",
      id: createSheetLoadId("NST-0001", "nestle"),
    });
  });

  it("sem pullAllRows (default): NÃO cria carga para linha já alocada, só a disponível", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = mockFetch(NESTLE_CSV);

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/nestle.csv",
      supabaseClient,
      sheetClientId: NESTLE_CLIENT_ID,
      source: "nestle",
      headerSchema: nestleHeaderSchema(),
    });

    const lhs = supabaseClient.calls
      .filter((c) => c[0] === "upsert" && c[1] === "cargas")
      .flatMap((c) => c[2])
      .map((p) => p.sheet_lh);

    expect(lhs).toContain("NST-0002"); // disponível criada
    expect(lhs).not.toContain("NST-0001"); // alocada NÃO criada (comportamento Shopee)
  });
});
