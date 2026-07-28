import { describe, it, expect } from "vitest";
import { cpfSuffix3, normalizeDriverName, buildHomonymIndex, stripDriverCpfSuffix } from "./driverHomonyms";

describe("cpfSuffix3", () => {
  it("retorna os 3 últimos dígitos mascarados", () => {
    expect(cpfSuffix3("123.456.789-01")).toBe("***901");
    expect(cpfSuffix3("12345678901")).toBe("***901");
    expect(cpfSuffix3("abc123")).toBe("***123");
  });
  it("vazio quando não há 3 dígitos", () => {
    expect(cpfSuffix3("")).toBe("");
    expect(cpfSuffix3(null)).toBe("");
    expect(cpfSuffix3("12")).toBe("");
  });
});

describe("normalizeDriverName", () => {
  it("tira acento, minúsculo, colapsa espaços", () => {
    expect(normalizeDriverName("  Antônio  Cézar  ")).toBe("antonio cezar");
    expect(normalizeDriverName("ANTONIO CEZAR DE JESUS")).toBe(normalizeDriverName("antonio cezar de jesus"));
  });
});

describe("buildHomonymIndex", () => {
  const drivers = [
    { displayName: "Antonio Cezar de Jesus", document: "111.111.111-23" },
    { displayName: "ANTÔNIO CEZAR DE JESUS", document: "222.222.222-56" }, // mesmo nome, CPF diferente
    { displayName: "Maria Silva", document: "333.333.333-99" },
    { displayName: "Sem Cpf", document: null },
  ];
  const idx = buildHomonymIndex(drivers);

  it("detecta homônimo (mesmo nome, 2 CPFs distintos) ignorando acento/caixa", () => {
    expect(idx.isHomonym("Antonio Cezar de Jesus")).toBe(true);
    expect(idx.distinctCount("antonio cezar de jesus")).toBe(2);
  });
  it("nome único NÃO é homônimo", () => {
    expect(idx.isHomonym("Maria Silva")).toBe(false);
    expect(idx.isHomonym("Fulano Inexistente")).toBe(false);
  });
  it("labelFor adiciona sufixo só p/ homônimo com CPF", () => {
    expect(idx.labelFor("Antonio Cezar de Jesus", "111.111.111-23")).toBe("Antonio Cezar de Jesus (***123)");
    expect(idx.labelFor("Antonio Cezar de Jesus", "222.222.222-56")).toBe("Antonio Cezar de Jesus (***256)");
    expect(idx.labelFor("Maria Silva", "333.333.333-99")).toBe("Maria Silva"); // não-homônimo → cru
  });
  it("motorista sem CPF não gera homônimo sozinho", () => {
    expect(idx.isHomonym("Sem Cpf")).toBe(false);
  });
});

describe("stripDriverCpfSuffix", () => {
  it("remove o sufixo (***NNN) e mantém nome limpo", () => {
    expect(stripDriverCpfSuffix("Antonio Cezar de Jesus (***123)")).toBe("Antonio Cezar de Jesus");
    expect(stripDriverCpfSuffix("Antonio Cezar de Jesus (***12)")).toBe("Antonio Cezar de Jesus");
  });
  it("no-op em nome normal", () => {
    expect(stripDriverCpfSuffix("Maria Silva")).toBe("Maria Silva");
    expect(stripDriverCpfSuffix("")).toBe("");
    expect(stripDriverCpfSuffix(null)).toBe("");
  });
});
