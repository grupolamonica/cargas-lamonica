import { describe, expect, it } from "vitest";
import { applyPlanilhaAvailabilityStatus } from "./planilha-availability.js";

const now = { todayIso: "2026-07-01", nowTimeIso: "12:00" };
const open = new Set(["LH-OPEN"]);

function row(over = {}) {
  return {
    lh: "LH-X",
    status: "",
    motoristas: "",
    data: "2026-07-05",
    horario: "08:00:00",
    isAvailable: true,
    ...over,
  };
}

describe("applyPlanilhaAvailabilityStatus", () => {
  it("mantém 'Disponível' (status vazio) só quando a carga está aberta pro motorista", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-OPEN" }), { openLhSet: open, now });
    expect(r.status).toBe("");
    expect(r.isAvailable).toBe(true);
  });

  it("carga FUTURA que não está aberta → 'Fechado'", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-X", data: "2026-07-05" }), { openLhSet: open, now });
    expect(r.status).toBe("Fechado");
    expect(r.isAvailable).toBe(false);
  });

  it("carga PASSADA que não está aberta → 'Fechado' (data de carregamento já passou)", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-X", data: "2026-06-20" }), { openLhSet: open, now });
    expect(r.status).toBe("Fechado");
    expect(r.isAvailable).toBe(false);
  });

  it("sem motorista e não aberta → 'Fechado' (independe de passada/futura)", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ data: "2026-07-01", horario: "09:00:00" }), { openLhSet: open, now });
    expect(r.status).toBe("Fechado");
  });

  it("NÃO mexe em linha com status operacional da planilha", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ status: "AGUARDANDO CARREGAMENTO", data: "2026-06-01" }), { openLhSet: open, now });
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("NÃO mexe em linha com motorista da planilha (badge Reservado)", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ motoristas: "JOÃO", data: "2026-06-01" }), { openLhSet: open, now });
    expect(r.status).toBe("");
    expect(r.motoristas).toBe("JOÃO");
  });

  it("motorista via override do operador (alloc) também preserva (não vira Fechado)", () => {
    const allocByLh = { "LH-X": { alloc_motorista: "MARIA" } };
    const r = applyPlanilhaAvailabilityStatus(row({ data: "2026-06-01" }), { openLhSet: open, allocByLh, now });
    expect(r.status).toBe("");
  });

  it("alloc '' (override vazio) NÃO esconde o motorista vivo da planilha → 'Reservado'", () => {
    // Um override vazio parado (ex.: cascata esvaziou e a Shopee re-escalou a viagem)
    // não pode mais mascarar o motorista da planilha: cai pro efetivo da planilha.
    const allocByLh = { "LH-X": { alloc_motorista: "" } };
    const r = applyPlanilhaAvailabilityStatus(row({ motoristas: "JOÃO DA PLANILHA", data: "2026-06-20" }), { openLhSet: open, allocByLh, now });
    expect(r.status).toBe(""); // badge deriva de `motoristas` → Reservado (tem motorista)
  });

  it("alloc '' + planilha também SEM motorista + não aberta → 'Fechado'", () => {
    // Sem motorista em lugar nenhum (nem override nem planilha) e não aberta → Fechado.
    const allocByLh = { "LH-X": { alloc_motorista: "" } };
    const r = applyPlanilhaAvailabilityStatus(row({ motoristas: "", data: "2026-06-20" }), { openLhSet: open, allocByLh, now });
    expect(r.status).toBe("Fechado");
  });

  it("sem openLhSet (falha na leitura) → não aplica a regra (no-op)", () => {
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-X", data: "2026-06-20" }), { openLhSet: null, now });
    expect(r.status).toBe("");
    expect(r.isAvailable).toBe(true);
  });

  it("carga RESERVADA por lead da Fila → 'Reservado' com o motorista injetado (não 'Fechada')", () => {
    const reservedByLh = { "LH-X": { motorista: "CARLOS DO PORTAL", cavalo: "AAA1B23", carreta: "CCC4D56" } };
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-X", data: "2026-07-05" }), { openLhSet: open, now, reservedByLh });
    expect(r.status).toBe(""); // badge deriva de `motoristas` → Reservado
    expect(r.motoristas).toBe("CARLOS DO PORTAL");
    expect(r.cavalo).toBe("AAA1B23");
    expect(r.carreta).toBe("CCC4D56");
    expect(r.hasDriver).toBe(true);
    expect(r.isAvailable).toBe(false);
  });

  it("reserva da Fila NÃO sobrepõe placas já presentes na planilha", () => {
    const reservedByLh = { "LH-X": { motorista: "CARLOS", cavalo: "DA-RESERVA", carreta: "" } };
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-X", cavalo: "DA-PLANILHA", data: "2026-07-05" }), { openLhSet: open, now, reservedByLh });
    expect(r.cavalo).toBe("DA-PLANILHA");
  });

  it("reserva da Fila em carga PASSADA também mostra Reservado (não 'Fechado')", () => {
    const reservedByLh = { "LH-X": { motorista: "CARLOS" } };
    const r = applyPlanilhaAvailabilityStatus(row({ lh: "LH-X", data: "2026-06-20" }), { openLhSet: open, now, reservedByLh });
    expect(r.status).toBe("");
    expect(r.motoristas).toBe("CARLOS");
  });
});
