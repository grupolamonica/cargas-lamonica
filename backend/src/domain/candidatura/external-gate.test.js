import { describe, expect, it } from "vitest";
import { EXTERNAL_GATE, resolveExternalGate } from "./external-gate.js";

const TODAY = "2026-07-31";
const conformeVigente = { found: true, statusText: "Conforme", validUntil: "2026-11-25" };

describe("resolveExternalGate — nova regra Angellira + SPX", () => {
  it("Angellira Conforme+vigente E SPX ativo na nossa agência → PASS", () => {
    const r = resolveExternalGate({ angellira: conformeVigente, spx: { status: "ativo" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.PASS);
  });

  it("Angellira OK mas SPX 'outra agência' → SEND_DATA_NO_SPX", () => {
    const r = resolveExternalGate({ angellira: conformeVigente, spx: { status: "outra_agencia" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.SEND_DATA_NO_SPX);
    expect(r.spxStatus).toBe("outra_agencia");
  });

  it("Angellira OK mas SPX não cadastrado → SEND_DATA_NO_SPX", () => {
    const r = resolveExternalGate({ angellira: conformeVigente, spx: { status: "nao_cadastrado" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.SEND_DATA_NO_SPX);
  });

  it("Angellira OK mas SPX inativo/bloqueado → SEND_DATA_NO_SPX", () => {
    expect(resolveExternalGate({ angellira: conformeVigente, spx: { status: "inativo" }, today: TODAY }).gate)
      .toBe(EXTERNAL_GATE.SEND_DATA_NO_SPX);
    expect(resolveExternalGate({ angellira: conformeVigente, spx: { status: "bloqueado" }, today: TODAY }).gate)
      .toBe(EXTERNAL_GATE.SEND_DATA_NO_SPX);
  });

  it("Angellira Conforme mas VENCIDO → SEND_DATA_EXPIRED (mesmo com SPX ativo)", () => {
    const vencido = { found: true, statusText: "Conforme", validUntil: "2026-06-01" };
    const r = resolveExternalGate({ angellira: vencido, spx: { status: "ativo" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.SEND_DATA_EXPIRED);
  });

  it("Angellira não encontrado → SEND_DATA (cadastrar) mesmo com SPX ativo", () => {
    const r = resolveExternalGate({ angellira: { found: false }, spx: { status: "ativo" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.SEND_DATA);
  });

  it("Angellira encontrado mas NÃO conforme → SEND_DATA", () => {
    const naoConforme = { found: true, statusText: "Não Conforme", validUntil: "2026-11-25" };
    const r = resolveExternalGate({ angellira: naoConforme, spx: { status: "ativo" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.SEND_DATA);
  });

  it("Angellira indisponível → UNAVAILABLE (não auto-passa)", () => {
    const r = resolveExternalGate({ angellira: { availability: "UNAVAILABLE" }, spx: { status: "ativo" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.UNAVAILABLE);
  });

  it("SPX indisponível → UNAVAILABLE (não auto-passa)", () => {
    const r = resolveExternalGate({ angellira: conformeVigente, spx: { availability: "UNAVAILABLE" }, today: TODAY });
    expect(r.gate).toBe(EXTERNAL_GATE.UNAVAILABLE);
  });

  it("vigência: validUntil == hoje ainda é vigente", () => {
    const r = resolveExternalGate({
      angellira: { found: true, statusText: "Conforme", validUntil: TODAY },
      spx: { status: "ativo" }, today: TODAY,
    });
    expect(r.gate).toBe(EXTERNAL_GATE.PASS);
  });

  it("statusText 'CONFORME' (caixa/espaços) ainda conta como conforme", () => {
    const r = resolveExternalGate({
      angellira: { found: true, statusText: "  CONFORME ", validUntil: "2026-11-25" },
      spx: { status: "ativo" }, today: TODAY,
    });
    expect(r.gate).toBe(EXTERNAL_GATE.PASS);
  });
});
