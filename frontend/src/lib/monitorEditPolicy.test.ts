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

  it('"aguardando carregamento" → editável COM aviso de ASPX', () => {
    expect(allocEditPolicy({ status: "AGUARDANDO CARREGAMENTO" })).toEqual({ editable: true, aspxWarning: true });
    expect(allocEditPolicy({ status: "Aguardando carregamento" })).toEqual({ editable: true, aspxWarning: true });
  });

  it("DC-224: status pós-carregamento agora são editáveis COM aviso de ASPX", () => {
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
      expect(allocEditPolicy({ status })).toEqual({ editable: true, aspxWarning: true });
    }
  });
});
