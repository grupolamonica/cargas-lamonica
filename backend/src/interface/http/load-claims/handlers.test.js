import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireDriverSession,
  mockRequireOperatorSession,
  mockRegisterDriverUser,
  mockGetDriverProfileByUserId,
  mockGetLoadClaimStatus,
  mockUpsertDriverProfile,
  mockCreatePublicLoadLeadPreRegistration,
  mockQueuePublicLoadLeadViaWhatsApp,
} = vi.hoisted(() => ({
  mockRequireDriverSession: vi.fn(),
  mockRequireOperatorSession: vi.fn(),
  mockRegisterDriverUser: vi.fn(),
  mockGetDriverProfileByUserId: vi.fn(),
  mockGetLoadClaimStatus: vi.fn(),
  mockUpsertDriverProfile: vi.fn(),
  mockCreatePublicLoadLeadPreRegistration: vi.fn(),
  mockQueuePublicLoadLeadViaWhatsApp: vi.fn(),
}));

vi.mock("../../../application/load-claims/auth.js", () => ({
  requireDriverSession: mockRequireDriverSession,
  requireOperatorSession: mockRequireOperatorSession,
  registerDriverUser: mockRegisterDriverUser,
}));

vi.mock("../../../application/load-claims/profile-service.js", () => ({
  getDriverProfileByUserId: mockGetDriverProfileByUserId,
  upsertDriverProfile: mockUpsertDriverProfile,
}));

vi.mock("../../../application/load-claims/public-leads.js", () => ({
  approvePublicLoadLead: vi.fn(),
  assertOperatorId: vi.fn(),
  createPublicLoadLeadPreRegistration: mockCreatePublicLoadLeadPreRegistration,
  listOperatorPublicLoadLeads: vi.fn(),
  queuePublicLoadLeadViaWhatsApp: mockQueuePublicLoadLeadViaWhatsApp,
}));

vi.mock("../../../application/load-claims/service.js", () => ({
  cancelLoadClaim: vi.fn(),
  confirmLoadClaim: vi.fn(),
  createLoadClaim: vi.fn(),
  getLoadClaimStatus: mockGetLoadClaimStatus,
  processExpiredLoadClaims: vi.fn(),
}));

import {
  resolveGetLoadClaimStatusResponse,
  resolveCreatePublicLoadLeadPreRegistrationResponse,
  resolveQueuePublicLoadLeadViaWhatsAppResponse,
  resolveRegisterDriverResponse,
  resolveRegisterOperatorResponse,
} from "./handlers.js";

const driverRegistrationPayload = {
  email: "motorista@teste.com",
  password: "123456",
  profile: {
    full_name: "Motorista Teste",
    phone: "71999999999",
    document_number: "123456789",
    vehicle_profile: "CARRETA",
    documents_valid: true,
    antt_valid: true,
    tracking_enabled: true,
    insurance_valid: true,
    monitoring_capable: true,
    allowed_regions: ["BA"],
    metadata: {},
  },
};

describe("load-claims handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bloqueia o endpoint publico de cadastro de operador", async () => {
    const response = await resolveRegisterOperatorResponse({
      body: JSON.stringify({
        email: "operador@empresa.com",
        password: "123456",
      }),
      headers: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found.",
    });
  });

  it("nao vaza mensagem interna quando o cadastro de motorista falha por erro inesperado", async () => {
    mockRegisterDriverUser.mockRejectedValueOnce(new Error("SUPABASE_SERVICE_ROLE_KEY is missing"));

    const response = await resolveRegisterDriverResponse({
      body: JSON.stringify(driverRegistrationPayload),
      headers: {},
    });

    expect(response.statusCode).toBe(500);
    expect(response.payload.message).toBe("Nao foi possivel processar sua solicitacao agora. Tente novamente em alguns instantes.");
    expect(JSON.stringify(response.payload)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("devolve uma mensagem amigavel quando o pre-cadastro publico falha por erro inesperado", async () => {
    mockCreatePublicLoadLeadPreRegistration.mockRejectedValueOnce(new Error("column trailer_plate_2 does not exist"));

    const response = await resolveCreatePublicLoadLeadPreRegistrationResponse({
      body: JSON.stringify({
        cpf: "12345678901",
        phone: "71999999999",
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
        trailerPlate2: "",
        vehicleType: "CARRETA",
      }),
      headers: {},
      query: {
        loadId: "load-1",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.payload.message).toBe(
      "Nao foi possivel salvar seu pre-cadastro agora. Tente novamente em alguns instantes.",
    );
    expect(JSON.stringify(response.payload)).not.toContain("trailer_plate_2");
  });

  it("encaminha o IP do cliente para o fluxo de pre-cadastro publico", async () => {
    mockCreatePublicLoadLeadPreRegistration.mockResolvedValueOnce({
      statusCode: 201,
      payload: {
        ok: true,
      },
    });

    await resolveCreatePublicLoadLeadPreRegistrationResponse({
      body: JSON.stringify({
        cpf: "12345678901",
        phone: "71999999999",
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
        trailerPlate2: "",
        vehicleType: "CARRETA",
      }),
      headers: {
        "x-forwarded-for": "198.51.100.25, 10.0.0.1",
      },
      query: {
        loadId: "load-1",
      },
    });

    expect(mockCreatePublicLoadLeadPreRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        loadId: "load-1",
        requestContext: {
          clientIp: "198.51.100.25",
        },
      }),
    );
  });

  it("encaminha o IP do cliente para o passo publico de fila por WhatsApp", async () => {
    mockQueuePublicLoadLeadViaWhatsApp.mockResolvedValueOnce({
      statusCode: 200,
      payload: {
        ok: true,
      },
    });

    await resolveQueuePublicLoadLeadViaWhatsAppResponse({
      headers: {
        "x-real-ip": "203.0.113.30",
      },
      query: {
        loadId: "load-1",
        leadId: "lead-1",
      },
    });

    expect(mockQueuePublicLoadLeadViaWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({
        loadId: "load-1",
        leadId: "lead-1",
        requestContext: {
          clientIp: "203.0.113.30",
        },
      }),
    );
  });

  it("encaminha o leadId publico para consultar o status correto da disputa", async () => {
    mockRequireDriverSession.mockResolvedValueOnce({
      user: {
        id: "driver-1",
      },
    });
    mockGetLoadClaimStatus.mockResolvedValueOnce({
      statusCode: 200,
      payload: {
        ok: true,
      },
    });

    await resolveGetLoadClaimStatusResponse({
      headers: {
        authorization: "Bearer mock-token",
      },
      query: {
        loadId: "load-1",
        leadId: "lead-1",
      },
    });

    expect(mockGetLoadClaimStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        loadId: "load-1",
        driverId: "driver-1",
        publicLeadId: "lead-1",
      }),
    );
  });
});
