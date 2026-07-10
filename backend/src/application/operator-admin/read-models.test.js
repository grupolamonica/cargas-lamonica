import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedDriverProfile,
  seedLoadClaim,
  seedPublicLead,
  seedRoute,
  withPgClient,
} from "./test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
}));

const readModels = await import("./read-models.js");

describe("operator-admin read models", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("aplica filtros de visibilidade e origem da carga no catalogo de cargas", async () => {
    const cliente = await seedCliente({ nome: "Cliente Catalogo" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      status: "OPEN",
      driver_visibility: "PUBLIC",
      sheet_lh: null,
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Feira de Santana / BA",
      destino: "Recife / PE",
      status: "OPEN",
      driver_visibility: "PREMIUM",
      sheet_lh: "sheet-123",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Recife / PE",
      destino: "Fortaleza / CE",
      status: "DRAFT",
      driver_visibility: "PREMIUM",
      sheet_lh: "sheet-456",
    });

    const response = await readModels.fetchOperatorCargoListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        status: "OPEN",
        driverVisibility: "PREMIUM",
        source: "planilha",
      },
      correlationId: "corr-cargo-filters",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Feira de Santana / BA",
      destino: "Recife / PE",
      status: "OPEN",
      driver_visibility: "PREMIUM",
      sheet_lh: "sheet-123",
    });
    expect(response.payload.meta.totalCount).toBe(1);
  });

  it("expoe codigo_viagem na lista de cargas (contrato usado pelo Editar Carga)", async () => {
    const cliente = await seedCliente({ nome: "Cliente Codigo Viagem" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Aracaju / SE",
      status: "OPEN",
      codigo_viagem: "LT-READMODEL-1",
    });

    const response = await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "10", status: "OPEN" },
      correlationId: "corr-codigo-viagem",
    });

    expect(response.statusCode).toBe(200);
    const match = response.payload.items.find((item) => item.origem === "Salvador / BA");
    expect(match?.codigo_viagem).toBe("LT-READMODEL-1");
  });

  it("oculta cargas expiradas da visao padrao Todos, mas mantem acesso via filtro explicito", async () => {
    const cliente = await seedCliente({ nome: "Cliente Expiradas" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      status: "OPEN",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Feira de Santana / BA",
      destino: "Recife / PE",
      status: "RESERVED",
    });
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Recife / PE",
      destino: "Fortaleza / CE",
      status: "EXPIRED",
    });

    // Visao padrao ("todos") nao deve incluir EXPIRED.
    const defaultResponse = await readModels.fetchOperatorCargoListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        status: "todos",
      },
      correlationId: "corr-cargo-hide-expired-default",
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.payload.items.map((item) => item.status).sort()).toEqual(["OPEN", "RESERVED"]);
    expect(defaultResponse.payload.meta.totalCount).toBe(2);

    // Filtro explicito "EXPIRED" continua expondo as cargas expiradas.
    const expiredResponse = await readModels.fetchOperatorCargoListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        status: "EXPIRED",
      },
      correlationId: "corr-cargo-expired-explicit",
    });

    expect(expiredResponse.statusCode).toBe(200);
    expect(expiredResponse.payload.items).toHaveLength(1);
    expect(expiredResponse.payload.items[0]).toMatchObject({
      origem: "Recife / PE",
      destino: "Fortaleza / CE",
      status: "EXPIRED",
    });
    expect(expiredResponse.payload.meta.totalCount).toBe(1);
  });

  it("expõe distancia e valor base da planilha no catalogo de rotas mesmo sem registro persistido", async () => {
    const response = await readModels.fetchOperatorRoutesListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        search: "campo grande",
        status: "ativas",
      },
      correlationId: "corr-routes-base-values",
    });

    expect(response.statusCode).toBe(200);

    // route_key agora inclui perfil + eixos (uma rota por veículo). Base sintética
    // (sem registro persistido) usa perfil vazio e eixos 0.
    const route = response.payload.items.find((item) => item.route_key === "campo grande|simoes filho||0");

    expect(route).toMatchObject({
      route_key: "campo grande|simoes filho||0",
      origem: "CAMPO GRANDE",
      destino: "SIMOES FILHO",
      distancia_km: 1607,
      valor_padrao: 11150,
      source: "base",
    });
  });

  it("normaliza metricas numericas persistidas no catalogo de rotas", async () => {
    await seedRoute({
      origem: "CAMPO GRANDE",
      destino: "SIMOES FILHO",
      origin_key: "campo grande",
      destination_key: "simoes filho",
      distancia_km: 1607,
      duracao_horas: 57,
      tempo_estimado_horas: 57,
      perfil_padrao: "CARRETA",
      valor_padrao: 11150,
      bonus_padrao: 0,
    });

    const response = await readModels.fetchOperatorRoutesListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        search: "campo grande",
        status: "ativas",
      },
      correlationId: "corr-routes-persisted-values",
    });

    expect(response.statusCode).toBe(200);

    // route_key inclui perfil (CARRETA) + eixos (0) da rota persistida.
    const route = response.payload.items.find(
      (item) => item.route_key === "campo grande|simoes filho|CARRETA|0",
    );

    expect(route).toMatchObject({
      route_key: "campo grande|simoes filho|CARRETA|0",
      distancia_km: 1607,
      duracao_horas: 57,
      tempo_estimado_horas: 57,
      valor_padrao: 11150,
      bonus_padrao: 0,
      source: "base+db",
    });
  });

  it("filtra as cargas que ainda aguardam dados para publicacao no portal", async () => {
    const cliente = await seedCliente({ nome: "Cliente Operacao" });

    await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      status: "OPEN",
      perfil: "CARRETA",
      valor: 7200,
      distancia_km: 1500,
      duracao_horas: 24,
    });

    const pendingCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Terminal Pendente / BA",
      destino: "Base Sem Dados / PE",
      status: "OPEN",
    });

    const autoCompletedCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Simoes Filho / BA",
      destino: "Salgueiro / PE",
      status: "OPEN",
    });

    await withPgClient((client) =>
      client.query(
        `
          UPDATE public.cargas
          SET
            valor = NULL,
            distancia_km = NULL,
            duracao_horas = NULL
          WHERE id IN ($1, $2)
        `,
        [pendingCargo.id, autoCompletedCargo.id],
      ),
    );

    await seedRoute({
      origem: "Simoes Filho / BA",
      destino: "Salgueiro / PE",
      origin_key: "simoes filho",
      destination_key: "salgueiro",
      distancia_km: 782,
      duracao_horas: 16,
      tempo_estimado_horas: 16,
      perfil_padrao: "CARRETA",
      valor_padrao: 5500,
      bonus_padrao: 0,
    });

    const response = await readModels.fetchOperatorCargoListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        status: "aguardando_dados",
      },
      correlationId: "corr-cargo-pending-data",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      origem: "Terminal Pendente / BA",
      destino: "Base Sem Dados / PE",
      status: "OPEN",
    });
    expect(response.payload.meta.totalCount).toBe(1);
  });

  it("agrega motoristas cadastrados e pre-cadastros publicos com candidaturas recentes", async () => {
    const cliente = await seedCliente({ nome: "Cliente Motoristas" });
    const registeredCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Campinas / SP",
      status: "OPEN",
      perfil: "CARRETA",
    });
    const publicCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Feira de Santana / BA",
      destino: "Recife / PE",
      status: "OPEN",
      perfil: "TRUCK",
    });
    const driver = await seedDriverProfile({
      full_name: "Maria Santos",
      phone: "71912345678",
      document_number: "12345678901",
      vehicle_profile: "CARRETA",
      documents_valid: true,
      antt_valid: true,
    });

    await seedLoadClaim({
      load_id: registeredCargo.id,
      driver_id: driver.user_id,
      status: "WAITLISTED",
      queue_position: 1,
      claimed_at: "2026-04-14T09:00:00.000Z",
      created_at: "2026-04-14T09:00:00.000Z",
    });

    await seedPublicLead({
      load_id: publicCargo.id,
      cpf: "98765432100",
      phone: "71999888777",
      horse_plate: "ABC1D23",
      trailer_plate: "DEF4G56",
      vehicle_type: "TRUCK",
      status: "QUEUED",
      validation_status: "EXPIRING",
      validation_checked_at: "2026-04-14T10:00:00.000Z",
      validation_summary_json: {
        schemaVersion: 1,
        checkedAt: "2026-04-14T10:00:00.000Z",
        candidateSubmittedAt: "2026-04-14T09:55:00.000Z",
        overallStatus: "EXPIRING",
        missingFields: [],
        warnings: ["Vigencia perto de vencer."],
        driver: {
          angelira: {
            status: "FOUND",
            found: true,
            displayName: null,
          },
          aspx: {
            status: "FOUND",
            found: true,
            displayName: null,
          },
        },
        plates: [],
        vigency: {
          status: "EXPIRING",
          validUntil: "2026-04-28",
          daysUntilExpiry: 14,
          source: "ANGELLIRA_DRIVER",
        },
        support: {
          whatsappNumber: "5571997254530",
          whatsappUrl: "https://wa.me/5571997254530",
        },
        sources: {
          angelira: {
            status: "OK",
          },
          aspx: {
            status: "OK",
          },
        },
      },
      created_at: "2026-04-14T10:05:00.000Z",
      updated_at: "2026-04-14T10:05:00.000Z",
    });

    const response = await readModels.fetchOperatorDriversListReadModel({
      query: {
        page: "1",
        pageSize: "10",
      },
      correlationId: "corr-operator-drivers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.summary).toMatchObject({
      totalDrivers: 2,
      registeredCount: 1,
      publicOnlyCount: 1,
      totalApplications: 2,
    });

    const registeredDriver = response.payload.items.find((item) => item.displayName === "Maria Santos");
    const publicDriver = response.payload.items.find((item) => item.registrationStatus === "PUBLIC_ONLY");

    expect(registeredDriver).toMatchObject({
      registrationStatus: "REGISTERED",
      contact: {
        phone: "71912345678",
        document: "12345678901",
      },
      stats: {
        totalApplications: 1,
        queuedApplications: 1,
      },
    });
    expect(registeredDriver?.applications[0]).toMatchObject({
      source: "CLAIM",
      status: "WAITLISTED",
      load: {
        origem: "Salvador / BA",
        destino: "Campinas / SP",
      },
    });

    expect(publicDriver).toMatchObject({
      displayName: "Motorista sem cadastro no app",
      contact: {
        phone: "71999888777",
        document: "98765432100",
      },
      externalValidation: {
        overallStatus: "EXPIRING",
        hasAngelira: true,
        hasAspx: true,
      },
      stats: {
        totalApplications: 1,
        queuedApplications: 1,
      },
    });
    expect(publicDriver?.applications[0]).toMatchObject({
      source: "PUBLIC_LEAD",
      status: "QUEUED",
      load: {
        origem: "Feira de Santana / BA",
        destino: "Recife / PE",
      },
      plates: {
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
      },
    });
  });

  it("filtra a lista de motoristas por origem e status da candidatura", async () => {
    const cliente = await seedCliente({ nome: "Cliente Filtro" });
    const filaCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Salvador / BA",
      destino: "Fortaleza / CE",
      status: "OPEN",
      perfil: "CARRETA",
    });
    const reservadoCargo = await seedCargo({
      cliente_id: cliente.id,
      origem: "Recife / PE",
      destino: "Campinas / SP",
      status: "RESERVED",
      perfil: "TRUCK",
    });
    const driverFila = await seedDriverProfile({
      full_name: "Motorista da Fila",
      phone: "71911111111",
      document_number: "11111111111",
    });
    const driverReservado = await seedDriverProfile({
      full_name: "Motorista Reservado",
      phone: "81922222222",
      document_number: "22222222222",
    });

    await seedLoadClaim({
      load_id: filaCargo.id,
      driver_id: driverFila.user_id,
      status: "WAITLISTED",
      queue_position: 1,
      claimed_at: "2026-04-14T08:00:00.000Z",
      created_at: "2026-04-14T08:00:00.000Z",
    });
    await seedLoadClaim({
      load_id: reservadoCargo.id,
      driver_id: driverReservado.user_id,
      status: "CONFIRMED",
      queue_position: null,
      claimed_at: "2026-04-14T09:00:00.000Z",
      created_at: "2026-04-14T09:00:00.000Z",
    });

    const response = await readModels.fetchOperatorDriversListReadModel({
      query: {
        page: "1",
        pageSize: "10",
        search: "Recife",
        source: "cadastrados",
        applicationStatus: "confirmado",
      },
      correlationId: "corr-operator-drivers-filter",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0]).toMatchObject({
      displayName: "Motorista Reservado",
      registrationStatus: "REGISTERED",
      stats: {
        confirmedApplications: 1,
      },
    });
    expect(response.payload.meta.totalCount).toBe(1);
  });
});
