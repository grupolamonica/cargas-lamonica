import { describe, expect, it } from "vitest";

import { buildAuditChanges } from "./audit-diff.js";

const FIELDS = [
  { key: "valor", label: "Valor" },
  { key: "ativa", label: "Ativa" },
  { key: "motorista", label: "Motorista" },
];

describe("buildAuditChanges", () => {
  it("ignora campos que não mudaram", () => {
    const changes = buildAuditChanges(
      { valor: 1000, ativa: true, motorista: "JOAO" },
      { valor: 1000, ativa: true, motorista: "JOAO" },
      FIELDS,
    );
    expect(changes).toEqual([]);
  });

  it("trata número igual em formatos diferentes como sem mudança", () => {
    // pg devolve numeric como string ("1000.00"); payload manda number.
    const changes = buildAuditChanges({ valor: "1000.00" }, { valor: 1000 }, [
      { key: "valor", label: "Valor" },
    ]);
    expect(changes).toEqual([]);
  });

  it("NÃO mascara mudança em identificador inteiro (LH '007' → '7')", () => {
    // Sem ponto decimal em nenhum lado → compara como string, registra a mudança.
    const changes = buildAuditChanges({ lh: "007" }, { lh: "7" }, [{ key: "lh", label: "LH" }]);
    expect(changes).toEqual([{ field: "lh", label: "LH", before: "007", after: "7" }]);
  });

  it("trata null / undefined / '' como equivalentes (vazio)", () => {
    const changes = buildAuditChanges({ motorista: "" }, { motorista: null }, [
      { key: "motorista", label: "Motorista" },
    ]);
    expect(changes).toEqual([]);
  });

  it("registra mudança de valor com antes e depois", () => {
    const changes = buildAuditChanges({ valor: 1000 }, { valor: 1200 }, [
      { key: "valor", label: "Valor" },
    ]);
    expect(changes).toEqual([{ field: "valor", label: "Valor", before: 1000, after: 1200 }]);
  });

  it("registra preenchimento de campo vazio (before null)", () => {
    const changes = buildAuditChanges({ motorista: "" }, { motorista: "JOAO" }, [
      { key: "motorista", label: "Motorista" },
    ]);
    expect(changes).toEqual([{ field: "motorista", label: "Motorista", before: null, after: "JOAO" }]);
  });

  it("registra mudança de boolean", () => {
    const changes = buildAuditChanges({ ativa: true }, { ativa: false }, [
      { key: "ativa", label: "Ativa" },
    ]);
    expect(changes).toEqual([{ field: "ativa", label: "Ativa", before: true, after: false }]);
  });

  it("preserva a ordem dos campos declarados", () => {
    const changes = buildAuditChanges(
      { valor: 1, ativa: false, motorista: "A" },
      { valor: 2, ativa: true, motorista: "B" },
      FIELDS,
    );
    expect(changes.map((c) => c.field)).toEqual(["valor", "ativa", "motorista"]);
  });

  it("é resiliente a entradas não-objeto", () => {
    expect(buildAuditChanges(null, null, FIELDS)).toEqual([]);
    expect(buildAuditChanges({ valor: 5 }, {}, [{ key: "valor", label: "Valor" }])).toEqual([
      { field: "valor", label: "Valor", before: 5, after: null },
    ]);
    expect(buildAuditChanges({}, {}, undefined)).toEqual([]);
  });
});
