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

  it("filtra origem/destino/perfil no SERVIDOR (varre todas as cargas, não só a página)", async () => {
    const cliente = await seedCliente({ nome: "Cliente Filtro Trecho" });

    // 15 cargas "Salvador" + 1 "Ilheus". Com pageSize pequeno, a de Ilheus fica
    // fora da página 1 — o filtro server-side tem que achá-la mesmo assim (o bug
    // antigo filtrava só as 12 linhas da página no cliente).
    for (let i = 0; i < 15; i += 1) {
      await seedCargo({
        cliente_id: cliente.id,
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        perfil: "CARRETA",
        status: "OPEN",
        sheet_lh: null,
      });
    }
    await seedCargo({
      cliente_id: cliente.id,
      origem: "Ilheus / BA",
      destino: "Vitoria / ES",
      perfil: "CARRETA_EXPRESSA",
      status: "OPEN",
      sheet_lh: null,
    });

    // origem (substring, case-insensitive) com página pequena → acha a de Ilheus.
    const byOrigem = await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "5", status: "OPEN", origem: "ilheus" },
      correlationId: "corr-origem",
    });
    expect(byOrigem.payload.meta.totalCount).toBe(1);
    expect(byOrigem.payload.items).toHaveLength(1);
    expect(byOrigem.payload.items[0]).toMatchObject({ origem: "Ilheus / BA" });

    // destino.
    const byDestino = await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "5", status: "OPEN", destino: "vitoria" },
      correlationId: "corr-destino",
    });
    expect(byDestino.payload.meta.totalCount).toBe(1);
    expect(byDestino.payload.items[0]).toMatchObject({ destino: "Vitoria / ES" });

    // perfil canônico → só a CARRETA_EXPRESSA.
    const byPerfil = await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "5", status: "OPEN", perfil: "CARRETA_EXPRESSA" },
      correlationId: "corr-perfil",
    });
    expect(byPerfil.payload.meta.totalCount).toBe(1);
    expect(byPerfil.payload.items[0]).toMatchObject({ perfil: "CARRETA_EXPRESSA" });

    // perfil="todos" = sem filtro (todas as 16 OPEN).
    const noPerfil = await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "50", status: "OPEN", perfil: "todos" },
      correlationId: "corr-noperfil",
    });
    expect(noPerfil.payload.meta.totalCount).toBe(16);
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

  // Fase 2 (aditiva) — visibilidade do apelido. O operador via "São José do Rio
  // Preto/SP" na tela de Rotas e não achava a carga que chegou como
  // "SJ Rio Preto-03/SP", concluindo que a carga foi puxada sem rota cadastrada.
  // A rota agora lista os nomes com que as cargas dela realmente chegam.
  describe("apelidos_de_carga (nomes com que a carga chega)", () => {
    const ORIGEM_ROTA = "São José do Rio Preto/SP";
    const DESTINO_ROTA = "Simões Filho/BA";

    async function seedRotaComCargas() {
      await seedRoute({
        origin_key: "sao jose do rio preto",
        destination_key: "simoes filho",
        origem: ORIGEM_ROTA,
        destino: DESTINO_ROTA,
        perfil_padrao: "CARRETA",
        valor_padrao: 14700,
      });
      // Estações distintas do SPX que colapsam no MESMO trecho pelo matcher.
      await seedCargo({ origem: "SJ Rio Preto-03/SP", destino: "Simoes Filho/BA", status: "OPEN" });
      await seedCargo({ origem: "SJ Rio Preto-05/SP", destino: "Simoes Filho/BA", status: "OPEN" });
      // Carga com a MESMA grafia da rota — não é apelido, deve ficar de fora.
      await seedCargo({ origem: ORIGEM_ROTA, destino: DESTINO_ROTA, status: "OPEN" });
      // Carga de outro trecho — não deve vazar para esta rota.
      await seedCargo({ origem: "Guarulhos/SP", destino: "Simoes Filho/BA", status: "OPEN" });
    }

    const findRota = (items) =>
      items.find((item) => item.origin_key === "sao jose do rio preto" && item.destination_key === "simoes filho");

    it("lista os nomes divergentes e omite o nome igual ao da rota", async () => {
      await seedRotaComCargas();

      const response = await readModels.fetchOperatorRoutesListReadModel({
        query: { page: "1", pageSize: "200", status: "todas" },
        correlationId: "corr-apelidos",
      });

      const rota = findRota(response.payload.items);
      expect(rota, "rota do trecho deveria estar na lista").toBeTruthy();
      expect(rota.apelidos_de_carga).toEqual([
        "SJ Rio Preto-03/SP → Simoes Filho/BA",
        "SJ Rio Preto-05/SP → Simoes Filho/BA",
      ]);
      // O nome idêntico à rota não é apelido, e o trecho de Guarulhos não vaza.
      expect(rota.apelidos_de_carga.join(" ")).not.toMatch(/São José do Rio Preto\/SP → Simões Filho\/BA/);
      expect(rota.apelidos_de_carga.join(" ")).not.toMatch(/Guarulhos/);
    });

    it("a busca da tela encontra a rota pelo nome com que a carga chega", async () => {
      await seedRotaComCargas();

      const response = await readModels.fetchOperatorRoutesListReadModel({
        // O operador digita o que ele VÊ na carga, não o nome cadastrado.
        query: { page: "1", pageSize: "200", status: "todas", search: "sj rio preto-05" },
        correlationId: "corr-apelidos-busca",
      });

      expect(findRota(response.payload.items), "busca pelo apelido deveria achar a rota").toBeTruthy();
    });

    it("rota sem carga no trecho vem com lista vazia (nunca undefined)", async () => {
      await seedRoute({
        origin_key: "salvador",
        destination_key: "aracaju",
        origem: "Salvador/BA",
        destino: "Aracaju/SE",
        perfil_padrao: "CARRETA",
      });

      const response = await readModels.fetchOperatorRoutesListReadModel({
        query: { page: "1", pageSize: "200", status: "todas" },
        correlationId: "corr-apelidos-vazio",
      });

      const rota = response.payload.items.find(
        (item) => item.origin_key === "salvador" && item.destination_key === "aracaju",
      );
      expect(rota.apelidos_de_carga).toEqual([]);
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
