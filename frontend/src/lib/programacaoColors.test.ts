import { describe, expect, it } from "vitest";

import { buildRouteColorMap, colorForRow, contrastText, normalizeVehicle } from "./programacaoColors";
import type { ProgramacaoRow, RouteColorRule } from "@/services/readModels";

const rules: RouteColorRule[] = [
  { id: "1", partida: "8808", chegada: "10963", veiculo: "CARRETA", cor: "#fde047", updatedAt: null },
  { id: "2", partida: "8808", chegada: "5050", veiculo: "TRUCK", cor: "#fdba74", updatedAt: null },
];

function row(over: Partial<ProgramacaoRow>): ProgramacaoRow {
  return {
    lh: "LT1", nome: "", statusRaw: "", statusOperacional: "", motorista: "", veiculo: "CARRETA",
    placa: "", origem: "", destino: "", origemRaw: "", destinoRaw: "", origemCidadeUf: "", destinoCidadeUf: "",
    origemCodigo: "", destinoCodigo: "", data: null, horario: null, carregamentoTs: null, dataDescarga: null,
    horarioDescarga: null, tab: "planejado", cliente: "Shopee", isLinehaul: true, acceptanceStatus: 0,
    podeAceitar: false, aguardandoMotorista: false, jaLancada: false, dataLancamento: null, expirada: false, ...over,
  };
}

describe("normalizeVehicle", () => {
  it("uppercases, colapsa espaços e canoniza hífen", () => {
    expect(normalizeVehicle("carreta  -  expressa")).toBe("CARRETA - EXPRESSA");
    expect(normalizeVehicle("carreta-expressa")).toBe("CARRETA - EXPRESSA");
  });
});

describe("colorForRow", () => {
  const map = buildRouteColorMap(rules);
  it("casa por partida+chegada+veículo (case/space-insensitive no veículo)", () => {
    expect(colorForRow(map, row({ origemCodigo: "8808", destinoCodigo: "10963", veiculo: "carreta" }))).toBe("#fde047");
    expect(colorForRow(map, row({ origemCodigo: "8808", destinoCodigo: "5050", veiculo: "TRUCK" }))).toBe("#fdba74");
  });
  it("sem código de estação → sem cor", () => {
    expect(colorForRow(map, row({ origemCodigo: "", destinoCodigo: "10963", veiculo: "CARRETA" }))).toBeNull();
  });
  it("rota/veículo não cadastrado → sem cor", () => {
    expect(colorForRow(map, row({ origemCodigo: "8808", destinoCodigo: "10963", veiculo: "TRUCK" }))).toBeNull();
    expect(colorForRow(map, row({ origemCodigo: "9999", destinoCodigo: "10963", veiculo: "CARRETA" }))).toBeNull();
  });
});

describe("contrastText", () => {
  it("texto escuro em fundo claro, claro em fundo escuro", () => {
    expect(contrastText("#fde047")).toBe("#0f172a"); // amarelo claro → escuro
    expect(contrastText("#1e3a8a")).toBe("#f8fafc"); // azul escuro → claro
  });
  it("cor de luminância média escolhe o texto de MAIOR contraste (não limiar fixo)", () => {
    expect(contrastText("#808080")).toBe("#0f172a"); // cinza médio → escuro dá mais contraste
  });
});
