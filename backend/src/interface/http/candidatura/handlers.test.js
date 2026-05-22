import { beforeEach, describe, expect, it, vi } from "vitest";

// NOTA (08-23): pre-check virou PUBLICO em Phase 7 (commit c5fa0bc) — nao
// requer mais driver-auth nem profile lookup. Tests de 401/409 do design
// antigo foram removidos. CPF vem do body (form do DriverClaimPanel).

const { mockCandidaturaPreCheck } = vi.hoisted(() => ({
  mockCandidaturaPreCheck: vi.fn(),
}));

vi.mock("../../../application/candidatura/use-cases/pre-check.js", () => ({
  candidaturaPreCheck: mockCandidaturaPreCheck,
}));

import { resolveCandidaturaPreCheckResponse } from "./handlers.js";

function buildRequest({ body, headers = {}, ip = "203.0.113.10" } = {}) {
  return {
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
    headers: {
      "x-forwarded-for": ip,
      ...headers,
    },
    query: {},
  };
}

describe("resolveCandidaturaPreCheckResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retorna 422 (ValidationError) quando body tem placa invalida", async () => {
    const response = await resolveCandidaturaPreCheckResponse(
      buildRequest({
        body: {
          cpf: "12345678901",
          horsePlate: "ABC123", // placa invalida — nao casa Mercosul nem antigo
          trailerPlates: [],
        },
        ip: "198.51.100.2",
      }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.payload).toMatchObject({
      error: "ValidationError",
      code: "VALIDATION_ERROR",
    });
    expect(mockCandidaturaPreCheck).not.toHaveBeenCalled();
  });

  it("retorna 400 (BadRequest) quando body nao e JSON valido", async () => {
    const response = await resolveCandidaturaPreCheckResponse({
      body: "{not-json",
      headers: { "x-forwarded-for": "198.51.100.10" },
      query: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ error: "BadRequest" });
    expect(mockCandidaturaPreCheck).not.toHaveBeenCalled();
  });

  it("retorna 200 com { pendencias, completos, meta } quando body valido", async () => {
    mockCandidaturaPreCheck.mockResolvedValueOnce({
      pendencias: [],
      completos: [{ plate: "ABC1D23", daysUntilExpiry: 45 }],
    });

    const response = await resolveCandidaturaPreCheckResponse(
      buildRequest({
        body: { cpf: "12345678901", horsePlate: "abc1d23", trailerPlates: [] },
        headers: { "x-correlation-id": "corr-success" },
        ip: "198.51.100.3",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload.pendencias).toEqual([]);
    expect(response.payload.completos).toEqual([
      expect.objectContaining({ plate: "ABC1D23" }),
    ]);
    expect(response.payload.meta).toMatchObject({ correlationId: "corr-success" });
    expect(mockCandidaturaPreCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "corr-success",
      }),
    );
  });

  it("retorna 429 na 6a requisicao do mesmo IP dentro da janela de rate-limit (A5 — 5/min anti-enumeration)", async () => {
    mockCandidaturaPreCheck.mockResolvedValue({
      pendencias: [],
      completos: [],
    });

    const rateLimitIp = `198.51.100.${100 + Math.floor(Math.random() * 100)}`;

    // 5 primeiras passam (limite alinhado com verify-document)
    for (let i = 0; i < 5; i += 1) {
      const response = await resolveCandidaturaPreCheckResponse(
        buildRequest({
          body: { cpf: "12345678901", horsePlate: "ABC1D23", trailerPlates: [] },
          ip: rateLimitIp,
        }),
      );
      expect(response.statusCode).toBe(200);
    }

    // 6a deve receber 429
    const overLimitResponse = await resolveCandidaturaPreCheckResponse(
      buildRequest({
        body: { cpf: "12345678901", horsePlate: "ABC1D23", trailerPlates: [] },
        ip: rateLimitIp,
      }),
    );

    expect(overLimitResponse.statusCode).toBe(429);
    expect(overLimitResponse.payload).toMatchObject({
      error: "TooManyRequests",
    });
  });
});
