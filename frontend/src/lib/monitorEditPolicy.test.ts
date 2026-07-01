import { describe, expect, it } from "vitest";

import { allocEditPolicy } from "./monitorEditPolicy";

describe("allocEditPolicy", () => {
  it("disponível / reservado (sem status) → editável, sem aviso", () => {
    expect(allocEditPolicy({ status: "" })).toEqual({ editable: true, aspxWarning: false });
    expect(allocEditPolicy({ status: "   " })).toEqual({ editable: true, aspxWarning: false });
  });

  it('"aguardando chegar no cliente" → editável COM aviso de ASPX', () => {
    expect(allocEditPolicy({ status: "AGUARDANDO CHEGAR NO CLIENTE" })).toEqual({ editable: true, aspxWarning: true });
    expect(allocEditPolicy({ status: "Aguardando chegar no cliente" })).toEqual({ editable: true, aspxWarning: true });
  });

  it("NÃO confunde 'aguardando carregamento' com 'aguardando chegar' → travado", () => {
    expect(allocEditPolicy({ status: "AGUARDANDO CARREGAMENTO" })).toEqual({ editable: false, aspxWarning: false });
    expect(allocEditPolicy({ status: "AGUARDANDO DESCARGA" })).toEqual({ editable: false, aspxWarning: false });
  });

  it("demais status operacionais → travados", () => {
    for (const status of ["CARREGADO", "DESCARREGADO", "DESCARREGANDO", "CTE ENVIADO", "CTE EM EMISSÃO", "NO SHOW", "CANCELADO", "Em transito"]) {
      expect(allocEditPolicy({ status })).toEqual({ editable: false, aspxWarning: false });
    }
  });
});
