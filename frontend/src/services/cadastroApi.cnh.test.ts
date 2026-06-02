import { describe, expect, it } from "vitest";

import { parseSegurancaRenach, splitFiliacao, splitRG } from "./cadastroApi";

describe("splitFiliacao", () => {
  it("reconstrói nomes quebrados em múltiplas linhas (caso real Infosimples)", () => {
    // Infosimples quebra nomes longos na coluna fixa, no meio da palavra:
    // "...DOS SA" + "NTOS" = "...DOS SANTOS".
    const filiacao =
      "FRANCISCO DE ASSIS R DOS SA\nNTOS\nAILANA DO CARMO SILVA DOS S\nANTOS";
    expect(splitFiliacao(filiacao)).toEqual({
      pai: "FRANCISCO DE ASSIS R DOS SANTOS",
      mae: "AILANA DO CARMO SILVA DOS SANTOS",
    });
  });

  it("não quebra nomes limpos (um por linha)", () => {
    expect(splitFiliacao("PEDRO HENRIQUE SILVA\nMARIA SOUZA LIMA")).toEqual({
      pai: "PEDRO HENRIQUE SILVA",
      mae: "MARIA SOUZA LIMA",
    });
  });

  it("aceita separador ponto-e-vírgula / pipe", () => {
    expect(splitFiliacao("JOAO DA SILVA; MARIA DA SILVA")).toEqual({
      pai: "JOAO DA SILVA",
      mae: "MARIA DA SILVA",
    });
    expect(splitFiliacao("JOAO DA SILVA | MARIA DA SILVA")).toEqual({
      pai: "JOAO DA SILVA",
      mae: "MARIA DA SILVA",
    });
  });

  it("respeita rótulos explícitos PAI/MÃE", () => {
    expect(splitFiliacao("PAI: JOSE ALVES\nMAE: ANA PAULA")).toEqual({
      pai: "JOSE ALVES",
      mae: "ANA PAULA",
    });
  });

  it("não cola a mãe num pai longo (>=24 chars) quando a mãe é nome completo", () => {
    // Pai completo com 33 chars (>= wrap min) seguido da mãe noutra linha:
    // a mãe tem espaço (não é fragmento) → inicia novo nome.
    expect(
      splitFiliacao("MARIA APARECIDA DE OLIVEIRA SOUZA\nJOSE LIMA"),
    ).toEqual({
      pai: "MARIA APARECIDA DE OLIVEIRA SOUZA",
      mae: "JOSE LIMA",
    });
  });

  it("reconstrói nome do pai quebrado em 3 linhas", () => {
    expect(
      splitFiliacao("ANTONIO CARLOS MAGALHAES JUNIO\nR\nLUCIA HELENA COSTA"),
    ).toEqual({
      pai: "ANTONIO CARLOS MAGALHAES JUNIOR",
      mae: "LUCIA HELENA COSTA",
    });
  });

  it("um nome só → pai preenchido, mãe vazia", () => {
    expect(splitFiliacao("CARLOS EDUARDO")).toEqual({
      pai: "CARLOS EDUARDO",
      mae: "",
    });
  });

  it("string vazia → ambos vazios", () => {
    expect(splitFiliacao("")).toEqual({ pai: "", mae: "" });
  });
});

describe("splitRG", () => {
  it("separa RG UF-prefixado 'MG9014856 SSP MG'", () => {
    expect(splitRG("MG9014856 SSP MG")).toEqual({
      numero: "MG9014856",
      orgao: "SSP",
      uf: "MG",
    });
  });

  it("separa 'NUM ORGAO/UF'", () => {
    expect(splitRG("9014856 SSP/MG")).toEqual({
      numero: "9014856",
      orgao: "SSP",
      uf: "MG",
    });
  });

  it("separa 'NUM ORGAO-UF'", () => {
    expect(splitRG("12345678 SSP-SP")).toEqual({
      numero: "12345678",
      orgao: "SSP",
      uf: "SP",
    });
  });

  it("RG só número mantém o valor", () => {
    expect(splitRG("12.345.678-9").orgao).toBe("");
    expect(splitRG("12.345.678-9").uf).toBe("");
  });
});

describe("parseSegurancaRenach (campo combinado nº segurança + Renach)", () => {
  it("extrai só o nº de segurança numérico, descartando o Renach alfanumérico", () => {
    expect(parseSegurancaRenach("51531458216\nMG607554835")).toBe("51531458216");
  });

  it("aceita ordem invertida (Renach primeiro)", () => {
    expect(parseSegurancaRenach("MG607554835 51531458216")).toBe("51531458216");
  });

  it("string vazia → vazio", () => {
    expect(parseSegurancaRenach("")).toBe("");
  });

  it("sem token numérico puro → vazio", () => {
    expect(parseSegurancaRenach("MG607554835")).toBe("");
  });
});
