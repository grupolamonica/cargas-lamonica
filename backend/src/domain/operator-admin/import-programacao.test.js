import { describe, expect, it } from "vitest";

import {
  buildHeaderIndex,
  buildSheetLoadId,
  detectCsvDelimiter,
  normalizeClientName,
  parseImportDate,
  parseImportDateTime,
  parseImportRow,
  parseImportTime,
  splitCsvRows,
  TEMPLATE_EXAMPLE_ROWS,
  TEMPLATE_HEADERS,
} from "./import-programacao.js";

const HEADER = [
  "COD. CARGA",
  "TIPO",
  "VEÍCULO",
  "DATA CARREGAMENTO",
  "DATA DESCARGA",
  "Origem",
  "Destino",
  "CLIENTE",
  "STATUS",
];

const clientes = new Map([
  [normalizeClientName("Shopee"), { id: "uuid-shopee", nome: "Shopee" }],
  [normalizeClientName("São Paulo Express"), { id: "uuid-spx", nome: "São Paulo Express" }],
]);

function row(cells) {
  const { indexByColumn } = buildHeaderIndex(HEADER);
  return parseImportRow(cells, indexByColumn, { clientesByName: clientes });
}

describe("import-programacao parsing helpers", () => {
  it("parses BR and ISO dates, rejects impossible ones", () => {
    expect(parseImportDate("15/07/2026")).toBe("2026-07-15");
    expect(parseImportDate("2026-07-15")).toBe("2026-07-15");
    expect(parseImportDate("31/02/2026")).toBeNull();
    expect(parseImportDate("foo")).toBeNull();
  });

  it("parses date+time, defaulting time to 00:00", () => {
    expect(parseImportDateTime("15/07/2026 08:00")).toEqual({
      date: "2026-07-15",
      time: "08:00",
      label: "15/07/2026 08:00",
    });
    expect(parseImportDateTime("15/07/2026")).toEqual({
      date: "2026-07-15",
      time: "00:00",
      label: "15/07/2026 00:00",
    });
    expect(parseImportDateTime("15/07/2026 99:99")).toBeNull();
    expect(parseImportDateTime("")).toBeNull();
  });

  it("parseImportTime validates ranges", () => {
    expect(parseImportTime("08:00")).toBe("08:00");
    expect(parseImportTime("24:00")).toBeNull();
  });
});

describe("buildSheetLoadId", () => {
  it("is deterministic per COD. CARGA (matches sheet sync UUID algorithm)", () => {
    const id1 = buildSheetLoadId("LH-0012345");
    expect(id1).toBe(buildSheetLoadId("LH-0012345"));
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(buildSheetLoadId("LH-OTHER")).not.toBe(id1);
  });
});

describe("buildHeaderIndex", () => {
  it("maps aliases (accents/punctuation insensitive) and detects missing required", () => {
    const { indexByColumn, missingRequired } = buildHeaderIndex(["COD.CARGA", "Tipo", "Veiculo", "STATUS"]);
    expect(indexByColumn.get("cod_carga")).toBe(0);
    expect(indexByColumn.get("tipo")).toBe(1);
    expect(indexByColumn.get("veiculo")).toBe(2);
    expect(indexByColumn.get("status")).toBe(3);
    // CLIENTE é opcional; faltam DATA CARREGAMENTO, Origem e Destino.
    expect(missingRequired).toEqual(["DATA CARREGAMENTO", "Origem", "Destino"]);
  });
});

describe("parseImportRow", () => {
  it("VEÍCULO→perfil, TIPO(viagem)→sheet_tipo, CLIENTE→cliente_id, COD.CARGA→sheet_lh+id", () => {
    const result = row([
      "LH-0012345",
      "Forecast",
      "CARRETA",
      "15/07/2026 08:00",
      "16/07/2026 18:00",
      "São Paulo - SP",
      "Rio de Janeiro - RJ",
      "shopee",
      "rascunho",
    ]);
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      id: buildSheetLoadId("LH-0012345"),
      sheet_lh: "LH-0012345",
      data: "2026-07-15",
      horario: "08:00",
      perfil: "CARRETA",
      sheet_tipo: "Forecast",
      cliente_id: "uuid-shopee", // resolvido pelo nome (case/acento-insensível)
      origem: "São Paulo - SP",
      destino: "Rio de Janeiro - RJ",
      status: "DRAFT",
      sheet_data_descarga: "16/07/2026 18:00",
    });
    expect(result.preview.cliente_nome).toBe("Shopee");
  });

  it("CLIENTE em branco → cliente_id null (sem erro)", () => {
    const result = row(["LH-1", "Spot", "TRUCK", "16/07/2026", "", "A B", "C D", "", "ativa"]);
    expect(result.ok).toBe(true);
    expect(result.payload.cliente_id).toBeNull();
    expect(result.payload.perfil).toBe("TRUCK");
    expect(result.payload.status).toBe("OPEN");
  });

  it("CLIENTE inexistente → rejeita a linha", () => {
    const result = row(["LH-2", "Forecast", "CARRETA", "16/07/2026", "", "A B", "C D", "Cliente Fantasma", "ativa"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Cliente não encontrado");
  });

  it("VEÍCULO vazio cai em CARRETA; sheet_tipo cru preservado", () => {
    const result = row(["LH-3", "Transferência", "", "16/07/2026", "", "A B", "C D", "", ""]);
    expect(result.ok).toBe(true);
    expect(result.payload.perfil).toBe("CARRETA");
    expect(result.payload.sheet_tipo).toBe("Transferência");
    expect(result.payload.status).toBe("DRAFT");
  });

  it("rejects missing COD. CARGA and bad dates", () => {
    const result = row(["", "Forecast", "CARRETA", "xx", "yy", "A B", "C D", "", "rascunho"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("COD. CARGA é obrigatório");
    expect(result.errors.join(" ")).toContain("DATA CARREGAMENTO inválida");
    expect(result.errors.join(" ")).toContain("DATA DESCARGA inválida");
  });

  it("rejects invalid STATUS", () => {
    const result = row(["LH-9", "Forecast", "CARRETA", "16/07/2026", "", "A B", "C D", "", "PROGRAMADA"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Status inválido");
  });
});

describe("separador (Excel pt-BR usa ;)", () => {
  it("detecta ',' e ';'", () => {
    expect(detectCsvDelimiter("a,b,c")).toBe(",");
    expect(detectCsvDelimiter("a;b;c")).toBe(";");
    expect(detectCsvDelimiter("COD. CARGA;TIPO;VEÍCULO;DATA CARREGAMENTO")).toBe(";");
  });

  it("parseia CSV ;-delimitado sem coluna CLIENTE e descarta linhas vazias (arquivo real)", () => {
    const csv = [
      "COD. CARGA;TIPO;VEÍCULO;DATA CARREGAMENTO;DATA DESCARGA;Origem;Destino;STATUS",
      "B101437150;Transferência;Truck;17/06/2026 10:00;21/06/2026 23:00;SAO BERNARDO DO CAMPO;FEIRA DE SANTANA;ATIVA",
      ";;;;;;;",
      ";;;;;;;",
    ].join("\r\n");

    const matrix = splitCsvRows(csv);
    expect(matrix).toHaveLength(2);

    const { indexByColumn, missingRequired } = buildHeaderIndex(matrix[0]);
    expect(missingRequired).toEqual([]);

    const result = parseImportRow(matrix[1], indexByColumn, { clientesByName: clientes });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      sheet_lh: "B101437150",
      sheet_tipo: "Transferência",
      perfil: "TRUCK",
      data: "2026-06-17",
      horario: "10:00",
      origem: "SAO BERNARDO DO CAMPO",
      destino: "FEIRA DE SANTANA",
      status: "OPEN",
      cliente_id: null, // sem coluna CLIENTE
    });
  });
});

describe("template", () => {
  it("matches the expected header order and arity", () => {
    expect(TEMPLATE_HEADERS).toEqual([
      "COD. CARGA",
      "TIPO",
      "VEÍCULO",
      "DATA CARREGAMENTO",
      "DATA DESCARGA",
      "Origem",
      "Destino",
      "CLIENTE",
      "STATUS",
    ]);
    for (const example of TEMPLATE_EXAMPLE_ROWS) {
      expect(example).toHaveLength(TEMPLATE_HEADERS.length);
    }
  });
});
