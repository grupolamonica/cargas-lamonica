import { describe, expect, it } from "vitest";
import { maskCredentialRow, normalizeSenhaParam } from "./rastreador-credentials.js";

describe("normalizeSenhaParam", () => {
  it("vazio/nulo/undefined → null (no upsert, null preserva a cifra atual via COALESCE)", () => {
    expect(normalizeSenhaParam(undefined)).toBeNull();
    expect(normalizeSenhaParam(null)).toBeNull();
    expect(normalizeSenhaParam("")).toBeNull();
  });

  it("valor → string do valor", () => {
    expect(normalizeSenhaParam("Lam0n1c@2026")).toBe("Lam0n1c@2026");
    expect(normalizeSenhaParam(12345)).toBe("12345");
  });
});

describe("maskCredentialRow", () => {
  it("com senha → hasPassword true + máscara; NUNCA devolve a senha/cifra", () => {
    const item = maskCredentialRow({
      horse_plate: "ABC1D23",
      provider: "Omnilink",
      username: "op01",
      has_password: true,
      notes: "conta principal",
      updated_at: "2026-07-12T10:00:00Z",
      updated_by: "u1",
    });
    expect(item).toEqual({
      horsePlate: "ABC1D23",
      provider: "Omnilink",
      username: "op01",
      hasPassword: true,
      passwordMask: "••••••••",
      notes: "conta principal",
      updatedAt: "2026-07-12T10:00:00Z",
      updatedBy: "u1",
    });
    // Nenhum campo de cifra/senha vaza no item mascarado.
    expect(Object.keys(item)).not.toContain("password_cipher");
    expect(Object.keys(item)).not.toContain("senha");
  });

  it("sem senha → hasPassword false + máscara null", () => {
    const item = maskCredentialRow({ horse_plate: "QAO2H45", provider: "", username: "", has_password: false });
    expect(item.hasPassword).toBe(false);
    expect(item.passwordMask).toBeNull();
    expect(item.provider).toBe("");
  });
});
