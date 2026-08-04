import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetNestleIndexCache,
  applyNestleSchedule,
  fetchNestleMonitorIndex,
  nestleIndexLookup,
  nestleStatusIndex,
  nestleStatusOperacional,
  parseGalileuDateTime,
} from "./nestle-monitor-overlay.js";

// Cliente pg falso: responde a 1ª query (ofertas) e a 2ª (embarques) na ordem em
// que o use-case as faz. Espelha o shape das colunas reais do Galileu.
function fakePg({ ofertas = [], embarques = [], erro = null } = {}) {
  let chamada = 0;
  const client = {
    query: vi.fn(async () => {
      if (erro) throw erro;
      chamada += 1;
      return { rows: chamada === 1 ? ofertas : embarques };
    }),
  };
  return { withPgClient: async (fn) => fn(client), client };
}

beforeEach(() => {
  __resetNestleIndexCache();
  delete process.env.NESTLE_MONITOR_LIVE_ENABLED;
  process.env.NESTLE_MONITOR_CACHE_SECONDS = "0"; // sem memo entre casos
});
afterEach(() => {
  delete process.env.NESTLE_MONITOR_CACHE_SECONDS;
});

describe("nestleStatusOperacional (Galileu → vocabulário do Monitor)", () => {
  it("traduz os estados conhecidos para o pipeline do Monitor", () => {
    expect(nestleStatusOperacional("AGUARDANDO INICIO")).toBe("AGUARDANDO CHEGAR NO CLIENTE");
    expect(nestleStatusOperacional("EM VIAGEM")).toBe("CARREGADO");
    expect(nestleStatusOperacional("FINALIZADO")).toBe("DESCARREGADO");
    expect(nestleStatusOperacional("PENDENTE FINALIZACAO")).toBe("AGUARDANDO DESCARGA");
  });

  it("casa as variantes qualificadas de PENDENTE FINALIZACAO por conteúdo", () => {
    // O Galileu qualifica o rótulo (27 das 31 linhas nesse estado, medido em prod).
    expect(nestleStatusOperacional("PENDENTE DE VINCULO (PENDENTE FINALIZACAO)")).toBe("AGUARDANDO DESCARGA");
    expect(nestleStatusOperacional("PENDENTE DE DEV. (PENDENTE FINALIZACAO)")).toBe("AGUARDANDO DESCARGA");
    expect(nestleStatusOperacional("AG. DELIVERY DE DEVOLUÇÃO (PENDENTE FINALIZACAO)")).toBe("AGUARDANDO DESCARGA");
  });

  it("NÃO traduz CANCELADO (dispararia a cascata de rota retroativa)", () => {
    expect(nestleStatusOperacional("CANCELADO")).toBe("");
  });

  it("status desconhecido/vazio → sem tradução (sem overlay)", () => {
    expect(nestleStatusOperacional("ESTADO NOVO DO GALILEU")).toBe("");
    expect(nestleStatusOperacional("")).toBe("");
    expect(nestleStatusOperacional(null)).toBe("");
  });
});

describe("parseGalileuDateTime", () => {
  it("aceita o ISO naive do Galileu e devolve o shape do overlay", () => {
    expect(parseGalileuDateTime("2026-08-04T16:00:00")).toEqual({
      label: "04/08/2026 16:00",
      dateIso: "2026-08-04",
      timeIso: "16:00",
      at: "2026-08-04T16:00",
    });
  });
  it("aceita separador por espaço", () => {
    expect(parseGalileuDateTime("2026-08-04 16:30").label).toBe("04/08/2026 16:30");
  });
  it("valor ausente/inválido → null", () => {
    expect(parseGalileuDateTime(null)).toBeNull();
    expect(parseGalileuDateTime("")).toBeNull();
    expect(parseGalileuDateTime("04/08/2026 16:00")).toBeNull(); // formato BR não é do Galileu
  });
});

describe("fetchNestleMonitorIndex", () => {
  it("indexa a oferta por grupos_id/codembarque/codprogcoleta", async () => {
    const { withPgClient } = fakePg({
      ofertas: [
        {
          grupos_id: "B101474178",
          codembarque: "2337001",
          codprogcoleta: "CP-9",
          dtahrprevatual: "2026-08-06T01:00:00",
          dtahrpreventrega: "2026-08-07T09:00:00",
        },
      ],
    });
    const idx = await fetchNestleMonitorIndex({ deps: { withPgClient } });
    for (const chave of ["B101474178", "2337001", "CP-9"]) {
      expect(idx.get(chave).carga.at).toBe("2026-08-06T01:00");
      expect(idx.get(chave).descarga.at).toBe("2026-08-07T09:00");
      expect(idx.get(chave).status).toBe("");
    }
  });

  it("o EMBARQUE sobrepõe a oferta: a viagem já carregada/em viagem manda", async () => {
    const { withPgClient } = fakePg({
      ofertas: [{ grupos_id: "B1", codembarque: "E1", codprogcoleta: null, dtahrprevatual: "2026-08-01T05:00:00", dtahrpreventrega: null }],
      embarques: [
        {
          codembarque: "E1",
          grupos_id: "B1",
          codprogcoleta: null,
          descrstatembarque: "EM VIAGEM",
          carreg_previsto: "2026-08-04T14:00:00",
          carreg_real: "2026-08-04T04:44:00",
          desc_previsto: "2026-08-05T00:00:00",
          desc_real: null,
        },
      ],
    });
    const idx = await fetchNestleMonitorIndex({ deps: { withPgClient } });
    // PREVISTO manda (mesma regra do overlay Shopee); REAL é só fallback.
    expect(idx.get("B1").carga.at).toBe("2026-08-04T14:00");
    expect(idx.get("B1").status).toBe("CARREGADO");
  });

  it("cai para a data REAL da coleta quando não há previsão", async () => {
    const { withPgClient } = fakePg({
      embarques: [
        {
          codembarque: "E2",
          grupos_id: "B2",
          codprogcoleta: null,
          descrstatembarque: "FINALIZADO",
          carreg_previsto: null,
          carreg_real: "2026-07-31T03:49:00",
          desc_previsto: null,
          desc_real: null,
        },
      ],
    });
    const idx = await fetchNestleMonitorIndex({ deps: { withPgClient } });
    expect(idx.get("B2").carga.at).toBe("2026-07-31T03:49");
    expect(idx.get("B2").descarga).toBeNull();
  });

  it("tabela ausente (42P01) → null, sem log de erro (prod sem migration)", async () => {
    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { withPgClient } = fakePg({ erro: err });
    expect(await fetchNestleMonitorIndex({ deps: { withPgClient } })).toBeNull();
  });

  it("kill-switch NESTLE_MONITOR_LIVE_ENABLED=false → null sem tocar o banco", async () => {
    process.env.NESTLE_MONITOR_LIVE_ENABLED = "false";
    const { withPgClient, client } = fakePg({ ofertas: [{ grupos_id: "B3", dtahrprevatual: "2026-08-04T10:00:00" }] });
    expect(await fetchNestleMonitorIndex({ deps: { withPgClient } })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("nestleIndexLookup", () => {
  const idx = new Map([["B101473490", { carga: null, descarga: null, status: "CARREGADO" }]]);

  it("casa o LH direto", () => {
    expect(nestleIndexLookup(idx, "B101473490").status).toBe("CARREGADO");
  });

  it("casa LH MULTI-GRUPO (célula com vírgula, como a planilha/lançamento gravam)", () => {
    expect(nestleIndexLookup(idx, "B101474063, B101473490").status).toBe("CARREGADO");
  });

  it("sem match / índice vazio → null", () => {
    expect(nestleIndexLookup(idx, "LT0Q8602CPLC1")).toBeNull();
    expect(nestleIndexLookup(null, "B101473490")).toBeNull();
    expect(nestleIndexLookup(idx, "")).toBeNull();
  });
});

describe("applyNestleSchedule", () => {
  const carga = { label: "05/08/2026 10:00", dateIso: "2026-08-05", timeIso: "10:00", at: "2026-08-05T10:00" };
  const descarga = { label: "06/08/2026 08:00", dateIso: "2026-08-06", timeIso: "08:00", at: "2026-08-06T08:00" };
  const nestleByLh = new Map([["B1", { carga, descarga, status: "CARREGADO" }]]);

  it("o Galileu SOBREPÕE a agenda já preenchida (decisão de operação)", () => {
    const row = { lh: "B1", data: "2026-08-03", horario: "00:00", carregamentoLabel: "03/08/2026 00:00", descargaLabel: null, cargaAt: "2026-08-03T00:00" };
    const out = applyNestleSchedule(row, { nestleByLh });
    expect(out.carregamentoLabel).toBe("05/08/2026 10:00");
    expect(out.data).toBe("2026-08-05");
    expect(out.horario).toBe("10:00");
    expect(out.cargaAt).toBe("2026-08-05T10:00");
    expect(out.descargaLabel).toBe("06/08/2026 08:00");
    expect(out.descargaAt).toBe("2026-08-06T08:00");
  });

  it("não toca motorista/status (overlay é só de agenda)", () => {
    const row = { lh: "B1", motoristas: "JOAO", status: "CTE ENVIADO" };
    const out = applyNestleSchedule(row, { nestleByLh });
    expect(out.motoristas).toBe("JOAO");
    expect(out.status).toBe("CTE ENVIADO");
  });

  it("linha Shopee (LH LT…) passa inalterada", () => {
    const row = { lh: "LT0Q8602CPLC1", data: "2026-08-06", horario: "18:00" };
    expect(applyNestleSchedule(row, { nestleByLh })).toBe(row);
  });

  it("sem índice → linha inalterada", () => {
    const row = { lh: "B1", data: "2026-08-03" };
    expect(applyNestleSchedule(row, { nestleByLh: null })).toBe(row);
  });
});

describe("nestleStatusIndex", () => {
  it("projeta só as chaves COM status traduzido", () => {
    const idx = new Map([
      ["B1", { carga: null, descarga: null, status: "CARREGADO" }],
      ["B2", { carga: null, descarga: null, status: "" }], // cancelado/desconhecido
    ]);
    const status = nestleStatusIndex(idx);
    expect(status.get("B1")).toBe("CARREGADO");
    expect(status.has("B2")).toBe(false);
  });

  it("nenhum status → null (caller não sobrepõe nada)", () => {
    expect(nestleStatusIndex(new Map([["B2", { status: "" }]]))).toBeNull();
    expect(nestleStatusIndex(null)).toBeNull();
  });
});
