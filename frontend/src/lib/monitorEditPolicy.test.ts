import { describe, expect, it } from "vitest";

import { allocEditPolicy, isSpxTrip } from "./monitorEditPolicy";

// LH de viagem SPX real (Shopee) começa com "LT". Nestlé usa "B101…".
const LT = "LT0Q7F02AY8M1"; // Shopee/SPX
const NESTLE = "B101457376"; // Nestlé (não vai pro ASPX)

describe("isSpxTrip", () => {
  it("LT… = viagem SPX; Nestlé/manual/vazio = não", () => {
    expect(isSpxTrip("LT0Q7E02AR731")).toBe(true);
    expect(isSpxTrip("lt0q7...")).toBe(true); // case-insensitive
    expect(isSpxTrip("B101457376")).toBe(false);
    expect(isSpxTrip("SPOT")).toBe(false);
    expect(isSpxTrip("")).toBe(false);
    expect(isSpxTrip(null)).toBe(false);
  });
});

describe("allocEditPolicy", () => {
  it("disponível / reservado (sem status) → editável, sem aviso", () => {
    expect(allocEditPolicy({ status: "", lh: LT })).toEqual({ editable: true, aspxWarning: false });
    expect(allocEditPolicy({ status: "   ", lh: LT })).toEqual({ editable: true, aspxWarning: false });
  });

  it("viagem SPX (LT…) com status operacional → editável COM aviso de ASPX", () => {
    expect(allocEditPolicy({ status: "AGUARDANDO CHEGAR NO CLIENTE", lh: LT })).toEqual({ editable: true, aspxWarning: true });
    expect(allocEditPolicy({ status: "Aguardando carregamento", lh: LT })).toEqual({ editable: true, aspxWarning: true });
  });

  it("Nestlé (LH B101…) com status operacional → editável SEM aviso de ASPX (não vai pro ASPX)", () => {
    expect(allocEditPolicy({ status: "AGUAR. CARREGAMENTO", lh: NESTLE })).toEqual({ editable: true, aspxWarning: false });
    expect(allocEditPolicy({ status: "EM TRÂNISTO", lh: NESTLE })).toEqual({ editable: true, aspxWarning: false });
  });

  it("DC-224: status pós-carregamento continuam editáveis; aviso de ASPX só em viagem SPX", () => {
    for (const status of [
      "AGUARDANDO DESCARGA",
      "CARREGADO",
      "DESCARREGADO",
      "DESCARREGANDO",
      "CTE ENVIADO",
      "CTE EM EMISSÃO",
      "NO SHOW",
      "CANCELADO",
      "Em transito",
    ]) {
      expect(allocEditPolicy({ status, lh: LT })).toEqual({ editable: true, aspxWarning: true });
      expect(allocEditPolicy({ status, lh: NESTLE })).toEqual({ editable: true, aspxWarning: false });
    }
  });
});
