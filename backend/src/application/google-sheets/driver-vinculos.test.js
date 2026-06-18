import { describe, expect, it, vi } from "vitest";

import {
  normalizeDriverNameKey,
  parseDriverVinculos,
  getVinculoSheetCsvUrl,
  syncDriverVinculos,
} from "./driver-vinculos.js";

// CSV que reproduz a forma real da aba "Vinculo" (Motoristas | Vinculo | <lista>).
const SAMPLE_CSV = [
  '"Motoristas","Vinculo",""',
  '"FABIO SOUZA DA SILVA","AGREGADO DEDICADO","Vinculo"',
  '"JOSÉ COSME GONÇALVES DIAS","AGREGADO DEDICADO","PME"',
  '"INALDO NOBREGA DE OLIVEIRA","FROTA",""',
  '"WILLIAM DE SOUZA SANTOS","PX",""',
  '"\tUELITON DE JESUS SILVA","FROTA",""',
  '"FROTA","FROTA",""',
  '"","AGREGADO DEDICADO",""',
].join("\n");

describe("normalizeDriverNameKey", () => {
  it("remove acentos, baixa caixa e colapsa espacos/tabs", () => {
    expect(normalizeDriverNameKey("JOSÉ COSME GONÇALVES DIAS")).toBe("jose cosme goncalves dias");
    expect(normalizeDriverNameKey("  Maria   Santos\t")).toBe("maria santos");
    expect(normalizeDriverNameKey("\tUELITON DE JESUS SILVA")).toBe("ueliton de jesus silva");
  });

  it("retorna string vazia para entradas invalidas", () => {
    expect(normalizeDriverNameKey(null)).toBe("");
    expect(normalizeDriverNameKey(undefined)).toBe("");
    expect(normalizeDriverNameKey("   ")).toBe("");
  });
});

describe("parseDriverVinculos", () => {
  it("extrai (nome, vinculo) e descarta linhas-ruido", () => {
    const records = parseDriverVinculos(SAMPLE_CSV);
    const byKey = new Map(records.map((r) => [r.nome_normalizado, r.vinculo]));

    expect(byKey.get("fabio souza da silva")).toBe("AGREGADO DEDICADO");
    expect(byKey.get("jose cosme goncalves dias")).toBe("AGREGADO DEDICADO");
    expect(byKey.get("inaldo nobrega de oliveira")).toBe("FROTA");
    expect(byKey.get("william de souza santos")).toBe("PX");
    expect(byKey.get("ueliton de jesus silva")).toBe("FROTA");

    // Ruido descartado: "FROTA","FROTA" (nome == vinculo) e linha sem nome.
    expect(byKey.has("frota")).toBe(false);
    expect(records.every((r) => r.nome_normalizado && r.vinculo)).toBe(true);
  });

  it("retorna [] quando o CSV nao tem o cabecalho esperado", () => {
    expect(parseDriverVinculos('"foo","bar"\n"1","2"')).toEqual([]);
  });
});

describe("getVinculoSheetCsvUrl", () => {
  it("monta a URL gviz por nome de aba quando GOOGLE_SHEET_ID esta setado", () => {
    vi.stubEnv("GOOGLE_SHEET_ID", "SHEET123");
    const url = getVinculoSheetCsvUrl();
    expect(url).toContain("/d/SHEET123/gviz/tq");
    expect(url).toContain("tqx=out:csv");
    expect(url).toContain("sheet=");
    vi.unstubAllEnvs();
  });
});

describe("syncDriverVinculos", () => {
  function createFakeSupabase() {
    const upserted = [];
    const deletes = [];
    const client = {
      from: () => ({
        upsert: (rows) => {
          upserted.push(...rows);
          return Promise.resolve({ error: null });
        },
        delete: () => ({
          not: (column, op, value) => {
            deletes.push({ column, op, value });
            return Promise.resolve({ error: null, count: 0 });
          },
        }),
      }),
    };
    return { client, upserted, deletes };
  }

  it("faz upsert dos registros parseados e remove os ausentes", async () => {
    const { client, upserted, deletes } = createFakeSupabase();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(SAMPLE_CSV).buffer,
    });

    const result = await syncDriverVinculos({
      fetchImpl,
      csvUrl: "https://example.test/vinculo.csv",
      supabaseClient: client,
    });

    expect(result.skipped).toBe(false);
    expect(result.upserted).toBe(upserted.length);
    expect(upserted.find((r) => r.nome_normalizado === "jose cosme goncalves dias")?.vinculo).toBe(
      "AGREGADO DEDICADO",
    );
    // O delete-not-in recebe a lista de chaves atuais.
    expect(deletes).toHaveLength(1);
    expect(deletes[0].value).toContain("fabio souza da silva");
  });

  it("e no-op quando csvUrl nao esta configurada", async () => {
    const { client } = createFakeSupabase();
    const result = await syncDriverVinculos({ fetchImpl: vi.fn(), csvUrl: null, supabaseClient: client });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("GOOGLE_SHEET_ID_NOT_CONFIGURED");
  });
});
