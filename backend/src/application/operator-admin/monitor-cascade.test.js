import { describe, expect, it } from "vitest";

import { computeCancelCascade } from "./monitor-cascade.js";

// Helpers para montar a fila de uma rota (ordem cronológica).
const load = (lh, motorista, extra = {}) => ({
  lh,
  motorista,
  cavalo: motorista ? `${lh}-CAV` : "",
  carreta: "",
  ...extra,
});

describe("computeCancelCascade (Interpretação A)", () => {
  it("ripple básico: o motorista da cancelada assume a próxima; o último vira reserva", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", "Maria", { cancelled: true }),
      load("C3", "Pedro"),
    ];
    const { moves, reserva } = computeCancelCascade(loads, "C2");

    // C2 esvazia (morta), C3 recebe Maria. C1 intocado.
    const byLh = Object.fromEntries(moves.map((m) => [m.lh, m]));
    expect(byLh.C2.motorista).toBe(""); // carga cancelada fica sem motorista
    expect(byLh.C3.motorista).toBe("Maria");
    expect(byLh.C3.cavalo).toBe("C2-CAV"); // veículo acompanha o motorista
    expect(byLh.C1).toBeUndefined(); // antes da cancelada → intocado
    expect(reserva?.motorista).toBe("Pedro"); // o último sobra → reserva
  });

  it("para numa carga VAZIA: o motorista preenche o buraco e ninguém vai pra reserva", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", "Maria", { cancelled: true }),
      load("C3", ""), // vaga disponível
    ];
    const { moves, reserva } = computeCancelCascade(loads, "C2");
    const byLh = Object.fromEntries(moves.map((m) => [m.lh, m]));
    expect(byLh.C2.motorista).toBe("");
    expect(byLh.C3.motorista).toBe("Maria");
    expect(reserva).toBeNull();
  });

  it("pula carga FIXA (mantém o motorista fixo) e segue a cascata", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", "Maria", { cancelled: true }),
      load("C3", "Pedro", { pinned: true }),
      load("C4", "Ana"),
    ];
    const { moves, reserva } = computeCancelCascade(loads, "C2");
    const byLh = Object.fromEntries(moves.map((m) => [m.lh, m]));
    expect(byLh.C2.motorista).toBe("");
    expect(byLh.C3).toBeUndefined();        // fixa → intocada
    expect(byLh.C4.motorista).toBe("Maria"); // Maria pulou a fixa e foi pra C4
    expect(reserva?.motorista).toBe("Ana");  // Ana sobra
  });

  it("pula outra carga CANCELADA (não aloca em carga morta)", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", "Maria", { cancelled: true }),
      load("C3", "Bob", { cancelled: true }),
      load("C4", "Pedro"),
    ];
    const { moves, reserva } = computeCancelCascade(loads, "C2");
    const byLh = Object.fromEntries(moves.map((m) => [m.lh, m]));
    expect(byLh.C2.motorista).toBe("");
    expect(byLh.C3).toBeUndefined();        // outra cancelada → intocada
    expect(byLh.C4.motorista).toBe("Maria");
    expect(reserva?.motorista).toBe("Pedro");
  });

  it("cancelada é a ÚLTIMA da fila: o motorista vai direto para reserva", () => {
    const loads = [load("C1", "Joao"), load("C2", "Maria", { cancelled: true })];
    const { moves, reserva } = computeCancelCascade(loads, "C2");
    const byLh = Object.fromEntries(moves.map((m) => [m.lh, m]));
    expect(byLh.C2.motorista).toBe("");
    expect(reserva?.motorista).toBe("Maria");
  });

  it("idempotente: carga cancelada já sem motorista → nada a fazer", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", ""), // já vazia
      load("C3", "Pedro"),
    ];
    const r = computeCancelCascade(loads, "C2");
    expect(r.moves).toEqual([]);
    expect(r.reserva).toBeNull();
  });

  it("pula carga TRAVADA (status operacional) — só remaneja Disponível/Reservado", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", "Maria", { cancelled: true }),
      load("C3", "Pedro", { locked: true }), // ex.: CARREGADO — intocável
      load("C4", "Ana"),
    ];
    const { moves, reserva } = computeCancelCascade(loads, "C2");
    const byLh = Object.fromEntries(moves.map((m) => [m.lh, m]));
    expect(byLh.C2.motorista).toBe("");
    expect(byLh.C3).toBeUndefined();         // travada → intocada
    expect(byLh.C4.motorista).toBe("Maria");  // Maria pulou a travada e foi pra C4
    expect(reserva?.motorista).toBe("Ana");
  });

  it("carga cancelada FIXA não cascateia (fixo é intocável)", () => {
    const loads = [
      load("C1", "Joao"),
      load("C2", "Maria", { cancelled: true, pinned: true }),
      load("C3", "Pedro"),
    ];
    const r = computeCancelCascade(loads, "C2");
    expect(r.moves).toEqual([]);
    expect(r.reserva).toBeNull();
  });

  it("LH inexistente → no-op", () => {
    const loads = [load("C1", "Joao")];
    const r = computeCancelCascade(loads, "NAO-EXISTE");
    expect(r.moves).toEqual([]);
    expect(r.reserva).toBeNull();
  });
});
