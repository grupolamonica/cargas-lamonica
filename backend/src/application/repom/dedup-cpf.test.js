import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  seedDriverProfile,
  seedPendingRegistration,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { resolveCpfDedup, normalizeCpf } = await import("./dedup-cpf.js");

describe("resolveCpfDedup — dedup por CPF (PRD §7)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("normalizeCpf remove máscara", () => {
    expect(normalizeCpf("123.456.789-01")).toBe("12345678901");
    expect(normalizeCpf(null)).toBe("");
  });

  it("caso 0: CPF inválido (≠ 11 dígitos)", async () => {
    const r = await resolveCpfDedup({ cpf: "123" });
    expect(r).toMatchObject({ case: 0, action: "invalid" });
  });

  it("caso 1: CPF não existe → create", async () => {
    const r = await resolveCpfDedup({ cpf: "11111111111" });
    expect(r).toMatchObject({ case: 1, action: "create", cpf: "11111111111" });
  });

  it("caso 2: cadastro incompleto (draft) → continue (aceita CPF mascarado)", async () => {
    const { id } = await seedPendingRegistration({
      status: "draft",
      dados: { motorista: { cpf: "222.222.222-22" } },
    });
    const r = await resolveCpfDedup({ cpf: "22222222222" });
    expect(r).toMatchObject({ case: 2, action: "continue", registrationId: id });
  });

  it("caso 3: cadastro em andamento (pendente) → resume", async () => {
    await seedPendingRegistration({ status: "pendente", dados: { motorista: { cpf: "33333333333" } } });
    const r = await resolveCpfDedup({ cpf: "33333333333" });
    expect(r).toMatchObject({ case: 3, action: "resume", registrationStatus: "pendente" });
  });

  it("caso 4: já é motorista oficial → inform_approved", async () => {
    await seedDriverProfile({ document_number: "44444444444" });
    const r = await resolveCpfDedup({ cpf: "444.444.444-44" });
    expect(r).toMatchObject({ case: 4, action: "inform_approved" });
    expect(r.driverUserId).toBeTruthy();
  });

  it("caso 4: cadastro aprovado (sem driver_profile ainda) → inform_approved", async () => {
    await seedPendingRegistration({ status: "aprovado", dados: { motorista: { cpf: "66666666666" } } });
    const r = await resolveCpfDedup({ cpf: "66666666666" });
    expect(r).toMatchObject({ case: 4, action: "inform_approved" });
  });

  it("caso 5: cadastro rejeitado → reopen (sem criar 2º)", async () => {
    await seedPendingRegistration({ status: "rejeitado", dados: { motorista: { cpf: "55555555555" } } });
    const r = await resolveCpfDedup({ cpf: "55555555555" });
    expect(r).toMatchObject({ case: 5, action: "reopen" });
  });
});
