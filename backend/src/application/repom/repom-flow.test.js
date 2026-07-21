import { describe, expect, it } from "vitest";

import { faltantes, isCadastroCompleto, normalizeTelefoneBr, proximoPasso, REPOM_MOTORISTA_STEPS } from "./repom-flow.js";

const dados = (motorista = {}) => ({ motorista });

describe("repom-flow (motor declarativo — Fase 3d)", () => {
  it("ordem dos passos: cnh → selfie_cnh → comprovante → telefone", () => {
    expect(REPOM_MOTORISTA_STEPS.map((s) => s.key)).toEqual(["cnh", "selfie_cnh", "comprovante", "telefone"]);
  });

  describe("proximoPasso — devolve o 1º passo pendente", () => {
    it("nada preenchido → cnh", () => {
      expect(proximoPasso(dados()).key).toBe("cnh");
    });
    it("com CNH → selfie_cnh", () => {
      expect(proximoPasso(dados({ cnh_url: "p/cnh.jpg" })).key).toBe("selfie_cnh");
    });
    it("com CNH + selfie → comprovante", () => {
      expect(proximoPasso(dados({ cnh_url: "a", selfie_cnh_url: "b" })).key).toBe("comprovante");
    });
    it("com CNH + selfie + comprovante → telefone", () => {
      expect(proximoPasso(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c" })).key).toBe("telefone");
    });
    it("tudo preenchido → null (completo)", () => {
      expect(proximoPasso(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "71999998888" }))).toBeNull();
    });
    it("cada passo tem uma pergunta (ask) não-vazia", () => {
      REPOM_MOTORISTA_STEPS.forEach((s) => expect(String(s.ask).trim().length).toBeGreaterThan(0));
    });
  });

  describe("telefone: exige ≥10 dígitos (DDD + número)", () => {
    it("telefone curto/ausente ainda pede telefone", () => {
      expect(proximoPasso(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "123" })).key).toBe("telefone");
      expect(proximoPasso(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "" })).key).toBe("telefone");
    });
    it("telefone com máscara e ≥10 dígitos satisfaz", () => {
      expect(proximoPasso(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "(71) 99999-8888" }))).toBeNull();
    });
  });

  describe("faltantes + isCadastroCompleto", () => {
    it("lista os que faltam na ordem", () => {
      expect(faltantes(dados({ cnh_url: "a" }))).toEqual(["selfie_cnh", "comprovante", "telefone"]);
      expect(faltantes(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "71999998888" }))).toEqual([]);
    });
    it("isCadastroCompleto reflete proximoPasso===null", () => {
      expect(isCadastroCompleto(dados({ cnh_url: "a" }))).toBe(false);
      expect(isCadastroCompleto(dados({ cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "71999998888" }))).toBe(true);
    });
  });

  it("robusto a dados vazio/sem motorista", () => {
    expect(proximoPasso(undefined).key).toBe("cnh");
    expect(proximoPasso({}).key).toBe("cnh");
    expect(faltantes({}).length).toBe(REPOM_MOTORISTA_STEPS.length);
  });

  describe("metadata de fiação (field/slot) — alinhado ao wizard", () => {
    it("docs têm slot da allowlist e field *_url; texto tem field e normalize", () => {
      const byKey = Object.fromEntries(REPOM_MOTORISTA_STEPS.map((s) => [s.key, s]));
      expect(byKey.cnh).toMatchObject({ tipo: "doc", field: "cnh_url", slot: "motorista_cnh" });
      expect(byKey.selfie_cnh).toMatchObject({ tipo: "doc", field: "selfie_cnh_url", slot: "motorista_selfie_cnh" });
      expect(byKey.comprovante).toMatchObject({ tipo: "doc", field: "comprovante_url", slot: "motorista_comprovante" });
      expect(byKey.telefone).toMatchObject({ tipo: "texto", field: "telefone" });
      expect(typeof byKey.telefone.normalize).toBe("function");
    });
  });

  describe("normalizeTelefoneBr", () => {
    it("aceita 10 (fixo) e 11 (celular) dígitos, com máscara", () => {
      expect(normalizeTelefoneBr("(71) 3333-4444")).toBe("7133334444");
      expect(normalizeTelefoneBr("71 99999-8888")).toBe("71999998888");
    });
    it("tira o 55 do código do país", () => {
      expect(normalizeTelefoneBr("+55 71 99999-8888")).toBe("71999998888");
      expect(normalizeTelefoneBr("5571333344 44".replace(" ", ""))).toBe("7133334444");
    });
    it("rejeita curto/longo demais → null", () => {
      expect(normalizeTelefoneBr("99998888")).toBeNull(); // sem DDD
      expect(normalizeTelefoneBr("")).toBeNull();
      expect(normalizeTelefoneBr("não sei meu número")).toBeNull();
      expect(normalizeTelefoneBr("119999988887777")).toBeNull(); // dígitos demais
    });
  });
});
