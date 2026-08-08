import { describe, expect, it } from "vitest";

import {
  DRIVER_CAMPAIGNS,
  getActiveDriverCampaign,
  type DriverCampaign,
} from "@/lib/driverCampaigns";

const campanha88 = DRIVER_CAMPAIGNS[0];

describe("getActiveDriverCampaign", () => {
  it("devolve a campanha dentro da janela anunciada (08/08 08h → 10/08 12h BRT)", () => {
    // 09/08/2026 10:00 BRT — meio da promoção.
    expect(getActiveDriverCampaign(new Date("2026-08-09T13:00:00.000Z"))?.id).toBe(campanha88.id);
  });

  it("inclui os instantes de abertura e de encerramento", () => {
    expect(getActiveDriverCampaign(new Date(campanha88.startsAt))).not.toBeNull();
    expect(getActiveDriverCampaign(new Date(campanha88.endsAt))).not.toBeNull();
  });

  it("não devolve nada antes de começar", () => {
    // 08/08/2026 07:59 BRT — um minuto antes da abertura.
    expect(getActiveDriverCampaign(new Date("2026-08-08T10:59:00.000Z"))).toBeNull();
  });

  it("some sozinha depois do fim — banner vencido não fica no ar", () => {
    // 10/08/2026 12:01 BRT.
    expect(getActiveDriverCampaign(new Date("2026-08-10T15:01:00.000Z"))).toBeNull();
  });

  it("ignora campanha com datas inválidas em vez de quebrar a lista", () => {
    const quebrada: DriverCampaign = { ...campanha88, startsAt: "não é data", endsAt: "nem isso" };
    expect(getActiveDriverCampaign(new Date("2026-08-09T13:00:00.000Z"), [quebrada])).toBeNull();
  });

  it("filtra pelos valores crus do facet (sem acento) — acento devolve zero carga", () => {
    expect(campanha88.origem).toBe("SIMOES FILHO");
    expect(campanha88.destino).toBe("JABOATAO DOS GUARARAPES");
  });
});
