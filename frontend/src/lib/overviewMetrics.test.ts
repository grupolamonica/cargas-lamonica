import { buildOverviewSnapshot, type OverviewCargoRow, type OverviewClaimRow, type OverviewLeadRow } from "@/lib/overviewMetrics";

describe("overview metrics", () => {
  const cargos: OverviewCargoRow[] = [
    {
      id: "load-1",
      data: "2026-04-08",
      horario: "08:00:00",
      origem: "Sao Paulo / SP",
      destino: "Simoes Filho / BA",
      distancia_km: 1500,
      duracao_horas: 24,
      perfil: "CARRETA",
      valor: 14000,
      bonus: 500,
      status: "OPEN",
      is_template: false,
      created_at: "2026-04-07T07:00:00.000Z",
      updated_at: "2026-04-07T08:10:00.000Z",
      sheet_data_carregamento: "08/04/2026 08:00",
      cliente: {
        id: "client-1",
        nome: "Shopee",
        prazo_pagamento: "14 dias",
        forma_pagamento: "PIX",
        reputacao_bom_pagador: true,
        reputacao_pagamento_rapido: true,
      },
    },
    {
      id: "load-2",
      data: "2026-04-09",
      horario: "10:00:00",
      origem: "Guarulhos / SP",
      destino: "Feira de Santana / BA",
      distancia_km: 1800,
      duracao_horas: 28,
      perfil: "TRUCK",
      valor: 12000,
      bonus: null,
      status: "OPEN",
      is_template: false,
      created_at: "2026-04-07T07:30:00.000Z",
      updated_at: "2026-04-07T08:20:00.000Z",
      sheet_data_carregamento: "09/04/2026 10:00",
      cliente: {
        id: "client-2",
        nome: "Cliente B",
        prazo_pagamento: "28 dias",
        forma_pagamento: "Faturado",
        reputacao_bom_pagador: false,
        reputacao_pagamento_rapido: false,
      },
    },
    {
      id: "load-3",
      data: "2026-04-08",
      horario: "06:00:00",
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      distancia_km: 40,
      duracao_horas: 1,
      perfil: "TOCO",
      valor: 700,
      bonus: 80,
      status: "RESERVED",
      is_template: false,
      created_at: "2026-04-07T06:00:00.000Z",
      updated_at: "2026-04-07T08:30:00.000Z",
      sheet_data_carregamento: "08/04/2026 06:00",
      cliente: {
        id: "client-3",
        nome: "Cliente C",
        prazo_pagamento: null,
        forma_pagamento: null,
        reputacao_bom_pagador: false,
        reputacao_pagamento_rapido: true,
      },
    },
  ];

  const leads: OverviewLeadRow[] = [
    {
      id: "lead-1",
      load_id: "load-1",
      status: "QUEUED",
      created_at: "2026-04-07T08:40:00.000Z",
      queued_at: "2026-04-07T08:45:00.000Z",
      approved_at: null,
      whatsapp_clicked_at: "2026-04-07T08:44:00.000Z",
      vehicle_type: "CARRETA",
    },
    {
      id: "lead-2",
      load_id: "load-2",
      status: "APPROVED",
      created_at: "2026-04-07T08:35:00.000Z",
      queued_at: "2026-04-07T08:36:00.000Z",
      approved_at: "2026-04-07T08:50:00.000Z",
      whatsapp_clicked_at: "2026-04-07T08:36:00.000Z",
      vehicle_type: "TRUCK",
    },
  ];

  const claims: OverviewClaimRow[] = [
    {
      id: "claim-1",
      load_id: "load-2",
      status: "PROMOTED",
      created_at: "2026-04-07T08:10:00.000Z",
      claimed_at: "2026-04-07T08:12:00.000Z",
      promoted_at: "2026-04-07T08:55:00.000Z",
      confirmed_at: null,
      queue_position: 1,
    },
  ];

  it("builds operational hero metrics from loads, leads, and claims", () => {
    const snapshot = buildOverviewSnapshot(cargos, leads, claims, new Date("2026-04-07T12:00:00.000Z"));

    expect(snapshot.hero).toMatchObject({
      // activeLoads conta apenas OPEN (fixture tem 2 OPEN + 1 RESERVED).
      activeLoads: 2,
      queuedLeads: 1,
      // activeClaims agora = leads vivos (QUEUED + APPROVED). A tabela
      // load_claims \u00e9 legado e est\u00e1 fora do fluxo atual.
      activeClaims: 2,
      draftCount: 0,
      bookedCount: 0,
      approvedToday: 1,
    });
  });

  it("counts loads with no driver interest", () => {
    const snapshot = buildOverviewSnapshot(cargos, leads, claims, new Date("2026-04-07T12:00:00.000Z"));

    // load-1 has lead-1, load-2 has lead-2 + claim-1, so noDriverLoads = 0
    expect(snapshot.hero.noDriverLoads).toBe(0);
  });

  it("detects stale loads needing attention", () => {
    // Make loads appear old by setting now far ahead
    const futureNow = new Date("2026-04-12T12:00:00.000Z");
    const staleCargos: OverviewCargoRow[] = [
      {
        id: "stale-1",
        data: "2026-04-12",
        horario: "08:00:00",
        origem: "Campinas / SP",
        destino: "Curitiba / PR",
        distancia_km: 500,
        duracao_horas: 8,
        perfil: "CARRETA",
        valor: 5000,
        bonus: null,
        status: "OPEN",
        is_template: false,
        created_at: "2026-04-08T10:00:00.000Z",
        updated_at: "2026-04-08T10:00:00.000Z",
        sheet_data_carregamento: null,
        cliente: null,
      },
    ];

    const snapshot = buildOverviewSnapshot(staleCargos, [], [], futureNow);

    expect(snapshot.attentionLoads).toHaveLength(1);
    expect(snapshot.attentionLoads[0]).toMatchObject({
      id: "stale-1",
      origem: "Campinas / SP",
      destino: "Curitiba / PR",
      status: "OPEN",
    });
    expect(snapshot.attentionLoads[0].ageHours).toBeGreaterThanOrEqual(48);
  });

  it("flags loads with missing required fields", () => {
    const incompleteCargos: OverviewCargoRow[] = [
      {
        id: "incomplete-1",
        data: "2026-04-12",
        horario: "08:00:00",
        origem: "Sao Paulo / SP",
        destino: "Rio / RJ",
        distancia_km: null,
        duracao_horas: null,
        perfil: "",
        valor: null,
        bonus: null,
        status: "OPEN",
        is_template: false,
        created_at: "2026-04-12T08:00:00.000Z",
        updated_at: "2026-04-12T08:00:00.000Z",
        sheet_data_carregamento: null,
        cliente: null,
      },
    ];

    const snapshot = buildOverviewSnapshot(incompleteCargos, [], [], new Date("2026-04-12T09:00:00.000Z"));

    expect(snapshot.attentionLoads).toHaveLength(1);
    expect(snapshot.attentionLoads[0].missingFields).toContain("perfil");
    expect(snapshot.attentionLoads[0].missingFields).toContain("distancia_km");
  });

  it("builds recent activity feed from cargo, lead, and claim events", () => {
    const snapshot = buildOverviewSnapshot(cargos, leads, claims, new Date("2026-04-07T12:00:00.000Z"));

    expect(snapshot.recentActivity.length).toBeGreaterThan(0);
    expect(snapshot.recentActivity.length).toBeLessThanOrEqual(8);

    const types = new Set(snapshot.recentActivity.map((a) => a.type));
    expect(types).toContain("load");
    expect(types).toContain("lead");
    expect(types).toContain("claim");
  });

  it("computes lastUpdatedAt from the most recent timestamp", () => {
    const snapshot = buildOverviewSnapshot(cargos, leads, claims, new Date("2026-04-07T12:00:00.000Z"));

    expect(snapshot.lastUpdatedAt).toBeTruthy();
  });

  it("does not include monetary fields in snapshot", () => {
    const snapshot = buildOverviewSnapshot(cargos, leads, claims, new Date("2026-04-07T12:00:00.000Z"));

    // Verify no monetary fields exist on hero
    const heroKeys = Object.keys(snapshot.hero);
    expect(heroKeys).not.toContain("openPayoutTotal");
    expect(heroKeys).not.toContain("next24hPayout");
    expect(heroKeys).not.toContain("averageTicket");
    expect(heroKeys).not.toContain("averagePayPerKm");
    expect(heroKeys).not.toContain("bonusTotal");

    // Verify no chart/ranking series exist on snapshot
    const snapshotKeys = Object.keys(snapshot);
    expect(snapshotKeys).not.toContain("opportunitySeries");
    expect(snapshotKeys).not.toContain("profileSeries");
    expect(snapshotKeys).not.toContain("premiumRoutes");
    expect(snapshotKeys).not.toContain("clientValueRanking");
  });
});
