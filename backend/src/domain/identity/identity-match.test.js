import { describe, expect, it } from "vitest";

import {
  checkTypedVsCnh,
  cpfMatches,
  isValidCpf,
  namesMatch,
  normalizeName,
} from "./identity-match.js";

describe("normalizeName", () => {
  it("remove acentos, pontuação e colapsa espaços", () => {
    expect(normalizeName("  JOSÉ   Eduardo-Silva  ")).toBe("jose eduardo silva");
  });
});

describe("namesMatch — deixa passar (não é fraude)", () => {
  it.each([
    ["igual", "JOSE EDUARDO SILVA", "JOSE EDUARDO SILVA"],
    ["acento/caixa", "José Eduardo Silva", "JOSE EDUARDO SILVA"],
    ["nome do meio faltando", "JOSE EDUARDO SILVA", "JOSE SILVA"],
    ["partículas", "MARIA DE FATIMA SOUZA", "MARIA FATIMA SOUZA"],
    ["ruído de OCR (1 char)", "FHILIPE MATHEUS DUARTE", "FHILIPE MATEUS DUARTE"],
    ["ruído de OCR em nome curto (ANA↔AMA)", "ANA SILVA", "AMA SILVA"],
    ["abreviação de inicial", "J EDUARDO SILVA", "JOSE EDUARDO SILVA"],
    ["um lado vazio (fail-open)", "", "JOSE SILVA"],
  ])("%s", (_label, a, b) => {
    expect(namesMatch(a, b)).toBe(true);
  });
});

describe("namesMatch — BARRA (divergência clara / troca de pessoa)", () => {
  it.each([
    ["fraude Fhilipe × Bruna", "FHILIPE MATHEUS SANTOS DUARTE", "BRUNA SILVA AMARAL"],
    ["sobrenome diferente", "JOSE SILVA", "JOSE SANTOS"],
    ["nome totalmente diferente", "ANA PAULA COSTA", "CARLOS HENRIQUE LIMA"],
  ])("%s", (_label, a, b) => {
    expect(namesMatch(a, b)).toBe(false);
  });
});

describe("isValidCpf", () => {
  it.each(["03070300596", "030.703.005-96"])("aceita CPF com dígito verificador correto: %s", (c) => {
    expect(isValidCpf(c)).toBe(true);
  });
  it.each(["11111111111", "00000000000", "12345678901", "0307030059", "123", ""])(
    "rejeita CPF inválido (DV errado / repetido / tamanho): %s",
    (c) => {
      expect(isValidCpf(c)).toBe(false);
    },
  );
});

describe("cpfMatches", () => {
  it("iguais → true; diferentes → false", () => {
    expect(cpfMatches("030.703.005-96", "03070300596")).toBe(true);
    expect(cpfMatches("11111111111", "22222222222")).toBe(false);
  });
  it("lado sem 11 dígitos → true (nada a comparar)", () => {
    expect(cpfMatches("123", "11111111111")).toBe(true);
    expect(cpfMatches("", "11111111111")).toBe(true);
  });
});

describe("checkTypedVsCnh", () => {
  const cnhNome = "BRUNA SILVA AMARAL";

  it("nome digitado bate com a CNH → ok", () => {
    const dados = { motorista: { nome: "BRUNA SILVA AMARAL", cpf: "03070300596", cnh: { nome: cnhNome } } };
    expect(checkTypedVsCnh({ dados, driverCpf: "03070300596" })).toEqual({ ok: true });
  });

  it("nome digitado (Fhilipe) diverge da CNH (Bruna) → barra NOME_DIVERGENTE_CNH", () => {
    const dados = {
      motorista: { nome: "FHILIPE MATHEUS SANTOS DUARTE", cpf: "03070300596", cnh: { nome: cnhNome } },
    };
    const r = checkTypedVsCnh({ dados, driverCpf: "03070300596" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOME_DIVERGENTE_CNH");
    expect(r.message).toContain("não batem com os dados da CNH");
  });

  it("CPF da candidatura diverge do CPF da CNH → barra CPF_DIVERGENTE_CNH", () => {
    const dados = { motorista: { nome: cnhNome, cpf: "03070300596", cnh: { nome: cnhNome } } };
    const r = checkTypedVsCnh({ dados, driverCpf: "99999999999" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CPF_DIVERGENTE_CNH");
  });

  it("sem snapshot da CNH (cnh.nome ausente) → fail-open observável (skipped)", () => {
    const dados = { motorista: { nome: "QUALQUER UM", cpf: "03070300596", cnh: {} } };
    expect(checkTypedVsCnh({ dados, driverCpf: "03070300596" })).toEqual({ ok: true, skipped: true });
  });
});
