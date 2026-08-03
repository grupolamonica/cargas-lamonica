import { describe, expect, it } from "vitest";

import {
  evaluateCandidaturaCnhCategoria,
  isCnhCategoriaElegivel,
  normalizeCnhCategoria,
} from "./cnh-category.js";

describe("normalizeCnhCategoria", () => {
  it("apara e passa para maiúsculas", () => {
    expect(normalizeCnhCategoria("  ae ")).toBe("AE");
  });
  it("null/undefined viram string vazia", () => {
    expect(normalizeCnhCategoria(null)).toBe("");
    expect(normalizeCnhCategoria(undefined)).toBe("");
  });
});

describe("isCnhCategoriaElegivel", () => {
  it.each(["D", "E", "AD", "AE", "BD", "BE", "CD", "CE", "DE", "ae", " d "])(
    "aceita categoria D pra cima (contém D ou E): %s",
    (cat) => {
      expect(isCnhCategoriaElegivel(cat)).toBe(true);
    },
  );

  it.each(["A", "B", "C", "AB", "AC", "BC", "ab", " c "])(
    "bloqueia categoria que topa em C (sem D nem E): %s",
    (cat) => {
      expect(isCnhCategoriaElegivel(cat)).toBe(false);
    },
  );

  it("categoria vazia/desconhecida NÃO bloqueia (best-effort)", () => {
    expect(isCnhCategoriaElegivel("")).toBe(true);
    expect(isCnhCategoriaElegivel(null)).toBe(true);
    expect(isCnhCategoriaElegivel(undefined)).toBe(true);
  });
});

describe("evaluateCandidaturaCnhCategoria", () => {
  it.each(["AE", "D", "DE", "CD"])(
    "retorna null quando a categoria é D pra cima (elegível): %s",
    (categoria) => {
      const dados = { motorista: { cnh: { categoria } } };
      expect(evaluateCandidaturaCnhCategoria(dados)).toBeNull();
    },
  );

  it("bloqueia quando a categoria topa em C (ex.: AB) — lê dados.motorista.cnh.categoria", () => {
    const dados = { motorista: { cnh: { categoria: "AB" } } };
    const block = evaluateCandidaturaCnhCategoria(dados);
    expect(block).toMatchObject({ error: "CNH_CATEGORIA_INCOMPATIVEL", categoria: "AB" });
    expect(block.message).toContain("categoria D ou superior");
  });

  it("bloqueia lendo o fallback dados.cnh.categoria", () => {
    const dados = { cnh: { categoria: "AC" } };
    expect(evaluateCandidaturaCnhCategoria(dados)?.categoria).toBe("AC");
  });

  it("bloqueia lendo o fallback dados.motorista.categoria", () => {
    const dados = { motorista: { categoria: "C" } };
    expect(evaluateCandidaturaCnhCategoria(dados)?.categoria).toBe("C");
  });

  it("categoria ausente → null (não bloqueia re-submit legado sem categoria)", () => {
    expect(evaluateCandidaturaCnhCategoria({ motorista: {} })).toBeNull();
    expect(evaluateCandidaturaCnhCategoria({})).toBeNull();
    expect(evaluateCandidaturaCnhCategoria(null)).toBeNull();
  });
});
