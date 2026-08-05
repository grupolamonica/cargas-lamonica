import { describe, expect, it } from "vitest";

import { SPX_TRIP_STATUS_LABEL, spxTripStatusLabel } from "./spx-trip-status.js";

// Este mapa NÃO tinha teste — foi como `arrived → AGUARDANDO DESCARGA` sobreviveu
// (chamado GLPI #40: "motorista confirma chegada e a planilha atualiza como aguardando
// descarga; o correto seria aguardando carregamento").
describe("spxTripStatusLabel", () => {
  it("arrived = chegou NO CLIENTE para carregar, NÃO no destino", () => {
    // O defeito do chamado #40. Evidência em produção: 11 de 12 viagens com status
    // Arrived tinham a chegada programada na ORIGEM ainda no futuro (06/08, 07/08) —
    // impossível estar no destino. E a planilha da Shopee (6168 linhas) nunca usa
    // "AGUARDANDO DESCARGA".
    expect(spxTripStatusLabel("arrived")).toBe("AGUARDANDO CARREGAMENTO");
    expect(spxTripStatusLabel("Arrived")).toBe("AGUARDANDO CARREGAMENTO"); // o portal manda capitalizado
    expect(spxTripStatusLabel("arrived")).not.toBe("AGUARDANDO DESCARGA");
  });

  it("nenhum status do SPX produz 'AGUARDANDO DESCARGA' — rótulo que a planilha não usa", () => {
    // A ponta de descarga tem códigos próprios (Unseal/Operating/Unloaded/Completed),
    // então não há lacuna: nada precisa mapear para esse rótulo.
    expect(Object.values(SPX_TRIP_STATUS_LABEL)).not.toContain("AGUARDANDO DESCARGA");
  });

  it("o ciclo de carregamento segue a ordem que a operação entende", () => {
    expect(spxTripStatusLabel("assigned")).toBe("AGUARDANDO CHEGAR NO CLIENTE");
    expect(spxTripStatusLabel("arrived")).toBe("AGUARDANDO CARREGAMENTO");
    expect(spxTripStatusLabel("loading")).toBe("CARREGANDO");
    expect(spxTripStatusLabel("seal")).toBe("CARREGANDO");
    expect(spxTripStatusLabel("departed")).toBe("CARREGADO");
  });

  it("a ponta de DESCARGA vem dos códigos do destino, não de arrived", () => {
    expect(spxTripStatusLabel("unseal")).toBe("DESCARREGANDO");
    expect(spxTripStatusLabel("operating")).toBe("DESCARREGANDO");
    expect(spxTripStatusLabel("unloaded")).toBe("DESCARREGADO");
    expect(spxTripStatusLabel("completed")).toBe("DESCARREGADO");
  });

  it("aceite e cancelamento", () => {
    expect(spxTripStatusLabel("created")).toBe("AGUARDANDO ACEITE");
    expect(spxTripStatusLabel("pending")).toBe("AGUARDANDO ACEITE");
    expect(spxTripStatusLabel("assigning")).toBe("AGUARDANDO CHEGAR NO CLIENTE");
    expect(spxTripStatusLabel("cancelled")).toBe("CANCELADO");
  });

  it("normaliza caixa e espaço; status desconhecido cai no cru em MAIÚSCULA", () => {
    expect(spxTripStatusLabel("  DePaRtEd  ")).toBe("CARREGADO");
    expect(spxTripStatusLabel("estado_novo_da_shopee")).toBe("ESTADO_NOVO_DA_SHOPEE");
  });

  it("vazio/nulo não inventa rótulo", () => {
    expect(spxTripStatusLabel("")).toBe("");
    expect(spxTripStatusLabel(null)).toBe("");
    expect(spxTripStatusLabel(undefined)).toBe("");
  });

  it("cobre TODOS os nomes do enum tt_trip_status do portal (nenhum cai no fallback)", () => {
    // Espelha bots/spx/backend/spx_robo/trips.py TRIP_STATUS. Se a Shopee adicionar um
    // estado novo, este teste continua verde — mas um nome do enum ATUAL sem tradução
    // apareceria cru na tela do operador, então fixamos os que conhecemos.
    const nomesDoEnum = [
      "Created", "Assigning", "Assigned", "Loading", "Seal", "Departed",
      "Arrived", "Unseal", "Operating", "Unloaded", "Completed", "Cancelled", "Pending",
    ];
    for (const nome of nomesDoEnum) {
      expect(SPX_TRIP_STATUS_LABEL, nome).toHaveProperty(nome.toLowerCase());
    }
  });
});

// Regressão do caso REAL que o operador apontou (LT0Q8702CP701, medido em produção
// 2026-08-05): a planilha da Shopee dizia AGUARDANDO CARREGAMENTO, o SPX dizia
// "Arrived", e o Monitor exibia AGUARDANDO DESCARGA. Planilha e SPX concordavam sobre
// o mundo real — só a nossa tradução divergia.
//
// Isso importa além do rótulo na tela: o modal vem pré-preenchido com o status EXIBIDO,
// e a guarda de eco de update-monitor-allocation.js compara o enviado contra o
// PERSISTIDO. Quando os dois divergiam, o eco não era reconhecido e o rótulo errado era
// espelhado na coluna STATUS da planilha. Com a tradução correta os dois voltam a bater,
// o eco funciona, e nada espúrio é gravado.
describe("regressão LT0Q8702CP701 (chamado GLPI #40)", () => {
  it("o rótulo do SPX passa a coincidir com o que a planilha já registrava", () => {
    const oQuePlanilhaDizia = "AGUARDANDO CARREGAMENTO";
    const oQueSpxDizia = "Arrived";
    expect(spxTripStatusLabel(oQueSpxDizia)).toBe(oQuePlanilhaDizia);
  });
});
