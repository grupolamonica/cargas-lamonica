import { describe, expect, it } from "vitest";

import {
  DUPLICATE_ALLOCATION_CODE,
  duplicateAllocationConflicts,
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
