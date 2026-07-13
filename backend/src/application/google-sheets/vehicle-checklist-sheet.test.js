import { describe, expect, it } from "vitest";
import { parseVehicleChecklistCsv } from "./vehicle-checklist-sheet.js";

// Cabeçalhos ACENTUADOS reais da aba Checklist do robô GRIFFI — o teste garante
// que o mapeamento por nome casa mesmo com "Veículo"/"Último"/"Cód."/"Proprietário".
const HEADER =
  "Placa,Tipo Veículo,Status,Data Validade Checklist,Vencimento,Último Status Checklist,Proprietário,Data Inclusão,Cód. Viagem";

describe("parseVehicleChecklistCsv", () => {
  it("mapeia colunas acentuadas e parseia a validade BR → epoch ms", () => {
    const csv = [
      "linha de lixo antes do cabeçalho,,,",
      HEADER,
      "OUO3A58,CAVALO,Reprovado,,,Checklist em execução,RAPIDAO BAHIA,01/04/2026 23:40:36,37685689",
      "MTY-0443,CARRETA 1,Aprovado,08/05/2026 19:09:39,0,Checklist Finalizado,JJ SOLUCOES,09/03/2026 18:28:32,38061844",
    ].join("\n");

    const items = parseVehicleChecklistCsv(csv);
    expect(items).toHaveLength(2);

    const cavalo = items[0];
    expect(cavalo.placaNorm).toBe("OUO3A58");
    expect(cavalo.tipoVeiculo).toBe("CAVALO");
    expect(cavalo.statusRaw).toBe("Reprovado");
    expect(cavalo.validadeMs).toBeNull(); // validade vazia
    expect(cavalo.ultimoStatus).toBe("Checklist em execução");

    const carreta = items[1];
    expect(carreta.placa).toBe("MTY-0443");
    expect(carreta.placaNorm).toBe("MTY0443");
    expect(carreta.statusRaw).toBe("Aprovado");
    expect(carreta.validadeLabel).toBe("08/05/2026 19:09:39");
    // 08/05/2026 19:09:39 BRT (UTC-3) = 2026-05-08T22:09:39Z
    expect(carreta.validadeMs).toBe(Date.UTC(2026, 4, 8, 19, 9, 39) + 3 * 60 * 60 * 1000);
    // Coluna Vencimento (dias restantes segundo o robô) parseada como int.
    expect(carreta.vencimentoDias).toBe(0);
    expect(cavalo.vencimentoDias).toBeNull(); // célula vazia
  });

  it("linhas sem placa são ignoradas", () => {
    const csv = [HEADER, ",,,,,,,,", "ABC1D23,CAVALO,Aprovado,,,,,,"].join("\n");
    const items = parseVehicleChecklistCsv(csv);
    expect(items).toHaveLength(1);
    expect(items[0].placaNorm).toBe("ABC1D23");
  });

  it("sem cabeçalho reconhecível → []", () => {
    expect(parseVehicleChecklistCsv("foo,bar\n1,2")).toEqual([]);
  });
});
