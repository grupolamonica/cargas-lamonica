import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do acesso ao banco: withPgClient devolve linhas canned (não precisa de
// schema real — o foco do teste é a MONTAGEM dos updates + a decisão de gravar).
const cannedRows = { current: [] };
const lastSql = { current: "" };
const queryCount = { current: 0 };
vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql) => {
        lastSql.current = typeof sql === "string" ? sql : (sql?.text ?? "");
        queryCount.current += 1;
        return { rows: cannedRows.current };
      },
    }),
}));

const { reconcileTakenCargosToSheet } = await import("./reconcile-sheet-allocations.js");

describe("reconcileTakenCargosToSheet", () => {
  let fetchMock;

  beforeEach(() => {
    process.env.GOOGLE_SHEET_WRITEBACK_URL = "https://example.test/exec";
    fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, updated: 99 }),
    }));
    globalThis.fetch = fetchMock;
    cannedRows.current = [];
    lastSql.current = "";
    queryCount.current = 0;
  });

  afterEach(() => {
    delete process.env.GOOGLE_SHEET_WRITEBACK_URL;
    vi.restoreAllMocks();
  });

  it("não faz nada quando o write-back está desligado (sem URL)", async () => {
    delete process.env.GOOGLE_SHEET_WRITEBACK_URL;
    cannedRows.current = [{ lh: "LT1", alloc_motorista: "Fulano" }];
    const res = await reconcileTakenCargosToSheet();
    expect(res.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("grava alocação (nome do operador) e reserva (nome Angellira) — sem mandar status", async () => {
    cannedRows.current = [
      {
        lh: "LT-ALLOC",
        alloc_motorista: "Leonardo Lima",
        alloc_cavalo: "ABC1D23",
        alloc_carreta: "XYZ9K88",
        validation_summary_json: null,
      },
      {
        lh: "LT-RESERVA",
        alloc_motorista: null,
        alloc_cavalo: null,
        alloc_carreta: null,
        horse_plate: "HHH1A11",
        trailer_plate: "TTT2B22",
        validation_summary_json: { driver: { angelira: { displayName: "Maria Souza" } } },
      },
    ];

    const res = await reconcileTakenCargosToSheet();
    expect(res.ok).toBe(true);
    expect(res.reconciled).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const byLh = Object.fromEntries(body.updates.map((u) => [u.lh, u]));

    expect(byLh["LT-ALLOC"]).toMatchObject({ motorista: "Leonardo Lima", cavalo: "ABC1D23", carreta: "XYZ9K88" });
    expect(byLh["LT-RESERVA"]).toMatchObject({ motorista: "Maria Souza", cavalo: "HHH1A11", carreta: "TTT2B22" });
    // NÃO envia `status` — o reconciliador só preenche motorista/placas, não
    // re-rotula a coluna de status da planilha.
    expect("status" in byLh["LT-ALLOC"]).toBe(false);
    expect("status" in byLh["LT-RESERVA"]).toBe(false);
  });

  it("carga do SISTEMA (create_row): CRIA-ou-preenche a linha (createIfMissing + rota/agenda)", async () => {
    cannedRows.current = [
      {
        lh: "LT-SISTEMA",
        create_row: true,
        sheet_source: null,
        alloc_motorista: "Carlos Pereira",
        alloc_cavalo: "AAA1B22",
        alloc_carreta: "CCC3D44",
        origem: "Jaboatao dos Guararapes/PE",
        destino: "Simoes Filho/BA",
        carreg: "2026-07-29T10:30",
        descarga: "2026-07-30T04:30",
        validation_summary_json: null,
      },
    ];

    const res = await reconcileTakenCargosToSheet();
    expect(res.ok).toBe(true);
    expect(res.reconciled).toBe(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const u = body.updates[0];
    expect(u).toMatchObject({
      lh: "LT-SISTEMA",
      motorista: "Carlos Pereira",
      cavalo: "AAA1B22",
      carreta: "CCC3D44",
      createIfMissing: true,
      origem: "Jaboatao dos Guararapes/PE",
      destino: "Simoes Filho/BA",
    });
    // Datas ISO denormalizadas → formato da planilha (DD/MM/YYYY HH:MM).
    expect(u.dataCarregamento).toBe("29/07/2026 10:30");
    expect(u.dataDescarga).toBe("30/07/2026 04:30");
    // Reconciliador NÃO manda status (não re-rotula a coluna de status).
    expect("status" in u).toBe(false);
  });

  it("pula linha sem nada para gravar (sem motorista e sem placas)", async () => {
    cannedRows.current = [{ lh: "LT-VAZIO", alloc_motorista: null, validation_summary_json: null }];
    const res = await reconcileTakenCargosToSheet();
    expect(res.reconciled).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Egress: forma da query ─────────────────────────────────────────────────
  // O SQL não roda em pg-mem (jsonb_array_elements sobre COLUNA não é suportado
  // pelo harness — vale para a forma antiga e para a nova), então as guardas são
  // travadas pelo TEXTO emitido. Qualquer remoção/afrouxamento derruba o teste.
  describe("forma da query (egress + guardas)", () => {
    beforeEach(async () => {
      cannedRows.current = [];
      await reconcileTakenCargosToSheet();
    });

    it("expande o snapshot UMA única vez (antes eram dois scans do rows_json)", () => {
      const matches = lastSql.current.match(/jsonb_array_elements\(/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(queryCount.current).toBe(1);
    });

    it("não seleciona mais o validation_summary_json cru — só o displayName", () => {
      expect(lastSql.current).toContain("->'driver'->'angelira'->>'displayName'");
      expect(lastSql.current).toContain("AS angelira_display_name");
      // Nenhuma referência à coluna crua como item de SELECT.
      expect(lastSql.current).not.toMatch(/l\.validation_summary_json(?!\s*->)/);
      expect(lastSql.current).not.toContain("NULL::jsonb AS validation_summary_json");
    });

    it("mantém TODAS as guardas do reconciliador", () => {
      const sql = lastSql.current;
      // Classe (1): só linha EM BRANCO na planilha, e só carga tomada.
      expect(sql).toContain("blank_sheet");
      expect(sql).toMatch(/COALESCE\(TRIM\(e->>'motoristas'\), ''\)/);
      expect(sql).toContain("JOIN blank_sheet b ON b.lh = c.sheet_lh");
      expect(sql).toMatch(/c\.status = 'RESERVED' OR COALESCE\(TRIM\(c\.alloc_motorista\), ''\) <> ''/);
      // Classe (2): sem sheet_lh, com alocação, sem linha já escrita, só "LT…".
      expect(sql).toContain("sheet_has_driver");
      expect(sql).toContain("LEFT JOIN sheet_has_driver d ON d.lh = c.lh_manual");
      expect(sql).toContain("d.lh IS NULL");
      expect(sql).toContain("c.sheet_lh IS NULL");
      expect(sql).toMatch(/upper\(TRIM\(c\.lh_manual\)\) LIKE 'LT%'/);
      // Cap por classe/ciclo.
      expect(sql.match(/LIMIT 100/g) ?? []).toHaveLength(2);
      // Linha sem LH nunca entra em nenhum dos dois conjuntos.
      expect(sql).toMatch(/COALESCE\(TRIM\(e->>'lh'\), ''\) <> ''/);
    });
  });

  // ── Egress: a coluna extraída no SQL alimenta o mesmo write-back ───────────
  it("usa angelira_display_name (extraído no SQL) no lugar do JSON inteiro", async () => {
    cannedRows.current = [
      {
        lh: "LT-RESERVA",
        alloc_motorista: null,
        horse_plate: "HHH1A11",
        trailer_plate: "TTT2B22",
        angelira_display_name: "Maria Souza",
      },
    ];

    const res = await reconcileTakenCargosToSheet();
    expect(res.reconciled).toBe(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.updates[0]).toMatchObject({
      lh: "LT-RESERVA",
      motorista: "Maria Souza",
      cavalo: "HHH1A11",
      carreta: "TTT2B22",
    });
  });

  it("angelira_display_name NULL sem alocação e sem placas → pula (como antes)", async () => {
    cannedRows.current = [{ lh: "LT-NULO", alloc_motorista: null, angelira_display_name: null }];
    const res = await reconcileTakenCargosToSheet();
    expect(res.reconciled).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
