import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedPublicLead,
  seedRoute,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "./test-harness.js";

const { mockGetRouteInfo } = vi.hoisted(() => ({
  mockGetRouteInfo: vi.fn(),
}));

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction,
}));

vi.mock("../../infrastructure/geoapify/index.js", () => ({
  getRouteInfo: mockGetRouteInfo,
}));

const service = await import("./service.js");

describe("operator-admin service", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    mockGetRouteInfo.mockResolvedValue({
      distanceKm: 1510,
      durationHours: 24.5,
    });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cria carga por endpoint autoritativo e registra auditoria", async () => {
    const operator = await seedUser({ email: "operador@teste.local" });
    const cliente = await seedCliente({ nome: "Cliente Atlas" });

    const response = await service.createOperatorCargo({
      operatorId: operator.id,
      requestIp: "203.0.113.5",
      correlationId: "corr-create-cargo",
      payload: {
        data: "2026-04-08",
        horario: "08:00:00",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        distancia_km: 1200,
        duracao_horas: 20,
        perfil: "CARRETA",
        valor: 7300,
        bonus: 300,
        bonus_exigencias: "Entregar no prazo\nEnviar comprovante",
        driver_visibility: "PUBLIC",
        cliente_id: cliente.id,
        status: "OPEN",
        is_template: false,
      },
    });

    expect(response.statusCode).toBe(201);

    const { rows: cargas } = await query(`SELECT * FROM public.cargas ORDER BY created_at DESC`);
    const { rows: auditRows } = await query(`SELECT * FROM public.security_audit_logs ORDER BY created_at DESC`);

    expect(cargas).toHaveLength(1);
    expect(cargas[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      cliente_id: cliente.id,
      bonus_exigencias: "Entregar no prazo\nEnviar comprovante",
      driver_visibility: "PUBLIC",
      status: "OPEN",
      is_template: false,
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      event_type: "operator.cargo.created",
      actor_user_id: operator.id,
      outcome: "success",
      request_ip: "203.0.113.5",
      correlation_id: "corr-create-cargo",
    });
  });

  it("mantem o salvamento de cargas funcional quando bonus_exigencias ainda nao existe no schema", async () => {
    const operator = await seedUser({ email: "operador-schema-legado@teste.local" });
    const cliente = await seedCliente({ nome: "Cliente Legacy Bonus" });

    await query(`ALTER TABLE public.cargas DROP COLUMN bonus_exigencias`);

    const response = await service.createOperatorCargo({
      operatorId: operator.id,
      requestIp: "203.0.113.15",
      correlationId: "corr-create-cargo-legacy-bonus",
      payload: {
        data: "2026-04-08",
        horario: "08:00:00",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        distancia_km: 1200,
        duracao_horas: 20,
        perfil: "CARRETA",
        valor: 7300,
        bonus: 300,
        bonus_exigencias: "Entregar no prazo\nEnviar comprovante",
        driver_visibility: "PUBLIC",
        cliente_id: cliente.id,
        status: "OPEN",
        is_template: false,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.warnings).toContain("Optional cargo fields are not available in the current database schema.");

    const { rows: cargas } = await query(`SELECT origem, destino, valor, bonus, cliente_id, status FROM public.cargas ORDER BY created_at DESC`);

    expect(cargas).toHaveLength(1);
    expect(cargas[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      valor: 7300,
      bonus: 300,
      cliente_id: cliente.id,
      status: "OPEN",
    });
  });

  it("oculta cargas premium da listagem principal do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Premium" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
      driver_visibility: "PUBLIC",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Feira de Santana / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-09",
      driver_visibility: "PREMIUM",
    });

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-public-only",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
    });
  });

  it("oculta cargas com motorista alocado na planilha (sheet_motorista preenchido) do painel do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Sheet Lock Motorista" });

    // Carga "limpa" — deve aparecer no painel
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
      driver_visibility: "PUBLIC",
    });
    // Carga com motorista já alocado na planilha — NÃO deve aparecer mesmo
    // que status='OPEN' (caso o sync atrase em refletir BOOKED no DB)
    const lockedByMotorista = await seedCargo({
      cliente_id: cliente.id,
      origem: "Feira de Santana / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-09",
      driver_visibility: "PUBLIC",
    });
    await query(`UPDATE public.cargas SET sheet_motorista = $2 WHERE id = $1`, [
      lockedByMotorista.id,
      "JOAO SILVA",
    ]);
    // Carga com sheet_status preenchido (ex.: DESCARREGADO) — também não deve aparecer
    const lockedByStatus = await seedCargo({
      cliente_id: cliente.id,
      origem: "Camacari / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-10",
      driver_visibility: "PUBLIC",
    });
    await query(`UPDATE public.cargas SET sheet_status = $2 WHERE id = $1`, [
      lockedByStatus.id,
      "DESCARREGADO",
    ]);
    // Carga com sheet_motorista = '' explicitamente (caso o sync persista string vazia em vez de NULL)
    const emptyStringSheetMotorista = await seedCargo({
      cliente_id: cliente.id,
      origem: "Lauro de Freitas / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-11",
      driver_visibility: "PUBLIC",
    });
    await query(`UPDATE public.cargas SET sheet_motorista = $2 WHERE id = $1`, [
      emptyStringSheetMotorista.id,
      "",
    ]);

    const response = await service.fetchDriverLoadsReadModel({
      query: { page: "1", pageSize: "10" },
      correlationId: "corr-driver-sheet-lock",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(2);
    const origens = response.payload.items.map((item) => item.origem).sort();
    expect(origens).toEqual(["Lauro de Freitas / BA", "Salvador / BA"]);
  });

  it("permite ajustar a visibilidade de uma carga reservada sem invalidar o status operacional", async () => {
    const operator = await seedUser({ email: "operador-update-reserved@teste.local" });
    const cliente = await seedCliente({ nome: "Cliente Reserved" });
    const cargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      perfil: "CARRETA",
      status: "RESERVED",
      is_template: false,
      data: "2026-04-09",
      horario: "09:00:00",
      valor: 8100,
      bonus: 200,
      driver_visibility: "PUBLIC",
    });

    const response = await service.updateOperatorCargo({
      cargoId: cargo.id,
      operatorId: operator.id,
      requestIp: "203.0.113.25",
      correlationId: "corr-update-cargo-reserved",
      payload: {
        data: "2026-04-09",
        horario: "09:00:00",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        distancia_km: 1200,
        duracao_horas: 20,
        perfil: "CARRETA",
        valor: 8100,
        bonus: 200,
        bonus_exigencias: null,
        driver_visibility: "PREMIUM",
        cliente_id: cliente.id,
        status: "RESERVED",
        is_template: false,
      },
    });

    expect(response.statusCode).toBe(200);

    const { rows } = await query(`SELECT status, driver_visibility FROM public.cargas WHERE id = $1`, [cargo.id]);

    expect(rows[0]).toMatchObject({
      status: "RESERVED",
      driver_visibility: "PREMIUM",
    });
  });

  it("mantem os horarios da planilha no portal do motorista mesmo sem a coluna driver_visibility", async () => {
    const cliente = await seedCliente({ nome: "Cliente Horario" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Simoes Filho / BA",
      destino: "Salvador Retiro / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-09",
      horario: "21:31:00",
      sheet_data_carregamento: "09/04/2026 21:31",
      sheet_data_descarga: "09/04/2026 23:30",
    });

    await query(`ALTER TABLE public.cargas DROP COLUMN driver_visibility`);

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-legacy-visibility",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Simoes Filho / BA",
      destino: "Salvador Retiro / BA",
      carregamentoLabel: "09/04/2026 21:31",
      descargaLabel: "09/04/2026 23:30",
    });
  });

  it("bloqueia exclusao de carga controlada pelo fluxo operacional", async () => {
    const operator = await seedUser({ email: "operador@teste.local" });
    const cargo = await seedCargo({ status: "RESERVED" });

    await expect(
      service.deleteOperatorCargo({
        cargoId: cargo.id,
        operatorId: operator.id,
        requestIp: "203.0.113.10",
        correlationId: "corr-delete-cargo",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Nao e seguro excluir cargas controladas pelo fluxo operacional.",
    });
  });

  it("bloqueia exclusao de cliente com cargas vinculadas", async () => {
    const operator = await seedUser({ email: "operador@teste.local" });
    const cliente = await seedCliente({ nome: "Cliente Vinculado" });
    await seedCargo({ cliente_id: cliente.id });

    await expect(
      service.deleteOperatorCliente({
        clienteId: cliente.id,
        operatorId: operator.id,
        requestIp: "203.0.113.11",
        correlationId: "corr-delete-cliente",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Nao e seguro excluir um embarcador que ainda possui cargas vinculadas.",
    });
  });

  it("pagina o read model do dashboard do operador sem carregar tudo no cliente", async () => {
    const clienteA = await seedCliente({ nome: "Cliente Alpha" });
    const clienteB = await seedCliente({ nome: "Cliente Beta" });

    await seedCargo({
      cliente_id: clienteA.id,
      origem: "Salvador / BA",
      destino: "Fortaleza / CE",
      status: "OPEN",
      created_at: "2026-04-08T10:00:00.000Z",
    });
    await seedCargo({
      cliente_id: clienteB.id,
      origem: "Campinas / SP",
      destino: "Curitiba / PR",
      status: "DRAFT",
      created_at: "2026-04-08T11:00:00.000Z",
    });

    const response = await service.fetchOperatorDashboardReadModel({
      query: {
        page: "1",
        pageSize: "1",
      },
      correlationId: "corr-dashboard",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.summary).toMatchObject({
      activeCount: 1,
      draftCount: 1,
      templateCount: 0,
    });
    expect(response.payload.meta).toMatchObject({
      page: 1,
      pageSize: 1,
      totalCount: 2,
      totalPages: 2,
      hasNextPage: true,
    });
  });

  it("filtra o dashboard do operador por status e visibilidade do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Filtro Dashboard" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Fortaleza / CE",
      status: "OPEN",
      driver_visibility: "PUBLIC",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Feira de Santana / BA",
      destino: "Recife / PE",
      status: "OPEN",
      driver_visibility: "PREMIUM",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Goiania / GO",
      destino: "Uberlandia / MG",
      status: "DRAFT",
      driver_visibility: "PREMIUM",
    });

    const response = await service.fetchOperatorDashboardReadModel({
      query: {
        page: "1",
        pageSize: "10",
        status: "OPEN",
        driverVisibility: "PREMIUM",
      },
      correlationId: "corr-dashboard-filters",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Feira de Santana / BA",
      destino: "Recife / PE",
      status: "OPEN",
      driver_visibility: "PREMIUM",
    });
    expect(response.payload.meta.totalCount).toBe(1);
  });

  it("aplica filtros server-side no read model do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Portal" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Jaboatao dos Guararapes / PE",
      destino: "Simoes Filho / BA",
      perfil: "TRUCK",
      status: "OPEN",
      is_template: false,
      data: "2026-04-09",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "DRAFT",
      is_template: false,
      data: "2026-04-08",
    });

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        origem: "Salvador",
        perfil: "CARRETA",
        dateFrom: "2026-04-08",
        dateTo: "2026-04-08",
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-loads",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      perfil: "CARRETA",
      clienteNome: "Cliente Portal",
      valor: 7200,
    });
    expect(typeof response.payload.items[0].valor).toBe("number");
    expect(response.payload.summary.totalCount).toBe(1);
  });

  it("puxa o tempo estimado da rota para o portal do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente ETA" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
      duracao_horas: 22,
    });

    await seedRoute({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      origin_key: "salvador",
      destination_key: "simoes filho",
      duracao_horas: 22,
      tempo_estimado_horas: 26,
    });

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-loads-route-eta",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      distancia_km: 1500,
      tempo_estimado_horas: 26,
      duracao_horas: 22,
    });
  });

  it("puxa a distancia do catalogo de rota quando a carga esta sem distancia no portal do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Distancia" });

    const cargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
      duracao_horas: 22,
    });

    await query(`UPDATE public.cargas SET distancia_km = NULL WHERE id = $1`, [cargo.id]);

    await seedRoute({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      origin_key: "salvador",
      destination_key: "simoes filho",
      distancia_km: 1510,
      duracao_horas: 22,
      tempo_estimado_horas: 26,
    });

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-loads-route-distance",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      distancia_km: 1510,
      tempo_estimado_horas: 26,
    });
  });

  it("usa os dados padrao da rota para publicar a carga no portal do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Rota Completa" });

    const cargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
      valor: 7200,
      bonus: 300,
      duracao_horas: 22,
    });

    await query(
      `
        UPDATE public.cargas
        SET
          perfil = '',
          valor = NULL,
          bonus = NULL,
          distancia_km = NULL,
          duracao_horas = NULL
        WHERE id = $1
      `,
      [cargo.id],
    );

    await seedRoute({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      origin_key: "salvador",
      destination_key: "simoes filho",
      distancia_km: 1510,
      duracao_horas: 22,
      tempo_estimado_horas: 26,
      perfil_padrao: "TRUCK",
      valor_padrao: 8450,
      bonus_padrao: 350,
    });

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-loads-route-publish-ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "TRUCK",
      valor: 8450,
      bonus: 350,
      distancia_km: 1510,
      duracao_horas: 22,
      tempo_estimado_horas: 26,
    });
  });

  it("oculta cargas incompletas do portal do motorista ate os dados essenciais serem preenchidos", async () => {
    const cliente = await seedCliente({ nome: "Cliente Publicacao" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
    });

    const incompleteCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Recife / PE",
      destino: "Fortaleza / CE",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-09",
      valor: 7200,
      bonus: 300,
      duracao_horas: 20,
    });

    await query(
      `
        UPDATE public.cargas
        SET
          valor = NULL,
          bonus = NULL,
          distancia_km = NULL,
          duracao_horas = NULL
        WHERE id = $1
      `,
      [incompleteCargo.id],
    );

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-loads-hide-incomplete",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
    });
    expect(response.payload.summary.totalCount).toBe(1);
    expect(response.payload.meta.totalCount).toBe(1);

    const facetsResponse = await service.fetchDriverLoadFacets({
      correlationId: "corr-driver-facets-hide-incomplete",
    });

    expect(facetsResponse.statusCode).toBe(200);
    // origemOptions/destinoOptions now derived from routeLabel split by " X ", not raw cargas values
    expect(facetsResponse.payload.origemOptions).toContain("SALVADOR");
    expect(facetsResponse.payload.origemOptions).not.toContain("Recife / PE");
    expect(facetsResponse.payload.destinoOptions).not.toContain("Fortaleza / CE");
  });

  it("aceita os valores formatados dos filtros do portal do motorista", async () => {
    const cliente = await seedCliente({ nome: "Cliente Portal" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
    });

    // In-memory filter post D-02: filters match against routeLabel city names (not raw cargas.origem/destino)
    const response = await service.fetchDriverLoadsReadModel({
      query: {
        origem: "Salvador",
        destino: "Simoes",
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-loads-formatted-location",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      clienteNome: "Cliente Portal",
    });
    expect(response.payload.summary.totalCount).toBe(1);
  });

  it("mantem o dashboard operacional quando colunas opcionais ainda nao existem no schema", async () => {
    const cliente = await seedCliente({ nome: "Cliente Sem Migrations" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      status: "OPEN",
      created_at: "2026-04-08T10:00:00.000Z",
    });

    await query(`ALTER TABLE public.cargas DROP COLUMN sheet_data_carregamento`);
    await query(`ALTER TABLE public.cargas DROP COLUMN sheet_data_descarga`);
    await query(`ALTER TABLE public.cargas DROP COLUMN distancia_km`);
    await query(`ALTER TABLE public.cargas DROP COLUMN duracao_horas`);

    const response = await service.fetchOperatorDashboardReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-dashboard-legacy-schema",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      distancia_km: null,
      duracao_horas: null,
      sheet_data_carregamento: null,
      sheet_data_descarga: null,
    });
  });

  it("mantem o portal do motorista operacional quando colunas opcionais ainda nao existem no schema", async () => {
    const cliente = await seedCliente({ nome: "Cliente Legacy" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      is_template: false,
      data: "2026-04-08",
    });

    await query(`ALTER TABLE public.cargas DROP COLUMN sheet_data_carregamento`);
    await query(`ALTER TABLE public.cargas DROP COLUMN sheet_data_descarga`);
    await query(`ALTER TABLE public.cargas DROP COLUMN distancia_km`);
    await query(`ALTER TABLE public.cargas DROP COLUMN duracao_horas`);

    const response = await service.fetchDriverLoadsReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-driver-legacy-schema",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      distancia_km: null,
      duracao_horas: null,
      carregamentoLabel: null,
      descargaLabel: null,
    });
  });

  it("redige PII antiga dos leads publicos e deixa trilha de auditoria", async () => {
    const operator = await seedUser({ email: "operador@teste.local" });
    const cargo = await seedCargo({
      status: "COMPLETED",
      created_by: operator.id,
    });
    const lead = await seedPublicLead({
      load_id: cargo.id,
      approved_by: operator.id,
    });

    const result = await service.redactExpiredPublicLeadPii({
      batchSize: 10,
      retentionDays: 30,
      correlationId: "corr-redact-pii",
    });

    expect(result.redactedCount).toBe(1);

    const { rows: leads } = await query(`SELECT * FROM public.load_public_leads WHERE id = $1`, [lead.id]);
    const { rows: auditRows } = await query(
      `SELECT * FROM public.security_audit_logs WHERE event_type = 'public-leads.pii.redacted'`,
    );

    expect(leads[0].cpf).toContain("redacted-cpf-");
    expect(leads[0].phone).toContain("redacted-phone-");
    expect(leads[0].pii_redacted_at).toBeTruthy();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].correlation_id).toBe("corr-redact-pii");
  });
});
