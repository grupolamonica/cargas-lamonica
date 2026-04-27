import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "../../../domain/load-claims/errors.js";

const {
  mockRequireOperatorSession,
  mockRecordSecurityAuditEvent,
  mockCreateOperatorCargo,
  mockUpdateOperatorCargo,
} = vi.hoisted(() => ({
  mockRequireOperatorSession: vi.fn(),
  mockRecordSecurityAuditEvent: vi.fn(),
  mockCreateOperatorCargo: vi.fn(),
  mockUpdateOperatorCargo: vi.fn(),
}));

vi.mock("../../../application/load-claims/auth.js", () => ({
  requireOperatorSession: mockRequireOperatorSession,
}));

vi.mock("../../../infrastructure/security-audit.js", () => ({
  recordSecurityAuditEvent: mockRecordSecurityAuditEvent,
}));

vi.mock("../../../application/operator-admin/service.js", () => ({
  createOperatorCargo: mockCreateOperatorCargo,
  createOperatorCliente: vi.fn(),
  createOperatorRoute: vi.fn(),
  deleteOperatorCargo: vi.fn(),
  deleteOperatorCliente: vi.fn(),
  duplicateOperatorCargo: vi.fn(),
  fetchOperatorDashboardReadModel: vi.fn(),
  redactExpiredPublicLeadPii: vi.fn(),
  toggleOperatorCargoStatus: vi.fn(),
  updateOperatorCargo: mockUpdateOperatorCargo,
  updateOperatorCliente: vi.fn(),
  updateOperatorDriverProfile: vi.fn(),
  updateOperatorRoute: vi.fn(),
}));

import {
  resolveCreateOperatorCargoResponse,
  resolveUpdateOperatorCargoResponse,
} from "./handlers.js";

describe("operator-admin handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireOperatorSession.mockResolvedValue({
      user: {
        id: "operator-1",
        app_metadata: { role: "operator", access_level: "advanced" },
      },
      accessLevel: "advanced",
    });
  });

  it("rejeita payload com campos inesperados para reduzir mass assignment", async () => {
    const response = await resolveCreateOperatorCargoResponse({
      body: JSON.stringify({
        data: "2026-04-08",
        horario: "08:00:00",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        perfil: "CARRETA",
        valor: 7200,
        bonus: 300,
        cliente_id: null,
        status: "OPEN",
        is_template: false,
        distancia_km: 1200,
        duracao_horas: 18,
        injected_field: "forbidden",
      }),
      headers: {
        authorization: "Bearer valid-token",
      },
      method: "POST",
      query: {},
      url: "/api/operator/cargas",
    });

    expect(response.statusCode).toBe(422);
    expect(response.payload).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Payload invalido para a operacao solicitada.",
    });
    expect(mockCreateOperatorCargo).not.toHaveBeenCalled();
  });

  it("nega acesso sem sessao valida de operador e registra auditoria", async () => {
    mockRequireOperatorSession.mockRejectedValueOnce(
      new ForbiddenError("Only authenticated operators can perform this operation."),
    );

    const response = await resolveCreateOperatorCargoResponse({
      body: JSON.stringify({}),
      headers: {
        authorization: "Bearer invalid-token",
        "x-forwarded-for": "198.51.100.20",
      },
      method: "POST",
      query: {},
      url: "/api/operator/cargas",
    });

    expect(response.statusCode).toBe(403);
    expect(response.payload.code).toBe("FORBIDDEN");
    expect(mockRecordSecurityAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "operator.request.denied",
        action: "create-cargo",
        outcome: "denied",
        requestIp: "198.51.100.20",
      }),
    );
  });

  it("exige cargoId nas mutacoes de update", async () => {
    const response = await resolveUpdateOperatorCargoResponse({
      body: JSON.stringify({
        data: "2026-04-08",
        horario: "08:00:00",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        perfil: "CARRETA",
        valor: 7200,
        bonus: 300,
        cliente_id: null,
        status: "OPEN",
        is_template: false,
        distancia_km: 1200,
        duracao_horas: 18,
      }),
      headers: {
        authorization: "Bearer valid-token",
      },
      method: "PATCH",
      query: {},
      url: "/api/operator/cargas/missing-id",
    });

    expect(response.statusCode).toBe(422);
    expect(response.payload).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("aceita status operacionais no update para permitir ajustes sem alterar o ciclo da carga", async () => {
    mockUpdateOperatorCargo.mockResolvedValue({
      statusCode: 200,
      payload: {
        ok: true,
        warnings: [],
        meta: {
          correlationId: "corr-update-cargo-reserved",
        },
      },
    });

    const response = await resolveUpdateOperatorCargoResponse({
      body: JSON.stringify({
        data: "2026-04-08",
        horario: "08:00:00",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        perfil: "CARRETA",
        valor: 7200,
        bonus: 300,
        bonus_exigencias: null,
        driver_visibility: "PREMIUM",
        cliente_id: null,
        status: "RESERVED",
        is_template: false,
        distancia_km: 1200,
        duracao_horas: 18,
      }),
      headers: {
        authorization: "Bearer valid-token",
      },
      method: "PATCH",
      query: {
        cargoId: "11111111-1111-1111-1111-111111111111",
      },
      url: "/api/operator/cargas/11111111-1111-1111-1111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(mockUpdateOperatorCargo).toHaveBeenCalledWith(
      expect.objectContaining({
        cargoId: "11111111-1111-1111-1111-111111111111",
        payload: expect.objectContaining({
          status: "RESERVED",
          driver_visibility: "PREMIUM",
        }),
      }),
    );
  });
});
