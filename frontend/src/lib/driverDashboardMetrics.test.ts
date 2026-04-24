import { buildDriverDashboardSnapshot } from "@/lib/driverDashboardMetrics";
import type { DriverLoadReadModelItem } from "@/services/readModels";

describe("driver dashboard metrics", () => {
  const loads: DriverLoadReadModelItem[] = [
    {
      id: "load-1",
      data: "2026-04-08",
      horario: "10:00:00",
      origem: "Sao Paulo / SP",
      destino: "Salvador / BA",
      distancia_km: 1500,
      duracao_horas: 24,
      perfil: "CARRETA",
      valor: 14000,
      bonus: 500,
      clienteId: "client-1",
      clienteNome: "Shopee",
      clienteDescricao: null,
      carregamentoLabel: "2026-04-08T10:00:00.000Z",
      descargaLabel: "2026-04-09T16:00:00.000Z",
    },
    {
      id: "load-2",
      data: "2026-04-09",
      horario: "09:00:00",
      origem: "Guarulhos / SP",
      destino: "Recife / PE",
      distancia_km: 900,
      duracao_horas: 18,
      perfil: "TRUCK",
      valor: 9000,
      bonus: null,
      clienteId: "client-2",
      clienteNome: "Atlas",
      clienteDescricao: null,
      carregamentoLabel: "2026-04-09T09:00:00.000Z",
      descargaLabel: "2026-04-10T04:00:00.000Z",
    },
    {
      id: "load-3",
      data: "2026-04-10",
      horario: "07:00:00",
      origem: "Campinas / SP",
      destino: "Sorocaba / SP",
      distancia_km: 120,
      duracao_horas: 3,
      perfil: "VUC",
      valor: 1800,
      bonus: 200,
      clienteId: "client-1",
      clienteNome: "Shopee",
      clienteDescricao: null,
      carregamentoLabel: "2026-04-10T07:00:00.000Z",
      descargaLabel: "2026-04-10T12:00:00.000Z",
    },
  ];

  it("builds hero metrics from real driver loads", () => {
    const snapshot = buildDriverDashboardSnapshot(loads, new Date("2026-04-08T08:00:00.000Z"));

    expect(snapshot.hero).toMatchObject({
      openLoads: 3,
      totalPayout: 25500,
      next24hLoads: 1,
      next24hPayout: 14500,
      bonusLoads: 2,
      bonusTotal: 700,
      uniqueClients: 2,
      uniqueCorridors: 3,
      uniqueProfiles: 3,
      uniqueStates: 3,
    });
    expect(snapshot.hero.averageTicket).toBeCloseTo(8500, 5);
    expect(snapshot.hero.averagePayPerKm).toBeCloseTo(12.1111, 3);
  });

  it("ranks the best routes and profiles for the driver", () => {
    const snapshot = buildDriverDashboardSnapshot(loads, new Date("2026-04-08T08:00:00.000Z"));

    expect(snapshot.topRoutes[0]).toMatchObject({
      id: "load-3",
      clientName: "Shopee",
      profile: "VUC",
      totalPayment: 2000,
      hasBonus: true,
    });
    expect(snapshot.topProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: "CARRETA",
          loads: 1,
          averageTicket: 14500,
        }),
        expect.objectContaining({
          profile: "TRUCK",
          loads: 1,
          averageTicket: 9000,
        }),
      ]),
    );
  });

  it("builds departure windows and client ranking", () => {
    const snapshot = buildDriverDashboardSnapshot(loads, new Date("2026-04-08T08:00:00.000Z"));

    expect(snapshot.departureWindows[0]).toMatchObject({
      label: "Hoje",
      loads: 1,
      payout: 14500,
    });
    expect(snapshot.departureWindows[1]).toMatchObject({
      label: "Amanhã",
      loads: 1,
      payout: 9000,
    });
    expect(snapshot.topClients[0]).toMatchObject({
      clientName: "Shopee",
      loads: 2,
      totalPayout: 16500,
    });
    expect(snapshot.topClients[0].share).toBeCloseTo(16500 / 25500, 5);
  });
});
