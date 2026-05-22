import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  lookupPisCnis,
  resetInfosimplesClientStateForTests,
} from "./infosimples-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

function setEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function withFakeTimers(fn) {
  return async () => {
    vi.useFakeTimers();
    try {
      const promise = fn();
      // Permite sleeps (2s/4s/8s) avancarem instantaneamente.
      await vi.runAllTimersAsync();
      return await promise;
    } finally {
      vi.useRealTimers();
    }
  };
}

describe("infosimples-client.lookupPisCnis", () => {
  const originalToken = process.env.INFOSIMPLES_TOKEN;
  const originalMock = process.env.INFOSIMPLES_MOCK;
  const originalTimeout = process.env.INFOSIMPLES_TIMEOUT_MS;

  beforeEach(() => {
    resetInfosimplesClientStateForTests();
    setEnv("INFOSIMPLES_TOKEN", "test-token");
    setEnv("INFOSIMPLES_MOCK", undefined);
    setEnv("INFOSIMPLES_TIMEOUT_MS", undefined);
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    setEnv("INFOSIMPLES_TOKEN", originalToken);
    setEnv("INFOSIMPLES_MOCK", originalMock);
    setEnv("INFOSIMPLES_TIMEOUT_MS", originalTimeout);
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("retorna pis fake sem fetch quando INFOSIMPLES_MOCK=1", async () => {
    setEnv("INFOSIMPLES_MOCK", "1");
    const result = await lookupPisCnis({
      cpf: "086.566.936-89",
      nome: "Joao Motorista",
      dataNascimento: "1990-05-10",
      correlationId: "c-1",
    });
    expect(result).toEqual({ pis: "12345678900", source: "mock", header: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("aceita INFOSIMPLES_MOCK=true (case-insensitive)", async () => {
    setEnv("INFOSIMPLES_MOCK", "TRUE");
    const result = await lookupPisCnis({
      cpf: "08656693689",
      nome: "Maria",
      dataNascimento: "1985-12-31",
    });
    expect(result.source).toBe("mock");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throw INFOSIMPLES_INVALID_INPUT quando cpf tem menos de 11 digitos", async () => {
    await expect(
      lookupPisCnis({ cpf: "123", nome: "Joao", dataNascimento: "1990-01-01" }),
    ).rejects.toThrow("INFOSIMPLES_INVALID_INPUT");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throw INFOSIMPLES_INVALID_INPUT quando data nao bate yyyy-mm-dd", async () => {
    await expect(
      lookupPisCnis({
        cpf: "08656693689",
        nome: "Joao",
        dataNascimento: "10/05/1990",
      }),
    ).rejects.toThrow("INFOSIMPLES_INVALID_INPUT");
  });

  it("throw INFOSIMPLES_INVALID_INPUT quando nome vazio", async () => {
    await expect(
      lookupPisCnis({
        cpf: "08656693689",
        nome: "   ",
        dataNascimento: "1990-01-01",
      }),
    ).rejects.toThrow("INFOSIMPLES_INVALID_INPUT");
  });

  it("throw INFOSIMPLES_NOT_CONFIGURED quando token ausente e mock off", async () => {
    setEnv("INFOSIMPLES_TOKEN", "");
    await expect(
      lookupPisCnis({
        cpf: "08656693689",
        nome: "Joao",
        dataNascimento: "1990-01-01",
      }),
    ).rejects.toThrow("INFOSIMPLES_NOT_CONFIGURED");
  });

  it("response 200 com data[0].nit retorna pis normalizado", async () => {
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        code: 200,
        header: { signature: "sig-abc", price: 0.24, billable: true },
        data: [{ nit: "123.45678.90-1" }],
      }),
    });

    const result = await lookupPisCnis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
    });

    expect(result).toEqual({
      pis: "12345678901",
      source: "infosimples",
      header: { signature: "sig-abc", price: 0.24, billable: true },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // body deve ter token + cpf + nome + data_nascimento
    expect(options.body).toContain("token=test-token");
    expect(options.body).toContain("cpf=08656693689");
    expect(options.body).toContain("data_nascimento=1990-01-01");
  });

  it("response 200 com data vazio retorna pis: null (CPF sem PIS no CNIS)", async () => {
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        code: 200,
        header: { signature: "sig-empty", price: 0.24, billable: false },
        data: [],
      }),
    });

    const result = await lookupPisCnis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
    });

    expect(result.pis).toBeNull();
    expect(result.source).toBe("infosimples");
    expect(result.header.signature).toBe("sig-empty");
  });

  it("response 615 (fonte pausada) throw INFOSIMPLES_SOURCE_UNAVAILABLE sem retry", async () => {
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        code: 615,
        code_message: "O site ou aplicativo de origem parece estar indisponivel.",
        header: { signature: "sig-615", price: 0, billable: false },
      }),
    });

    await expect(
      lookupPisCnis({
        cpf: "08656693689",
        nome: "Joao",
        dataNascimento: "1990-01-01",
      }),
    ).rejects.toThrow("INFOSIMPLES_SOURCE_UNAVAILABLE");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // sem retry — fonte ja pausada
  });

  it("response 620 (saldo zerado) throw INFOSIMPLES_NO_CREDIT", async () => {
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        code: 620,
        code_message: "Saldo insuficiente",
        header: { signature: "sig-620", price: 0, billable: false },
      }),
    });

    await expect(
      lookupPisCnis({
        cpf: "08656693689",
        nome: "Joao",
        dataNascimento: "1990-01-01",
      }),
    ).rejects.toThrow("INFOSIMPLES_NO_CREDIT");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // sem retry
  });

  it(
    "response 612 tres vezes throw INFOSIMPLES_SOURCE_TIMEOUT (com fake timers)",
    withFakeTimers(async () => {
      globalThis.fetch.mockResolvedValue({
        status: 200,
        json: async () => ({
          code: 612,
          code_message: "Timeout na fonte",
          header: { signature: "sig-612", price: 0, billable: false },
        }),
      });

      await expect(
        lookupPisCnis({
          cpf: "08656693689",
          nome: "Joao",
          dataNascimento: "1990-01-01",
        }),
      ).rejects.toThrow("INFOSIMPLES_SOURCE_TIMEOUT");

      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    }),
  );

  it("loga header.signature/price/billable em todo response (auditoria)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        code: 200,
        header: { signature: "sig-audit", price: 0.24, billable: true },
        data: [{ nit: "12345678901" }],
      }),
    });

    await lookupPisCnis({
      cpf: "08656693689",
      nome: "Joao",
      dataNascimento: "1990-01-01",
      correlationId: "c-audit",
    });

    const auditCall = logSpy.mock.calls.find(
      ([eventName]) =>
        typeof eventName === "string" &&
        eventName.includes("infosimples.lookup_pis.response"),
    );
    expect(auditCall).toBeTruthy();
    const payload = auditCall?.[1];
    expect(payload).toMatchObject({
      signature: "sig-audit",
      price: 0.24,
      billable: true,
      code: 200,
      correlationId: "c-audit",
    });
    logSpy.mockRestore();
  });

  it("response com code inesperado throw INFOSIMPLES_API_ERROR:<code>", async () => {
    globalThis.fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        code: 999,
        header: { signature: "sig-999" },
      }),
    });

    await expect(
      lookupPisCnis({
        cpf: "08656693689",
        nome: "Joao",
        dataNascimento: "1990-01-01",
      }),
    ).rejects.toThrow("INFOSIMPLES_API_ERROR:999");
  });
});
