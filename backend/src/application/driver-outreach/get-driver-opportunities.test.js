import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  seedCargo,
  seedDriverOutreachOptout,
  seedMotoristaHistorico,
  seedPendingRegistration,
  seedSheetSnapshot,
  withPgClient,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient }));

// Angellira é externo — mock (padrão: não vigente, não interfere na detecção).
const { angMock } = vi.hoisted(() => ({ angMock: vi.fn() }));
vi.mock("./angellira-check.js", () => ({ checkAngelliraVigencia: angMock }));

const { getDriverOpportunities } = await import("./get-driver-opportunities.js");

const daysAgoIso = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
// Data (YYYY-MM-DD) N dias no FUTURO — cargas de retorno só contam de hoje em
// diante; uma data fixa aqui vira bomba-relógio (o teste quebrou quando
// "2026-07-20" ficou no passado e derrubou o gate de deploy).
const daysAheadDate = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("getDriverOpportunities (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    angMock.mockResolvedValue({ checked: true, vigente: false, status: "NOT_FOUND", found: false, validUntil: null });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("detecta churn + carga de retorno e compõe o whatsappUrl com o telefone do motorista", async () => {
    await seedMotoristaHistorico({ cpf: "12345678901", nome: "JOAO DA SILVA", telefone: "71988887777" });
    await seedSheetSnapshot([
      { motoristas: "Joao da Silva", data: "2026-05-01", origem: "Simoes Filho / BA", destino: "Recife / PE" },
      { motoristas: "Joao da Silva", data: "2026-04-01", origem: "Simoes Filho / BA", destino: "Recife / PE" },
      { motoristas: "Outro Motorista", data: "2026-05-02", origem: "X / SP", destino: "Y / SP" },
    ]);
    await seedCargo({ status: "OPEN", origem: "Recife / PE", destino: "Simoes Filho / BA", data: daysAheadDate(7) });

    const result = await getDriverOpportunities({ cpf: "123.456.789-01", nome: "Joao da Silva" });

    const triggers = result.opportunities.map((o) => o.trigger);
    expect(triggers).toContain("churn");
    expect(triggers).toContain("return_load");
    expect(result.driver.phone).toBe("71988887777");

    const churn = result.opportunities.find((o) => o.trigger === "churn");
    expect(churn.whatsappUrl).toContain("https://wa.me/5571988887777?text=");
    // Copy simplificada (sem jargão): saudação com nome + CTA "SIM".
    expect(churn.message).toMatch(/Joao/);
    expect(churn.message).toMatch(/SIM/);

    const preferences = result.opportunities.find((o) => o.trigger === "preferences");
    expect(preferences.whatsappUrl).toBeNull(); // preferências = exibição, sem envio
    // clicar em preferências abre um modal com as cargas OPEN que casam
    expect(Array.isArray(preferences.data.suggestedLoads)).toBe(true);
    expect(preferences.data.suggestedLoads.length).toBeGreaterThan(0);
    expect(preferences.data.suggestedLoads[0].whatsappUrl).toContain("https://wa.me/");
  });

  it("detecta cadastro perdido (draft antigo não finalizado)", async () => {
    await seedPendingRegistration({
      status: "draft",
      dados: { motorista: { cpf: "99999999999", nome: "Maria", telefone: "81970001111" }, __currentStep: "stepC" },
      created_at: daysAgoIso(3),
    });

    const result = await getDriverOpportunities({ cpf: "99999999999", nome: "Maria" });

    const lost = result.opportunities.find((o) => o.trigger === "lost_registration");
    expect(lost).toBeTruthy();
    expect(lost.data.currentStep).toBe("stepC");
    expect(lost.whatsappUrl).toContain("https://wa.me/5581970001111?text=");
  });

  it("NÃO mostra cadastro perdido quando o motorista já é vigente no Angellira (Parte 4a)", async () => {
    angMock.mockResolvedValue({ checked: true, vigente: true, status: "FOUND", found: true, validUntil: "2026-12-31" });
    await seedPendingRegistration({
      status: "draft",
      dados: { motorista: { cpf: "99999999999", nome: "Maria", telefone: "81970001111" }, __currentStep: "stepC" },
      created_at: daysAgoIso(3),
    });

    const result = await getDriverOpportunities({ cpf: "99999999999", nome: "Maria" });
    expect(result.opportunities.find((o) => o.trigger === "lost_registration")).toBeUndefined();
  });

  it("respeita opt-out: detecta a oportunidade mas não gera whatsappUrl", async () => {
    await seedMotoristaHistorico({ cpf: "11122233344", nome: "PEDRO SOUZA", telefone: "71911112222" });
    await seedSheetSnapshot([
      { motoristas: "Pedro Souza", data: "2026-05-01", origem: "Salvador / BA", destino: "Recife / PE" },
    ]);
    await seedDriverOutreachOptout({ driver_key: "11122233344" });

    const result = await getDriverOpportunities({ cpf: "11122233344", nome: "Pedro Souza" });

    expect(result.optedOut).toBe(true);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opp of result.opportunities) {
      expect(opp.whatsappUrl).toBeNull();
    }
  });

  it("retorna vazio para motorista sem sinais", async () => {
    const result = await getDriverOpportunities({ cpf: "00000000000", nome: "Fantasma Inexistente" });
    expect(result.opportunities).toEqual([]);
    expect(result.optedOut).toBe(false);
  });
});
