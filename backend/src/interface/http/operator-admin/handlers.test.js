import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "../../../domain/load-claims/errors.js";

const {
  mockRequireOperatorSession,
  mockRecordSecurityAuditEvent,
  mockCreateOperatorCargo,
  mockUpdateOperatorCargo,
  mockBuildAspxAssignedByLh,
  mockListAllocationChanges,
  mockRevertAllocationChanges,
} = vi.hoisted(() => ({
  mockRequireOperatorSession: vi.fn(),
  mockRecordSecurityAuditEvent: vi.fn(),
  mockCreateOperatorCargo: vi.fn(),
  mockUpdateOperatorCargo: vi.fn(),
  mockBuildAspxAssignedByLh: vi.fn(),
  mockListAllocationChanges: vi.fn(),
  mockRevertAllocationChanges: vi.fn(),
}));

vi.mock("../../../application/load-claims/auth.js", () => ({
  requireOperatorSession: mockRequireOperatorSession,
}));

vi.mock("../../../infrastructure/security-audit.js", () => ({
  recordSecurityAuditEvent: mockRecordSecurityAuditEvent,
}));

vi.mock("../../../application/operator-admin/use-cases/aspx-assigned-map.js", () => ({
  buildAspxAssignedByLh: mockBuildAspxAssignedByLh,
}));

vi.mock("../../../application/operator-admin/use-cases/list-operator-allocation-changes.js", () => ({
  listOperatorAllocationChanges: mockListAllocationChanges,
}));

vi.mock("../../../application/operator-admin/use-cases/revert-allocation-changes.js", () => ({
  revertAllocationChanges: mockRevertAllocationChanges,
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
  resolveAspxAssignedResponse,
  resolveCreateOperatorCargoResponse,
  resolveUpdateOperatorCargoResponse,
  resolveListAllocationChangesResponse,
  resolveRevertAllocationChangesResponse,
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

  // Selo "S" (atribuição da viagem no ASPX) — guarda a PERMISSÃO exata: um operador
  // (advanced/intermediate) tem `operator:read`, então precisa passar (200). Se
  // alguém trocar por uma permissão inexistente (ex.: "cargos:read"), este teste
  // falha com 403 — foi exatamente o bug pego na revisão.
  it("consulta atribuição no ASPX com operador válido e devolve o mapa por lh", async () => {
    mockBuildAspxAssignedByLh.mockResolvedValue({ LT0Q7G02AY851: true, LT0Q7G02AY852: false });

    const response = await resolveAspxAssignedResponse({
      body: JSON.stringify({
        items: [
          { lh: "LT0Q7G02AY851", motorista: "JOAO" },
          { lh: "LT0Q7G02AY852", motorista: "MARIA" },
        ],
      }),
      headers: { authorization: "Bearer valid-token" },
      method: "POST",
      query: {},
      url: "/api/operator/sheet-monitor/aspx-assigned",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.assignedByLh).toEqual({ LT0Q7G02AY851: true, LT0Q7G02AY852: false });
    expect(mockBuildAspxAssignedByLh).toHaveBeenCalledOnce();
  });

  it("rejeita body inesperado na consulta de atribuição (strict schema)", async () => {
    const response = await resolveAspxAssignedResponse({
      body: JSON.stringify({ items: [{ lh: "LT1", motorista: "X" }], injected: "nope" }),
      headers: { authorization: "Bearer valid-token" },
      method: "POST",
      query: {},
      url: "/api/operator/sheet-monitor/aspx-assigned",
    });

    expect(response.statusCode).toBe(422);
    expect(mockBuildAspxAssignedByLh).not.toHaveBeenCalled();
  });

  it("lista as mudanças de alocação do operador logado (GET)", async () => {
    mockListAllocationChanges.mockResolvedValue({ statusCode: 200, payload: { items: [], meta: {} } });

    const response = await resolveListAllocationChangesResponse({
      headers: { authorization: "Bearer valid-token" },
      method: "GET",
      query: { page: "1", pageSize: "20" },
      url: "/api/operator/allocation-changes",
    });

    expect(response.statusCode).toBe(200);
    expect(mockListAllocationChanges).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: "operator-1" }),
    );
  });

  it("reverte mudanças selecionadas (POST) e repassa os items", async () => {
    mockRevertAllocationChanges.mockResolvedValue({
      statusCode: 200,
      payload: { ok: true, revertedCount: 1, skippedCount: 0, reverted: [], skipped: [] },
      movedLhs: [],
    });

    const response = await resolveRevertAllocationChangesResponse({
      body: JSON.stringify({ items: [{ auditLogId: "11111111-1111-1111-1111-111111111111", lh: "LT-1" }] }),
      headers: { authorization: "Bearer valid-token" },
      method: "POST",
      query: {},
      url: "/api/operator/allocation-changes/revert",
    });

    expect(response.statusCode).toBe(200);
    expect(mockRevertAllocationChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        items: [{ auditLogId: "11111111-1111-1111-1111-111111111111", lh: "LT-1" }],
      }),
    );
  });

  it("rejeita body inesperado no revert (strict schema) e não chama o use-case", async () => {
    const response = await resolveRevertAllocationChangesResponse({
      body: JSON.stringify({ items: [{ auditLogId: "11111111-1111-1111-1111-111111111111", lh: "LT-1" }], injected: "nope" }),
      headers: { authorization: "Bearer valid-token" },
      method: "POST",
      query: {},
      url: "/api/operator/allocation-changes/revert",
    });

    expect(response.statusCode).toBe(422);
    expect(mockRevertAllocationChanges).not.toHaveBeenCalled();
  });
});
