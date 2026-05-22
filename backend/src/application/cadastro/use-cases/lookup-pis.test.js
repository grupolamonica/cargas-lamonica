import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../infrastructure/infosimples/infosimples-client.js", () => ({
  lookupPisCnis: vi.fn(),
}));

import { lookupPis } from "./lookup-pis.js";
import { lookupPisCnis } from "../../../infrastructure/infosimples/infosimples-client.js";

describe("lookupPis use case", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sucesso com pis preenchido retorna 200 com source", async () => {
    lookupPisCnis.mockResolvedValueOnce({
      pis: "12345678901",
      source: "infosimples",
      header: { signature: "sig", price: 0.24, billable: true },
    });

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-1",
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      pis: "12345678901",
      source: "infosimples",
      meta: { correlationId: "c-1" },
    });
  });

  it("pis null (sem CNIS) retorna 404 PisNotFound", async () => {
    lookupPisCnis.mockResolvedValueOnce({
      pis: null,
      source: "infosimples",
      header: { signature: "sig", price: 0.24, billable: true },
    });

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-2",
    });

    expect(result.statusCode).toBe(404);
    expect(result.payload.error).toBe("PisNotFound");
    expect(result.payload.meta.correlationId).toBe("c-2");
  });

  it("INFOSIMPLES_SOURCE_TIMEOUT mapeia para 504 SourceTimeout", async () => {
    lookupPisCnis.mockRejectedValueOnce(new Error("INFOSIMPLES_SOURCE_TIMEOUT"));

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-3",
    });

    expect(result.statusCode).toBe(504);
    expect(result.payload.error).toBe("SourceTimeout");
  });

  it("INFOSIMPLES_SOURCE_UNAVAILABLE mapeia para 503 SourceUnavailable", async () => {
    lookupPisCnis.mockRejectedValueOnce(new Error("INFOSIMPLES_SOURCE_UNAVAILABLE"));

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-615",
    });

    expect(result.statusCode).toBe(503);
    expect(result.payload.error).toBe("SourceUnavailable");
    expect(result.payload.message).toContain("temporariamente indisponivel");
  });

  it("INFOSIMPLES_NO_CREDIT mapeia para 502 SourceUnavailable", async () => {
    lookupPisCnis.mockRejectedValueOnce(new Error("INFOSIMPLES_NO_CREDIT"));

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-4",
    });

    expect(result.statusCode).toBe(502);
    expect(result.payload.error).toBe("SourceUnavailable");
  });

  it("INFOSIMPLES_NOT_CONFIGURED mapeia para 503 ServiceNotConfigured", async () => {
    lookupPisCnis.mockRejectedValueOnce(new Error("INFOSIMPLES_NOT_CONFIGURED"));

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-5",
    });

    expect(result.statusCode).toBe(503);
    expect(result.payload.error).toBe("ServiceNotConfigured");
  });

  it("INFOSIMPLES_INVALID_INPUT mapeia para 400 InvalidInput", async () => {
    lookupPisCnis.mockRejectedValueOnce(new Error("INFOSIMPLES_INVALID_INPUT"));

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-6",
    });

    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toBe("InvalidInput");
  });

  it("INFOSIMPLES_API_ERROR:* mapeia para 502 SourceError generico", async () => {
    lookupPisCnis.mockRejectedValueOnce(new Error("INFOSIMPLES_API_ERROR:999"));

    const result = await lookupPis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-7",
    });

    expect(result.statusCode).toBe(502);
    expect(result.payload.error).toBe("SourceError");
  });
});
