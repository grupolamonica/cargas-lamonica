import { describe, expect, it } from "vitest";

import { computeShiftMoves, computeSwapMoves, sameMonitorAlloc } from "./monitorReorder";

const A = { motorista: "A", cavalo: "AA1", carreta: "" };
const B = { motorista: "B", cavalo: "BB2", carreta: "" };
const C = { motorista: "C", cavalo: "CC3", carreta: "" };
const D = { motorista: "D", cavalo: "DD4", carreta: "" };
const EMPTY = { motorista: "", cavalo: "", carreta: "" };

function fila(...allocs: Array<{ motorista: string; cavalo: string; carreta: string }>) {
  return allocs.map((alloc, i) => ({ lh: `R${i}`, alloc }));
}

describe("computeSwapMoves", () => {
  it("troca a alocação entre duas posições", () => {
    expect(computeSwapMoves(fila(A, B, C, D), 0, 2)).toEqual([
      { lh: "R0", ...C },
      { lh: "R2", ...A },
    ]);
  });

  it("swap com linha vazia move o motorista e esvazia a outra", () => {
    expect(computeSwapMoves(fila(A, EMPTY), 0, 1)).toEqual([
      { lh: "R0", ...EMPTY },
      { lh: "R1", ...A },
    ]);
  });

  it("no-op para mesma posição / índice inválido / alocações iguais", () => {
    expect(computeSwapMoves(fila(A, B), 0, 0)).toEqual([]);
    expect(computeSwapMoves(fila(A, B), 0, 9)).toEqual([]);
    expect(computeSwapMoves(fila(A, A, B), 0, 1)).toEqual([]);
  });
});

describe("computeShiftMoves", () => {
  it("desce: move a origem para antes de uma posição abaixo, deslocando o meio", () => {
    // [A,B,C,D] mover R0 para antes do idx2 (C) => [B,A,C,D]
    expect(computeShiftMoves(fila(A, B, C, D), 0, 2)).toEqual([
      { lh: "R0", ...B },
      { lh: "R1", ...A },
    ]);
  });

  it("desce até o fim (insertBefore = len)", () => {
    // [A,B,C,D] mover R0 para o fim => [B,C,D,A]
    expect(computeShiftMoves(fila(A, B, C, D), 0, 4)).toEqual([
      { lh: "R0", ...B },
      { lh: "R1", ...C },
      { lh: "R2", ...D },
      { lh: "R3", ...A },
    ]);
  });

  it("sobe: move a origem para antes de uma posição acima", () => {
    // [A,B,C,D] mover R3 (D) para antes do idx1 (B) => [A,D,B,C]
    expect(computeShiftMoves(fila(A, B, C, D), 3, 1)).toEqual([
      { lh: "R1", ...D },
      { lh: "R2", ...B },
      { lh: "R3", ...C },
    ]);
  });

  it("no-op: inserir na própria posição ou logo após não muda nada", () => {
    expect(computeShiftMoves(fila(A, B, C), 0, 0)).toEqual([]);
    expect(computeShiftMoves(fila(A, B, C), 0, 1)).toEqual([]);
    expect(computeShiftMoves(fila(A, B, C), 1, 1)).toEqual([]);
    expect(computeShiftMoves(fila(A, B, C), 1, 2)).toEqual([]);
  });

  it("no-op para índices inválidos", () => {
    expect(computeShiftMoves(fila(A, B), -1, 1)).toEqual([]);
    expect(computeShiftMoves(fila(A, B), 0, 5)).toEqual([]);
  });
});

describe("sameMonitorAlloc", () => {
  it("compara os três campos", () => {
    expect(sameMonitorAlloc(A, { ...A })).toBe(true);
    expect(sameMonitorAlloc(A, B)).toBe(false);
    expect(sameMonitorAlloc(EMPTY, { motorista: "", cavalo: "", carreta: "" })).toBe(true);
  });
});
