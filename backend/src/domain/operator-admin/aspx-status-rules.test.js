import { describe, expect, it } from "vitest";

import {
  shouldUpdateAspxStatus,
  shouldUpdateAspxData,
  parseAspTripRow,
  normalizeAspxStatus,
} from "./aspx-status-rules.js";

describe("shouldUpdateAspxStatus (regras DC-316)", () => {
  it("status vazio: só aceita AGUARDANDO CARREGAMENTO ou CARREGADO", () => {
    expect(shouldUpdateAspxStatus("", "AGUARDANDO CARREGAMENTO")).toBe(true);
    expect(shouldUpdateAspxStatus("", "CARREGADO")).toBe(true);
    // Qualquer outro status novo num vazio → não escreve.
    expect(shouldUpdateAspxStatus("", "AGUARDANDO DESCARGA")).toBe(false);
    expect(shouldUpdateAspxStatus("", "CTE ENVIADO")).toBe(false);
    expect(shouldUpdateAspxStatus("", "CANCELADO")).toBe(false);
    expect(shouldUpdateAspxStatus("   ", "DESCARREGADO")).toBe(false);
  });

  it("sem status novo → nunca atualiza", () => {
    expect(shouldUpdateAspxStatus("CARREGADO", "")).toBe(false);
    expect(shouldUpdateAspxStatus("", "")).toBe(false);
    expect(shouldUpdateAspxStatus("CTE ENVIADO", "   ")).toBe(false);
  });

  it("status igual (ignorando caixa/espaços) → não atualiza", () => {
    expect(shouldUpdateAspxStatus("CARREGADO", "CARREGADO")).toBe(false);
    expect(shouldUpdateAspxStatus(" carregado ", "CARREGADO")).toBe(false);
  });

  it("REGRA 1: NO SHOW e CTE EM EMISSÃO são intocáveis", () => {
    for (const novo of ["CARREGADO", "CANCELADO", "AGUARDANDO DESCARGA", "DESCARREGADO", "CTE ENVIADO"]) {
      expect(shouldUpdateAspxStatus("NO SHOW", novo)).toBe(false);
      expect(shouldUpdateAspxStatus("CTE EM EMISSÃO", novo)).toBe(false);
    }
  });

  it("REGRA 2: CANCELADO / DEVOLVIDO sempre atualizam (menos sobre intocáveis)", () => {
    expect(shouldUpdateAspxStatus("CARREGADO", "CANCELADO")).toBe(true);
    expect(shouldUpdateAspxStatus("CTE ENVIADO", "CANCELADO")).toBe(true);
    expect(shouldUpdateAspxStatus("AGUARDANDO DESCARGA", "DEVOLVIDO")).toBe(true);
    expect(shouldUpdateAspxStatus("DESCARREGADO", "CANCELADO")).toBe(true);
    // Intocável ainda vence a exceção.
    expect(shouldUpdateAspxStatus("NO SHOW", "CANCELADO")).toBe(false);
  });

  it("REGRA 3: descarga só entra a partir de CTE ENVIADO / AGUARDANDO DESCARGA / DESCARREGANDO", () => {
    // Permitidos.
    expect(shouldUpdateAspxStatus("CTE ENVIADO", "AGUARDANDO DESCARGA")).toBe(true);
    expect(shouldUpdateAspxStatus("AGUARDANDO DESCARGA", "DESCARREGANDO")).toBe(true);
    expect(shouldUpdateAspxStatus("DESCARREGANDO", "DESCARREGADO")).toBe(true);
    // Bloqueados: não dá para pular direto de CARREGADO para descarga.
    expect(shouldUpdateAspxStatus("CARREGADO", "AGUARDANDO DESCARGA")).toBe(false);
    expect(shouldUpdateAspxStatus("AGUARDANDO CARREGAMENTO", "DESCARREGADO")).toBe(false);
    expect(shouldUpdateAspxStatus("AGUARDANDO CHEGAR NO CLIENTE", "DESCARREGANDO")).toBe(false);
  });

  it("REGRA 4: anti-regressão — não sobrescreve CTE ENVIADO nem status de descarga", () => {
    // CTE ENVIADO não regride para carregamento.
    expect(shouldUpdateAspxStatus("CTE ENVIADO", "CARREGADO")).toBe(false);
    expect(shouldUpdateAspxStatus("CTE ENVIADO", "AGUARDANDO CARREGAMENTO")).toBe(false);
    // Descarga não regride para carregamento.
    expect(shouldUpdateAspxStatus("AGUARDANDO DESCARGA", "CARREGADO")).toBe(false);
    expect(shouldUpdateAspxStatus("DESCARREGADO", "CARREGADO")).toBe(false);
    // Progressões normais permitidas.
    expect(shouldUpdateAspxStatus("AGUARDANDO CHEGAR NO CLIENTE", "AGUARDANDO CARREGAMENTO")).toBe(true);
    expect(shouldUpdateAspxStatus("AGUARDANDO CARREGAMENTO", "CARREGADO")).toBe(true);
    expect(shouldUpdateAspxStatus("CARREGADO", "CTE ENVIADO")).toBe(true);
  });

  it("normalizeAspxStatus: string/trim/upper defensivo", () => {
    expect(normalizeAspxStatus(" carregado ")).toBe("CARREGADO");
    expect(normalizeAspxStatus(null)).toBe("");
    expect(normalizeAspxStatus(undefined)).toBe("");
  });
});

describe("shouldUpdateAspxData (gates DC-316 Bloco 2)", () => {
  it("dados (motorista/placas) só em AGUARDANDO CARREGAMENTO / CARREGADO", () => {
    expect(shouldUpdateAspxData("AGUARDANDO CARREGAMENTO")).toEqual({ dados: true, datas: true });
    expect(shouldUpdateAspxData("CARREGADO")).toEqual({ dados: true, datas: true });
  });
  it("datas também em AGUARDANDO CHEGAR NO CLIENTE (mas dados não)", () => {
    expect(shouldUpdateAspxData("AGUARDANDO CHEGAR NO CLIENTE")).toEqual({ dados: false, datas: true });
  });
  it("nada em CTE ENVIADO / descarga / vazio", () => {
    expect(shouldUpdateAspxData("CTE ENVIADO")).toEqual({ dados: false, datas: false });
    expect(shouldUpdateAspxData("AGUARDANDO DESCARGA")).toEqual({ dados: false, datas: false });
    expect(shouldUpdateAspxData("")).toEqual({ dados: false, datas: false });
  });
});

describe("parseAspTripRow", () => {
  it("extrai e limpa os campos da linha ASP (igual DC-316)", () => {
    const row = {
      "LH Trip Number": " LT-500 ",
      "Status Operacional": "CARREGADO",
      "Driver ID": "[912] JOAO DA SILVA",
      "Vehicle Plate Number": "ABC1D23,XYZ9Z88",
      "ETA ORIGEM PROGRAMADO": "2026-07-27 08:00",
      "ETA DESTINO PROGRAMADO": "2026-07-28 10:00",
      "Station_Origem": "[HUB] Sao Paulo",
      "Station_Destino": "[DEST] Salvador [BA]",
    };
    expect(parseAspTripRow(row)).toEqual({
      lh: "LT-500",
      status: "CARREGADO",
      motorista: "JOAO DA SILVA",
      cavalo: "ABC1D23",
      carreta: "XYZ9Z88",
      dataCarregamento: "2026-07-27 08:00",
      dataDescarga: "2026-07-28 10:00",
      origem: "Sao Paulo",
      destino: "Salvador",
    });
  });
  it("placa com carreta dupla → cavalo + carreta juntas por '/'", () => {
    const p = parseAspTripRow({ "LH Trip Number": "LT-1", "Vehicle Plate Number": "CAV1A11,CAR2B22,CAR3C33" });
    expect(p.cavalo).toBe("CAV1A11");
    expect(p.carreta).toBe("CAR2B22/CAR3C33");
  });
  it("linha sem LH → lh vazio", () => {
    expect(parseAspTripRow({}).lh).toBe("");
    expect(parseAspTripRow({ "Vehicle Plate Number": "," }).cavalo).toBe("");
  });
});
