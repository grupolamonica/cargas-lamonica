import { describe, expect, it } from "vitest";

import {
  shouldUpdateAspxStatus,
  shouldUpdateAspxData,
  shouldReleaseAllocStatusOverride,
  shouldOverlayLiveSpxStatus,
  statusPipelinePosition,
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

  // Carga que JÁ tem motorista: o vazio não é uma linha "disponível" a proteger, e
  // ficava vazia para sempre quando a linha nasceu depois de a viagem avançar.
  it("status vazio COM motorista: aceita o pipeline inteiro", () => {
    const comMotorista = { hasDriver: true };
    expect(shouldUpdateAspxStatus("", "DESCARREGADO", comMotorista)).toBe(true);
    expect(shouldUpdateAspxStatus("", "AGUARDANDO DESCARGA", comMotorista)).toBe(true);
    expect(shouldUpdateAspxStatus("", "CTE ENVIADO", comMotorista)).toBe(true);
    expect(shouldUpdateAspxStatus("", "AGUARDANDO CHEGAR NO CLIENTE", comMotorista)).toBe(true);
  });

  it("status vazio COM motorista: cancelamento/NO SHOW seguem fora (cascata retroativa)", () => {
    const comMotorista = { hasDriver: true };
    expect(shouldUpdateAspxStatus("", "CANCELADO", comMotorista)).toBe(false);
    expect(shouldUpdateAspxStatus("", "DEVOLVIDO", comMotorista)).toBe(false);
    expect(shouldUpdateAspxStatus("", "NO SHOW", comMotorista)).toBe(false);
    // Fora do vocabulário do pipeline → não assume.
    expect(shouldUpdateAspxStatus("", "QUALQUER COISA", comMotorista)).toBe(false);
  });

  it("hasDriver NÃO afeta status já preenchido (as regras 1-4 valem igual)", () => {
    const comMotorista = { hasDriver: true };
    expect(shouldUpdateAspxStatus("NO SHOW", "CARREGADO", comMotorista)).toBe(false);
    expect(shouldUpdateAspxStatus("CTE EM EMISSÃO", "CARREGADO", comMotorista)).toBe(false);
    expect(shouldUpdateAspxStatus("AGUARDANDO CHEGAR NO CLIENTE", "DESCARREGADO", comMotorista)).toBe(false);
    expect(shouldUpdateAspxStatus("CTE ENVIADO", "DESCARREGADO", comMotorista)).toBe(true);
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

describe("shouldReleaseAllocStatusOverride (soltar override atrasado)", () => {
  it("solta quando a planilha está À FRENTE do override no pipeline", () => {
    // O caso real: o modal gravou o rótulo do SPX no instante da alocação
    // ("AGUARDANDO CHEGAR NO CLIENTE" = `assigned`) e a viagem seguiu.
    expect(shouldReleaseAllocStatusOverride("AGUARDANDO CHEGAR NO CLIENTE", "CARREGADO")).toBe(true);
    expect(shouldReleaseAllocStatusOverride("AGUARDANDO CHEGAR NO CLIENTE", "CTE EM EMISSÃO")).toBe(true);
    expect(shouldReleaseAllocStatusOverride("AGUARDANDO CARREGAMENTO", "CTE ENVIADO")).toBe(true);
    // O caso MAIS COMUM em produção (26 das 43 cargas): painel na chegada,
    // planilha já descarregada. `shouldUpdateAspxStatus` diria não (regra 3);
    // aqui o alvo é a própria planilha, então o override cede.
    expect(shouldReleaseAllocStatusOverride("AGUARDANDO CHEGAR NO CLIENTE", "DESCARREGADO")).toBe(true);
    expect(shouldReleaseAllocStatusOverride("CARREGADO", "DESCARREGADO")).toBe(true);
  });

  it("preserva o CTE enquanto a planilha não passa dele", () => {
    // O ASPX não conhece o vocabulário de CTE — enquanto a planilha está atrás,
    // o override do operador é a informação boa.
    expect(shouldReleaseAllocStatusOverride("CTE EM EMISSÃO", "CARREGADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("CTE EM EMISSÃO", "AGUARDANDO CARREGAMENTO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("CTE ENVIADO", "CARREGADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("CTE ENVIADO", "CTE EM EMISSÃO")).toBe(false);
    // …e cede quando a planilha passa dele (avanço legítimo da viagem).
    expect(shouldReleaseAllocStatusOverride("CTE EM EMISSÃO", "CTE ENVIADO")).toBe(true);
    expect(shouldReleaseAllocStatusOverride("CTE ENVIADO", "AGUARDANDO DESCARGA")).toBe(true);
    expect(shouldReleaseAllocStatusOverride("CTE ENVIADO", "DESCARREGADO")).toBe(true);
  });

  it("exceções (CANCELADO / DEVOLVIDO / NO SHOW) nunca são soltas — não estão no pipeline", () => {
    for (const excecao of ["CANCELADO", "DEVOLVIDO", "NO SHOW"]) {
      expect(shouldReleaseAllocStatusOverride(excecao, "CARREGADO")).toBe(false);
      expect(shouldReleaseAllocStatusOverride(excecao, "DESCARREGADO")).toBe(false);
    }
    // Nem entram como destino: uma exceção na planilha não solta o override.
    expect(shouldReleaseAllocStatusOverride("CARREGADO", "CANCELADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("CTE EM EMISSÃO", "DEVOLVIDO")).toBe(false);
  });

  it("não mexe em override ausente, vazio SEM motorista ou já alinhado", () => {
    expect(shouldReleaseAllocStatusOverride(null, "CARREGADO")).toBe(false);
    // "" sem motorista = "Disponível" (reabertura deliberada), não é artefato.
    expect(shouldReleaseAllocStatusOverride("", "CARREGADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("   ", "CARREGADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("", "CARREGADO", { hasDriver: false })).toBe(false);
    expect(shouldReleaseAllocStatusOverride("CARREGADO", "CARREGADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride(" carregado ", "CARREGADO")).toBe(false);
  });

  it("solta o override VAZIO quando há motorista (carga aparecia SEM status)", () => {
    // Artefato do editor inline (`status: allocStatus ?? ""`): COALESCE devolve ""
    // e a carga fica sem status mesmo com a planilha em DESCARREGADO.
    expect(shouldReleaseAllocStatusOverride("", "DESCARREGADO", { hasDriver: true })).toBe(true);
    expect(shouldReleaseAllocStatusOverride("", "CARREGADO", { hasDriver: true })).toBe(true);
    expect(shouldReleaseAllocStatusOverride("   ", "CTE ENVIADO", { hasDriver: true })).toBe(true);
    // Vale também para rótulo fora do pipeline: o vazio não é decisão, a planilha é.
    expect(shouldReleaseAllocStatusOverride("", "RESERVADO", { hasDriver: true })).toBe(true);
    // Sem status na planilha não há o que assumir.
    expect(shouldReleaseAllocStatusOverride("", "", { hasDriver: true })).toBe(false);
  });

  it("override VAZIO nunca assume cancelamento/NO SHOW da planilha (evita cascata retroativa)", () => {
    // Soltar aqui desmascararia um CANCELADO e sweepCancelledCascades desceria o
    // motorista da fila muito depois do fato — decisão de operação, não saneamento.
    for (const st of ["CANCELADO", "DEVOLVIDO", "NO SHOW", "CANCELADA"]) {
      expect(shouldReleaseAllocStatusOverride("", st, { hasDriver: true })).toBe(false);
    }
  });

  it("não solta quando a planilha está sem status, atrás ou fora do vocabulário", () => {
    expect(shouldReleaseAllocStatusOverride("CARREGADO", "")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("DESCARREGADO", "CARREGADO")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("DESCARREGANDO", "AGUARDANDO DESCARGA")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("CARREGADO", "STATUS LEGADO QUALQUER")).toBe(false);
    expect(shouldReleaseAllocStatusOverride("STATUS LEGADO QUALQUER", "CARREGADO")).toBe(false);
  });
});

describe("shouldOverlayLiveSpxStatus (status ao vivo do SPX só AVANÇA)", () => {
  it("tela vazia recebe qualquer rótulo do SPX", () => {
    // É o caso das cargas do SISTEMA (lh_manual): o sync ASPX casa por sheet_lh e
    // nunca as visita, então sem overlay o painel fica sem status nenhum.
    expect(shouldOverlayLiveSpxStatus("", "AGUARDANDO CHEGAR NO CLIENTE")).toBe(true);
    expect(shouldOverlayLiveSpxStatus(null, "DESCARREGADO")).toBe(true);
    expect(shouldOverlayLiveSpxStatus("   ", "CANCELADO")).toBe(true); // melhor que vazio
  });

  it("sobrepõe quando o SPX está à FRENTE no pipeline", () => {
    expect(shouldOverlayLiveSpxStatus("AGUARDANDO CHEGAR NO CLIENTE", "CARREGADO")).toBe(true);
    expect(shouldOverlayLiveSpxStatus("CARREGADO", "AGUARDANDO DESCARGA")).toBe(true);
    expect(shouldOverlayLiveSpxStatus("CTE ENVIADO", "DESCARREGADO")).toBe(true);
  });

  it("NÃO rebaixa o CTE — o vocabulário de CTE não existe no SPX", () => {
    expect(shouldOverlayLiveSpxStatus("CTE EM EMISSÃO", "CARREGADO")).toBe(false);
    expect(shouldOverlayLiveSpxStatus("CTE ENVIADO", "CARREGADO")).toBe(false);
    expect(shouldOverlayLiveSpxStatus("CTE ENVIADO", "CARREGANDO")).toBe(false);
  });

  it("nunca regride e não mexe no que já está igual", () => {
    expect(shouldOverlayLiveSpxStatus("DESCARREGADO", "CARREGADO")).toBe(false);
    expect(shouldOverlayLiveSpxStatus("AGUARDANDO DESCARGA", "CARREGANDO")).toBe(false);
    expect(shouldOverlayLiveSpxStatus("CARREGADO", "CARREGADO")).toBe(false);
    expect(shouldOverlayLiveSpxStatus("CARREGADO", " carregado ")).toBe(false);
  });

  it("exibido fora do pipeline (decisão do operador) e SPX sem status → preserva", () => {
    for (const terminal of ["NO SHOW", "CANCELADO", "DEVOLVIDO", "RESERVADO"]) {
      expect(shouldOverlayLiveSpxStatus(terminal, "DESCARREGADO")).toBe(false);
    }
    expect(shouldOverlayLiveSpxStatus("CARREGADO", "")).toBe(false);
    expect(shouldOverlayLiveSpxStatus("CARREGADO", null)).toBe(false);
    // Cancelamento do SPX sobre uma carga em andamento NÃO passa: o cancelamento
    // chega pela planilha (regra 2 do DC-316, que sempre atualiza).
    expect(shouldOverlayLiveSpxStatus("CARREGADO", "CANCELADO")).toBe(false);
  });
});

describe("statusPipelinePosition", () => {
  it("devolve a ordem do pipeline e -1 fora dele", () => {
    expect(statusPipelinePosition("AGUARDANDO ACEITE")).toBe(0);
    expect(statusPipelinePosition(" descarregado ")).toBe(9);
    expect(statusPipelinePosition("CTE EM EMISSÃO")).toBeGreaterThan(statusPipelinePosition("CARREGADO"));
    expect(statusPipelinePosition("CANCELADO")).toBe(-1);
    expect(statusPipelinePosition("")).toBe(-1);
    expect(statusPipelinePosition(null)).toBe(-1);
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
