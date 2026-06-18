import { describe, expect, it } from "vitest";

import { computeReassignMoves, sameMonitorAlloc } from "./monitorReorder";

const A = { motorista: "A", cavalo: "AA1", carreta: "" };
const B = { motorista: "B", cavalo: "BB2", carreta: "" };
const C = { motorista: "C", cavalo: "CC3", carreta: "" };
const D = { motorista: "D", cavalo: "DD4", carreta: "" };
const EMPTY = { motorista: "", cavalo: "", carreta: "" };

function fila(...allocs: Array<{ motorista: string; cavalo: string; carreta: string }>) {
  return allocs.map((alloc, i) => ({ lh: `R${i}`, alloc }));
}

describe("computeReassignMoves", () => {
  it("swap: troca apenas as duas posições", () => {
    const moves = computeReassignMoves(fila(A, B, C, D), 0, 2, "swap");
    expect(moves).toEqual([
      { lh: "R0", ...C },
      { lh: "R2", ...A },
    ]);
  });

  it("shift: desce a origem até o destino, deslocando os do meio", () => {
    // [A,B,C,D] mover R0 -> idx2 => [B,C,A,D]
    const moves = computeReassignMoves(fila(A, B, C, D), 0, 2, "shift");
    expect(moves).toEqual([
      { lh: "R0", ...B },
      { lh: "R1", ...C },
      { lh: "R2", ...A },
    ]);
    // R3 (D) não muda
    expect(moves.find((m) => m.lh === "R3")).toBeUndefined();
  });

  it("shift: sobe a origem (destino acima da origem)", () => {
    // [A,B,C,D] mover R3 -> idx1 => [A,D,B,C]
    const moves = computeReassignMoves(fila(A, B, C, D), 3, 1, "shift");
    expect(moves).toEqual([
      { lh: "R1", ...D },
      { lh: "R2", ...B },
      { lh: "R3", ...C },
    ]);
  });

  it("swap envolvendo linha vazia move o motorista e esvazia a origem", () => {
    // [A, EMPTY] swap 0<->1 => [EMPTY, A]
    const moves = computeReassignMoves(fila(A, EMPTY), 0, 1, "swap");
    expect(moves).toEqual([
      { lh: "R0", ...EMPTY },
      { lh: "R1", ...A },
    ]);
  });

  it("retorna vazio para no-op (mesma posição ou índices inválidos)", () => {
    expect(computeReassignMoves(fila(A, B), 0, 0, "swap")).toEqual([]);
    expect(computeReassignMoves(fila(A, B), 0, 5, "shift")).toEqual([]);
    expect(computeReassignMoves(fila(A, B), -1, 1, "swap")).toEqual([]);
  });

  it("não inclui linhas inalteradas (alocações iguais)", () => {
    // dois motoristas idênticos: swap entre eles não muda nada efetivamente
    const moves = computeReassignMoves(fila(A, A, B), 0, 1, "swap");
    expect(moves).toEqual([]);
  });
});

describe("sameMonitorAlloc", () => {
  it("compara os três campos", () => {
    expect(sameMonitorAlloc(A, { ...A })).toBe(true);
    expect(sameMonitorAlloc(A, B)).toBe(false);
    expect(sameMonitorAlloc(EMPTY, { motorista: "", cavalo: "", carreta: "" })).toBe(true);
  });
});
