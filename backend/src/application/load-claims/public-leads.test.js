import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LOAD_STATUS, PUBLIC_LEAD_STATUS } from "../../domain/load-claims/constants.js";
import { normalizeDriverNameKey } from "../google-sheets/driver-vinculos.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";

vi.mock("../../infrastructure/pg/postgres.js", async () => {
  const harness = await import("./test-harness.js");
  return {
    withPgClient: harness.withPgClient,
    withPgTransaction: harness.withPgTransaction,
  };
});

vi.mock("./logging.js", () => ({
  logLoadClaimEvent: vi.fn(),
}));

const { mockValidatePublicLeadPreRegistration } = vi.hoisted(() => ({
  mockValidatePublicLeadPreRegistration: vi.fn(),
}));

vi.mock("./public-lead-validation.js", () => ({
  validatePublicLeadPreRegistration: mockValidatePublicLeadPreRegistration,
  rehydrateStoredValidationSummary: (summary, fallback = {}) => {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return null;
    }

    if (!summary.driver || !summary.vigency || !Array.isArray(summary.plates)) {
      return null;
    }

    return {
      ...summary,
      overallStatus: fallback.status || summary.overallStatus || "PARTIAL",
      checkedAt: fallback.checkedAt || summary.checkedAt || null,
    };
  },
}));

let harness;
let service;

const buildPayload = (overrides = {}) => ({
  cpf: "123.456.789-01",
  phone: "(71) 99999-9999",
  horsePlate: "ABC1D23",
  trailerPlate: "DEF4G56",
  trailerPlate2: "",
  vehicleType: "CARRETA",
  ...overrides,
});

describe.sequential("public load leads", () => {
  beforeAll(async () => {
    harness = await import("./test-harness.js");
    service = await import("./public-leads.js");
  });

  beforeEach(async () => {
    vi.stubEnv("PUBLIC_LOAD_WHATSAPP_NUMBER", "5571999999999");
    vi.stubEnv("PUBLIC_LEAD_PRE_REGISTRATION_MAX_ATTEMPTS", "6");
    vi.stubEnv("PUBLIC_LEAD_PRE_REGISTRATION_WINDOW_SECONDS", "600");
    vi.stubEnv("PUBLIC_LEAD_WHATSAPP_QUEUE_MAX_ATTEMPTS", "8");
    vi.stubEnv("PUBLIC_LEAD_WHATSAPP_QUEUE_WINDOW_SECONDS", "600");
    mockValidatePublicLeadPreRegistration.mockReset();
    mockValidatePublicLeadPreRegistration.mockResolvedValue({
      summary: {
        schemaVersion: 1,
        checkedAt: "2026-04-14T10:00:00.000Z",
        candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
        overallStatus: "VALID",
        missingFields: [],
        warnings: [],
        driver: {
          angelira: {
            status: "FOUND",
            found: true,
            displayName: "Motorista Teste",
            validUntil: "2026-06-20",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
          },
          aspx: {
            status: "FOUND",
            found: true,
            displayName: "Motorista Teste",
          },
        },
        plates: [
          {
            field: "horsePlate",
            label: "Placa do cavalo",
            status: "FOUND",
            found: true,
            validUntil: "2026-06-20",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
          },
          {
            field: "trailerPlate",
            label: "Placa da carreta",
            status: "FOUND",
            found: true,
            validUntil: "2026-06-20",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
          },
        ],
        vigency: {
          status: "VALID",
          validUntil: "2026-06-20",
          daysUntilExpiry: 67,
          source: "ANGELLIRA_DRIVER",
        },
        support: {
          whatsappNumber: "5571999999999",
          whatsappUrl: "https://wa.me/5571999999999?text=teste",
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
      storedSummary: {
        schemaVersion: 1,
        checkedAt: "2026-04-14T10:00:00.000Z",
        candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
        overallStatus: "VALID",
        missingFields: [],
        warnings: [],
        driver: {
          angelira: {
            status: "FOUND",
            found: true,
            displayName: null,
            validUntil: "2026-06-20",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
          },
          aspx: {
            status: "FOUND",
            found: true,
            displayName: null,
          },
        },
        plates: [
          {
            field: "horsePlate",
            label: "Placa do cavalo",
            status: "FOUND",
            found: true,
            validUntil: "2026-06-20",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
          },
          {
            field: "trailerPlate",
            label: "Placa da carreta",
            status: "FOUND",
            found: true,
            validUntil: "2026-06-20",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
          },
        ],
        vigency: {
          status: "VALID",
          validUntil: "2026-06-20",
          daysUntilExpiry: 67,
          source: "ANGELLIRA_DRIVER",
        },
        support: {
          whatsappNumber: "5571999999999",
          whatsappUrl: "https://wa.me/5571999999999?text=teste",
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
    });
    await harness.resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await harness.closeTestDatabase();
  });

  it("creates a public pre-registration and already sends the lead to the operator queue", async () => {
    const { id: loadId } = await harness.seedLoad();

    const response = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-public-prereg",
    });

    const leads = await harness.getPublicLeadsByLoad(loadId);
    const load = await harness.getLoad(loadId);

    expect(response.statusCode).toBe(201);
    expect(response.payload.lead.status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(response.payload.lead.queuePosition).toBe(1);
    expect(response.payload.meta.validationPending).toBe(true);
    expect(load.status).toBe(LOAD_STATUS.OPEN);
    expect(load.reserved_public_lead_id).toBeNull();
    expect(leads).toHaveLength(1);
  });

  it("bloqueia pre-cadastro com tipo diferente do exigido pela carga", async () => {
    const { id: loadId } = await harness.seedLoad({
      perfil: "TRUCK",
    });

    const vehicleMismatchError = await service
      .createPublicLoadLeadPreRegistration({
        loadId,
        payload: buildPayload(),
        correlationId: "corr-public-vehicle-mismatch",
      })
      .catch((error) => error);

    expect(vehicleMismatchError).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: {
        field: "vehicleType",
        requiredVehicleType: "TRUCK",
      },
    });
  });

  it("rejeita CPF invalido antes de consultar integracoes externas", async () => {
    const { id: loadId } = await harness.seedLoad();

    const invalidCpfError = await service
      .createPublicLoadLeadPreRegistration({
        loadId,
        payload: buildPayload({
          cpf: "123.456.789-0",
        }),
        correlationId: "corr-public-invalid-cpf",
      })
      .catch((error) => error);

    expect(invalidCpfError).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: {
        field: "cpf",
      },
    });
    expect(mockValidatePublicLeadPreRegistration).not.toHaveBeenCalled();
  });

  it("exige duas placas de carreta quando a carga pede bitrem", async () => {
    const { id: loadId } = await harness.seedLoad({
      perfil: "BITREM",
    });

    const missingSecondTrailerError = await service
      .createPublicLoadLeadPreRegistration({
        loadId,
        payload: buildPayload({
          trailerPlate2: "",
          vehicleType: "BITREM",
        }),
        correlationId: "corr-public-bitrem-invalid",
      })
      .catch((error) => error);

    expect(missingSecondTrailerError).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: {
        field: "trailerPlate2",
      },
    });

    const response = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        trailerPlate: "DEF4G56",
        trailerPlate2: "GHI7J89",
        vehicleType: "BITREM",
      }),
      correlationId: "corr-public-bitrem-valid",
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.lead).toMatchObject({
      trailerPlate: "DEF4G56",
      trailerPlate2: "GHI7J89",
      vehicleType: "BITREM",
    });
  });

  it("deduplicates the same active public lead for the same load", async () => {
    const { id: loadId } = await harness.seedLoad();

    const first = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-public-first",
    });

    const second = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-public-second",
    });

    const leads = await harness.getPublicLeadsByLoad(loadId);

    expect(first.payload.lead.id).toBe(second.payload.lead.id);
    expect(second.statusCode).toBe(200);
    expect(second.payload.meta.reused).toBe(true);
    expect(leads).toHaveLength(1);
  });

  it("keeps the lead queued after the pre-registration and records the WhatsApp click separately", async () => {
    const { id: loadId } = await harness.seedLoad();
    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-public-whatsapp-prereg",
      requestContext: {
        clientIp: "198.51.100.24",
      },
    });

    const queued = await service.queuePublicLoadLeadViaWhatsApp({
      loadId,
      leadId: preregistered.payload.lead.id,
      correlationId: "corr-public-whatsapp",
      requestContext: {
        clientIp: "198.51.100.24",
      },
    });

    const lead = await harness.getPublicLead(preregistered.payload.lead.id);
    const events = await harness.getPublicLeadEventsByLoad(loadId);

    expect(queued.statusCode).toBe(200);
    expect(queued.payload.lead.status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(queued.payload.lead.queuePosition).toBe(1);
    expect(queued.payload.whatsappUrl).toContain("wa.me");
    expect(lead.status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(events.filter((event) => event.actor_type === "public-driver").map((event) => event.event_type)).toEqual([
      "PRE_REGISTERED",
      "QUEUED",
      "WHATSAPP_CLICKED",
    ]);
    expect(events.filter((event) => event.actor_type === "request-ip").map((event) => event.event_type)).toEqual([
      "PRE_REGISTERED",
      "WHATSAPP_CLICKED",
    ]);
  });

  it("rejects repeated public pre-registration bursts from the same IP", async () => {
    vi.stubEnv("PUBLIC_LEAD_PRE_REGISTRATION_MAX_ATTEMPTS", "1");

    const { id: loadId } = await harness.seedLoad();

    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-rate-limit-first",
      requestContext: {
        clientIp: "198.51.100.25",
      },
    });

    const rateLimitedError = await service
      .createPublicLoadLeadPreRegistration({
        loadId,
        payload: buildPayload({
          cpf: "987.654.321-00",
          phone: "(11) 98888-7777",
          horsePlate: "GHI7J89",
          trailerPlate: "JKL0M12",
        }),
        correlationId: "corr-rate-limit-second",
        requestContext: {
          clientIp: "198.51.100.25",
        },
      })
      .catch((error) => error);

    const auditRows = await harness.getSecurityAuditEvents("public-leads.request.rate_limited");

    expect(rateLimitedError).toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
      details: {
        scope: "public-lead-pre-registration",
      },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      event_type: "public-leads.request.rate_limited",
      action: "public-lead-pre-registration",
      outcome: "denied",
      request_ip: "198.51.100.25",
    });
  });

  it("permite o pre-cadastro mesmo quando o WhatsApp publico ainda nao foi configurado", async () => {
    vi.stubEnv("PUBLIC_LOAD_WHATSAPP_NUMBER", "");

    const { id: loadId } = await harness.seedLoad();
    const response = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-missing-whatsapp-prereg",
    });

    const events = await harness.getPublicLeadEventsByLoad(loadId);
    const leads = await harness.getPublicLeadsByLoad(loadId);

    expect(response.statusCode).toBe(201);
    expect(response.payload.lead.status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(leads).toHaveLength(1);
    expect(events.filter((event) => event.actor_type === "public-driver").map((event) => event.event_type)).toEqual([
      "PRE_REGISTERED",
      "QUEUED",
    ]);
  });

  it("normaliza o numero publico do WhatsApp com codigo do pais quando configurado so com DDD", async () => {
    vi.stubEnv("PUBLIC_LOAD_WHATSAPP_NUMBER", "71997254530");

    const { id: loadId } = await harness.seedLoad();
    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-whatsapp-number-normalized-prereg",
    });

    const queued = await service.queuePublicLoadLeadViaWhatsApp({
      loadId,
      leadId: preregistered.payload.lead.id,
      correlationId: "corr-whatsapp-number-normalized-queue",
    });

    expect(queued.payload.whatsappUrl).toContain("https://wa.me/5571997254530");
  });

  it("lists queued leads ordered by server queue order", async () => {
    const { id: loadId } = await harness.seedLoad();

    const first = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "123.456.789-01",
        phone: "(71) 99999-9999",
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
      }),
      correlationId: "corr-list-first-prereg",
    });

    const second = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "987.654.321-00",
        phone: "(11) 98888-7777",
        horsePlate: "GHI7J89",
        trailerPlate: "JKL0M12",
      }),
      correlationId: "corr-list-second-prereg",
    });

    const listing = await service.listOperatorPublicLoadLeads({
      correlationId: "corr-list-operator",
    });

    expect(listing.statusCode).toBe(200);
    expect(listing.payload.groups).toHaveLength(1);
    expect(listing.payload.groups[0].queueCount).toBe(2);
    expect(listing.payload.groups[0].leads.map((lead) => [lead.id, lead.queuePosition])).toEqual([
      [first.payload.lead.id, 1],
      [second.payload.lead.id, 2],
    ]);
    expect(listing.payload.groups[0].leads[0]).toMatchObject({
      cpf: "12345678901",
      phone: "71999999999",
      horsePlate: "ABC1D23",
      trailerPlate: "DEF4G56",
    });
  });

  it("mantem a fila do operador funcionando quando a coluna de redacao ainda nao existe", async () => {
    const { id: loadId } = await harness.seedLoad();

    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-legacy-column-prereg",
    });

    await harness.query(`ALTER TABLE public.load_public_leads DROP COLUMN pii_redacted_at`);

    const listing = await service.listOperatorPublicLoadLeads({
      correlationId: "corr-legacy-column-list",
    });

    expect(listing.statusCode).toBe(200);
    expect(listing.payload.groups).toHaveLength(1);
    expect(listing.payload.groups[0].leads).toHaveLength(1);
    expect(listing.payload.groups[0].leads[0]).toMatchObject({
      id: preregistered.payload.lead.id,
      status: PUBLIC_LEAD_STATUS.QUEUED,
    });
  });

  it("resolve driverName via fallback chain (Angellira -> ASPx -> pending registration)", async () => {
    const { id: loadId } = await harness.seedLoad();

    // Lead 1: tem nome no Angellira (validation_summary_json).
    // Lead 2: nao tem Angellira mas existe em aspx_drivers.
    // Lead 3: nao tem Angellira nem ASPx mas tem cadastro pendente.
    // Lead 4: nenhum dos tres — driverName deve ser null.
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        schemaVersion: 1,
        checkedAt: "2026-05-25T10:00:00.000Z",
        candidateSubmittedAt: "2026-05-25T09:00:00.000Z",
        overallStatus: "VALID",
        missingFields: [],
        warnings: [],
        driver: {
          angelira: { status: "FOUND", found: true, displayName: "Joao Silva Angellira", validUntil: "2026-12-31" },
          aspx: { status: "FOUND", found: true },
        },
        plates: [],
        vigency: { status: "VALID", validUntil: "2026-12-31", daysUntilExpiry: 200, source: "ANGELLIRA_DRIVER" },
        support: { whatsappNumber: "5571999999999", whatsappUrl: "https://wa.me/5571999999999" },
        sources: { angelira: { status: "OK" }, aspx: { status: "OK" } },
      },
      storedSummary: {
        schemaVersion: 1,
        checkedAt: "2026-05-25T10:00:00.000Z",
        candidateSubmittedAt: "2026-05-25T09:00:00.000Z",
        overallStatus: "VALID",
        missingFields: [],
        warnings: [],
        driver: {
          angelira: { status: "FOUND", found: true, displayName: "Joao Silva Angellira", validUntil: "2026-12-31" },
          aspx: { status: "FOUND", found: true },
        },
        plates: [],
        vigency: { status: "VALID", validUntil: "2026-12-31", daysUntilExpiry: 200, source: "ANGELLIRA_DRIVER" },
        support: { whatsappNumber: "5571999999999", whatsappUrl: "https://wa.me/5571999999999" },
        sources: { angelira: { status: "OK" }, aspx: { status: "OK" } },
      },
    });

    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "111.111.111-11",
        phone: "(71) 91111-1111",
        horsePlate: "AAA1B11",
        trailerPlate: "BBB2C22",
      }),
      correlationId: "corr-name-angellira",
    });

    // Lead 2 — ASPx fallback (sem displayName Angellira)
    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "222.222.222-22",
        phone: "(71) 92222-2222",
        horsePlate: "AAA2B22",
        trailerPlate: "BBB3C33",
      }),
      correlationId: "corr-name-aspx",
    });
    await harness.seedAspxDriver({ cpf: "22222222222", displayName: "Maria Santos ASPx" });

    // Lead 3 — pending registration fallback
    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "333.333.333-33",
        phone: "(71) 93333-3333",
        horsePlate: "AAA3B33",
        trailerPlate: "BBB4C44",
      }),
      correlationId: "corr-name-pdr",
    });
    await harness.seedPendingDriverRegistration({
      cpf: "33333333333",
      nomeMotorista: "Pedro Souza Cadastro",
      status: "pendente",
    });

    // Lead 4 — phone-only (sem nada)
    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "444.444.444-44",
        phone: "(71) 94444-4444",
        horsePlate: "AAA4B44",
        trailerPlate: "BBB5C55",
      }),
      correlationId: "corr-name-nothing",
    });

    const listing = await service.listOperatorPublicLoadLeads({
      correlationId: "corr-name-list",
    });

    expect(listing.statusCode).toBe(200);
    const leads = listing.payload.groups[0].leads;
    const leadsByPhone = new Map(leads.map((l) => [l.phone, l]));

    expect(leadsByPhone.get("71911111111")?.driverName).toBe("Joao Silva Angellira");
    expect(leadsByPhone.get("71922222222")?.driverName).toBe("Maria Santos ASPx");
    expect(leadsByPhone.get("71933333333")?.driverName).toBe("Pedro Souza Cadastro");
    expect(leadsByPhone.get("71944444444")?.driverName).toBeNull();
  });

  it("anexa o vinculo do motorista (aba Vinculo) casando por nome normalizado", async () => {
    const { id: loadId } = await harness.seedLoad();

    // Lead 1: nome via ASPx, COM vinculo cadastrado (casa por nome normalizado).
    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "111.111.111-11",
        phone: "(71) 91111-1111",
        horsePlate: "AAA1B11",
        trailerPlate: "BBB2C22",
      }),
      correlationId: "corr-vinc-1",
    });
    await harness.seedAspxDriver({ cpf: "11111111111", displayName: "JOSÉ COSME GONÇALVES DIAS" });
    // Vinculo gravado com a MESMA normalização do sync (acento/caixa removidos).
    await harness.seedDriverVinculo({
      nomeOriginal: "JOSÉ COSME GONÇALVES DIAS",
      nomeNormalizado: normalizeDriverNameKey("jose cosme goncalves dias"),
      vinculo: "AGREGADO DEDICADO",
    });

    // Lead 2: nome via ASPx, SEM vinculo cadastrado → vinculo null.
    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "222.222.222-22",
        phone: "(71) 92222-2222",
        horsePlate: "AAA2B22",
        trailerPlate: "BBB3C33",
      }),
      correlationId: "corr-vinc-2",
    });
    await harness.seedAspxDriver({ cpf: "22222222222", displayName: "Motorista Sem Vinculo" });

    const listing = await service.listOperatorPublicLoadLeads({
      correlationId: "corr-vinc-list",
    });

    expect(listing.statusCode).toBe(200);
    const leadsByPhone = new Map(listing.payload.groups[0].leads.map((l) => [l.phone, l]));

    // Casamento acento-insensível: "JOSÉ ... GONÇALVES" -> "AGREGADO DEDICADO".
    expect(leadsByPhone.get("71911111111")?.vinculo).toBe("AGREGADO DEDICADO");
    // Sem vinculo cadastrado → null (UI não mostra badge).
    expect(leadsByPhone.get("71922222222")?.vinculo).toBeNull();
  });

  it("expoe 503 SCHEMA_DRIFT quando a coluna cargas.sheet_status nao existe", async () => {
    const { id: loadId } = await harness.seedLoad();

    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-schema-drift-prereg",
    });

    // Simula migracao nao aplicada: sheet_status nao existe em producao.
    await harness.query(`ALTER TABLE public.cargas DROP COLUMN sheet_status`);

    const driftError = await service
      .listOperatorPublicLoadLeads({
        correlationId: "corr-schema-drift-list",
      })
      .catch((error) => error);

    expect(driftError).toMatchObject({
      code: "SCHEMA_DRIFT",
      statusCode: 503,
    });
  });

  it("expoe 503 SCHEMA_DRIFT quando a tabela cargas_casadas nao existe", async () => {
    const { id: loadId } = await harness.seedLoad();

    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-cargas-casadas-prereg",
    });

    // Simula rollout incompleto: cargas_casadas nao foi criada.
    await harness.query(`DROP TABLE public.cargas_casadas CASCADE`);

    const driftError = await service
      .listOperatorPublicLoadLeads({
        correlationId: "corr-cargas-casadas-list",
      })
      .catch((error) => error);

    expect(driftError).toMatchObject({
      code: "SCHEMA_DRIFT",
      statusCode: 503,
    });
  });

  it("mantem o pre-cadastro funcionando quando a coluna da segunda placa ainda nao existe", async () => {
    const { id: loadId } = await harness.seedLoad();

    await harness.query(`ALTER TABLE public.load_public_leads DROP COLUMN trailer_plate_2`);

    const response = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-legacy-second-trailer-prereg",
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.lead).toMatchObject({
      trailerPlate: "DEF4G56",
      trailerPlate2: "",
      vehicleType: "CARRETA",
      status: PUBLIC_LEAD_STATUS.QUEUED,
    });
  });

  it("approves a queued public lead and reserves the load without booking it", async () => {
    const { id: loadId } = await harness.seedLoad();
    const operator = await harness.seedOperator();

    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-approve-prereg",
    });

    const approved = await service.approvePublicLoadLead({
      loadId,
      leadId: preregistered.payload.lead.id,
      operatorId: operator.id,
      correlationId: "corr-approve",
    });

    const lead = await harness.getPublicLead(preregistered.payload.lead.id);
    const load = await harness.getLoad(loadId);

    expect(approved.statusCode).toBe(200);
    expect(lead.status).toBe(PUBLIC_LEAD_STATUS.APPROVED);
    expect(load.status).toBe(LOAD_STATUS.RESERVED);
    expect(load.reserved_public_lead_id).toBe(preregistered.payload.lead.id);
    expect(load.reserved_driver_id).toBeNull();
    expect(load.reserved_claim_id).toBeNull();
    expect(load.booked_driver_id).toBeNull();
  });

  const isoDateOf = (value) =>
    value instanceof Date
      ? `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`
      : String(value).slice(0, 10);

  it("clona uma carga recorrente ao reservar e desmarca a recorrência da reservada", async () => {
    // Data futura fixa (2099) — determinística e nunca expira (sem time-bomb).
    const { id: loadId } = await harness.seedLoad({
      data: "2099-06-10",
      horario: "04:00:00",
      is_recurring: true,
      recurrence_interval_days: 1,
    });
    const operator = await harness.seedOperator();

    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-recur-prereg",
    });

    const approved = await service.approvePublicLoadLead({
      loadId,
      leadId: preregistered.payload.lead.id,
      operatorId: operator.id,
      correlationId: "corr-recur-approve",
    });

    expect(approved.statusCode).toBe(200);

    // A carga reservada deixou de ser recorrente (virou concreta).
    const reserved = await harness.getLoad(loadId);
    expect(reserved.status).toBe(LOAD_STATUS.RESERVED);
    expect(reserved.is_recurring).toBe(false);

    // Nasceu uma cópia OPEN, recorrente, com a data avançada 1 dia, apontando
    // para a carga mãe e com fila vazia.
    const { rows: clones } = await harness.query(
      `SELECT id, status, data, is_recurring, recurrence_interval_days, recurrence_parent_id
       FROM public.cargas WHERE recurrence_parent_id = $1`,
      [loadId],
    );
    expect(clones).toHaveLength(1);
    const clone = clones[0];
    expect(clone.status).toBe(LOAD_STATUS.OPEN);
    expect(clone.is_recurring).toBe(true);
    expect(Number(clone.recurrence_interval_days)).toBe(1);
    expect(isoDateOf(clone.data)).toBe("2099-06-11"); // 2099-06-10 + 1 dia

    const cloneLeads = await harness.getPublicLeadsByLoad(clone.id);
    expect(cloneLeads).toHaveLength(0);
  });

  it("clona já na próxima ocorrência VISÍVEL quando a carga mãe está com data defasada", async () => {
    // Mãe com data no passado (ex.: job de avanço não rodou). A cópia NÃO pode
    // nascer no passado — deve pular para a próxima ocorrência visível (>= hoje).
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 10);
    const pastIso = past.toISOString().slice(0, 10);
    // Limiar = hoje no relógio de São Paulo (mesma base do clone/filtro).
    const todayIso = getSaoPauloWallClock().dateIso;

    const { id: loadId } = await harness.seedLoad({
      data: pastIso,
      horario: "04:00:00",
      is_recurring: true,
      recurrence_interval_days: 1,
    });
    const operator = await harness.seedOperator();

    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-recur-stale-prereg",
    });
    await service.approvePublicLoadLead({
      loadId,
      leadId: preregistered.payload.lead.id,
      operatorId: operator.id,
      correlationId: "corr-recur-stale-approve",
    });

    const { rows: clones } = await harness.query(
      `SELECT data FROM public.cargas WHERE recurrence_parent_id = $1`,
      [loadId],
    );
    expect(clones).toHaveLength(1);
    // Visível pelo filtro do portal: data >= hoje (não nasce no passado).
    expect(isoDateOf(clones[0].data) >= todayIso).toBe(true);
  });

  it("não clona ao reservar uma carga não-recorrente", async () => {
    const { id: loadId } = await harness.seedLoad({ is_recurring: false });
    const operator = await harness.seedOperator();

    const preregistered = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-norecur-prereg",
    });

    await service.approvePublicLoadLead({
      loadId,
      leadId: preregistered.payload.lead.id,
      operatorId: operator.id,
      correlationId: "corr-norecur-approve",
    });

    const { rows } = await harness.query(`SELECT id FROM public.cargas`);
    expect(rows).toHaveLength(1); // nenhuma cópia criada
  });

  it("replicates a pacote candidatura em todas as cargas do mesmo viagem_id", async () => {
    // 3 cargas no mesmo pacote — o motorista candidata na carga #1 e o backend
    // precisa criar lead em #2 e #3 tambem (uma candidatura por viagem casada).
    const { id: pacoteId } = await harness.seedPacote({ valor_total: 18000 });
    const { id: carga1 } = await harness.seedLoad();
    const { id: carga2 } = await harness.seedLoad();
    const { id: carga3 } = await harness.seedLoad();
    await harness.attachLoadToPacote(carga1, pacoteId, 1);
    await harness.attachLoadToPacote(carga2, pacoteId, 2);
    await harness.attachLoadToPacote(carga3, pacoteId, 3);

    const response = await service.createPublicLoadLeadPreRegistration({
      loadId: carga1,
      payload: buildPayload(),
      correlationId: "corr-pacote-prereg",
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.meta.pacoteViagemId).toBe(pacoteId);
    expect(response.payload.meta.pacoteLeadsCount).toBe(3);

    const leadsCarga1 = await harness.getPublicLeadsByLoad(carga1);
    const leadsCarga2 = await harness.getPublicLeadsByLoad(carga2);
    const leadsCarga3 = await harness.getPublicLeadsByLoad(carga3);

    expect(leadsCarga1).toHaveLength(1);
    expect(leadsCarga2).toHaveLength(1);
    expect(leadsCarga3).toHaveLength(1);
    // mesma identidade replicada em todas as paradas
    expect(leadsCarga1[0].cpf).toBe(leadsCarga2[0].cpf);
    expect(leadsCarga1[0].cpf).toBe(leadsCarga3[0].cpf);
    expect(leadsCarga1[0].phone).toBe(leadsCarga2[0].phone);
    // todos ja entram em QUEUED
    expect(leadsCarga1[0].status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(leadsCarga2[0].status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(leadsCarga3[0].status).toBe(PUBLIC_LEAD_STATUS.QUEUED);

    // Eventos PRE_REGISTERED e QUEUED registram pacote_viagem_id no payload.
    const eventsCarga2 = await harness.getPublicLeadEventsByLoad(carga2);
    const preEvent = eventsCarga2.find((e) => e.event_type === PUBLIC_LEAD_STATUS.PRE_REGISTERED || e.event_type === "PRE_REGISTERED");
    expect(preEvent).toBeDefined();
    expect(preEvent.event_payload_json).toMatchObject({ pacote_viagem_id: pacoteId });
  });

  it("mantem comportamento avulso (1 insert) quando carga nao tem viagem_id", async () => {
    const { id: loadId } = await harness.seedLoad();

    const response = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-avulsa-prereg",
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.meta.pacoteViagemId).toBeNull();
    expect(response.payload.meta.pacoteLeadsCount).toBe(1);

    const leads = await harness.getPublicLeadsByLoad(loadId);
    expect(leads).toHaveLength(1);
  });

  it("operator queue retorna pacote_meta nos groups quando carga tem viagem_id", async () => {
    const { id: pacoteId } = await harness.seedPacote({
      valor_total: 24000,
      status: "publicado",
      version: 2,
    });
    const { id: carga1 } = await harness.seedLoad();
    const { id: carga2 } = await harness.seedLoad();
    await harness.attachLoadToPacote(carga1, pacoteId, 1);
    await harness.attachLoadToPacote(carga2, pacoteId, 2);

    await service.createPublicLoadLeadPreRegistration({
      loadId: carga1,
      payload: buildPayload(),
      correlationId: "corr-pacote-list",
    });

    const listing = await service.listOperatorPublicLoadLeads({
      correlationId: "corr-pacote-list-operator",
    });

    expect(listing.statusCode).toBe(200);
    // 2 cargas do pacote — ambas tem lead (pre-cadastro replicado).
    const pacoteGroups = listing.payload.groups.filter(
      (g) => g.load.viagemId === pacoteId,
    );
    expect(pacoteGroups).toHaveLength(2);

    pacoteGroups.forEach((g) => {
      expect(g.load.pacoteMeta).not.toBeNull();
      expect(g.load.pacoteMeta).toMatchObject({
        id: pacoteId,
        status: "publicado",
        valorTotal: 24000,
        version: 2,
        totalCargas: 2,
      });
      expect([1, 2]).toContain(g.load.pacoteMeta.ordemPropria);
      expect(g.leads).toHaveLength(1);
    });
  });

  it("operator queue mantem pacoteMeta=null para cargas avulsas", async () => {
    const { id: loadId } = await harness.seedLoad();

    await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-avulsa-list",
    });

    const listing = await service.listOperatorPublicLoadLeads({
      correlationId: "corr-avulsa-list-operator",
    });

    expect(listing.statusCode).toBe(200);
    const avulsa = listing.payload.groups.find((g) => g.load.id === loadId);
    expect(avulsa).toBeDefined();
    expect(avulsa.load.viagemId).toBeNull();
    expect(avulsa.load.pacoteMeta).toBeNull();
  });

  it("rejects approving a queued lead when the load is no longer open", async () => {
    const { id: loadId } = await harness.seedLoad();
    const operator = await harness.seedOperator();

    const first = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload(),
      correlationId: "corr-conflict-first-prereg",
    });
    await service.approvePublicLoadLead({
      loadId,
      leadId: first.payload.lead.id,
      operatorId: operator.id,
      correlationId: "corr-conflict-first-approve",
    });

    const second = await service.createPublicLoadLeadPreRegistration({
      loadId,
      payload: buildPayload({
        cpf: "111.222.333-44",
        phone: "(31) 97777-6666",
        horsePlate: "MNO3P45",
        trailerPlate: "QRS6T78",
      }),
      correlationId: "corr-conflict-second-prereg",
    }).catch((error) => error);

    expect(second).toMatchObject({
      code: "CONFLICT",
      details: {
        code: "LOAD_NOT_OPEN",
        loadStatus: LOAD_STATUS.RESERVED,
      },
    });
  });
});
