import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lookups externos mockados — resolveExpectedDriverName (real) roda sobre eles.
vi.mock("../../../infrastructure/angellira/angellira-client.js", () => ({
  lookupAngelliraDriverByCpf: vi.fn(),
}));
vi.mock("../../../infrastructure/aspx/aspx-directory.js", () => ({
  lookupAspxDriverByCpf: vi.fn(),
}));
// A checagem de identidade roda ANTES da transação — nos casos de bloqueio o
// withPgTransaction nem deve ser alcançado.
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgTransaction: vi.fn(async () => {
    throw new Error("não deveria entrar na transação quando a identidade bloqueia");
  }),
}));
vi.mock("../../../infrastructure/security-audit.js", () => ({ insertSecurityAuditEvent: vi.fn() }));
vi.mock("../../../infrastructure/security-log.js", () => ({ logStructuredEvent: vi.fn() }));
vi.mock("./antt-cascade.js", () => ({ resolveAnttCascade: vi.fn() }));

import { lookupAngelliraDriverByCpf } from "../../../infrastructure/angellira/angellira-client.js";
import { lookupAspxDriverByCpf } from "../../../infrastructure/aspx/aspx-directory.js";
import { submitCandidaturaFinal } from "./submit-final.js";

function makeArgs(motorista) {
  return {
    driverUserId: null,
    driverCpf: "03070300596",
    cargaId: null,
    idempotencyKey: "test-key",
    dados: { motorista },
    correlationId: "c-1",
  };
}

describe("submitCandidaturaFinal — backstop de identidade (chokepoint compartilhado)", () => {
  beforeEach(() => {
    lookupAngelliraDriverByCpf.mockResolvedValue({ found: false, displayName: null });
    lookupAspxDriverByCpf.mockResolvedValue({ found: false, displayName: null });
  });
  afterEach(() => vi.clearAllMocks());

  it("CPF inválido (dígito verificador) → 422 CPF_INVALIDO, sem entrar na transação", async () => {
    const res = await submitCandidaturaFinal(
      makeArgs({ nome: "BRUNA SILVA AMARAL", cpf: "12345678901", cnh: { nome: "BRUNA SILVA AMARAL" } }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.payload.code).toBe("CPF_INVALIDO");
  });

  it("#4 — nome digitado diverge da CNH (OCR) → 422 NOME_DIVERGENTE_CNH, sem entrar na transação", async () => {
    const res = await submitCandidaturaFinal(
      makeArgs({ nome: "FHILIPE MATHEUS SANTOS DUARTE", cpf: "03070300596", cnh: { nome: "BRUNA SILVA AMARAL" } }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.payload.code).toBe("NOME_DIVERGENTE_CNH");
  });

  it("#3 — FORJA do snapshot (digitado == cnh.nome) NÃO burla: diverge do Angellira → 422 NOME_DIVERGENTE_CANDIDATURA", async () => {
    lookupAngelliraDriverByCpf.mockResolvedValue({ found: true, displayName: "BRUNA SILVA AMARAL" });
    const res = await submitCandidaturaFinal(
      // O fraudador forja cnh.nome = nome digitado (passa no #4), mas o CPF é da
      // vítima → o Angellira devolve "BRUNA" → o #3 barra.
      makeArgs({ nome: "FRAUDADOR QUALQUER", cpf: "03070300596", cnh: { nome: "FRAUDADOR QUALQUER" } }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.payload.code).toBe("NOME_DIVERGENTE_CANDIDATURA");
    expect(lookupAngelliraDriverByCpf).toHaveBeenCalled();
  });

  it("nome confere com CNH e com Angellira → passa da checagem (entra na transação)", async () => {
    lookupAngelliraDriverByCpf.mockResolvedValue({ found: true, displayName: "BRUNA SILVA AMARAL" });
    // Aqui a identidade PASSA → chega no withPgTransaction (mock que lança) →
    // confirma que a checagem não barrou (o throw prova que passou do gate).
    await expect(
      submitCandidaturaFinal(
        makeArgs({ nome: "BRUNA SILVA AMARAL", cpf: "03070300596", cnh: { nome: "BRUNA SILVA AMARAL" } }),
      ),
    ).rejects.toThrow(/não deveria entrar na transação|transação/);
  });
});
