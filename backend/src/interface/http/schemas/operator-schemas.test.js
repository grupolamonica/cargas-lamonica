import { describe, expect, it } from "vitest";

import {
  sheetMonitorAllocationBodySchema,
  sheetMonitorCargoUpdateBodySchema,
  sheetMonitorConformityOverrideBodySchema,
} from "./operator-schemas.js";

// Casos derivados do fuzz adversarial (usuário confuso / requisição crua) — garantem
// que a validação recusa lixo com erro tratado (nunca 500) e aceita só o esperado.

describe("sheetMonitorAllocationBodySchema", () => {
  const LH = "LT0Q8202C3611";

  it("aceita verdito de checklist válido (Aprovado/Reprovado/vazio)", () => {
    for (const v of ["Aprovado", "Reprovado", ""]) {
      expect(sheetMonitorAllocationBodySchema.safeParse({ lh: LH, checklistCavalo: v }).success).toBe(true);
    }
  });

  it("recusa verdito de checklist fora do conjunto (case-sensitive)", () => {
    for (const v of ["talvez", "aprovado", "REPROVADO", "sim"]) {
      const r = sheetMonitorAllocationBodySchema.safeParse({ lh: LH, checklistCarreta: v });
      expect(r.success).toBe(false);
    }
  });

  it("recusa campo desconhecido (.strict) e lh vazio", () => {
    expect(sheetMonitorAllocationBodySchema.safeParse({ lh: LH, foo: "bar" }).success).toBe(false);
    expect(sheetMonitorAllocationBodySchema.safeParse({ lh: "" }).success).toBe(false);
  });

  it("recusa tratativas acima de 1000 caracteres e aceita no limite", () => {
    expect(sheetMonitorAllocationBodySchema.safeParse({ lh: LH, tratativas: "x".repeat(1001) }).success).toBe(false);
    expect(sheetMonitorAllocationBodySchema.safeParse({ lh: LH, tratativas: "x".repeat(1000) }).success).toBe(true);
  });
});

describe("sheetMonitorCargoUpdateBodySchema", () => {
  const cargoId = "d83a6f11-0cca-4af5-8bc3-242fe3cebf79";

  it("recusa verdito de checklist inválido também na carga do sistema", () => {
    expect(sheetMonitorCargoUpdateBodySchema.safeParse({ cargoId, checklistCarreta: "xyz" }).success).toBe(false);
    expect(sheetMonitorCargoUpdateBodySchema.safeParse({ cargoId, checklistCarreta: "Reprovado" }).success).toBe(true);
  });

  it("recusa cargoId que não é uuid", () => {
    expect(sheetMonitorCargoUpdateBodySchema.safeParse({ cargoId: "not-a-uuid", tratativas: "x" }).success).toBe(false);
  });
});

describe("sheetMonitorConformityOverrideBodySchema", () => {
  it("exige observação ao aprovar/reprovar", () => {
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "DRIVER", subjectKey: "123", decision: "APPROVED" }).success).toBe(false);
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "DRIVER", subjectKey: "123", decision: "APPROVED", observacao: "   " }).success).toBe(false);
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "DRIVER", subjectKey: "123", decision: "APPROVED", observacao: "ok" }).success).toBe(true);
  });

  it("permite limpar (decision null) sem observação", () => {
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "VEHICLE", subjectKey: "ABC1D23", decision: null }).success).toBe(true);
  });

  it("recusa enums inválidos, subjectKey vazio e campo desconhecido", () => {
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "TRUCK", subjectKey: "1", decision: "APPROVED", observacao: "x" }).success).toBe(false);
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "DRIVER", subjectKey: "1", decision: "MAYBE", observacao: "x" }).success).toBe(false);
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "DRIVER", subjectKey: "", decision: null }).success).toBe(false);
    expect(sheetMonitorConformityOverrideBodySchema.safeParse({ subjectType: "DRIVER", subjectKey: "1", decision: null, foo: 1 }).success).toBe(false);
  });
});
