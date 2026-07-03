import { describe, expect, it, vi } from "vitest";

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
}));

import {
  formatSpreadsheetLocation,
  createSheetLoadId,
  parseAvailableGoogleSheetLoads,
  SheetClientNotConfiguredError,
  syncGoogleSheetLoads,
  updateSheetMonitorSnapshot,
} from "./google-sheet-loads.js";

const SAMPLE_CSV = [
  "Lamina",
  "Outra linha de cabecalho",
  [
    "LH",
    "TIPO",
    "DATA CARREGAMENTO",
    "DATA DESCARGA",
    "Motoristas",
    "CAVALO",
    "CARRETA",
    "VINCULO",
    "ORIGEM",
    "DESTINO",
    "EXTRA",
    "STATUS",
    "AGREGADO",
    "CheckList Cavalo",
    "CheckList Carreta1",
    "CheckList Carreta2",
    "Column 17",
    "DATA CARREGAMENTO2",
  ].join(","),
  [
    "LT0Q4302267L1",
    "ForeCast",
    "03/04/2026 22:30:00",
    "4/4/2026 16:30:00",
    "",
    "",
    "",
    "",
    "SoC_PE_Jaboatao dos Guararapes",
    "SoC_BA_Simoes Filho",
    "",
    "",
    "",
    "Aprovado",
    "Aprovado",
    "",
    "02/04/2026",
    "03/04/2026",
  ].join(","),
  [
    "LT0Q4402267J1",
    "ForeCast",
    "04/04/2026 20:00:00",
    "5/4/2026 14:00:00",
    "Antonio",
    "",
    "",
    "",
    "SoC_PE_Jaboatao dos Guararapes",
    "SoC_BA_Simoes Filho",
    "",
    "",
    "",
    "Aprovado",
    "Aprovado",
    "",
    "03/04/2026",
    "04/04/2026",
  ].join(","),
  [
    "LT0Q4502267H1",
    "ForeCast",
    "05/04/2026 07:00:00",
    "6/4/2026 01:00:00",
    "",
    "",
    "",
    "",
    "SoC_PE_Jaboatao dos Guararapes",
    "SoC_BA_Simoes Filho",
    "",
    "Em aberto",
    "",
    "Aprovado",
    "Aprovado",
    "",
    "04/04/2026",
    "05/04/2026",
  ].join(","),
].join("\n");

function appendCsvColumn(csvText, headerName, rowValues) {
  const formatCsvCell = (value) => {
    if (value == null) {
      return "";
    }

    const stringValue = String(value);

    if (!/[",\n]/.test(stringValue)) {
      return stringValue;
    }

    return `"${stringValue.replace(/"/g, '""')}"`;
  };

  return csvText
    .split("\n")
    .map((line, index) => {
      if (index < 2) {
        return line;
      }

      if (index === 2) {
        return `${line},${formatCsvCell(headerName)}`;
      }

      return `${line},${formatCsvCell(rowValues[index - 3])}`;
    })
    .join("\n");
}

const SAMPLE_CSV_WITH_VALUE = appendCsvColumn(SAMPLE_CSV, "VALOR FRETE", [
  "R$ 4.500,00",
  "R$ 5.100,00",
  "",
]);

const SAMPLE_CSV_WITH_BLANK_VALUE_COLUMN = appendCsvColumn(SAMPLE_CSV, "VALOR FRETE", [
  "",
  "R$ 5.100,00",
  "",
]);
const SAMPLE_CSV_WITH_OPERATIONAL_ALIASES = SAMPLE_CSV.replace(
  "SoC_PE_Jaboatao dos Guararapes,SoC_BA_Simoes Filho",
  "SJ Rio Preto-02 / SP,SoC_BA_Simoes Filho",
);
const SAMPLE_CSV_WITH_GLUE_DATETIME = SAMPLE_CSV.replace(
  "03/04/2026 22:30:00,4/4/2026 16:30:00",
  "11-04-202607:00,12-04-2026 16:30:00",
);
const SAMPLE_CSV_WITH_ONE_INVALID_ROW = `${SAMPLE_CSV}\n${[
  "LT-INVALID-0001",
  "ForeCast",
  "11-04-2026T07:00",
  "12-04-2026 16:30:00",
  "",
  "",
  "",
  "",
  "SoC_PE_Jaboatao dos Guararapes",
  "SoC_BA_Simoes Filho",
  "",
  "",
  "",
  "Aprovado",
  "Aprovado",
  "",
  "11/04/2026",
  "11/04/2026",
].join(",")}`;
const SHEET_CLIENT_ID = "client-shopee";

function createSupabaseMock({
  existingSheetRows = [],
  routeCatalogRows = [],
  templateRows = [],
  clientRows = [{ id: SHEET_CLIENT_ID, nome: "Shopee" }],
} = {}) {
  const calls = [];
  const tableRows = {
    cargas: [...existingSheetRows, ...templateRows],
    route_metrics_cache: routeCatalogRows,
    clientes: clientRows,
  };

  function applyFilters(rows, filters) {
    return rows.filter((row) => filters.every((filter) => filter(row)));
  }

  function applyOrdering(rows, orderBy) {
    if (!orderBy) {
      return rows;
    }

    const { column, ascending } = orderBy;
    const direction = ascending ? 1 : -1;

    return [...rows].sort((rowA, rowB) => {
      const valueA = rowA[column];
      const valueB = rowB[column];

      if (valueA == null && valueB == null) {
        return 0;
      }

      if (valueA == null) {
        return 1;
      }

      if (valueB == null) {
        return -1;
      }

      if (valueA < valueB) {
        return -1 * direction;
      }

      if (valueA > valueB) {
        return 1 * direction;
      }

      return 0;
    });
  }

  function createQueryBuilder(table) {
    const state = {
      filters: [],
      orderBy: null,
    };

    return {
      select(columns) {
        calls.push(["select", table, columns]);
        return this;
      },
      not(column, operator, value) {
        calls.push(["not", table, column, operator, value]);

        if (operator === "is") {
          state.filters.push((row) => row[column] !== value);
        }

        return this;
      },
      eq(column, value) {
        calls.push(["eq", table, column, value]);
        state.filters.push((row) => row[column] === value);
        return this;
      },
      order(column, options) {
        calls.push(["order", table, column, options]);
        state.orderBy = {
          column,
          ascending: options?.ascending !== false,
        };
        return this;
      },
      range(from, to) {
        calls.push(["range", table, from, to]);
        const rows = applyOrdering(applyFilters(tableRows[table] || [], state.filters), state.orderBy);
        return Promise.resolve({
          data: rows.slice(from, to + 1),
          error: null,
        });
      },
      upsert(payload, options) {
        calls.push(["upsert", table, payload, options]);
        // Emulates PostgREST: upsert is awaitable AND chainable with .select().maybeSingle()
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
      update(payload) {
        calls.push(["update", table, payload]);
        return {
          in(column, values) {
            calls.push(["in", table, column, values]);
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
      delete() {
        calls.push(["delete", table]);
        return {
          in(column, values) {
            calls.push(["in", table, column, values]);
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    };
  }

  return {
    calls,
    from(table) {
      calls.push(["from", table]);
      return createQueryBuilder(table);
    },
  };
}

import { beforeEach } from "vitest";

describe("google sheet loads sync", () => {
  beforeEach(() => {
    pgQueryCalls.length = 0;
  });
  it("formats spreadsheet locations into the dashboard-friendly pattern", () => {
    expect(formatSpreadsheetLocation("SoC_PE_Jaboatao dos Guararapes")).toBe(
      "Jaboatao dos Guararapes / PE",
    );
    expect(formatSpreadsheetLocation("LM Hub_BA_Salvador_Piraja")).toBe("Salvador Piraja / BA");
  });

  it("parses only rows with LH, blank driver name, blank status, and routing data", () => {
    const loads = parseAvailableGoogleSheetLoads(SAMPLE_CSV);

    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      lh: "LT0Q4302267L1",
      tipo: "ForeCast",
      data: "2026-04-03",
      horario: "22:30:00",
      carregamentoLabel: "03/04/2026 22:30",
      descargaLabel: "04/04/2026 16:30",
      origem: "Jaboatao dos Guararapes / PE",
      destino: "Simoes Filho / BA",
    });
  });

  it("normalizes spreadsheet datetimes that arrive with hyphens and no space before the hour", () => {
    const loads = parseAvailableGoogleSheetLoads(SAMPLE_CSV_WITH_GLUE_DATETIME);

    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      data: "2026-04-11",
      horario: "07:00:00",
      carregamentoLabel: "11/04/2026 07:00",
      descargaLabel: "12/04/2026 16:30",
    });
  });

  it("parses the optional sheet value column when it exists", () => {
    const loads = parseAvailableGoogleSheetLoads(SAMPLE_CSV_WITH_VALUE);

    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      lh: "LT0Q4302267L1",
      valor: 4500,
    });
  });

  it("treats a blank sheet value cell as an omitted value update", () => {
    const loads = parseAvailableGoogleSheetLoads(SAMPLE_CSV_WITH_BLANK_VALUE_COLUMN);

    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      lh: "LT0Q4302267L1",
      valor: undefined,
    });
  });

  it("fills the load value from the built-in base route list when the sheet does not export a value", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      cliente_id: SHEET_CLIENT_ID,
      valor: 5350,
    });
  });

  it("matches operational aliases when filling values from the base route list", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV_WITH_OPERATIONAL_ALIASES)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV_WITH_OPERATIONAL_ALIASES),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      cliente_id: SHEET_CLIENT_ID,
      origem: "SJ Rio Preto-02 / SP",
      destino: "Simoes Filho / BA",
      valor: 14000,
    });
  });

  it("uses route catalog defaults when origem and destino identify a configured route", async () => {
    const supabaseClient = createSupabaseMock({
      routeCatalogRows: [
        {
          id: "route-1",
          origin_key: "jaboatao dos guararapes",
          destination_key: "simoes filho",
          origem: "Jaboatao dos Guararapes",
          destino: "Simoes Filho",
          distancia_km: 781,
          duracao_horas: 15.5,
          perfil_padrao: "CARRETA - EXPRESSA",
          valor_padrao: 5250,
          bonus_padrao: 350,
          ativa: true,
          updated_at: "2026-04-06T12:00:00.000Z",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      cliente_id: SHEET_CLIENT_ID,
      perfil: "CARRETA_EXPRESSA",
      valor: 5250,
      bonus: 350,
      distancia_km: 781,
      duracao_horas: 15.5,
    });
  });

  it("keeps Shopee as the client for the online sheet while still using route template defaults", async () => {
    const supabaseClient = createSupabaseMock({
      templateRows: [
        {
          id: "template-1",
          origem: "Jaboatao dos Guararapes",
          destino: "Simoes Filho",
          perfil: "TRUCK",
          valor: 6100,
          bonus: 450,
          cliente_id: "client-route-template",
          distancia_km: 790,
          duracao_horas: 16,
          is_template: true,
          created_at: "2026-04-06T09:30:00.000Z",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      cliente_id: SHEET_CLIENT_ID,
      perfil: "TRUCK",
      valor: 6100,
      bonus: 450,
      distancia_km: 790,
      duracao_horas: 16,
    });
  });

  it("resolves Shopee automatically from the configured online sheet source when no client id is passed", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      cliente_id: SHEET_CLIENT_ID,
    });

    expect(
      supabaseClient.calls.some(
        (call) => call[0] === "eq" && call[1] === "clientes" && call[2] === "nome" && call[3] === "Shopee",
      ),
    ).toBe(true);
  });

  it("upserts the sheet loads and unlinks stale rows that disappeared from the sheet", async () => {
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [{ id: "00000000-0000-4000-a000-000000000001", sheet_lh: "LT-OLD-0001" }],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.availableLoadsCount).toBe(1);
    expect(result.unlinkedLoadsCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();

    const payload = upsertCall[2];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: createSheetLoadId("LT0Q4302267L1"),
      sheet_lh: "LT0Q4302267L1",
      sheet_data_carregamento: "03/04/2026 22:30",
      sheet_data_descarga: "04/04/2026 16:30",
      origem: "Jaboatao dos Guararapes / PE",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      cliente_id: SHEET_CLIENT_ID,
    });
  });

  it("skips only the invalid spreadsheet rows and keeps syncing the valid loads", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV_WITH_ONE_INVALID_ROW)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV_WITH_ONE_INVALID_ROW),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.availableLoadsCount).toBe(1);
    expect(result.skippedInvalidLoadsCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[google-sheet-loads] skipped rows with invalid datetime",
      expect.objectContaining({
        count: 1,
      }),
    );

    warnSpy.mockRestore();
  });

  it("reverts BOOKED loads to OPEN when the sheet clears the motorista and status", async () => {
    const existingId = createSheetLoadId("LT0Q4302267L1");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: existingId,
          sheet_lh: "LT0Q4302267L1",
          status: "BOOKED",
          valor: 5000,
          perfil: "CARRETA",
          bonus: null,
          distancia_km: null,
          duracao_horas: null,
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.revertedToOpenCount).toBe(1);

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      status: "OPEN",
    });
  });

  it("preserves RESERVED status when the sheet shows the load as available", async () => {
    const existingId = createSheetLoadId("LT0Q4302267L1");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: existingId,
          sheet_lh: "LT0Q4302267L1",
          status: "RESERVED",
          valor: 5000,
          perfil: "CARRETA",
          bonus: null,
          distancia_km: null,
          duracao_horas: null,
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.revertedToOpenCount).toBe(0);

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      status: "RESERVED",
    });
  });

  it("reopens an EXPIRED load to OPEN when the sheet lists it as available and its date is in the future", async () => {
    // Carga foi expirada (cron, ou correção de uma alocação errada na planilha
    // depois da data vencer) e ficou presa em EXPIRED. A planilha volta a
    // listá-la disponível com data FUTURA → o sync deve reabrir para OPEN.
    const futureCsv = SAMPLE_CSV.replace("03/04/2026 22:30:00", "31/12/2099 22:30:00");
    const existingId = createSheetLoadId("LT0Q4302267L1");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: existingId,
          sheet_lh: "LT0Q4302267L1",
          status: "EXPIRED",
          // cron-expire NÃO limpa sheet_synced_at — carga continua "do sync".
          sheet_synced_at: "2026-06-01T00:00:00.000Z",
          valor: 5000,
          perfil: "CARRETA",
          bonus: null,
          distancia_km: null,
          duracao_horas: null,
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(futureCsv)),
      text: vi.fn().mockResolvedValue(futureCsv),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.revivedExpiredCount).toBe(1);

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    const revived = upsertCall[2].find((row) => row.sheet_lh === "LT0Q4302267L1");
    expect(revived).toMatchObject({ sheet_lh: "LT0Q4302267L1", status: "OPEN" });
  });

  it("keeps an EXPIRED load expired when the available sheet row is still in the past (no flapping)", async () => {
    // Mesma carga EXPIRED, mas a data da planilha continua no passado: reabrir
    // só para o cron reexpirar provocaria flapping (eventos realtime/egress).
    // SAMPLE_CSV usa datas de abr/2026 (passado) → deve permanecer EXPIRED.
    const existingId = createSheetLoadId("LT0Q4302267L1");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: existingId,
          sheet_lh: "LT0Q4302267L1",
          status: "EXPIRED",
          sheet_synced_at: "2026-06-01T00:00:00.000Z",
          valor: 5000,
          perfil: "CARRETA",
          bonus: null,
          distancia_km: null,
          duracao_horas: null,
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.revivedExpiredCount).toBe(0);

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    const stale = upsertCall[2].find((row) => row.sheet_lh === "LT0Q4302267L1");
    expect(stale).toMatchObject({ sheet_lh: "LT0Q4302267L1", status: "EXPIRED" });
  });

  it("does NOT flip a RESERVED load to BOOKED when its sheet row becomes closed (driver assigned)", async () => {
    // Cenário do bug: carga reservada no portal; alguém preenche o motorista na
    // linha da planilha. O sync NÃO pode tocar a carga (senão vira BOOKED e o
    // cancelar-reserva deixa de reabrir → carga presa). LH "LT0Q4402267J1" tem
    // motorista "Antonio" no SAMPLE_CSV (linha fechada, presente na planilha).
    const reservedId = createSheetLoadId("LT0Q4402267J1");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: reservedId,
          sheet_lh: "LT0Q4402267J1",
          status: "RESERVED",
          sheet_synced_at: "2026-06-27T00:00:00.000Z",
          valor: 5000,
          perfil: "CARRETA",
          bonus: null,
          distancia_km: null,
          duracao_horas: null,
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    // Nenhuma query de UPDATE (staleInSheet/trulyGone) pode referenciar a carga reservada.
    const touchedReserved = pgQueryCalls.some((c) => JSON.stringify(c.params ?? []).includes(reservedId));
    expect(touchedReserved).toBe(false);
  });

  it("still flips an OPEN load to BOOKED when its sheet row is closed (OPEN regression)", async () => {
    const openId = createSheetLoadId("LT0Q4402267J1");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: openId,
          sheet_lh: "LT0Q4402267J1",
          status: "OPEN",
          sheet_synced_at: "2026-06-27T00:00:00.000Z",
          valor: 5000,
          perfil: "CARRETA",
          bonus: null,
          distancia_km: null,
          duracao_horas: null,
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    const staleInSheetCall = pgQueryCalls.find((c) => c.sql.includes("UPDATE public.cargas c"));
    expect(staleInSheetCall).toBeTruthy();
    // SQL só transita OPEN→BOOKED (RESERVED nunca).
    expect(staleInSheetCall.sql).toContain("WHEN c.status = 'OPEN' THEN 'BOOKED'");
    expect(staleInSheetCall.sql).not.toContain("IN ('OPEN', 'RESERVED')");
    // O id da carga OPEN é alvo do UPDATE (params[1] = array de ids).
    expect(staleInSheetCall.params[1]).toContain(openId);
  });

  it("excludes RESERVED from the truly-gone batch but still expires OPEN when the row is removed", async () => {
    const reservedGoneId = createSheetLoadId("LT-GONE-RSVD");
    const openGoneId = createSheetLoadId("LT-GONE-OPEN");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        {
          id: reservedGoneId,
          sheet_lh: "LT-GONE-RSVD",
          status: "RESERVED",
          sheet_synced_at: "2026-06-27T00:00:00.000Z",
          perfil: "CARRETA",
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
        {
          id: openGoneId,
          sheet_lh: "LT-GONE-OPEN",
          status: "OPEN",
          sheet_synced_at: "2026-06-27T00:00:00.000Z",
          perfil: "CARRETA",
          cliente_id: SHEET_CLIENT_ID,
          is_template: false,
          created_by: null,
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    const trulyGoneCall = pgQueryCalls.find(
      (c) => c.sql.includes("UPDATE public.cargas") && c.sql.includes("WHEN status = 'OPEN' THEN 'EXPIRED'"),
    );
    expect(trulyGoneCall).toBeTruthy();
    expect(trulyGoneCall.params[0]).toContain(openGoneId);
    expect(trulyGoneCall.params[0]).not.toContain(reservedGoneId);
    // E o SQL não tem mais a transição RESERVED→BOOKED.
    expect(trulyGoneCall.sql).not.toContain("'RESERVED'");
  });

  it("preserves operator-edited valor on existing loads even when sheet exports a different amount", async () => {
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        { id: createSheetLoadId("LT0Q4302267L1"), sheet_lh: "LT0Q4302267L1", valor: 7800 },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV_WITH_VALUE)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV_WITH_VALUE),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    // Existing load valor (7800) is preserved — operator edits are not overwritten by sync
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      valor: 7800,
    });
  });

  it("preserves operator-edited valor on existing loads even when sheet has no value column", async () => {
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        { id: createSheetLoadId("LT0Q4302267L1"), sheet_lh: "LT0Q4302267L1", valor: 7800 },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    // Existing load valor (7800) is preserved — operator edits are not overwritten by sync
    expect(upsertCall[2][0]).toMatchObject({
      sheet_lh: "LT0Q4302267L1",
      valor: 7800,
    });
  });

  it("preserves operator-edited valor when a stale row leaves the sheet", async () => {
    const currentRowId = createSheetLoadId("LT0Q4302267L1");
    const staleRowId = createSheetLoadId("LT-OLD-0001");
    const supabaseClient = createSupabaseMock({
      existingSheetRows: [
        { id: currentRowId, sheet_lh: "LT0Q4302267L1", valor: 7800 },
        { id: staleRowId, sheet_lh: "LT-OLD-0001", valor: 9900 },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV_WITH_BLANK_VALUE_COLUMN)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV_WITH_BLANK_VALUE_COLUMN),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.availableLoadsCount).toBe(1);
    expect(result.unlinkedLoadsCount).toBe(1);

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeTruthy();
    // Existing load valor (7800) is preserved — operator edits are not overwritten by sync
    expect(upsertCall[2][0]).toMatchObject({
      id: currentRowId,
      sheet_lh: "LT0Q4302267L1",
      valor: 7800,
    });
  });

  it("batches stale load unlinks to avoid oversized requests", async () => {
    const existingRows = Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      sheet_lh: `LT-OLD-${index}`,
    }));
    const supabaseClient = createSupabaseMock({
      existingSheetRows: existingRows,
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.availableLoadsCount).toBe(1);
    expect(result.unlinkedLoadsCount).toBe(205);

    // Unlink now uses a single raw SQL UPDATE via withPgClient instead of supabase batches
    // staleTrulyGone query uses WHERE id = ANY($1::uuid[]) — staleInSheet uses UNNEST FROM clause
    const unlinkQueries = pgQueryCalls.filter((call) => call.sql.includes("WHERE id = ANY($1::uuid[])"));
    expect(unlinkQueries).toHaveLength(1);
    expect(unlinkQueries[0].params[0]).toHaveLength(205);
  });

  it("paginates existing sheet loads so rows beyond the first 1000 are also unlinked", async () => {
    const existingRows = [
      { id: "00000000-0000-4000-b000-000000000000", sheet_lh: "LT0Q4302267L1" },
      ...Array.from({ length: 1204 }, (_, index) => ({
        id: `00000000-0000-4000-b000-${String(index + 1).padStart(12, "0")}`,
        sheet_lh: `LT-OLD-PAGE-${index}`,
      })),
    ];
    const supabaseClient = createSupabaseMock({
      existingSheetRows: existingRows,
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });

    const result = await syncGoogleSheetLoads({
      fetchImpl,
      sheetUrl: "https://example.test/sheet.csv",
      supabaseClient,
      sheetClientId: SHEET_CLIENT_ID,
    });

    expect(result.availableLoadsCount).toBe(1);
    expect(result.unlinkedLoadsCount).toBe(1204);

    const rangeCalls = supabaseClient.calls.filter((call) => call[0] === "range");
    const sheetRangeCalls = rangeCalls.filter((call) => call[1] === "cargas");

    expect(sheetRangeCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      sheetRangeCalls.some((call) => call[2] === 0 && call[3] === 999),
    ).toBe(true);
    expect(
      sheetRangeCalls.some((call) => call[2] === 1000 && call[3] === 1999),
    ).toBe(true);
  });

  // Regressão do incidente 2026-05-18 — cliente "Shopee" foi renomeado pra
  // "E-COMMERCE" no DB e o sync ficou 4 dias travado sem alerta visível.
  // Garantir que o erro é tipado E que `[security-event] sheet.client.missing`
  // sai no log para o Loki/Grafana poder alarmar.
  it("throws a typed SheetClientNotConfiguredError when the sheet client name does not exist in DB", async () => {
    const supabaseClient = createSupabaseMock({ clientRows: [] });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        syncGoogleSheetLoads({
          fetchImpl,
          sheetUrl: "https://example.test/sheet.csv",
          supabaseClient,
          clientName: "Shopee",
        }),
      ).rejects.toMatchObject({
        name: "SheetClientNotConfiguredError",
        code: "SHEET_CLIENT_NOT_CONFIGURED",
        clientName: "Shopee",
      });

      // Confirma que o structured log foi emitido pra que o Loki/Grafana
      // tenha um sinal alarmável ao invés de um throw opaco.
      const eventLogged = errorSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("sheet.client.missing"),
      );
      expect(eventLogged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("throws a typed SheetClientNotConfiguredError when the client name is blank", async () => {
    const supabaseClient = createSupabaseMock();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(SAMPLE_CSV)),
      text: vi.fn().mockResolvedValue(SAMPLE_CSV),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        syncGoogleSheetLoads({
          fetchImpl,
          sheetUrl: "https://example.test/sheet.csv",
          supabaseClient,
          clientName: "   ",
        }),
      ).rejects.toBeInstanceOf(SheetClientNotConfiguredError);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("updateSheetMonitorSnapshot", () => {
  function createSnapshotSupabaseClient({ upsertError = null, returnedSyncedAt = null } = {}) {
    const calls = [];

    return {
      calls,
      from(table) {
        calls.push(["from", table]);
        const chain = {
          upsert(payload, options) {
            calls.push(["upsert", table, payload, options]);
            return chain;
          },
          select(columns) {
            calls.push(["select", table, columns]);
            return chain;
          },
          async maybeSingle() {
            calls.push(["maybeSingle", table]);
            if (upsertError) {
              return { data: null, error: upsertError };
            }
            return {
              data: { id: 1, synced_at: returnedSyncedAt ?? new Date().toISOString() },
              error: null,
            };
          },
        };
        return chain;
      },
    };
  }

  it("returns persisted=true when upsert succeeds", async () => {
    const supabaseClient = createSnapshotSupabaseClient();

    const result = await updateSheetMonitorSnapshot({
      csvText: SAMPLE_CSV,
      supabaseClient,
    });

    expect(result.persisted).toBe(true);
    expect(result.persistError).toBeNull();
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.summary).toEqual(expect.objectContaining({ total: expect.any(Number) }));
    expect(result.syncedAt).toEqual(expect.any(String));

    const upsertCall = supabaseClient.calls.find((call) => call[0] === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall[1]).toBe("sheet_monitor_snapshot");
    expect(upsertCall[2]).toEqual(
      expect.objectContaining({ id: 1, rows_json: expect.any(Array), summary_json: expect.any(Object) }),
    );
    expect(upsertCall[3]).toEqual({ onConflict: "id" });
  });

  it("returns persisted=false and propagates the error when upsert fails", async () => {
    const upsertError = {
      name: "PostgrestError",
      code: "42P01",
      message: 'relation "public.sheet_monitor_snapshot" does not exist',
      hint: "Apply the sheet_monitor_snapshot migration.",
      details: null,
    };
    const supabaseClient = createSnapshotSupabaseClient({ upsertError });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await updateSheetMonitorSnapshot({
        csvText: SAMPLE_CSV,
        supabaseClient,
      });

      expect(result.persisted).toBe(false);
      expect(result.persistError).toEqual({
        code: upsertError.code,
        message: upsertError.message,
        hint: upsertError.hint,
      });
      // Rows/summary still returned so the UI never shows an empty screen.
      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.summary).toBeDefined();
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
