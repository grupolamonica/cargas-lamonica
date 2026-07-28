import { beforeEach, describe, expect, it, vi } from "vitest";

// NOTA (08-23): pre-check virou PUBLICO em Phase 7 (commit c5fa0bc) — nao
// requer mais driver-auth nem profile lookup. Tests de 401/409 do design
// antigo foram removidos. CPF vem do body (form do DriverClaimPanel).

const { mockCandidaturaPreCheck, mockAttachSelfie } = vi.hoisted(() => ({
  mockCandidaturaPreCheck: vi.fn(),
  mockAttachSelfie: vi.fn(),
}));

vi.mock("../../../application/candidatura/use-cases/pre-check.js", () => ({
  candidaturaPreCheck: mockCandidaturaPreCheck,
}));

vi.mock("../../../application/candidatura/use-cases/attach-selfie.js", () => ({
  attachSelfieToCadastro: mockAttachSelfie,
}));

import {
  resolveAttachSelfieResponse,
  resolveCandidaturaPreCheckResponse,
} from "./handlers.js";

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

  it("propaga persistedMotorista no payload quando o use-case o devolve (caso SELFIE_REQUIRED)", async () => {
    mockCandidaturaPreCheck.mockResolvedValueOnce({
      pendencias: [{ step: "A", reason: "SELFIE_REQUIRED", label: "Falta a selfie com a CNH" }],
      completos: [],
      persistedMotorista: { nome: "JOSE EDUARDO", cpf: "12345678901" },
    });

    const response = await resolveCandidaturaPreCheckResponse(
      buildRequest({
        body: { cpf: "12345678901", horsePlate: "abc1d23", trailerPlates: [] },
        ip: "198.51.100.55",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload.persistedMotorista).toEqual({
      nome: "JOSE EDUARDO",
      cpf: "12345678901",
    });
  });

  it("NAO inclui persistedMotorista no payload quando o use-case nao o devolve", async () => {
    mockCandidaturaPreCheck.mockResolvedValueOnce({
      pendencias: [],
      completos: [],
    });

    const response = await resolveCandidaturaPreCheckResponse(
      buildRequest({
        body: { cpf: "12345678901", horsePlate: "abc1d23", trailerPlates: [] },
        ip: "198.51.100.56",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toHaveProperty("persistedMotorista");
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

describe("resolveAttachSelfieResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validBody = {
    cpf: "12345678901",
    selfieStoragePath: "12345678901/carga/motorista_selfie_cnh_1.jpg",
  };

  it("422 quando falta selfieStoragePath (zod)", async () => {
    const response = await resolveAttachSelfieResponse(
      buildRequest({ body: { cpf: "12345678901" }, ip: "203.0.113.71" }),
    );
    expect(response.statusCode).toBe(422);
    expect(mockAttachSelfie).not.toHaveBeenCalled();
  });

  it("200 quando o use-case anexa a selfie", async () => {
    mockAttachSelfie.mockResolvedValueOnce({
      ok: true,
      cadastroId: "cad-1",
      selfie_cnh_url: validBody.selfieStoragePath,
    });

    const response = await resolveAttachSelfieResponse(
      buildRequest({ body: validBody, ip: "203.0.113.72" }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      selfie_cnh_url: validBody.selfieStoragePath,
    });
    expect(mockAttachSelfie).toHaveBeenCalledWith(
      expect.objectContaining({
        cpf: "12345678901",
        selfieStoragePath: validBody.selfieStoragePath,
      }),
    );
  });

  it("404 quando nao ha cadastro aprovado para o CPF", async () => {
    mockAttachSelfie.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND" });
    const response = await resolveAttachSelfieResponse(
      buildRequest({ body: validBody, ip: "203.0.113.73" }),
    );
    expect(response.statusCode).toBe(404);
    expect(response.payload).toMatchObject({ error: "NotFound" });
  });

  it("422 quando o use-case rejeita o path (INVALID_PATH)", async () => {
    mockAttachSelfie.mockResolvedValueOnce({ ok: false, code: "INVALID_PATH" });
    const response = await resolveAttachSelfieResponse(
      buildRequest({ body: validBody, ip: "203.0.113.74" }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.payload).toMatchObject({ code: "INVALID_PATH" });
  });

  it("429 na 6a requisicao do mesmo IP (rate-limit 5/min)", async () => {
    mockAttachSelfie.mockResolvedValue({
      ok: true,
      cadastroId: "cad-1",
      selfie_cnh_url: validBody.selfieStoragePath,
    });
    const ip = `203.0.113.${120 + Math.floor(Math.random() * 50)}`;
    for (let i = 0; i < 5; i += 1) {
      const ok = await resolveAttachSelfieResponse(buildRequest({ body: validBody, ip }));
      expect(ok.statusCode).toBe(200);
    }
    const over = await resolveAttachSelfieResponse(buildRequest({ body: validBody, ip }));
    expect(over.statusCode).toBe(429);
  });
});
