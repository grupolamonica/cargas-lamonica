import { describe, it, expect } from "vitest";

import { deriveSpxOutcome } from "./ExternalRegistrationPanel";
import type { ExternalRegistrationJob } from "@/services/readModels";

// Rótulo honesto do SPX: um job "OK" NÃO significa "cadastrado com sucesso" —
// só as etapas de motorista ativo/aprovado na nossa agência (ja_cadastrado_
// nossa_agencia, reativado) são "apto". Rascunho/importado/pendente = em
// processamento (aguardando aprovação da Shopee). Este teste trava essa regra.

function job(partial: Partial<ExternalRegistrationJob>): ExternalRegistrationJob {
  return {
    id: "j1",
    cadastro_id: "c1",
    target: "spx",
    step: "spx_motorista",
    status: "OK",
    ...partial,
  } as ExternalRegistrationJob;
}

describe("deriveSpxOutcome", () => {
  it("retorna NONE quando não há job", () => {
    expect(deriveSpxOutcome(null)).toBe("NONE");
    expect(deriveSpxOutcome(undefined)).toBe("NONE");
  });

  it("mapeia estados não-OK direto", () => {
    expect(deriveSpxOutcome(job({ status: "IN_PROGRESS" }))).toBe("PROCESSANDO");
    expect(deriveSpxOutcome(job({ status: "ERROR" }))).toBe("ERRO");
    expect(deriveSpxOutcome(job({ status: "PENDING" }))).toBe("PENDENTE");
  });

  it("OK + etapa de agência ativa = APTO", () => {
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "ja_cadastrado_nossa_agencia" } }))).toBe("APTO");
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "reativado" } }))).toBe("APTO");
  });

  it("OK + etapa de rascunho/solicitação = RASCUNHO (nunca APTO)", () => {
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "completo" } }))).toBe("RASCUNHO");
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "importado" } }))).toBe("RASCUNHO");
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "request_pendente" } }))).toBe("RASCUNHO");
  });

  it("OK sem etapa conhecida = RASCUNHO (conservador: nunca afirma sucesso)", () => {
    expect(deriveSpxOutcome(job({ status: "OK", response: null }))).toBe("RASCUNHO");
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "algo_novo_do_bot" } }))).toBe("RASCUNHO");
    expect(deriveSpxOutcome(job({ status: "OK" }))).toBe("RASCUNHO");
  });

  it("OK + etapa de sync (poller) = INATIVO / BLOQUEADO (RF-08)", () => {
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "inativo" } }))).toBe("INATIVO");
    expect(deriveSpxOutcome(job({ status: "OK", response: { etapa: "bloqueado" } }))).toBe("BLOQUEADO");
  });
});
