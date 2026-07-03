import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  lookupTorreDriverByCpf,
  resetTorreClientStateForTests,
} from "./torre-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

function setEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

const TORRE_BODY = {
  cpf: "04943235662",
  cadastroTorre: true,
  fonte: "torre",
  ranking: { encontrado: true, posicao: 810, pontuacao: -1, vinculo: "TERCEIRO", status: "ATIVO" },
};

describe("torre-client.lookupTorreDriverByCpf", () => {
  const originalKey = process.env.TORRE_API_KEY;
  const originalBase = process.env.TORRE_API_BASE_URL;
  const originalThreshold = process.env.TORRE_CIRCUIT_BREAKER_FAILURE_THRESHOLD;

  beforeEach(() => {
    resetTorreClientStateForTests();
    setEnv("TORRE_API_KEY", "test-key");
    setEnv("TORRE_API_BASE_URL", "https://torre.test");
    setEnv("TORRE_CIRCUIT_BREAKER_FAILURE_THRESHOLD", undefined);
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    setEnv("TORRE_API_KEY", originalKey);
    setEnv("TORRE_API_BASE_URL", originalBase);
    setEnv("TORRE_CIRCUIT_BREAKER_FAILURE_THRESHOLD", originalThreshold);
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("200 retorna found:true com o payload e envia x-api-key", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(200, TORRE_BODY));

    const result = await lookupTorreDriverByCpf("049.432.356-62", { correlationId: "c-1" });

    expect(result).toEqual({ found: true, data: TORRE_BODY });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://torre.test/api/integrations/drivers/04943235662",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-key" }),
      }),
    );
  });

  it("404 retorna found:false sem throw", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(404, { error: "Motorista não encontrado" }));

    const result = await lookupTorreDriverByCpf("04943235662");

    expect(result).toEqual({ found: false, data: null });
  });

  it("cacheia resultado por CPF (segunda chamada não refaz fetch)", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(200, TORRE_BODY));

    await lookupTorreDriverByCpf("04943235662");
    const second = await lookupTorreDriverByCpf("04943235662");

    expect(second.found).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throw TORRE_INVALID_INPUT quando cpf tem menos de 11 digitos", async () => {
    await expect(lookupTorreDriverByCpf("123")).rejects.toThrow("TORRE_INVALID_INPUT");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throw TORRE_NOT_CONFIGURED sem TORRE_API_KEY", async () => {
    setEnv("TORRE_API_KEY", undefined);
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_NOT_CONFIGURED");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throw TORRE_UNAUTHORIZED em 401", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(401, { error: "Invalid API key" }));
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_UNAUTHORIZED");
  });

  it("throw TORRE_SOURCE_UNAVAILABLE em 5xx", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(500, {}));
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_SOURCE_UNAVAILABLE");
  });

  it("throw TORRE_SOURCE_TIMEOUT em erro de rede", async () => {
    globalThis.fetch.mockRejectedValueOnce(new Error("aborted"));
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_SOURCE_TIMEOUT");
  });

  it("circuit breaker abre apos N falhas e responde UNAVAILABLE sem fetch", async () => {
    setEnv("TORRE_CIRCUIT_BREAKER_FAILURE_THRESHOLD", "2");
    globalThis.fetch.mockRejectedValue(new Error("aborted"));

    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_SOURCE_TIMEOUT");
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_SOURCE_TIMEOUT");
    // Circuito aberto: terceira chamada nem chega ao fetch.
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_SOURCE_UNAVAILABLE");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("401 nao conta para o circuit breaker", async () => {
    setEnv("TORRE_CIRCUIT_BREAKER_FAILURE_THRESHOLD", "1");
    globalThis.fetch.mockResolvedValue(jsonResponse(401, { error: "Invalid API key" }));

    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_UNAUTHORIZED");
    await expect(lookupTorreDriverByCpf("04943235662")).rejects.toThrow("TORRE_UNAUTHORIZED");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
