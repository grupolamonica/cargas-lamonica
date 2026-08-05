import { describe, expect, it } from "vitest";

import {
  ALLOCATION_CHANGED_CODE,
  DUPLICATE_ALLOCATION_CODE,
  allocationChangedBaseline,
  duplicateAllocationConflicts,
  isAllocationChangedError,
  isDuplicateAllocationError,
} from "./allocationConflict";

describe("isDuplicateAllocationError", () => {
  it("reconhece o aviso de duplicidade pelo código", () => {
    expect(isDuplicateAllocationError({ details: { code: DUPLICATE_ALLOCATION_CODE } })).toBe(true);
  });

  it("NÃO confunde com outros 409 do mesmo endpoint", () => {
    // Estes precisam continuar como erro puro (não são confirmáveis).
    expect(isDuplicateAllocationError({ details: { code: "DUPLICATE_TRIP_CODE" } })).toBe(false);
    expect(isDuplicateAllocationError({ details: { code: "CARGO_MERGED_OR_RETIRED" } })).toBe(false);
  });

  it("é seguro com erro comum, null e undefined", () => {
    expect(isDuplicateAllocationError(new Error("falhou"))).toBe(false);
    expect(isDuplicateAllocationError(null)).toBe(false);
    expect(isDuplicateAllocationError(undefined)).toBe(false);
    expect(isDuplicateAllocationError({ details: null })).toBe(false);
    expect(isDuplicateAllocationError({})).toBe(false);
  });
});

describe("duplicateAllocationConflicts", () => {
  it("devolve a lista anexada pelo backend", () => {
    const conflitos = [{ lh: "LT-1", conflitaMotorista: true }];
    expect(duplicateAllocationConflicts({ details: { code: DUPLICATE_ALLOCATION_CODE, conflitos } })).toEqual(conflitos);
  });

  it("devolve vazio quando ausente ou malformado", () => {
    expect(duplicateAllocationConflicts({ details: { code: DUPLICATE_ALLOCATION_CODE } })).toEqual([]);
    expect(duplicateAllocationConflicts({ details: { conflitos: "nao-array" } })).toEqual([]);
    expect(duplicateAllocationConflicts(null)).toEqual([]);
  });
});

describe("isAllocationChangedError", () => {
  it("reconhece o aviso de edição simultânea pelo código", () => {
    expect(isAllocationChangedError({ details: { code: ALLOCATION_CHANGED_CODE } })).toBe(true);
  });

  it("NÃO confunde com o aviso de duplicidade nem com os 409 não-confirmáveis", () => {
    expect(isAllocationChangedError({ details: { code: DUPLICATE_ALLOCATION_CODE } })).toBe(false);
    expect(isAllocationChangedError({ details: { code: "CARGO_MERGED_OR_RETIRED" } })).toBe(false);
    expect(isAllocationChangedError({ details: { code: "DUPLICATE_TRIP_CODE" } })).toBe(false);
  });

  it("é seguro com erro comum, null e undefined", () => {
    expect(isAllocationChangedError(new Error("falhou"))).toBe(false);
    expect(isAllocationChangedError(null)).toBe(false);
    expect(isAllocationChangedError(undefined)).toBe(false);
  });
});

describe("allocationChangedBaseline", () => {
  it("extrai o carimbo para o reenvio (sem ele, confirmar cairia no mesmo aviso em loop)", () => {
    const iso = "2026-08-05T12:13:12.000Z";
    expect(allocationChangedBaseline({ details: { code: ALLOCATION_CHANGED_CODE, allocUpdatedAt: iso } })).toBe(iso);
  });

  it("devolve null quando ausente ou de tipo inesperado", () => {
    expect(allocationChangedBaseline({ details: { code: ALLOCATION_CHANGED_CODE } })).toBeNull();
    expect(allocationChangedBaseline({ details: { allocUpdatedAt: 12345 } })).toBeNull();
    expect(allocationChangedBaseline(null)).toBeNull();
  });
});
