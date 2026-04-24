import {
  applyAssignableRouteToCargoDraft,
  buildCargoTotalPayment,
  buildAssignableRouteKey,
  findAssignableRouteByLocations,
  getAssignableRouteLabel,
  resolveCargoCompensation,
  resolveAssignableRouteForCargo,
  type AssignableRouteOption,
} from "@/lib/assignableRoutes";

describe("assignable routes helpers", () => {
  const route: AssignableRouteOption = {
    id: "route-1",
    route_key: "sao paulo|simoes filho",
    origin_key: "sao paulo",
    destination_key: "simoes filho",
    origem: "SAO PAULO",
    destino: "SIMOES FILHO",
    distancia_km: 1000,
    duracao_horas: 15,
    tempo_estimado_horas: 16,
    perfil_padrao: "CARRETA",
    valor_padrao: 14000,
    bonus_padrao: 500,
    ativa: true,
    base_route_label: "SAO PAULO X SIMOES FILHO",
    source: "base+db",
  };

  it("builds a normalized route key", () => {
    expect(buildAssignableRouteKey("Sao Paulo", "Simoes Filho")).toBe("sao paulo|simoes filho");
  });

  it("finds a route by origin and destination even with state suffixes", () => {
    expect(findAssignableRouteByLocations([route], "Sao Paulo", "Simoes Filho")).toEqual(route);
    expect(findAssignableRouteByLocations([route], "Sao Paulo / SP", "Simoes Filho / BA")).toEqual(route);
    expect(findAssignableRouteByLocations([route], "Pedreira 01 / SP", "Simoes Filho / BA")).toEqual(route);
    expect(findAssignableRouteByLocations([route], "Campinas", "Bahia")).toBeNull();
  });

  it("prefers the base route label when available", () => {
    expect(getAssignableRouteLabel(route)).toBe("SAO PAULO X SIMOES FILHO");
    expect(
      getAssignableRouteLabel({
        base_route_label: null,
        origem: "Campinas",
        destino: "Recife",
      }),
    ).toBe("Campinas -> Recife");
  });

  it("applies route defaults to a cargo draft after matching by locations", () => {
    const matchedRoute = resolveAssignableRouteForCargo([route], {
      route_key: "",
      origem: "Pedreira 01 / SP",
      destino: "Simoes Filho / BA",
    });

    expect(
      applyAssignableRouteToCargoDraft(
        {
          route_key: "",
          origem: "Pedreira 01 / SP",
          destino: "Simoes Filho / BA",
          perfil: "TRUCK",
          valor: "",
          bonus: "",
        },
        matchedRoute,
      ),
    ).toMatchObject({
      route_key: route.route_key,
      perfil: "CARRETA",
      valor: "14000",
      bonus: "500",
    });
  });

  it("matches abbreviated operational names like SJ Rio Preto to the route catalog city", () => {
    const sjRioPretoRoute: AssignableRouteOption = {
      ...route,
      id: "route-2",
      route_key: "sao jose do rio preto|simoes filho",
      origin_key: "sao jose do rio preto",
      origem: "SAO JOSE DO RIO PRETO",
      valor_padrao: 15000,
      bonus_padrao: 0,
      base_route_label: "SAO JOSE DO RIO PRETO X SIMOES FILHO",
    };

    expect(findAssignableRouteByLocations([sjRioPretoRoute], "SJ Rio Preto-02 / SP", "Simoes Filho / BA")).toEqual(
      sjRioPretoRoute,
    );
  });

  it("falls back to route payment defaults when the cargo has no valor or bonus", () => {
    expect(resolveCargoCompensation({ valor: null, bonus: null }, route)).toMatchObject({
      valor: 14000,
      bonus: 500,
      total: 14500,
      source: "route",
    });
  });

  it("keeps cargo values when already persisted and still computes the total payout", () => {
    expect(resolveCargoCompensation({ valor: 16000, bonus: 700 }, route)).toMatchObject({
      valor: 16000,
      bonus: 700,
      total: 16700,
      source: "cargo",
    });
    expect(buildCargoTotalPayment(16000, 700)).toBe(16700);
  });

  it("mixes persisted cargo payment with the missing route bonus when needed", () => {
    expect(resolveCargoCompensation({ valor: 15250, bonus: null }, route)).toMatchObject({
      valor: 15250,
      bonus: 500,
      total: 15750,
      source: "mixed",
    });
  });
});
